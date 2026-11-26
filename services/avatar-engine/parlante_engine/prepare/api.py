"""POST /v1/portraits/prepare"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import Field

from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import EngineError
from parlante_engine.core.jobs import get_job_manager
from parlante_engine.core.paths import resolve_input_file, resolve_output_dir
from parlante_engine.core.registry import get_registry
from parlante_engine.core.schemas import PhotoLandmarks, Request

router = APIRouter()


class PrepareRequest(Request):
    imagePath: str = Field(min_length=1, max_length=4096)
    landmarks: Optional[PhotoLandmarks] = None
    outputDir: str = Field(min_length=1, max_length=4096)


@router.post("/v1/portraits/prepare", status_code=202)
def prepare(body: PrepareRequest) -> JSONResponse:
    from .service import PrepareJob, run_prepare

    if not get_registry().capability_ready("prepare"):
        raise EngineError("SERVICE_UNAVAILABLE", "Model weights for `prepare` are missing. Run "
                          "`python scripts/download_models.py` in services/avatar-engine.", "weights_missing")
    image = resolve_input_file(body.imagePath, "imagePath", get_settings().max_image_mb * 1024 * 1024)
    out = resolve_output_dir(body.outputDir)
    job = PrepareJob(image, out, body.landmarks.model_dump() if body.landmarks else None)
    manager = get_job_manager()
    handle = manager.submit("prepare", lambda ctx: run_prepare(job, ctx), eta_hint=15.0, client_ref=body.clientRef)
    return JSONResponse(manager.describe(handle), status_code=202)
