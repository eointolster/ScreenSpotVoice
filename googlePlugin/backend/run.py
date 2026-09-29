from __future__ import annotations

import os
import secrets

import uvicorn
from dotenv import load_dotenv

from .server import Settings, create_app


def _parse_keep_alive(raw: str) -> str | int | None:
    """Accept Ollama duration syntax ("30m", "2h") or bare seconds.

    Empty or "0" means "don't send keep_alive", leaving Ollama's own default.
    """
    raw = raw.strip()
    if not raw or raw == "0":
        return None
    return int(raw) if raw.isdigit() else raw


def main():
    load_dotenv()
    host = os.getenv("BACKEND_HOST", "127.0.0.1")
    if host != "127.0.0.1":
        raise SystemExit("BACKEND_HOST must be 127.0.0.1")
    port = int(os.getenv("BACKEND_PORT", "8766"))
    fps = float(os.getenv("GEMINI_IMAGE_FPS", "0.8"))
    if not 0 < fps <= 1:
        raise SystemExit("GEMINI_IMAGE_FPS must be >0 and <=1")
    backend = os.getenv("MODEL_BACKEND", "gemini").strip().lower()
    if backend not in ("gemini", "local"):
        raise SystemExit("MODEL_BACKEND must be 'gemini' or 'local'")
    key = os.getenv("GEMINI_API_KEY", "").strip()
    local_host = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434").strip()
    # Accepts Ollama's own duration syntax ("30m", "2h", "-1") or a bare seconds
    # count. Empty or "0" means "leave it to Ollama".
    keep_alive = _parse_keep_alive(os.getenv("OLLAMA_KEEP_ALIVE", ""))
    settings = Settings(key=key,
                        model=os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"),
                        image_fps=fps,
                        allowed_extension_id=os.getenv("ALLOWED_EXTENSION_ID", "").strip() or None,
                        backend=backend,
                        local_host=local_host,
                        local_model=os.getenv("OLLAMA_MODEL", "qwen3.8:27b").strip(),
                        local_keep_alive=keep_alive)
    token = secrets.token_urlsafe(24)
    if backend == "local":
        mode = f"LOCAL ({settings.local_model} via {local_host})"
    else:
        mode = "LIVE" if key else "CALIBRATION"
    print(f"ScreenSpot backend: http://127.0.0.1:{port}  mode={mode}", flush=True)
    print(f"Pairing code for extension side panel: {token}", flush=True)
    if backend == "gemini" and not key:
        # The side panel says "Gemini" regardless of what is actually running,
        # so a no-key start is the most likely way to be confused. Say plainly
        # what is missing and how to switch, rather than only the mode word.
        print("", flush=True)
        print("No GEMINI_API_KEY, so there is no live model: the extension can only show", flush=True)
        print("transports and calibrate the overlay. No voice answers will come back.", flush=True)
        print("To run entirely locally instead (no key, no Google video upload):", flush=True)
        print("    echo 'MODEL_BACKEND=local' >> .env", flush=True)
        print("    ./start-backend.sh", flush=True)
    uvicorn.run(create_app(settings, token), host=host, port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
