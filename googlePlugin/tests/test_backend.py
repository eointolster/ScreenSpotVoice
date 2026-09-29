import asyncio
import math
import time
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from PIL import Image

from backend.audio import ReturnAudio
from backend.gemini import GeminiAdapter, tool_config
from backend.grounding import Frame, Grounding, inside_box_distance, outside_box_distance
from backend.protocol import Hello, HighlightArgs, OverlayResult, SimpleEvent, View, check_origin, parse_event
from backend.video_geometry import align_tab_frame


def view(revision=0):
    return View(documentId="document-123456", revision=revision, width=1280, height=720, dpr=1.0, zoom=1.0)


def frame(received=None, signature=None):
    return Frame(b"jpeg", 1024, 576, signature or bytes([40] * 576), received or time.monotonic())


def test_highlight_schema_and_protocol():
    assert HighlightArgs.model_validate({"label": "Upload", "box_2d": [100, 100, 300, 300]}).box_2d == [100.0, 100.0, 300.0, 300.0]
    for box in [[0, 0, 0, 20], [0, 0, math.nan, 20], [-1, 0, 20, 20],
                [900, 200, 100, 300], [0, 0, 1000, 1000], [1, 2, 3]]:
        with pytest.raises(ValidationError):
            HighlightArgs(label="Bad", box_2d=box)
    with pytest.raises(ValidationError):
        parse_event({"type": "text", "text": "Hi", "extra": "forbidden"})
    with pytest.raises(ValueError):
        parse_event({"type": "execute_script", "code": "alert(1)"})
    assert check_origin("chrome-extension://" + "a" * 32)
    assert not check_origin("https://example.org")
    assert not check_origin("chrome-extension://" + "a" * 32, "b" * 32)
    assert check_origin("chrome-extension://" + "a" * 32, "a" * 32)


def test_stale_revisions_and_clean_frame_gate():
    g = Grounding("source-1", view())
    first = frame()
    g.accept_frame(first)
    sent = g.mark_sent(first)
    assert g.valid_stamp(sent)[0]
    g.invalidate(view(1))
    assert not g.valid_stamp(sent)[0]
    assert g.ready_frame() is None
    assert g.frame_gate_reason() == "waiting for clear acknowledgment"
    g.cleared()
    assert g.ready_frame() is None
    assert g.frame_gate_reason() == "waiting for clean frame"
    g.clean_after = time.monotonic() - 0.01
    old = frame(time.monotonic() - 1)
    g.accept_frame(old)
    assert g.ready_frame() is None
    fresh = frame()
    g.accept_frame(fresh)
    assert g.ready_frame() is fresh
    assert g.frame_gate_reason() == "ready"
    g.view = View(documentId="document-123456", revision=1, width=900, height=720, dpr=1.0, zoom=1.0)
    assert g.frame_gate_reason() == "ready"
    assert not g.coordinate_fit()
    mismatch_stamp = g.mark_sent(fresh)
    assert g.valid_stamp(mismatch_stamp)[0] is False
    g.view = view(1)
    current = g.mark_sent(fresh)
    g.accept_frame(frame(signature=bytes([250] * 576)))
    assert g.valid_stamp(current)[0] is False
    g.invalidate()
    assert not g.valid_stamp(current)[0]


def test_audio_jitter_buffer_preserves_bursty_chunks():
    async def scenario():
        audio = ReturnAudio()
        sample = (1000).to_bytes(2, "little", signed=True)
        audio.push(sample * 480, audio.generation)
        first = await audio.recv()
        assert bytes(first.planes[0])[:2] == b"\0\0"
        audio.push(sample * 480 * 99, audio.generation)
        assert audio.queue.qsize() == 100
        assert audio.dropped == 0
        second = await audio.recv()
        assert bytes(second.planes[0])[:2] == sample
    asyncio.run(scenario())


def test_audio_cancellation_clears_bounded_queue():
    a = ReturnAudio()
    for _ in range(70):
        a.push(b"\1\0" * 480, a.generation)
    assert a.queue.qsize() == 70
    assert a.dropped == 0
    for _ in range(400):
        a.push(b"\1\0" * 480, a.generation)
    assert a.queue.qsize() == a.MAX_BUFFER_FRAMES
    assert a.dropped == 70
    old = a.generation
    a.clear()
    assert a.queue.empty()
    a.push(b"\1\0" * 480, old)
    assert a.queue.empty()
    a.push(b"\2\0" * 480, a.generation)
    assert a.queue.qsize() == 1


def test_json_tool_box_reaches_render_ack():
    async def scenario():
        from backend.server import Call, Settings
        class Socket:
            def __init__(self): self.messages = []
            async def send_json(self, data): self.messages.append(data)
            async def close(self): pass
        socket = Socket()
        hello = Hello(type="hello", token="a" * 24, session_id="session-test",
                      source_id="source-test", view=view())
        call = Call(socket, hello, Settings())
        source_frame = frame()
        call.grounding.accept_frame(source_frame)
        call.grounding.mark_sent(source_frame)
        async def confirmed(*args, **kwargs):
            return OverlayResult(type="overlay_result", id="render-test", ok=True)
        call._request_overlay = confirmed
        try:
            result = await call._on_tool("highlight_region", {"label": "Upload", "box_2d": [100, 100, 300, 300]})
            assert result["ok"]
            assert call.grounding.overlay_visible
            assert call.grounding.overlay_box == (100.0, 100.0, 300.0, 300.0)
            call.audio_out.push(b"\1\0" * 480 * 6, call.audio_out.generation)
            generation = call.audio_out.generation
            await call.handle(SimpleEvent(type="turn_start"))
            assert call.audio_out.generation == generation
            assert call.grounding.overlay_visible
            await call._on_interrupt()
            assert call.audio_out.generation == generation + 1
            assert not call.grounding.overlay_visible
        finally:
            await call.close()
    asyncio.run(scenario())


def test_gemini_adapter_events_with_labelled_mock():
    asyncio.run(gemini_adapter_events())


async def gemini_adapter_events():
    from google.genai import types
    config = types.LiveConnectConfig(response_modalities=["AUDIO"], tools=tool_config())
    assert config.tools
    seen = []
    class MockLive:
        async def send_tool_response(self, **kwargs):
            seen.append(("tool_response", kwargs["function_responses"].response))
    async def interrupt(): seen.append(("interrupted", None))
    async def start(): seen.append(("response_start", None))
    async def transcript(text): seen.append(("transcript", text))
    async def tool(name, args):
        seen.append(("tool", (name, args)))
        return {"ok": True}
    adapter = GeminiAdapter("MOCK_KEY_NOT_USED", "MOCK_MODEL", lambda b: seen.append(("audio", b)),
                            interrupt, start, transcript, tool)
    adapter.live = MockLive()
    part = SimpleNamespace(inline_data=SimpleNamespace(data=b"audio"))
    content = SimpleNamespace(interrupted=False, input_transcription=None,
                              output_transcription=SimpleNamespace(text="There"), model_turn=SimpleNamespace(parts=[part]),
                              turn_complete=False)
    await adapter.handle_message(SimpleNamespace(server_content=content, tool_call=None, tool_call_cancellation=None))
    assert ("response_start", None) in seen and ("audio", b"audio") in seen
    call = SimpleNamespace(name="highlight_region", id="call-1", args={"label": "Upload", "box_2d": [1, 2, 100, 200]})
    await adapter.handle_message(SimpleNamespace(server_content=None,
        tool_call=SimpleNamespace(function_calls=[call]), tool_call_cancellation=None))
    assert ("tool_response", {"ok": True}) in seen
    content.interrupted = True
    content.model_turn = None
    await adapter.handle_message(SimpleNamespace(server_content=content, tool_call=None, tool_call_cancellation=None))
    assert ("interrupted", None) in seen



def test_visual_change_detector_ignores_our_box_but_sees_other_changes():
    clean = bytes([40] * (32 * 18))
    changed_inside = bytearray(clean)
    changed_inside[9 * 32 + 16] = 250
    changed_outside = bytearray(clean)
    for y in range(18):
        for x in range(6):
            changed_outside[y * 32 + x] = 230
    box = (250.0, 250.0, 750.0, 750.0)
    assert outside_box_distance(clean, bytes(changed_inside), box) == 0
    assert outside_box_distance(clean, bytes(changed_outside), box) > 22



def test_dynamic_content_outside_target_does_not_stale_box():
    g = Grounding("source-1", view())
    original = frame(signature=bytes([40] * 576))
    g.accept_frame(original)
    stamp = g.mark_sent(original)
    changed = bytearray(original.signature)
    for y in range(18):
        for x in range(12):
            changed[y * 32 + x] = 230
    g.accept_frame(frame(signature=bytes(changed)))
    target = [300.0, 600.0, 700.0, 900.0]
    assert inside_box_distance(original.signature, bytes(changed), target) == 0
    assert g.valid_stamp(stamp, target)[0]
    assert not g.valid_stamp(stamp)[0]
    for y in range(7, 11):
        for x in range(22, 26):
            changed[y * 32 + x] = 230
    g.accept_frame(frame(signature=bytes(changed)))
    assert not g.valid_stamp(stamp, target)[0]


def test_gemini_adapter_keeps_receiving_after_first_completed_turn(monkeypatch):
    from contextlib import asynccontextmanager
    from backend import gemini as module

    seen = []
    class MockSession:
        def __init__(self): self.calls = 0
        def receive(self):
            self.calls += 1
            if self.calls > 2:
                raise RuntimeError("MOCK_SESSION_ENDED")
            async def one_turn():
                yield SimpleNamespace(server_content=SimpleNamespace(
                    interrupted=False, input_transcription=None, output_transcription=None,
                    model_turn=None, turn_complete=True), tool_call=None, tool_call_cancellation=None,
                    go_away=None)
            return one_turn()
    mock_session = MockSession()
    @asynccontextmanager
    async def connect(**kwargs):
        seen.append(kwargs["model"])
        yield mock_session
    class MockClient:
        def __init__(self):
            self.aio = SimpleNamespace(live=SimpleNamespace(connect=connect))
    monkeypatch.setattr(module.genai, "Client", lambda api_key: MockClient())
    async def nop(*args): pass
    adapter = module.GeminiAdapter("MOCK_KEY_NOT_USED", "MOCK_MODEL", lambda _: None,
                                   nop, nop, nop, lambda name, args: nop())
    with pytest.raises(RuntimeError, match="MOCK_SESSION_ENDED"):
        asyncio.run(adapter.run())
    assert mock_session.calls == 3
    assert seen == ["MOCK_MODEL"]


def test_tab_capture_side_bars_are_removed_before_grounding():
    page = View(documentId="document-123456", revision=0, width=1454, height=1028, dpr=1.0, zoom=1.0)
    raw = Image.new("RGB", (3440, 1440), "black")
    content_width = round(raw.height * page.width / page.height)
    left = (raw.width - content_width) // 2
    raw.paste(Image.new("RGB", (content_width, raw.height), (230, 220, 200)), (left, 0))
    aligned, mapping = align_tab_frame(raw, page)
    assert mapping == "cropped side capture bars"
    assert aligned.size == (content_width, 1440)
    assert aligned.getpixel((0, 0)) == (230, 220, 200)
    grounding = Grounding("source-1", page)
    grounding.accept_frame(Frame(b"jpeg", aligned.width, aligned.height, bytes([40] * 576), time.monotonic()))
    assert grounding.coordinate_fit()


def test_tab_capture_top_bars_are_removed_but_dark_page_is_not_guessed():
    page = View(documentId="document-123456", revision=0, width=1454, height=1028, dpr=1.0, zoom=1.0)
    raw = Image.new("RGB", (1454, 1454), "black")
    raw.paste(Image.new("RGB", (1454, 1028), (30, 30, 30)), (0, 213))
    aligned, mapping = align_tab_frame(raw, page)
    assert mapping == "cropped top/bottom capture bars"
    assert aligned.size == (1454, 1028)
    assert align_tab_frame(Image.new("RGB", (3440, 1440), (8, 8, 8)), page)[1] == "unresolved aspect mismatch"
    direct = Image.new("RGB", (1454, 1028), (8, 8, 8))
    assert align_tab_frame(direct, page) == (direct, "direct")
