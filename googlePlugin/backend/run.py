from __future__ import annotations

import os
import secrets

import uvicorn
from dotenv import load_dotenv

from .server import Settings, create_app


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
    if backend == "gemini" and not key:
        # Matches the previous behaviour: without a key the Gemini provider
        # still starts, in calibration mode. Keep that, but be explicit.
        print("No GEMINI_API_KEY: starting in calibration mode (no live voice).", flush=True)
    local_host = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434").strip()
    settings = Settings(key=key,
                        model=os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"),
                        image_fps=fps,
                        allowed_extension_id=os.getenv("ALLOWED_EXTENSION_ID", "").strip() or None,
                        backend=backend,
                        local_host=local_host,
                        local_model=os.getenv("OLLAMA_MODEL", "qwen3.8:27b").strip())
    token = secrets.token_urlsafe(24)
    if backend == "local":
        mode = f"LOCAL ({settings.local_model} via {local_host})"
    else:
        mode = "LIVE" if key else "CALIBRATION"
    print(f"ScreenSpot backend: http://127.0.0.1:{port}  mode={mode}", flush=True)
    print(f"Pairing code for extension side panel: {token}", flush=True)
    uvicorn.run(create_app(settings, token), host=host, port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
