"""Tests for the local (Ollama vision+tools) provider.

The Gemini path is covered in test_backend.py and must stay unchanged; these
tests guard only the added local backend, its argument coercion, and the
one-question-one-frame turn.
"""
import asyncio
import time
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.local_model import LocalAdapter, LocalModelError, _coerce_arguments
from backend.protocol import HighlightArgs, Hello, OverlayResult, View
from backend.server import Call, Settings


def view(revision=0):
    return View(documentId="document-123456", revision=revision, width=1280, height=720, dpr=1.0, zoom=1.0)


def frame(received=None):
    from backend.grounding import Frame
    return Frame(b"jpeg", 1024, 576, bytes([40] * 576), received or time.monotonic())


class Socket:
    def __init__(self): self.messages = []
    async def send_json(self, data): self.messages.append(data)
    async def close(self): pass


def make_call():
    # protocol.Hello requires 8+ character session_id/source_id.
    return Call(Socket(), hello=Hello(type="hello", token="a" * 24, session_id="session-local",
                                      source_id="source-local", view=view()),
                settings=Settings(backend="local", local_model="stub"))


def statuses(call):
    return [m for m in call.ws.messages if m.get("type") == "status"]


def test_backend_selection_labels_and_local_defaults():
    """The Gemini path must be unchanged when MODEL_BACKEND is unset."""
    default = Settings()
    assert default.backend == "gemini"
    assert not default.is_local
    assert default.mode_label() == "calibration"          # no key => calibration, as before
    assert Settings(key="k").mode_label() == "live"
    assert default.provider_label() == default.model

    local = Settings(backend="local")
    assert local.is_local
    assert local.mode_label() == "local"
    assert local.provider_label() == "local:qwen3.8:27b"
    # A local session must not depend on, or be gated by, the Gemini key.
    assert local.key == ""


def test_local_tool_arguments_are_coerced_into_strict_schema():
    # The real model emits box_2d as the *string* "[172, 30, 205, 122]".
    coerced = _coerce_arguments("highlight_region", {"label": "Upload", "box_2d": "[172, 30, 205, 122]"})
    assert coerced["box_2d"] == [172, 30, 205, 122]
    assert HighlightArgs.model_validate(coerced).box_2d == [172.0, 30.0, 205.0, 122.0]

    assert _coerce_arguments("highlight_region", {"label": "U", "box_2d": [1, 2, 30, 40]})["box_2d"] == [1, 2, 30, 40]
    assert _coerce_arguments("highlight_region", {"label": "U", "box_2d": "[1.0, 2.0, 3.0, 4.0]"})["box_2d"] == [1, 2, 3, 4]
    # A missing label must not lose an otherwise valid highlight.
    assert _coerce_arguments("highlight_region", {"box_2d": [1, 2, 30, 40]})["label"] == "target"

    # Garbage is left alone so HighlightArgs reports the real error, not a coerced one.
    for bad in ("not a box", "[1,2,3]", "[a,b,c,d]"):
        with pytest.raises(ValidationError):
            HighlightArgs.model_validate(_coerce_arguments("highlight_region", {"label": "U", "box_2d": bad}))

    # Other tools are never rewritten.
    other = {"reason": "done", "box_2d": "[1,2,3,4]"}
    assert _coerce_arguments("clear_highlights", other) == other


def test_local_response_parsing_handles_both_argument_shapes():
    adapter = LocalAdapter("http://127.0.0.1:11434", "stub")
    # Native Ollama: arguments already a dict.
    native = {"message": {"content": "Here it is.", "tool_calls": [
        {"id": "c1", "function": {"name": "highlight_region", "arguments": {"label": "Upload", "box_2d": [1, 2, 30, 40]}}}]}}
    turn = adapter._parse(native)
    assert turn.text == "Here it is."
    assert turn.tool_calls[0]["arguments"]["box_2d"] == [1, 2, 30, 40]

    # OpenAI-compatible shape: arguments still a JSON string.
    compat = {"message": {"content": "", "tool_calls": [
        {"id": "c2", "function": {"name": "clear_highlights", "arguments": '{"reason":"stale"}'}}]}}
    assert adapter._parse(compat).tool_calls[0]["arguments"] == {"reason": "stale"}

    # No text and no tool call is an error, never a silent success.
    with pytest.raises(LocalModelError):
        adapter._parse({"message": {"content": "   ", "tool_calls": []}})


def test_local_turn_runs_tool_then_speaks_reply():
    """One question -> validated tool call -> overlay ack -> spoken reply."""
    from backend.local_model import LocalTurn

    async def scenario():
        call = make_call()
        seen = {}

        async def fake_ask(question, jpeg):
            seen["question"], seen["jpeg"] = question, jpeg
            return LocalTurn("The upload button is top left.", [
                {"id": "t1", "name": "highlight_region",
                 "arguments": {"label": "Upload", "box_2d": [171, 31, 205, 122]}}])

        async def confirmed(kind, box=None, label="", view=None, image=None):
            return OverlayResult(type="overlay_result", id="render-ok", ok=True)

        call.local = SimpleNamespace(ask=fake_ask, last_latency_ms=412)
        call._request_overlay = confirmed
        call._invalidate = lambda view=None: None
        source = frame()
        call.grounding.accept_frame(source)
        call.grounding.mark_sent(source)
        call.last_image_at = 0.0
        try:
            await call._local_turn("where is the upload button", call.grounding.generation)
            assert seen["question"] == "where is the upload button"
            assert seen["jpeg"] == source.jpeg
            # The reply must be both transcribed and sent for speech.
            assert any(m.get("speak") == "The upload button is top left." for m in statuses(call))
            assert any(m.get("localLatencyMs") == 412 for m in statuses(call))
        finally:
            call.local = None
            await call.close()
    asyncio.run(scenario())


def test_local_turn_refuses_to_answer_without_a_clean_frame():
    """A stale or missing frame must not be described as the current page."""
    async def scenario():
        call = make_call()
        called = []
        call.local = SimpleNamespace(ask=lambda q, j: called.append(q), last_latency_ms=None)
        call._invalidate = lambda view=None: None
        try:
            await call._local_turn("anything", call.grounding.generation)
            assert called == []
            assert any(m.get("status") == "Error" and "frame" in m.get("detail", "") for m in statuses(call))
        finally:
            call.local = None
            await call.close()
    asyncio.run(scenario())


def test_local_turn_surfaces_model_failure_without_claiming_success():
    async def scenario():
        call = make_call()
        async def boom(question, jpeg): raise LocalModelError("ConnectError: refused")
        call.local = SimpleNamespace(ask=boom, last_latency_ms=None)
        call._invalidate = lambda view=None: None
        source = frame()
        call.grounding.accept_frame(source)
        call.grounding.mark_sent(source)
        call.last_image_at = 0.0
        try:
            await call._local_turn("hello", call.grounding.generation)
            assert any(m.get("status") == "Error" and "Local model failed" in m.get("detail", "")
                       for m in statuses(call))
            assert not any(m.get("speak") for m in statuses(call))
        finally:
            call.local = None
            await call.close()
    asyncio.run(scenario())


def test_silent_tool_call_is_described_by_what_actually_happened():
    """The local model often draws a box and says nothing at all.

    Substituting "I could not answer that" was wrong: the rectangle was on the
    page. These assertions pin the honest wording for each outcome.
    """
    from backend.server import _describe_tool_results

    drawn = {"ok": True, "result": "Highlight rendered on current webpage"}
    cleared = {"ok": True, "reason": "Highlight cleared"}
    rejected = {"ok": False, "reason": "The page changed"}

    assert _describe_tool_results([drawn]) == "I put a box around it."
    assert _describe_tool_results([cleared]) == "I cleared the box."
    assert _describe_tool_results([drawn, cleared]) == "I cleared the previous box."
    # A refusal must still say so rather than claiming a box was drawn.
    assert "I could not highlight that" in _describe_tool_results([rejected])
    assert "The page changed" in _describe_tool_results([rejected])
    # Nothing at all is the only case that may say it could not answer.
    assert _describe_tool_results([]) == "I could not answer that."


def test_local_turn_speaks_the_real_outcome_when_the_model_is_silent():
    """A box was drawn, so the spoken reply must not claim otherwise."""
    async def scenario():
        from types import SimpleNamespace
        from backend.local_model import LocalTurn
        call = make_call()

        async def fake_ask(question, jpeg):
            return LocalTurn("", [                      # no text at all
                {"id": "t1", "name": "highlight_region",
                 "arguments": {"label": "Upload", "box_2d": [171, 31, 205, 122]}}])

        async def confirmed(kind, box=None, label="", view=None, image=None):
            return OverlayResult(type="overlay_result", id="render-ok", ok=True)

        call.local = SimpleNamespace(ask=fake_ask, last_latency_ms=900)
        call._request_overlay = confirmed
        call._invalidate = lambda view=None: None
        source = frame()
        call.grounding.accept_frame(source)
        call.grounding.mark_sent(source)
        call.last_image_at = 0.0
        try:
            await call._local_turn("put a box anywhere", call.grounding.generation)
            spoken = [m.get("speak") for m in statuses(call) if m.get("speak")]
            assert spoken, "a reply must be spoken"
            assert spoken[-1] == "I put a box around it."
            assert "could not answer" not in spoken[-1]
        finally:
            call.local = None
            await call.close()
    asyncio.run(scenario())


def test_keep_alive_is_passed_to_ollama_and_optional(monkeypatch):
    """A 17 GB model unloads after 5 min idle; the reload costs ~20 s."""
    from backend.local_model import LocalAdapter

    captured = {}

    class FakeResponse:
        def raise_for_status(self): pass
        def json(self): return {"message": {"content": "ok", "tool_calls": []}}

    class FakeClient:
        def __init__(self, *a, **kw): pass
        async def post(self, url, json=None):
            captured.clear()                 # each call is inspected on its own
            captured.update(json or {})
            return FakeResponse()

    monkeypatch.setattr("backend.local_model.httpx.AsyncClient", FakeClient)

    async def scenario():
        with_keep = LocalAdapter("http://h", "m", keep_alive="30m")
        await with_keep.ask("hi", b"jpeg")
        assert captured.get("keep_alive") == "30m"
        # Omitted entirely when unset, so Ollama's own default applies.
        without = LocalAdapter("http://h", "m")
        await without.ask("hi", b"jpeg")
        assert "keep_alive" not in captured
    asyncio.run(scenario())


def _parse_keep_alive(raw: str) -> str | int | None:
    """Accept Ollama duration syntax ("30m", "2h") or bare seconds.

    Empty or "0" means "don't send keep_alive", leaving Ollama's own default.
    """
    raw = raw.strip()
    if not raw or raw == "0":
        return None
    return int(raw) if raw.isdigit() else raw


def test_keep_alive_parsing_accepts_ollama_syntax():
    from backend.run import _parse_keep_alive

    assert _parse_keep_alive("30m") == "30m"
    assert _parse_keep_alive("2h") == "2h"
    assert _parse_keep_alive("-1") == "-1"          # Ollama's "keep forever"
    assert _parse_keep_alive("600") == 600          # bare seconds
    assert _parse_keep_alive(" 30m ") == "30m"      # whitespace tolerated
    # Unset or zero must not be forwarded at all.
    assert _parse_keep_alive("") is None
    assert _parse_keep_alive("   ") is None
    assert _parse_keep_alive("0") is None


def test_main_boots_for_every_keep_alive_form(monkeypatch):
    from backend import run as run_module

    booted = []
    monkeypatch.setenv("MODEL_BACKEND", "local")
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setattr(run_module.uvicorn, "run", lambda app, **kw: booted.append(app))

    for raw in ("30m", "2h", "600", "0", ""):
        monkeypatch.setenv("OLLAMA_KEEP_ALIVE", raw)
        run_module.main()                    # must not raise
    assert len(booted) == 5


def test_local_path_never_streams_images_or_audio_on_a_timer():
    """Local is one image per question, so the Gemini frame/audio loops are off."""
    from backend.server import Call as RealCall

    call = make_call()
    assert call.settings.is_local
    # _image_loop and _status_loop return immediately for the local provider.
    assert asyncio.run(call._image_loop()) is None
    call.ended = True                      # stop _status_loop without waiting 2s
    assert asyncio.run(call._status_loop()) is None
