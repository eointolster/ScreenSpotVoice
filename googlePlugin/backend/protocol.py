from __future__ import annotations

import re
import secrets
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class View(StrictModel):
    documentId: str = Field(min_length=8, max_length=100)
    revision: int = Field(ge=0)
    width: int = Field(gt=0, le=10000)
    height: int = Field(gt=0, le=10000)
    dpr: float = Field(gt=0, le=16)
    zoom: float = Field(gt=0, le=16)


class Hello(StrictModel):
    type: Literal["hello"]
    token: str = Field(min_length=16, max_length=256)
    session_id: str = Field(min_length=8, max_length=100)
    source_id: str = Field(min_length=8, max_length=100)
    view: View


class Offer(StrictModel):
    type: Literal["offer"]
    sdp: str = Field(min_length=10, max_length=200000)


class Ice(StrictModel):
    type: Literal["ice"]
    candidate: dict


class ViewEvent(StrictModel):
    type: Literal["view", "resume"]
    view: View
    reason: str = Field(default="", max_length=100)


class OverlayResult(StrictModel):
    type: Literal["overlay_result"]
    id: str = Field(min_length=8, max_length=100)
    ok: bool
    reason: str = Field(default="", max_length=200)
    view: View | None = None


class TextEvent(StrictModel):
    type: Literal["text"]
    text: str = Field(min_length=1, max_length=500)


class MuteEvent(StrictModel):
    type: Literal["mute"]
    muted: bool


class SimpleEvent(StrictModel):
    type: Literal["pause", "turn_start", "clear", "end"]


EVENTS = {"offer": Offer, "ice": Ice, "view": ViewEvent, "resume": ViewEvent,
          "overlay_result": OverlayResult, "text": TextEvent, "mute": MuteEvent,
          "pause": SimpleEvent, "turn_start": SimpleEvent, "clear": SimpleEvent, "end": SimpleEvent}


def parse_event(raw: object):
    if not isinstance(raw, dict) or not isinstance(raw.get("type"), str):
        raise ValueError("Expected a typed control message")
    cls = EVENTS.get(raw["type"])
    if cls is None:
        raise ValueError("Unknown control message")
    return cls.model_validate(raw)


def check_origin(origin: str | None, allowed_id: str | None = None) -> bool:
    if not origin or not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
        return False
    return allowed_id is None or secrets.compare_digest(origin.removeprefix("chrome-extension://"), allowed_id)


class HighlightArgs(StrictModel):
    label: str = Field(min_length=1, max_length=100)
    box_2d: list[float] = Field(min_length=4, max_length=4)

    @field_validator("box_2d")
    @classmethod
    def validate_box(cls, box: list[float]):
        import math
        if not all(math.isfinite(v) and 0 <= v <= 1000 for v in box):
            raise ValueError("Coordinates must be finite and normalized to 0–1000")
        if box[0] + 2 > box[2] or box[1] + 2 > box[3]:
            raise ValueError("Region is empty or incorrectly ordered")
        if (box[2] - box[0]) * (box[3] - box[1]) > 700000:
            raise ValueError("Region covers too much of the viewport")
        return box


class ClearArgs(StrictModel):
    reason: str = Field(default="", max_length=100)
