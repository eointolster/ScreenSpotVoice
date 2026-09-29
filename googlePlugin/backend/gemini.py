from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from google import genai
from google.genai import types

from .tools import SYSTEM_INSTRUCTION, tool_config

__all__ = ["GeminiAdapter", "SYSTEM_INSTRUCTION", "tool_config"]


class GeminiAdapter:
    """Only Gemini protocol and event translation; no browser or WebRTC knowledge."""

    def __init__(self, key: str, model: str,
                 on_audio: Callable[[bytes], None],
                 on_interrupt: Callable[[], Awaitable[None]],
                 on_response_start: Callable[[], Awaitable[None]],
                 on_transcript: Callable[[str], Awaitable[None]],
                 on_tool: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]):
        self.key, self.model = key, model
        self.on_audio, self.on_interrupt = on_audio, on_interrupt
        self.on_response_start, self.on_transcript, self.on_tool = on_response_start, on_transcript, on_tool
        self.live: Any = None
        self.send_lock = asyncio.Lock()
        self.responding = False
        self.cancel_generation = 0
        self.suppress_audio = False

    async def run(self):
        client = genai.Client(api_key=self.key)
        config = {"response_modalities": ["AUDIO"], "system_instruction": SYSTEM_INSTRUCTION,
                  "tools": tool_config(), "input_audio_transcription": {}, "output_audio_transcription": {}}
        try:
            async with client.aio.live.connect(model=self.model, config=config) as live:
                self.live = live
                while True:
                    async for message in live.receive():
                        if getattr(message, 'go_away', None):
                            raise RuntimeError('Gemini Live session is expiring; end and start a new authorized session')
                        await self.handle_message(message)
        finally:
            self.live = None
            self.responding = False

    async def send_audio(self, data: bytes):
        if self.live:
            async with self.send_lock:
                await self.live.send_realtime_input(audio=types.Blob(data=data, mime_type="audio/pcm;rate=16000"))

    async def send_video(self, jpeg: bytes):
        if self.live:
            async with self.send_lock:
                await self.live.send_realtime_input(video=types.Blob(data=jpeg, mime_type="image/jpeg"))

    async def send_text(self, text: str):
        if self.live:
            async with self.send_lock:
                await self.live.send_realtime_input(text=text)

    async def audio_stream_end(self):
        if self.live:
            async with self.send_lock:
                await self.live.send_realtime_input(audio_stream_end=True)

    def cancel_local(self):
        self.cancel_generation += 1
        self.suppress_audio = self.responding
        self.responding = False

    async def handle_message(self, message: Any):
        content = getattr(message, "server_content", None)
        if content:
            if getattr(content, "interrupted", False):
                self.cancel_generation += 1
                self.responding = False
                self.suppress_audio = False
                await self.on_interrupt()
            input_text = getattr(getattr(content, "input_transcription", None), "text", None)
            output_text = getattr(getattr(content, "output_transcription", None), "text", None)
            if input_text: await self.on_transcript("You: " + input_text)
            if output_text: await self.on_transcript("Gemini: " + output_text)
            turn = getattr(content, "model_turn", None)
            for part in getattr(turn, "parts", None) or []:
                inline = getattr(part, "inline_data", None)
                if inline and getattr(inline, "data", None) and not self.suppress_audio:
                    if not self.responding:
                        self.responding = True
                        await self.on_response_start()
                    self.on_audio(inline.data)
            if getattr(content, "turn_complete", False):
                self.responding = False
                self.suppress_audio = False
        if getattr(message, "tool_call_cancellation", None):
            self.cancel_local()
            await self.on_interrupt()
        tool_call = getattr(message, "tool_call", None)
        if tool_call and self.live:
            generation = self.cancel_generation
            for call in getattr(tool_call, "function_calls", None) or []:
                if generation != self.cancel_generation:
                    result = {"ok": False, "reason": "Response cancelled"}
                else:
                    result = await self.on_tool(call.name, dict(call.args or {}))
                    if generation != self.cancel_generation:
                        result = {"ok": False, "reason": "Response cancelled"}
                response = types.FunctionResponse(name=call.name, id=call.id, response=result)
                async with self.send_lock:
                    await self.live.send_tool_response(function_responses=response)
