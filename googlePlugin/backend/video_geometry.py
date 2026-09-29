from __future__ import annotations

from PIL import Image

from .protocol import View


def _mean_brightness(image: Image.Image, box: tuple[int, int, int, int]) -> float:
    # A tiny sample is enough to distinguish Chrome's dark padding from page pixels.
    sample = image.crop(box).convert("RGB")
    sample.thumbnail((12, 12), Image.Resampling.BILINEAR)
    pixels = list(sample.getdata())
    return sum(sum(pixel) / 3 for pixel in pixels) / len(pixels)


def align_tab_frame(image: Image.Image, view: View) -> tuple[Image.Image, str]:
    """Remove verified, centered tab-capture padding before Gemini sees a frame.

    A changed aspect ratio by itself is not proof of padding. Keep unmatched
    frames untouched so the existing coordinate checks reject unsafe boxes.
    """
    width, height = image.size
    target_ratio = view.width / view.height
    if abs(width / height - target_ratio) <= 0.045:
        return image, "direct"

    if width / height > target_ratio:
        content_width = round(height * target_ratio)
        margin = (width - content_width) // 2
        if margin < 12:
            return image, "unresolved aspect mismatch"
        content = (margin, 0, margin + content_width, height)
        bars = ((0, 0, margin, height), (margin + content_width, 0, width, height))
        edge = (margin + max(1, content_width // 20), 0,
                margin + content_width - max(1, content_width // 20), height)
        direction = "side"
    else:
        content_height = round(width / target_ratio)
        margin = (height - content_height) // 2
        if margin < 12:
            return image, "unresolved aspect mismatch"
        content = (0, margin, width, margin + content_height)
        bars = ((0, 0, width, margin), (0, margin + content_height, width, height))
        edge = (0, margin + max(1, content_height // 20), width,
                margin + content_height - max(1, content_height // 20))
        direction = "top/bottom"

    first, second = (_mean_brightness(image, box) for box in bars)
    middle = _mean_brightness(image, edge)
    if max(first, second) <= 24 and abs(first - second) <= 12 and middle >= max(first, second) + 12:
        return image.crop(content), f"cropped {direction} capture bars"
    return image, "unresolved aspect mismatch"
