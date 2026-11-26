"""In-process job queue: ONE heavy job runs at a time (CPU inference saturates the machine),
the rest wait in FIFO order. Jobs report progress, an ETA and can be canceled.

    job = get_job_manager().submit("animate", fn)        # fn(ctx: JobContext) -> result dict
    ctx.set_total(units, seconds_per_unit_hint)           # e.g. frames
    ctx.advance(done_units)                               # progress + ETA from measured speed
    ctx.progress(fraction, eta_sec)                       # or report explicitly
    ctx.check_canceled()                                  # raises JobCanceled -> status "canceled"

`Job.to_dict()` has exactly the shape of EngineJob in packages/shared/src/avatar-engine.ts.
"""
from __future__ import annotations

import logging
import threading
import time
import traceback
import uuid
from collections import OrderedDict, deque
from typing import Callable

from .errors import EngineError, JobCanceled

log = logging.getLogger("parlante.jobs")
TERMINAL = ("succeeded", "failed", "canceled")


class Job:
    def __init__(self, kind: str, fn: Callable[["JobContext"], dict], eta_hint: float | None,
                 client_ref: str | None = None):
        self.id = uuid.uuid4().hex
        self.kind = kind
        self.client_ref = client_ref
        self.fn = fn
        self.status = "queued"
        self.progress = 0.0
        self.eta_sec: float | None = eta_hint
        self.eta_hint = eta_hint
        self.result: dict | None = None
        self.error: dict | None = None
        self.created_at = time.time()
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.cancel_event = threading.Event()

    def to_dict(self) -> dict:
        eta = self.eta_sec
        return {
            "jobId": self.id,
            "status": self.status,
            "progress": round(min(1.0, max(0.0, self.progress)), 4),
            "etaSec": None if eta is None else round(max(0.0, eta), 1),
            "result": self.result,
            "error": self.error,
        }


class JobContext:
    """Handed to the job function. Thread-safe enough for one reporter."""

    def __init__(self, job: Job):
        self._job = job
        self._total = 0.0
        self._t0: float | None = None
        self._base = 0.0            # progress fraction reserved before the unit loop
        self._span = 1.0
        self._hint: float | None = None

    @property
    def job_id(self) -> str:
        return self._job.id

    @property
    def canceled(self) -> bool:
        return self._job.cancel_event.is_set()

    def check_canceled(self) -> None:
        if self._job.cancel_event.is_set():
            raise JobCanceled()

    def progress(self, fraction: float, eta_sec: float | None = None) -> None:
        self._job.progress = float(min(1.0, max(self._job.progress, fraction)))
        self._job.eta_sec = eta_sec

    def set_total(self, units: float, seconds_per_unit_hint: float | None = None,
                  base: float = 0.0, span: float = 1.0) -> None:
        """Declare a loop of `units` equal steps mapped to progress [base, base+span]."""
        self._total = max(float(units), 1e-9)
        self._t0 = time.monotonic()
        self._base, self._span, self._hint = base, span, seconds_per_unit_hint
        self._job.progress = max(self._job.progress, base)
        if seconds_per_unit_hint:
            self._job.eta_sec = seconds_per_unit_hint * units

    def advance(self, done_units: float) -> None:
        """Progress + ETA from the speed measured so far in this very job."""
        done = min(max(float(done_units), 0.0), self._total)
        self._job.progress = max(self._job.progress, self._base + self._span * done / self._total)
        if self._t0 is not None and done > 0:
            per_unit = (time.monotonic() - self._t0) / done
            if self._hint and done < 3:       # first units include warm-up: blend with the hint
                per_unit = 0.5 * per_unit + 0.5 * self._hint
            self._job.eta_sec = per_unit * (self._total - done)


class JobManager:
    def __init__(self, ttl_seconds: int = 3600, max_finished: int = 200, max_queued: int = 32):
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._queue: deque[Job] = deque()
        self._cv = threading.Condition()
        self._ttl = ttl_seconds
        self._max_finished = max_finished
        self._max_queued = max_queued
        self._current: Job | None = None
        self._stop = False
        self._thread = threading.Thread(target=self._run, name="parlante-job-worker", daemon=True)
        self._thread.start()

    # ---------- public ----------
    def submit(self, kind: str, fn: Callable[[JobContext], dict], eta_hint: float | None = None,
               client_ref: str | None = None) -> Job:
        """Queue a job. `eta_hint`: estimated seconds of work (shown while queued). `client_ref`:
        idempotent retries - a queued/running job of the same kind and reference is returned as is."""
        job = Job(kind, fn, eta_hint, client_ref)
        with self._cv:
            if client_ref:
                for other in self._jobs.values():
                    if other.client_ref == client_ref and other.kind == kind and other.status in ("queued", "running"):
                        return other
            if len(self._queue) >= self._max_queued:
                raise EngineError("SERVICE_UNAVAILABLE", "The engine queue is full; retry later.", "queue_full")
            self._prune()
            self._jobs[job.id] = job
            self._queue.append(job)
            self._cv.notify_all()
        return job

    def get(self, job_id: str) -> Job:
        with self._cv:
            job = self._jobs.get(job_id)
        if job is None:
            raise EngineError("NOT_FOUND", "Job not found", "job_not_found")
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        with self._cv:
            if job.status == "queued":
                try:
                    self._queue.remove(job)
                except ValueError:
                    pass
                self._finish(job, "canceled")
            elif job.status == "running":
                job.cancel_event.set()
        if job.status == "running":
            # the running function notices at its next check; wait briefly so DELETE can answer "canceled"
            deadline = time.monotonic() + 15
            while job.status == "running" and time.monotonic() < deadline:
                time.sleep(0.05)
        return job

    def describe(self, job: Job) -> dict:
        """EngineJob dict; for queued jobs the ETA includes the work queued ahead of them."""
        body = job.to_dict()
        if job.status == "queued":
            with self._cv:
                ahead = 0.0
                known = job.eta_hint is not None
                if self._current is not None:
                    if self._current.eta_sec is None:
                        known = False
                    else:
                        ahead += self._current.eta_sec
                for other in self._queue:
                    if other is job:
                        break
                    if other.eta_hint is None:
                        known = False
                    else:
                        ahead += other.eta_hint
            body["etaSec"] = round(ahead + (job.eta_hint or 0.0), 1) if known else None
        return body

    def counts(self) -> dict:
        with self._cv:
            return {"running": 1 if self._current is not None else 0, "queued": len(self._queue)}

    def queue_position(self, job_id: str) -> int | None:
        with self._cv:
            for i, job in enumerate(self._queue):
                if job.id == job_id:
                    return i
        return None

    def busy(self) -> bool:
        with self._cv:
            return self._current is not None or bool(self._queue)

    def wait(self, job_id: str, timeout: float | None = None) -> Job:
        job = self.get(job_id)
        deadline = None if timeout is None else time.monotonic() + timeout
        while job.status not in TERMINAL:
            if deadline is not None and time.monotonic() > deadline:
                break
            time.sleep(0.02)
        return job

    def shutdown(self) -> None:
        with self._cv:
            self._stop = True
            for job in self._queue:
                self._finish(job, "canceled")
            self._queue.clear()
            if self._current is not None:
                self._current.cancel_event.set()
            self._cv.notify_all()

    # ---------- internals ----------
    def _finish(self, job: Job, status: str) -> None:
        job.status = status
        job.finished_at = time.time()
        job.eta_sec = 0.0 if status == "succeeded" else None
        if status == "succeeded":
            job.progress = 1.0

    def _prune(self) -> None:
        now = time.time()
        finished = [j for j in self._jobs.values() if j.status in TERMINAL]
        for job in finished:
            if now - (job.finished_at or now) > self._ttl:
                self._jobs.pop(job.id, None)
        finished = [j for j in self._jobs.values() if j.status in TERMINAL]
        for job in finished[: max(0, len(finished) - self._max_finished)]:
            self._jobs.pop(job.id, None)

    def _run(self) -> None:
        while True:
            with self._cv:
                while not self._queue and not self._stop:
                    self._cv.wait(timeout=1.0)
                if self._stop:
                    return
                job = self._queue.popleft()
                job.status = "running"
                job.started_at = time.time()
                self._current = job
            try:
                result = job.fn(JobContext(job))
                with self._cv:
                    if job.cancel_event.is_set() and result is None:
                        self._finish(job, "canceled")
                    else:
                        job.result = result
                        self._finish(job, "succeeded")
            except JobCanceled:
                with self._cv:
                    self._finish(job, "canceled")
            except EngineError as exc:
                with self._cv:
                    job.error = exc.to_dict()
                    self._finish(job, "failed")
            except MemoryError:
                with self._cv:
                    job.error = {"code": "SERVICE_UNAVAILABLE", "message": "Out of memory while running the job.",
                                 "reason": "out_of_memory"}
                    self._finish(job, "failed")
            except Exception as exc:  # noqa: BLE001 - a job must never kill the worker thread
                log.error("job %s (%s) crashed: %s\n%s", job.id, job.kind, exc, traceback.format_exc())
                with self._cv:
                    job.error = {"code": "INTERNAL", "message": f"Unexpected engine error: {type(exc).__name__}"}
                    self._finish(job, "failed")
            finally:
                with self._cv:
                    self._current = None
                    job.fn = None  # type: ignore[assignment]  (drop closures holding big arrays)


_manager: JobManager | None = None
_manager_lock = threading.Lock()


def get_job_manager() -> JobManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            from .config import get_settings
            _manager = JobManager(ttl_seconds=get_settings().job_ttl_seconds)
        return _manager
