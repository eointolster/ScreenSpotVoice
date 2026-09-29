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
    settings = Settings(key=os.getenv("GEMINI_API_KEY", "").strip(),
                        model=os.getenv("GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"),
                        image_fps=fps,
                        allowed_extension_id=os.getenv("ALLOWED_EXTENSION_ID", "").strip() or None)
    token = secrets.token_urlsafe(24)
    print(f"ScreenSpot backend: http://127.0.0.1:{port}  mode={'LIVE' if settings.key else 'CALIBRATION'}", flush=True)
    print(f"Pairing code for extension side panel: {token}", flush=True)
    uvicorn.run(create_app(settings, token), host=host, port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
