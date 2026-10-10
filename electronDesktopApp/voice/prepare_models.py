"""Download and verify the project-local speech models once during setup."""
from __future__ import annotations

import hashlib
import os
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
ASSETS = {
    "kokoro-v1.0.onnx": (325505369, "beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a"),
    "voices-v1.0.bin": (28214398, "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"),
}
BASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1"


def verified(path: Path, expected_size: int, expected_hash: str) -> bool:
    if not path.is_file() or path.stat().st_size != expected_size:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == expected_hash


def download_kokoro() -> None:
    MODELS.mkdir(exist_ok=True)
    for name, (size, digest) in ASSETS.items():
        destination = MODELS / name
        if verified(destination, size, digest):
            print(f"Verified {name}", flush=True)
            continue
        temporary = destination.with_suffix(destination.suffix + ".part")
        print(f"Downloading {name} ({size // 1_000_000} MB)...", flush=True)
        request = urllib.request.Request(f"{BASE_URL}/{name}", headers={"User-Agent": "ScreenSpot-Desktop/0.1"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        if not verified(temporary, size, digest):
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"Downloaded {name} failed size or SHA-256 verification")
        os.replace(temporary, destination)


def prepare_whisper(model_name: str = "base.en") -> None:
    from faster_whisper import WhisperModel
    cache = ROOT / ".cache" / "whisper"
    cache.mkdir(parents=True, exist_ok=True)
    print(f"Downloading/loading Whisper {model_name}...", flush=True)
    WhisperModel(model_name, device="cpu", compute_type="int8", download_root=str(cache))
    print(f"Whisper {model_name} ready", flush=True)


if __name__ == "__main__":
    os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface"))
    download_kokoro()
    prepare_whisper()
