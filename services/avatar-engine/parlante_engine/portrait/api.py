"""POST /v1/portraits/generate — text description -> portrait of a SYNTHETIC presenter.
GET  /v1/portraits/options  — template choices and expected duration on this machine.

`generate` is a long job (tens of seconds to minutes on CPU): it answers 202 with an EngineJob;
poll GET /v1/jobs/{jobId} for `progress`, `etaSec` and the result.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import Field

from parlante_engine.core.errors import EngineError
from parlante_engine.core.jobs import get_job_manager
from parlante_engine.core.paths import resolve_output_dir
from parlante_engine.core.registry import get_registry
from parlante_engine.core.schemas import Request

router = APIRouter()


class GenerateRequest(Request):
    prompt: str = Field(min_length=1, max_length=1000)
    seed: int = Field(ge=0, le=2 ** 53)
    width: int = Field(default=512, ge=256, le=1024)
    height: int = Field(default=512, ge=256, le=1024)
    outputDir: str = Field(min_length=1, max_length=4096)
    #: additive (optional in the shared contract): steers the template and the negative prompt
    gender: Optional[Literal["female", "male", "neutral"]] = None


@router.get("/v1/portraits/options")
def options() -> dict:
    """Additive helper (not in the shared contract): the structured choices of the presenter
    template and the expected duration of a job on THIS machine, for forms and estimates."""
    from .prompts import BACKGROUNDS, GENDERS, MAX_AGE, MIN_AGE, SKIN_TONES, STYLES
    from .service import MAX_SIDE, MIN_SIDE, performance_summary

    return {
        "genders": list(GENDERS),
        "age": {"min": MIN_AGE, "max": MAX_AGE},
        "skinTones": list(SKIN_TONES),
        "styles": {name: clothing for name, clothing in STYLES.items()},
        "backgrounds": list(BACKGROUNDS),
        "size": {"min": MIN_SIDE, "max": MAX_SIDE, "multipleOf": 64, "default": 512},
        "ready": get_registry().capability_ready("generate"),
        "performance": performance_summary(),
    }


@router.post("/v1/portraits/generate", status_code=202)
def generate(body: GenerateRequest) -> JSONResponse:
    from .prompts import prompt_from_description
    from .service import MAX_SIDE, MIN_SIDE, GenerateJob, estimate_seconds, run_generate
    from .pipeline import round_size

    if not get_registry().capability_ready("generate"):
        raise EngineError("SERVICE_UNAVAILABLE", "Model weights for portrait generation are missing. Run "
                          "`python scripts/download_models.py --all` in services/avatar-engine.", "weights_missing")
    # validate the description before queueing so bad requests fail fast (400, not a failed job)
    prompt_from_description(body.prompt, body.gender)
    out = resolve_output_dir(body.outputDir)
    job = GenerateJob(output_dir=out, seed=body.seed, width=body.width, height=body.height,
                      description=body.prompt, gender=body.gender)
    eta = estimate_seconds(round_size(body.width, MIN_SIDE, MAX_SIDE), round_size(body.height, MIN_SIDE, MAX_SIDE))
    manager = get_job_manager()
    handle = manager.submit("generate", lambda ctx: run_generate(job, ctx), eta_hint=eta, client_ref=body.clientRef)
    return JSONResponse(manager.describe(handle), status_code=202)
