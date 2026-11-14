"""HTTP server of the avatar engine (FastAPI). Contract: packages/shared/src/avatar-engine.ts.

    GET    /health
    POST   /v1/portraits/generate      (parlante_engine.portrait.api, when installed)
    POST   /v1/portraits/prepare       (parlante_engine.prepare.api)
    POST   /v1/animations              (parlante_engine.animate.api)
    GET    /v1/jobs/{jobId}
    DELETE /v1/jobs/{jobId}

Security: binds to loopback by default; a non-loopback bind requires AVATAR_ENGINE_TOKEN and
then every request except GET /health needs `Authorization: Bearer <token>`. Request bodies
are size-limited JSON; files are only ever touched inside AVATAR_ENGINE_WORK_DIR.
"""
from __future__ import annotations

import hmac
import importlib
import ipaddress
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from parlante_engine import __version__
from parlante_engine.core import backends, perf
from parlante_engine.core.config import get_settings
from parlante_engine.core.errors import HTTP_STATUS, EngineError
from parlante_engine.core.jobs import get_job_manager
from parlante_engine.core.registry import SUBPACKAGES, get_registry

log = logging.getLogger("parlante.server")
MAX_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_FPS = 30


def error_response(code: str, message: str, status: int | None = None, **extra) -> JSONResponse:
    body = {"code": code, "message": message}
    body.update({k: v for k, v in extra.items() if v is not None})
    return JSONResponse({"error": body}, status_code=status or HTTP_STATUS.get(code, 500))


def is_loopback(host: str) -> bool:
    if host in ("localhost", ""):
        return host == "localhost"
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _include_routers(app: FastAPI) -> list[str]:
    """Include `parlante_engine.<sub>.api:router` of every sub-package that has one. A missing
    or broken sub-package only removes its own endpoints: the rest of the engine keeps working."""
    included = []
    for sub in SUBPACKAGES:
        name = f"parlante_engine.{sub}.api"
        try:
            module = importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name not in (name, f"parlante_engine.{sub}"):
                log.warning("sub-package %s is not usable (%s); its endpoints are disabled", sub, exc)
            continue
        except Exception as exc:  # noqa: BLE001
            log.warning("sub-package %s failed to load (%s); its endpoints are disabled", sub, exc)
            continue
        router = getattr(module, "router", None)
        if router is not None:
            app.include_router(router)
            included.append(sub)
    return included


def health_body(app: FastAPI) -> dict:
    reg = get_registry()
    spf = perf.seconds_per_frame("visemes")
    generate_ready = "portrait" in app.state.subpackages and reg.capability_ready("generate")
    models = [{k: m[k] for k in ("id", "role", "downloaded", "license", "commercialUse")} | {"sizeBytes": m["sizeBytes"]}
              for m in reg.model_status()]
    return {
        "status": "ok",
        "version": __version__,
        "device": backends.device(),
        "capabilities": {
            "generate": generate_ready,
            "prepare": reg.capability_ready("prepare"),
            "animate": reg.capability_ready("animate"),
        },
        "models": models,
        "secondsPerVideoSecond": round(spf * DEFAULT_FPS, 2) if spf else None,
        "secondsPerPortrait": perf.get_metric("secondsPerPortrait"),
        # ---- additive fields (ignored by the zod schema of the contract) ----
        "drivers": {"visemes": reg.capability_ready("animate"), "audio": reg.capability_ready("animate-audio")},
        "performance": perf.summary(DEFAULT_FPS),
        "backend": backends.describe(),
        "queue": get_job_manager().counts(),
    }


def create_app() -> FastAPI:
    settings = get_settings()
    backends.limit_threads()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        manager = get_job_manager()
        reg = get_registry()
        if settings.startup_benchmark and reg.capability_ready("animate") and perf.seconds_per_frame("visemes") is None:
            from parlante_engine.core.benchmark import run_benchmark
            manager.submit("benchmark", run_benchmark, eta_hint=20.0)
        yield
        manager.shutdown()

    app = FastAPI(title="Parlante avatar engine", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        length = request.headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
            return error_response("PAYLOAD_TOO_LARGE", "Request body too large.")
        if request.method in ("POST", "PUT", "PATCH") and length is None:
            return error_response("BAD_REQUEST", "Content-Length is required.", 411)
        if settings.token and not (request.method == "GET" and request.url.path == "/health"):
            given = request.headers.get("authorization", "")
            if not hmac.compare_digest(given.encode(), f"Bearer {settings.token}".encode()):
                return error_response("UNAUTHENTICATED", "Missing or invalid engine token.", 401)
        return await call_next(request)

    @app.exception_handler(EngineError)
    async def on_engine_error(_: Request, exc: EngineError):
        return error_response(exc.code, exc.message, exc.status, reason=exc.reason)

    @app.exception_handler(RequestValidationError)
    async def on_validation(_: Request, exc: RequestValidationError):
        issues = [{"path": ".".join(str(p) for p in e.get("loc", ()) if p != "body"), "message": e.get("msg", "")}
                  for e in exc.errors()[:50]]
        return error_response("VALIDATION_ERROR", "Invalid request body.", 400, details={"issues": issues})

    @app.exception_handler(StarletteHTTPException)
    async def on_http(_: Request, exc: StarletteHTTPException):
        code = {404: "NOT_FOUND", 405: "BAD_REQUEST", 413: "PAYLOAD_TOO_LARGE"}.get(exc.status_code, "BAD_REQUEST")
        return error_response(code, str(exc.detail), exc.status_code)

    @app.exception_handler(Exception)
    async def on_crash(_: Request, exc: Exception):
        log.exception("unhandled error: %s", exc)
        return error_response("INTERNAL", "Unexpected engine error.", 500)

    app.state.subpackages = _include_routers(app)

    if "portrait" not in app.state.subpackages:
        @app.post("/v1/portraits/generate")
        def generate_unavailable():
            raise EngineError("SERVICE_UNAVAILABLE", "Portrait generation is not installed in this engine.",
                              "generate_unavailable")

    @app.get("/health")
    def health():
        return health_body(app)

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: str):
        manager = get_job_manager()
        return manager.describe(manager.get(job_id))

    @app.delete("/v1/jobs/{job_id}")
    def cancel_job(job_id: str):
        manager = get_job_manager()
        return manager.describe(manager.cancel(job_id))

    return app


def main() -> int:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if not is_loopback(settings.host) and not settings.token:
        print(f"Refusing to listen on {settings.host}: a non-loopback bind requires AVATAR_ENGINE_TOKEN "
              "(see services/avatar-engine/README.md).", file=sys.stderr)
        return 2
    log.info("work dir %s | models dir %s | threads %d | backend %s", settings.work_dir, settings.models_dir,
             settings.threads, backends.heavy_backend())
    uvicorn.run(create_app(), host=settings.host, port=settings.port, log_level="info", access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
