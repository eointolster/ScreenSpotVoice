"""Local model provider: one image + one question -> text plus tool calls.

Design notes that matter for anyone changing this file:

* The native Ollama endpoint (``/api/chat``) is used deliberately. It is the
  only one that accepts images *and* ``tools`` together in this project's
  measured setup, and its ``tool_calls[].function.arguments`` arrive already
  decoded as a dict. The OpenAI-compatible endpoint is the mirror image: it
  handles audio, but audio is not used here because Chrome's own
  SpeechRecognition does that job before a request is ever built.

* Audio is never sent to this provider. Chrome transcribes the microphone and
  the backend only ever receives text. The WebRTC send path therefore carries
  video alone on this path.

* ``think`` is sent as a plain boolean false. This model advertises a
  "thinking" capability; leaving it on spends the token budget on reasoning
  and can return a truncated turn with no tool call at all.
"""
from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

import httpx

from .tools import LOCAL_SYSTEM_INSTRUCTION, ollama_tools


class LocalModelError(RuntimeError):
    """Raised for transport, HTTP, or malformed-response failures."""


class LocalTurn:
    """One completed local turn: what the model said and what it asked for."""

    def __init__(self, text: str, tool_calls: list[dict[str, Any]]):
        self.text = text
        self.tool_calls = tool_calls


class LocalAdapter:
    """Only local-model protocol translation; no browser or WebRTC knowledge.

    Unlike GeminiAdapter this is request/response, not a persistent duplex
    socket. There is no streaming audio, no server-side VAD, and therefore no
    barge-in or cancellation to manage here: each call is one user turn.
    """

    def __init__(self, host: str, model: str, timeout: float = 120.0,
                 keep_alive: str | int | None = None):
        self.host = host.rstrip("/")
        self.model = model
        self.timeout = timeout
        # Ollama unloads a model after 5 minutes idle by default, which makes the
        # next question pay a ~20 s reload on a 17 GB model. Passed per request.
        self.keep_alive = keep_alive
        self._client: httpx.AsyncClient | None = None
        self.last_latency_ms: int | None = None

    @property
    def live(self) -> bool:
        """Mirrors GeminiAdapter.live so server.py can treat both alike."""
        return self._client is not None

    def model_label(self) -> str:
        return f"local:{self.model}"

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def health(self) -> tuple[bool, str]:
        """Report reachability without ever submitting a model call."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.host}/api/tags")
                response.raise_for_status()
                names = [entry.get("name", "") for entry in response.json().get("models", [])]
        except Exception as error:  # noqa: BLE001 - surfaced to the panel as text
            return False, f"{type(error).__name__}: {error}"
        if not any(name == self.model or name.split(":")[0] == self.model.split(":")[0] for name in names):
            return False, f"model {self.model!r} is not pulled (have: {', '.join(names) or 'none'})"
        return True, f"model {self.model} available"

    async def ask(self, question: str, jpeg: bytes) -> LocalTurn:
        """Run one turn: a spoken question plus the clean frame it refers to."""
        await self.start()
        assert self._client is not None
        body = {
            "model": self.model,
            "stream": False,
            "think": False,
            "tools": ollama_tools(),
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": LOCAL_SYSTEM_INSTRUCTION},
                {
                    "role": "user",
                    "content": question,
                    "images": [base64.b64encode(jpeg).decode("ascii")],
                },
            ],
        }
        if self.keep_alive is not None:
            body["keep_alive"] = self.keep_alive
        started = asyncio.get_running_loop().time()
        try:
            response = await self._client.post(f"{self.host}/api/chat", json=body)
            response.raise_for_status()
            payload = response.json()
        except Exception as error:  # noqa: BLE001 - normalised for the panel
            raise LocalModelError(f"{type(error).__name__}: {error}") from error
        self.last_latency_ms = round((asyncio.get_running_loop().time() - started) * 1000)
        return self._parse(payload)

    def _parse(self, payload: dict[str, Any]) -> LocalTurn:
        message = payload.get("message")
        if not isinstance(message, dict):
            raise LocalModelError("response had no message object")
        text = (message.get("content") or "").strip()
        calls = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            name = function.get("name")
            if not name:
                continue
            arguments = function.get("arguments")
            # Native Ollama decodes arguments to a dict; the OpenAI-compatible
            # endpoint leaves them as a JSON string. Accept both.
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError as error:
                    raise LocalModelError(f"tool arguments were not valid JSON: {error}") from error
            if not isinstance(arguments, dict):
                raise LocalModelError("tool arguments were not an object")
            calls.append({
                "id": call.get("id") or "",
                "name": name,
                "arguments": _coerce_arguments(name, arguments),
            })
        if not text and not calls:
            raise LocalModelError("model returned neither text nor a tool call")
        return LocalTurn(text, calls)


def _coerce_arguments(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Normalise loosely-typed tool arguments into the shapes protocol.py expects.

    The local model is inconsistent about JSON types even though its values are
    accurate: ``box_2d`` is frequently emitted as the *string*
    ``"[172, 30, 205, 122]"`` rather than a list of numbers, and ``label`` can
    arrive absent. protocol.HighlightArgs is deliberately strict, so a raw
    string would otherwise be rejected and the highlight silently lost.

    Coercion is deliberately narrow: only bracket-wrapped numeric lists are
    parsed, and anything still not numeric is left alone so that
    HighlightArgs reports the real validation error rather than a coerced one.
    """
    if name != "highlight_region":
        return arguments
    box = arguments.get("box_2d")
    if isinstance(box, str):
        text = box.strip().strip("[]")
        parts = [part.strip() for part in text.split(",")] if text else []
        if len(parts) == 4:
            try:
                numbers = [float(part) for part in parts]
            except ValueError:
                return arguments
            if all(number == int(number) for number in numbers):
                arguments = {**arguments, "box_2d": [int(number) for number in numbers]}
    if "label" not in arguments:
        arguments = {**arguments, "label": "target"}
    return arguments
