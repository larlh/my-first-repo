"""Shared pydantic pieces of the HTTP contract (packages/shared/src/avatar-engine.ts)."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class Request(BaseModel):
    """Base of request bodies: known fields are validated strictly, unknown ones are ignored
    so that newer clients keep working."""

    model_config = ConfigDict(extra="ignore", strict=False)
    clientRef: Optional[str] = Field(default=None, min_length=1, max_length=200)


class Point(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class PhotoLandmarks(BaseModel):
    leftEye: Point
    rightEye: Point
    mouthLeft: Point
    mouthRight: Point
    chin: Point
