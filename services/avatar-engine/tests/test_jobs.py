"""Job queue: one job at a time, FIFO, progress / ETA, cancellation, errors, idempotent refs."""
from __future__ import annotations

import threading
import time

import pytest

from parlante_engine.core.errors import EngineError
from parlante_engine.core.jobs import JobManager


@pytest.fixture()
def manager():
    m = JobManager(ttl_seconds=60)
    yield m
    m.shutdown()


def test_success_shape_matches_contract(manager):
    job = manager.submit("prepare", lambda ctx: {"kind": "prepare", "ok": True})
    manager.wait(job.id, 5)
    body = manager.describe(job)
    assert set(body) == {"jobId", "status", "progress", "etaSec", "result", "error"}
    assert body["status"] == "succeeded" and body["progress"] == 1.0 and body["etaSec"] == 0.0
    assert body["result"] == {"kind": "prepare", "ok": True} and body["error"] is None


def test_one_job_at_a_time_in_fifo_order(manager):
    running, peak, order = [0], [0], []
    lock = threading.Lock()

    def work(name):
        def fn(ctx):
            with lock:
                running[0] += 1
                peak[0] = max(peak[0], running[0])
            time.sleep(0.05)
            order.append(name)
            with lock:
                running[0] -= 1
            return {"kind": name}
        return fn

    jobs = [manager.submit("animate", work(f"j{i}")) for i in range(5)]
    for j in jobs:
        manager.wait(j.id, 10)
    assert peak[0] == 1
    assert order == [f"j{i}" for i in range(5)]


def test_progress_and_eta_from_measured_speed(manager):
    gate = threading.Event()
    seen = {}

    def fn(ctx):
        ctx.set_total(10, seconds_per_unit_hint=0.5)
        seen["initial_eta"] = manager.describe(job)["etaSec"]
        for i in range(10):
            time.sleep(0.02)
            ctx.advance(i + 1)
            if i == 4:
                seen["mid"] = manager.describe(job)
                gate.wait(2)
        return {"kind": "animate"}

    job = manager.submit("animate", fn)
    for _ in range(200):
        if "mid" in seen:
            break
        time.sleep(0.01)
    assert seen["initial_eta"] == pytest.approx(5.0)
    assert seen["mid"]["status"] == "running" and seen["mid"]["progress"] == pytest.approx(0.5)
    assert 0.03 < seen["mid"]["etaSec"] < 1.0           # 5 units left at ~0.02 s each, not the 0.5 s hint
    gate.set()
    assert manager.wait(job.id, 5).status == "succeeded"


def test_queued_eta_includes_jobs_ahead(manager):
    release = threading.Event()

    def blocker(ctx):
        ctx.progress(0.5, 30.0)
        release.wait(5)
        return {"kind": "x"}

    first = manager.submit("animate", blocker, eta_hint=60.0)
    time.sleep(0.1)
    second = manager.submit("animate", lambda ctx: {"kind": "x"}, eta_hint=10.0)
    third = manager.submit("animate", lambda ctx: {"kind": "x"}, eta_hint=7.0)
    assert manager.describe(second)["etaSec"] == pytest.approx(40.0)
    assert manager.describe(third)["etaSec"] == pytest.approx(47.0)
    assert manager.counts() == {"running": 1, "queued": 2}
    release.set()
    for j in (first, second, third):
        assert manager.wait(j.id, 5).status == "succeeded"


def test_cancel_running_and_queued(manager):
    started = threading.Event()

    def long(ctx):
        started.set()
        for _ in range(500):
            ctx.check_canceled()
            time.sleep(0.01)
        return {"kind": "animate"}

    a = manager.submit("animate", long)
    b = manager.submit("animate", lambda ctx: {"kind": "animate"})
    started.wait(2)
    assert manager.cancel(b.id).status == "canceled"          # queued: never runs
    t0 = time.time()
    done = manager.cancel(a.id)
    assert done.status == "canceled" and time.time() - t0 < 2
    assert manager.describe(done)["result"] is None
    c = manager.submit("prepare", lambda ctx: {"kind": "prepare"})   # worker thread survived
    assert manager.wait(c.id, 5).status == "succeeded"
    assert manager.cancel(c.id).status == "succeeded"                # canceling a finished job is a no-op


def test_engine_error_and_crash_are_reported_not_raised(manager):
    def bad(ctx):
        raise EngineError("UNPROCESSABLE", "No face was detected.", "no_face")

    def crash(ctx):
        raise RuntimeError("secret internal detail")

    a, b = manager.submit("prepare", bad), manager.submit("prepare", crash)
    manager.wait(a.id, 5), manager.wait(b.id, 5)
    assert manager.describe(a)["error"] == {"code": "UNPROCESSABLE", "message": "No face was detected.",
                                            "reason": "no_face"}
    body = manager.describe(b)
    assert body["status"] == "failed" and body["error"]["code"] == "INTERNAL"
    assert "secret" not in body["error"]["message"]


def test_client_ref_returns_the_live_job(manager):
    release = threading.Event()
    a = manager.submit("animate", lambda ctx: release.wait(5) or {"kind": "animate"}, client_ref="r1:s1:l1")
    b = manager.submit("animate", lambda ctx: {"kind": "animate"}, client_ref="r1:s1:l1")
    other_kind = manager.submit("prepare", lambda ctx: {"kind": "prepare"}, client_ref="r1:s1:l1")
    assert b is a and other_kind is not a
    release.set()
    manager.wait(a.id, 5)
    c = manager.submit("animate", lambda ctx: {"kind": "animate"}, client_ref="r1:s1:l1")
    assert c is not a                                           # finished jobs are not reused
    manager.wait(c.id, 5)


def test_unknown_job_is_not_found(manager):
    with pytest.raises(EngineError) as exc:
        manager.get("nope")
    assert exc.value.code == "NOT_FOUND"


def test_queue_limit():
    m = JobManager(max_queued=2)
    try:
        gate = threading.Event()
        m.submit("x", lambda ctx: gate.wait(5) or {})
        time.sleep(0.05)
        m.submit("x", lambda ctx: {})
        m.submit("x", lambda ctx: {})
        with pytest.raises(EngineError) as exc:
            m.submit("x", lambda ctx: {})
        assert exc.value.code == "SERVICE_UNAVAILABLE"
        gate.set()
    finally:
        m.shutdown()
