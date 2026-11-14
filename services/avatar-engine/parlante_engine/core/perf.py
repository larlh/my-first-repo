"""Measured performance of this machine, persisted next to the weights so that /health and job
ETAs are honest from the first request after a restart. Every number comes from a real run:
the startup benchmark or finished animation jobs (exponential moving average)."""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import psutil

from .config import get_settings

_lock = threading.Lock()


def _path() -> Path:
    return get_settings().models_dir / ".perf.json"


def load() -> dict:
    try:
        return json.loads(_path().read_text())
    except (OSError, ValueError):
        return {}


def record(driver: str, seconds_per_frame: float, frames: int, extra: dict | None = None,
           peak_rss: float | None = None) -> dict:
    """Blend a new measurement of `seconds_per_frame` (render loop only) into the store."""
    with _lock:
        data = load()
        cur = data.get(driver)
        if cur and cur.get("secondsPerFrame"):
            weight = min(0.5, frames / 100.0 + 0.1)          # short runs move the average less
            spf = (1 - weight) * cur["secondsPerFrame"] + weight * seconds_per_frame
        else:
            spf = seconds_per_frame
        entry = {
            "secondsPerFrame": round(spf, 4),
            "lastSecondsPerFrame": round(seconds_per_frame, 4),
            "lastFrames": frames,
            "loadAvg1": round(os.getloadavg()[0], 2),
            "measuredAt": int(time.time()),
            # peak resident memory of the process while a job of this driver ran (sampled)
            "peakRssMb": round(peak_rss if peak_rss is not None else (cur or {}).get("peakRssMb") or rss_mb(), 0),
        }
        if extra:
            entry.update(extra)
        data[driver] = entry
        try:
            tmp = _path().with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1))
            os.replace(tmp, _path())
        except OSError:
            pass
        return entry


def set_metric(name: str, value: float) -> None:
    """Store a free-form measured number (e.g. "secondsPerPortrait" by the portrait sub-package)."""
    with _lock:
        data = load()
        data.setdefault("_metrics", {})[name] = {"value": float(value), "measuredAt": int(time.time())}
        try:
            tmp = _path().with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=1))
            os.replace(tmp, _path())
        except OSError:
            pass


def get_metric(name: str) -> float | None:
    entry = load().get("_metrics", {}).get(name)
    return float(entry["value"]) if entry else None


def seconds_per_frame(driver: str = "visemes") -> float | None:
    entry = load().get(driver)
    return float(entry["secondsPerFrame"]) if entry and entry.get("secondsPerFrame") else None


def peak_rss_mb() -> float:
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def rss_mb() -> float:
    return psutil.Process().memory_info().rss / (1024.0 * 1024.0)


def summary(default_fps: int = 30) -> dict:
    """Shape published under `performance` in GET /health."""
    data = load()
    out: dict = {"threads": get_settings().threads, "rssMb": round(rss_mb(), 0), "drivers": {}}
    for driver, entry in data.items():
        if driver.startswith("_"):
            continue
        spf = entry.get("secondsPerFrame")
        if not spf:
            continue
        out["drivers"][driver] = {
            "secondsPerFrame": spf,
            "secondsPerVideoSecond": round(spf * default_fps, 1),
            "minutesPer10sVideo": round(spf * default_fps * 10 / 60.0, 2),
            "fps": default_fps,
            "peakRssMb": entry.get("peakRssMb"),
            "setupSeconds": entry.get("setupSeconds"),
            "loadAvg1": entry.get("loadAvg1"),
            "measuredAt": entry.get("measuredAt"),
            "source": entry.get("source", "job"),
        }
    return out
