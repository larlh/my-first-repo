"""Engine errors. Codes are the shared error codes of packages/shared/src/errors.ts."""
from __future__ import annotations

HTTP_STATUS = {
    "VALIDATION_ERROR": 400,
    "BAD_REQUEST": 400,
    "UNAUTHENTICATED": 401,
    "FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "CONFLICT": 409,
    "INVALID_STATE": 409,
    "PAYLOAD_TOO_LARGE": 413,
    "UNSUPPORTED_MEDIA_TYPE": 415,
    "UNPROCESSABLE": 422,
    "INTERNAL": 500,
    "NOT_IMPLEMENTED": 501,
    "SERVICE_UNAVAILABLE": 503,
}


class EngineError(Exception):
    """Error with a shared code, a user-presentable message and an optional machine reason.

    `reason` is a stable snake_case key (e.g. ``no_face``) that the UI can translate; the
    message is a complete English sentence that can be shown verbatim.
    """

    def __init__(self, code: str, message: str, reason: str | None = None):
        super().__init__(message)
        self.code = code if code in HTTP_STATUS else "INTERNAL"
        self.message = message
        self.reason = reason

    @property
    def status(self) -> int:
        return HTTP_STATUS[self.code]

    def to_dict(self) -> dict:
        body = {"code": self.code, "message": self.message}
        if self.reason:
            body["reason"] = self.reason
        return body


class JobCanceled(Exception):
    """Raised inside a job function when the job was canceled."""
