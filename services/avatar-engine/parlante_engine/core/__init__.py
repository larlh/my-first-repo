"""Shared infrastructure of the engine. Public API for every sub-package:

    from parlante_engine.core.config import get_settings
    from parlante_engine.core.errors import EngineError
    from parlante_engine.core.registry import ModelFile, get_registry
    from parlante_engine.core.jobs import get_job_manager, JobContext
    from parlante_engine.core.paths import resolve_input_file, resolve_output_dir

A sub-package `parlante_engine.<name>` is plugged in by convention:
    <name>/models.py   ->  MODELS: list[ModelFile]          (aggregated by the registry)
    <name>/api.py      ->  router: fastapi.APIRouter        (included by server.py)
"""
