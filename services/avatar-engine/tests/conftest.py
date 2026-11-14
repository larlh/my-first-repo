"""Test configuration. Unit tests need no weights: they get their own empty work dir. Tests
marked `slow` use the real weights (AVATAR_ENGINE_MODELS_DIR / HF caches) and are skipped
with a clear reason when the weights are not downloaded.

    pytest                 # unit tests only (seconds)
    pytest -m slow         # integration: renders ~1 s of real video (minutes on CPU)
    pytest -m "slow or not slow"
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
REPO = next((p for p in ROOT.parents if (p / "pnpm-workspace.yaml").exists()), None)


def pytest_collection_modifyitems(config, items):
    if config.getoption("-m"):
        return
    skip = pytest.mark.skip(reason="slow integration test: run with `pytest -m slow`")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)


@pytest.fixture()
def work_dir(tmp_path, monkeypatch):
    """Fresh settings pointing at a temporary work dir (models dir untouched)."""
    from parlante_engine.core import config

    wd = tmp_path / "work"
    wd.mkdir()
    monkeypatch.setenv("AVATAR_ENGINE_WORK_DIR", str(wd))
    monkeypatch.setenv("AVATAR_ENGINE_STARTUP_BENCHMARK", "0")
    config.reset_settings_cache()
    yield wd
    config.reset_settings_cache()


@pytest.fixture(scope="session")
def repo_root():
    return REPO
