from __future__ import annotations

import asyncio
import io
from collections import deque
import os
import secrets
from dataclasses import dataclass
from time import monotonic
from typing import Any

from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp
from av import AudioResampler
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from google.genai import types
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .audio import ReturnAudio
from .gemini import GeminiAdapter
from .grounding import Frame, Grounding, outside_box_distance
from .local_model import LocalAdapter, LocalModelError
from .protocol import ClearArgs, Hello, HighlightArgs, OverlayResult, View, check_origin, parse_event
from .video_geometry import align_tab_frame


def _describe_tool_results(results: list[dict[str, Any]]) -> str:
    """Say what actually happened when the model returned a tool call and no words.

    The local model often calls highlight_region and then emit no text at all.
    Substituting a generic "I could not answer that" was both wrong and, spoken
    aloud, actively confusing: the rectangle was on the page while the reply
    claimed nothing had been found. Describe the real outcome instead.
    """
    if not results:
        return "I could not answer that."
    highlighted = any(r.get("ok") and r.get("result") for r in results)
    cleared = any(r.get("ok") and r.get("reason") == "Highlight cleared" for r in results)
    if highlighted and cleared:
        return "I cleared the previous box."
    if highlighted:
        return "I put a box around it."
    if cleared:
        return "I cleared the box."
    reason = next((r.get("reason") for r in results if r.get("reason")), "")
    return f"I could not highlight that. {reason}".strip()


@dataclass
class Settings:
    key: str = ""
    model: str = "gemini-2.5-flash-native-audio-preview-12-2025"
    image_fps: float = 0.8
    allowed_extension_id: str | None = None
    # "gemini" (default, unchanged behaviour) or "local" (Ollama vision+tools).
    backend: str = "gemini"
    local_host: str = "http://127.0.0.1:11434"
    local_model: str = "qwen3.8:27b"
    # How long Ollama keeps the model resident; None uses Ollama's own default.
    local_keep_alive: str | int | None = None
    # File the panel's choice is written to, so it survives a restart.
    choice_path: str | None = None

    def save_choice(self) -> None:
        """Remember the panel's choice for the next run.

        A best-effort convenience: a read-only or missing directory must not stop
        the backend from serving, so failures are ignored rather than raised.
        """
        if not self.choice_path:
            return
        try:
            with open(self.choice_path, "w", encoding="utf-8") as handle:
                handle.write(self.backend)
        except OSError:
            pass

    def remember_choice(self, provider: str) -> None:
        self.backend = provider
        self.save_choice()

    @property
    def is_local(self) -> bool:
        return self.backend == "local"

    def provider_label(self) -> str:
        return f"local:{self.local_model}" if self.is_local else self.model

    def mode_label(self) -> str:
        """Calibration means "no live provider", exactly as before for Gemini."""
        if self.is_local:
            return "local"
        return "live" if self.key else "calibration"

    def provider_status(self) -> dict[str, dict[str, object]]:
        """Which providers can actually answer right now, and why not if not.

        Reported to the side panel so it can show an honest choice instead of
        letting someone pick Gemini with no key and wonder why nothing replies.
        Reports availability only: never the key itself, and never any other
        secret, so it is safe on an unauthenticated loopback endpoint.
        """
        return {
            "gemini": {
                "label": "Gemini Live",
                "available": bool(self.key),
                "detail": "Live duplex voice." if self.key else "No GEMINI_API_KEY set in googlePlugin/.env.",
            },
            "local": {
                "label": f"Local model ({self.local_model})",
                "available": True,
                "detail": f"Vision and tools on your own machine via {self.local_host}. "
                          "Chrome transcribes the microphone.",
            },
        }


class Call:
    def __init__(self, ws: WebSocket, hello: Hello, settings: Settings):
        self.ws, self.hello, self.settings = ws, hello, settings
        self.send_lock = asyncio.Lock()
        self.pc = RTCPeerConnection()
        self.audio_out = ReturnAudio()
        self.grounding = Grounding(hello.source_id, hello.view)
        self.adapter: GeminiAdapter | None = None
        self.local: LocalAdapter | None = None
        self.provider_dead = False
        self.tasks: set[asyncio.Task] = set()
        self.pending: dict[str, asyncio.Future[OverlayResult]] = {}
        self.paused = False
        self.muted = False
        self.ended = False
        self.last_image_at = 0.0
        self.last_receive_video_at = 0.0
        self.decoded_video_size = 'none'
        self.video_mapping = 'waiting for tab video'
        self.image_times: deque[float] = deque(maxlen=20)
        self.first_audio_after_speech_ms: int | None = None
        self.last_user_start_at = 0.0
        self.video_frames = 0
        self.audio_frames = 0
        self.image_count = 0
        self.audio_chunks = 0
        self.local_turn_starts = 0
        self.last_grounding = "none"
        self.pc.on("track", self._on_track)
        self.pc.on("connectionstatechange", self._on_connection_state)

    def spawn(self, coro):
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def send(self, data: dict[str, Any]):
        if not self.ended:
            async with self.send_lock:
                await self.ws.send_json(data)

    async def status(self, status: str, detail: str = "", text: str = "", speak: str = "",
                     local_latency_ms: int | None = None):
        frame = self.grounding.latest
        diagnostics = {"rtc": self.pc.connectionState, "receivedAudioFrames": self.audio_frames,
                       "receivedVideoFrames": self.video_frames, "sentGeminiImages": self.image_count,
                       "screenReady": bool(self.grounding.last_sent and self.grounding.coordinate_fit()),
                       "geminiImageFpsLimit": self.settings.image_fps, "returnAudioChunks": self.audio_chunks,
                       "returnQueueDepth": self.audio_out.queue.qsize(), "returnDroppedChunks": self.audio_out.dropped,
                       "decodedVideoSize": self.decoded_video_size, "videoMapping": self.video_mapping,
                       "geminiImageSize": f"{frame.width}×{frame.height}" if frame else "none",
                       "viewportSize": f"{self.grounding.view.width}×{self.grounding.view.height}",
                       "coordinateFit": self.grounding.coordinate_fit(),
                       "frameGate": self.grounding.frame_gate_reason(),
                       "localTurnStarts": self.local_turn_starts,
                       "geminiImageRateLast10s": round(sum(t >= monotonic() - 10 for t in self.image_times) / 10, 2),
                       "firstGeminiAudioAfterSpeechEstimateMs": self.first_audio_after_speech_ms,
                       "grounding": self.last_grounding,
                       "lastFrameReceivedSecondsAgo": round(monotonic() - frame.received_at, 2) if frame else None}
        await self.send({"type": "status", "status": status, "detail": detail, "text": text,
                         "diagnostics": diagnostics, **({"speak": speak} if speak else {}),
                         **({"localLatencyMs": local_latency_ms} if local_latency_ms is not None else {})})

    def _on_track(self, track):
        if track.kind == "audio": self.spawn(self._audio_loop(track))
        elif track.kind == "video": self.spawn(self._video_loop(track))

    def _on_connection_state(self):
        if self.pc.connectionState in ("failed", "closed") and not self.ended:
            self.spawn(self.status("Disconnected", "WebRTC connection ended. End and restart the session."))

    async def _audio_loop(self, track):
        # Local path: Chrome transcribes the microphone, so no audio track is
        # ever sent here. Drain and discard so a stray track cannot stall RTP.
        if self.settings.is_local:
            try:
                while not self.ended:
                    await track.recv()
            except (asyncio.CancelledError, Exception):
                pass
            return
        resampler = AudioResampler(format="s16", layout="mono", rate=16000)
        try:
            while not self.ended:
                frame = await track.recv()
                self.audio_frames += 1
                if self.paused or self.muted or not self.adapter or not self.grounding.last_sent or not self.grounding.coordinate_fit():
                    continue
                for converted in resampler.resample(frame):
                    pcm = bytes(converted.planes[0])[:converted.samples * 2]
                    if pcm:
                        await self.adapter.send_audio(pcm)
        except (asyncio.CancelledError, Exception) as error:
            if not isinstance(error, asyncio.CancelledError) and not self.ended:
                await self.status("Disconnected", "Microphone media stopped.")

    async def _video_loop(self, track):
        try:
            while not self.ended:
                av_frame = await track.recv()
                self.video_frames += 1
                now = monotonic()
                if self.paused or now - self.last_receive_video_at < 0.11:
                    continue
                self.last_receive_video_at = now
                self.decoded_video_size = f'{av_frame.width}×{av_frame.height}'
                image, self.video_mapping = align_tab_frame(av_frame.to_image(), self.grounding.view)
                if image.width > 1024:
                    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
                signature = image.convert("L").resize((32, 18), Image.Resampling.BILINEAR).tobytes()
                output = io.BytesIO(); image.save(output, format="JPEG", quality=75)
                latest = Frame(output.getvalue(), image.width, image.height, signature, monotonic())
                self.grounding.accept_frame(latest)
                stamp = self.grounding.last_sent
                box = self.grounding.overlay_box
                if self.grounding.overlay_visible and stamp and box and outside_box_distance(stamp.frame.signature, latest.signature, box) > 22:
                    self.last_grounding = "visual change outside highlight"
                    self._invalidate()
                    await self.status("Listening", "Visible page changed; highlight cleared.")
        except (asyncio.CancelledError, Exception) as error:
            if not isinstance(error, asyncio.CancelledError) and not self.ended:
                await self.status("Disconnected", "Tab video stopped.")

    async def _image_loop(self):
        # The local path is one image per question, not a continuous feed, so
        # only the Gemini provider streams frames on a timer.
        if self.settings.is_local:
            return
        while not self.ended:
            await asyncio.sleep(0.08)
            if self.paused or not self.adapter or not self.adapter.live:
                continue
            now = monotonic()
            if now - self.last_image_at < 1 / self.settings.image_fps:
                continue
            frame = self.grounding.ready_frame(now)
            if not frame or frame.received_at <= self.last_image_at or not self.grounding.coordinate_fit(frame):
                continue
            try:
                await self.adapter.send_video(frame.jpeg)
            except Exception as error:
                await self.status("Error", f"Gemini video send failed: {type(error).__name__}")
                continue
            self.grounding.mark_sent(frame)
            self.last_image_at = monotonic()
            self.image_count += 1
            self.image_times.append(self.last_image_at)

    async def _status_loop(self):
        while not self.ended:
            await asyncio.sleep(2)
            if self.provider_dead or self.settings.is_local:
                continue
            if self.grounding.latest and not self.grounding.coordinate_fit() and not self.paused:
                await self.status("Aligning", "Captured tab dimensions do not match the webpage. Highlights and microphone forwarding are waiting for aligned video.")
            elif self.settings.key and self.adapter and self.adapter.live and not self.grounding.last_sent and not self.paused:
                await self.status("Connecting", "Waiting for a clean tab image before forwarding microphone audio.")
            else:
                await self.status("Paused" if self.paused else "Ready" if not self.settings.key else "Connecting" if not self.adapter or not self.adapter.live else "Responding" if self.adapter.responding else "Listening")

    async def _run_adapter(self):
        if self.settings.is_local:
            self.local = LocalAdapter(self.settings.local_host, self.settings.local_model,
                                     keep_alive=self.settings.local_keep_alive)
            reachable, detail = await self.local.health()
            if not reachable:
                self.provider_dead = True
                await self.status("Error", f"Local model unavailable: {detail}")
                return
            await self.local.start()
            await self.status("Ready", f"Local model {self.settings.local_model} ready. "
                                        "Microphone audio is transcribed by Chrome; screenshots stay on this machine.")
            return
        if not self.settings.key:
            await self.status("Ready", "No API key: transport and overlay calibration only.")
            return
        self.adapter = GeminiAdapter(self.settings.key, self.settings.model, self._on_audio, self._on_interrupt,
                                     self._on_response_start, self._on_transcript, self._on_tool)
        try:
            await self.adapter.run()
            if not self.ended:
                self.provider_dead = True
                await self.status("Disconnected", "Gemini Live session ended. End and restart; no automatic paid reconnect.")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self.ended:
                self.provider_dead = True
                await self.status("Error", f"Gemini Live failed: {type(error).__name__}. Check the API key, model, quota, and backend terminal.")

    def _on_audio(self, data: bytes):
        if not self.paused:
            self.audio_out.push(data, self.audio_out.generation)
            self.audio_chunks += 1

    async def _on_interrupt(self):
        self.audio_out.clear()
        if not self.grounding.clear_pending:
            self._invalidate()
        await self.send({"type": "interrupted"})
        self.last_grounding = "response interrupted"

    async def _on_response_start(self):
        if self.paused: return
        latency = round((monotonic() - self.last_user_start_at) * 1000) if self.last_user_start_at else None
        self.first_audio_after_speech_ms = latency
        await self.send({"type": "response_start"})
        await self.status("Responding", f"First Gemini audio received {latency} ms after local speech-start estimate." if latency else "First Gemini audio received.")

    async def _on_transcript(self, text: str):
        if text.startswith("You:") and self.grounding.overlay_visible and not self.grounding.clear_pending:
            self._invalidate()
        await self.status("Responding" if text.startswith("Gemini") else "Listening", text=text[:500])

    async def _request_overlay(self, kind: str, box=None, label="", view: View | None = None, image: Frame | None = None) -> OverlayResult:
        request_id = secrets.token_hex(16)
        future: asyncio.Future[OverlayResult] = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        message = {"type": "overlay", "id": request_id, "kind": kind}
        if box is not None:
            message.update(box=list(box), label=label, view=view.model_dump() if view else None,
                           image={"width": image.width, "height": image.height} if image else None)
        await self.send(message)
        try:
            return await asyncio.wait_for(future, 1.8)
        except asyncio.TimeoutError:
            return OverlayResult(type="overlay_result", id=request_id, ok=False, reason="Extension did not confirm rendering")
        finally:
            self.pending.pop(request_id, None)

    async def _clear_for_clean_frame(self, generation: int):
        result = await self._request_overlay("CLEAR")
        if result.ok and not self.ended and generation == self.grounding.generation:
            self.grounding.cleared()
            self.last_grounding = "waiting for clean frame"
        elif generation == self.grounding.generation:
            self.last_grounding = f"clear failed: {result.reason}"

    def _invalidate(self, view: View | None = None):
        self.grounding.invalidate(view)
        self.spawn(self._clear_for_clean_frame(self.grounding.generation))

    async def _on_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if self.ended or self.paused:
            return {"ok": False, "reason": "Session paused or ended"}
        if name == "clear_highlights":
            try: ClearArgs.model_validate(arguments)
            except ValidationError as error: return {"ok": False, "reason": str(error)[:160]}
            self.grounding.invalidate()
            generation = self.grounding.generation
            result = await self._request_overlay("CLEAR")
            if result.ok and generation == self.grounding.generation:
                self.grounding.cleared()
                return {"ok": True, "reason": "Highlight cleared"}
            return {"ok": False, "reason": result.reason or "Clear was superseded"}
        if name != "highlight_region":
            return {"ok": False, "reason": "Unknown tool"}
        try: args = HighlightArgs.model_validate(arguments)
        except ValidationError as error: return {"ok": False, "reason": str(error)[:160]}
        stamp = self.grounding.last_sent
        valid, reason = self.grounding.valid_stamp(stamp, args.box_2d)
        if not valid or stamp is None:
            self.last_grounding = f"rejected: {reason}"
            return {"ok": False, "reason": reason + ". Ask for a fresh view."}
        result = await self._request_overlay("SHOW", args.box_2d, args.label, stamp.view, stamp.frame)
        if not result.ok or stamp.generation != self.grounding.generation or stamp.view != self.grounding.view:
            self.last_grounding = f"render rejected: {result.reason or 'view changed'}"
            if result.ok: self.spawn(self._clear_for_clean_frame(self.grounding.generation))
            return {"ok": False, "reason": self.last_grounding}
        self.grounding.overlay_visible = True
        self.grounding.overlay_box = tuple(args.box_2d)
        self.last_grounding = f"rendered: {args.label}"
        await self.status("Responding", "Highlight confirmed on current webpage.")
        return {"ok": True, "result": "Highlight rendered on current webpage"}

    async def handle(self, event):
        if event.type == "offer":
            await self.pc.setRemoteDescription(RTCSessionDescription(sdp=event.sdp, type="offer"))
            self.pc.addTrack(self.audio_out)
            answer = await self.pc.createAnswer()
            await self.pc.setLocalDescription(answer)
            await self.send({"type": "answer", "sdp": self.pc.localDescription.sdp})
            self.spawn(self._run_adapter())
            self.spawn(self._image_loop())
            self.spawn(self._status_loop())
        elif event.type == "ice":
            data = event.candidate
            if isinstance(data.get("candidate"), str) and data["candidate"].startswith("candidate:"):
                candidate = candidate_from_sdp(data["candidate"].split(":", 1)[1])
                candidate.sdpMid = data.get("sdpMid")
                candidate.sdpMLineIndex = data.get("sdpMLineIndex")
                await self.pc.addIceCandidate(candidate)
        elif event.type == "overlay_result":
            future = self.pending.get(event.id)
            if future and not future.done(): future.set_result(event)
        elif event.type == "pause":
            self.paused = True; self.audio_out.clear(); self._invalidate()
            if self.adapter: await self.adapter.audio_stream_end()
            await self.send({"type": "interrupted"})
            await self.status("Paused", "Outgoing media is withheld.")
        elif event.type == "resume":
            self.paused = False; self._invalidate(event.view)
            await self.status("Listening", "Waiting for a fresh frame.")
        elif event.type == "view":
            self._invalidate(event.view)
            await self.status("Listening" if not self.paused else "Paused", "View changed; old grounding invalidated.")
        elif event.type == "turn_start":
            # Mic energy may be speaker echo. Use it for approximate latency only;
            # Gemini's confirmed VAD interruption handles audio cancellation.
            self.local_turn_starts += 1
            self.last_user_start_at = monotonic()
        elif event.type == "clear":
            self._invalidate()
        elif event.type == "text":
            self._invalidate()
            generation = self.grounding.generation
            if self.settings.is_local:
                self.spawn(self._local_turn(event.text, generation))
            else:
                self.spawn(self._text_after_image(event.text, generation))
        elif event.type == "mute":
            self.muted = event.muted
            if event.muted and self.adapter: await self.adapter.audio_stream_end()
        elif event.type == "end":
            self.ended = True

    async def _text_after_image(self, text: str, generation: int):
        for _ in range(35):
            await asyncio.sleep(0.1)
            stamp = self.grounding.last_sent
            if stamp and stamp.generation == generation and self.adapter:
                await self.adapter.send_text(text)
                return
        await self.status("Error", "No clean screen frame was available for typed request.")

    async def _local_turn(self, question: str, generation: int):
        """Answer one transcribed question with one clean frame, then speak.

        The local path is request/response rather than a duplex socket, so this
        replaces Gemini's streaming send_text/send_video with a single call.
        Tool calls go through the same _on_tool validator and the same overlay
        acknowledgement as the Gemini path; only the transport differs.
        """
        frame = self.grounding.ready_frame()
        if not frame or frame.received_at <= self.last_image_at or not self.grounding.coordinate_fit(frame):
            await self.status("Aligning", "Waiting for a clean aligned frame before answering.")
            for _ in range(30):
                await asyncio.sleep(0.1)
                frame = self.grounding.ready_frame()
                if frame and frame.received_at > self.last_image_at and self.grounding.coordinate_fit(frame):
                    break
            else:
                await self.status("Error", "No clean screen frame was available for that request.")
                return
        if self.ended or generation != self.grounding.generation:
            return
        # This frame is what the answer refers to, so it must count as sent.
        self.grounding.mark_sent(frame)
        self.last_image_at = monotonic()
        self.image_count += 1
        self.image_times.append(self.last_image_at)
        assert self.local is not None
        await self.status("Responding", "Asking the local model…")
        try:
            turn = await self.local.ask(question, frame.jpeg)
        except LocalModelError as error:
            await self.status("Error", f"Local model failed: {error}")
            return
        if self.ended or generation != self.grounding.generation:
            return
        results = [await self._on_tool(call["name"], call["arguments"]) for call in turn.tool_calls]
        reply = turn.text or _describe_tool_results(results)
        await self.status("Responding", text=reply[:500],
                          speak=reply[:400],
                          local_latency_ms=self.local.last_latency_ms)

    async def run(self):
        try:
            while not self.ended:
                raw = await self.ws.receive_json()
                try: event = parse_event(raw)
                except (ValidationError, ValueError):
                    await self.send({"type": "status", "status": "Error", "detail": "Invalid local control message"})
                    continue
                await self.handle(event)
        except WebSocketDisconnect:
            pass
        finally:
            await self.close()

    async def close(self):
        self.ended = True
        self.audio_out.clear()
        if self.local is not None:
            await self.local.close()
        for future in self.pending.values():
            if not future.done(): future.cancel()
        for task in list(self.tasks): task.cancel()
        if self.tasks: await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.pc.close()
        try: await self.ws.close()
        except RuntimeError: pass


class ProviderChoice(BaseModel):
    """A request to change which provider the *next* session will use.

    Validated rather than trusted: a client asking for Gemini without a key is
    rejected, so the panel cannot put the backend into a state that silently
    never answers.
    """
    model_config = ConfigDict(extra="forbid", strict=True)
    provider: str = Field(min_length=3, max_length=16)
    token: str = Field(min_length=16, max_length=256)


def create_app(settings: Settings, pairing_token: str) -> FastAPI:
    app = FastAPI(title="ScreenSpot Voice local backend", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.owner = None
    app.state.bound_extension_id = settings.allowed_extension_id

    @app.get("/health")
    async def health():
        return {"ok": True, "mode": settings.mode_label(), "model": settings.provider_label(),
                "selected": settings.backend, "providers": settings.provider_status()}

    @app.post("/provider")
    async def choose_provider(choice: ProviderChoice):
        """Choose the provider for subsequent sessions.

        Deliberately cannot switch the provider of a live session: the two paths
        differ in whether microphone audio crosses the wire, so changing it
        mid-call would leak or drop audio without either side asking. The panel
        is told to end the session first.
        """
        if not secrets.compare_digest(choice.token, pairing_token):
            raise HTTPException(status_code=403, detail="Incorrect pairing code.")
        provider = choice.provider.strip().lower()
        if provider not in ("gemini", "local"):
            raise HTTPException(status_code=422, detail="Provider must be 'gemini' or 'local'.")
        if app.state.owner is not None:
            raise HTTPException(status_code=409, detail="End the current session before switching provider.")
        status = settings.provider_status()[provider]
        if not status["available"]:
            # This is the case the button must refuse: Gemini with no key.
            raise HTTPException(status_code=409, detail=str(status["detail"]))
        settings.remember_choice(provider)
        return {"ok": True, "selected": settings.backend, "mode": settings.mode_label(),
                "model": settings.provider_label(), "providers": settings.provider_status()}

    @app.websocket("/ws")
    async def endpoint(ws: WebSocket):
        if not check_origin(ws.headers.get("origin"), app.state.bound_extension_id):
            await ws.close(code=1008); return
        if app.state.owner is not None:
            await ws.close(code=1008); return
        await ws.accept()
        try:
            raw = await asyncio.wait_for(ws.receive_json(), timeout=5)
            hello = Hello.model_validate(raw)
            if not secrets.compare_digest(hello.token, pairing_token):
                await ws.close(code=1008); return
        except (ValidationError, ValueError, asyncio.TimeoutError, WebSocketDisconnect):
            await ws.close(code=1008); return
        if app.state.bound_extension_id is None:
            app.state.bound_extension_id = ws.headers["origin"].removeprefix("chrome-extension://")
        if app.state.owner is not None:
            await ws.close(code=1008); return
        app.state.owner = hello.session_id
        call = Call(ws, hello, settings)
        try:
            await call.send({"type": "hello", "model": settings.provider_label(), "mode": settings.mode_label()})
            await call.run()
        finally:
            app.state.owner = None

    return app
