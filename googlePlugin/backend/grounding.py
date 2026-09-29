from __future__ import annotations

from dataclasses import dataclass
from time import monotonic

from .protocol import View


@dataclass(frozen=True)
class Frame:
    jpeg: bytes
    width: int
    height: int
    signature: bytes
    received_at: float


@dataclass(frozen=True)
class Stamp:
    source_id: str
    view: View
    frame: Frame
    generation: int
    sent_at: float


def outside_box_distance(a: bytes, b: bytes, box: tuple[float, float, float, float]) -> float:
    if len(a) != 32 * 18 or len(b) != len(a):
        return 256
    ymin, xmin, ymax, xmax = box
    # Ignore a padded rectangle: our own SVG outline is included in tab capture.
    margin = 35
    differences = []
    for y in range(18):
        for x in range(32):
            nx, ny = (x + 0.5) / 32 * 1000, (y + 0.5) / 18 * 1000
            if xmin - margin <= nx <= xmax + margin and ymin - margin <= ny <= ymax + margin:
                continue
            differences.append(abs(a[y * 32 + x] - b[y * 32 + x]))
    return sum(differences) / len(differences) if differences else 0


def signature_distance(a: bytes, b: bytes) -> float:
    if len(a) != len(b) or not a:
        return 256
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def inside_box_distance(a: bytes, b: bytes, box: tuple[float, float, float, float] | list[float]) -> float:
    if len(a) != 32 * 18 or len(b) != len(a):
        return 256
    ymin, xmin, ymax, xmax = box
    differences = []
    for y in range(18):
        for x in range(32):
            nx, ny = (x + 0.5) / 32 * 1000, (y + 0.5) / 18 * 1000
            if xmin - 35 <= nx <= xmax + 35 and ymin - 35 <= ny <= ymax + 35:
                differences.append(abs(a[y * 32 + x] - b[y * 32 + x]))
    return sum(differences) / len(differences) if differences else 256


class Grounding:
    def __init__(self, source_id: str, view: View):
        self.source_id = source_id
        self.view = view
        self.latest: Frame | None = None
        self.last_sent: Stamp | None = None
        self.generation = 0
        self.overlay_visible = False
        self.overlay_box: tuple[float, float, float, float] | None = None
        self.clean_after = monotonic()
        self.clear_pending = False

    def invalidate(self, view: View | None = None):
        self.generation += 1
        if view is not None:
            self.view = view
        self.last_sent = None
        self.overlay_visible = False
        self.overlay_box = None
        self.clear_pending = True
        self.clean_after = float("inf")

    def cleared(self):
        self.overlay_visible = False
        self.overlay_box = None
        self.clear_pending = False
        # Account for tab paint, capture, encode, RTP, decode and event scheduling.
        self.clean_after = monotonic() + 0.35

    def accept_frame(self, frame: Frame):
        self.latest = frame  # bounded latest-frame buffer: exactly one frame

    def coordinate_fit(self, frame: Frame | None = None) -> bool:
        frame = frame or self.latest
        return bool(frame and abs(frame.width / frame.height - self.view.width / self.view.height) <= 0.045)

    def frame_gate_reason(self, now: float | None = None) -> str:
        now = monotonic() if now is None else now
        frame = self.latest
        if self.clear_pending:
            return "waiting for clear acknowledgment"
        if self.overlay_visible:
            return "highlight visible; images withheld"
        if not frame:
            return "waiting for tab video"
        if frame.received_at < self.clean_after or now < self.clean_after:
            return "waiting for clean frame"
        return "ready"

    def ready_frame(self, now: float | None = None) -> Frame | None:
        return self.latest if self.frame_gate_reason(now) == "ready" else None

    def mark_sent(self, frame: Frame) -> Stamp:
        stamp = Stamp(self.source_id, self.view, frame, self.generation, monotonic())
        self.last_sent = stamp
        return stamp

    def valid_stamp(self, stamp: Stamp | None, box: tuple[float, float, float, float] | list[float] | None = None,
                    max_age: float = 4.0) -> tuple[bool, str]:
        if stamp is None or stamp is not self.last_sent:
            return False, "No current clean image was sent"
        if stamp.source_id != self.source_id or stamp.view != self.view or stamp.generation != self.generation:
            return False, "The page or request changed"
        if self.clear_pending or self.overlay_visible:
            return False, "The page is awaiting a clean frame"
        if not self.coordinate_fit(stamp.frame):
            return False, "Capture and viewport dimensions disagree"
        if monotonic() - stamp.sent_at > max_age:
            return False, "The image is too old"
        if not self.latest:
            return False, "No current video frame"
        change = (inside_box_distance(stamp.frame.signature, self.latest.signature, box)
                  if box is not None else signature_distance(stamp.frame.signature, self.latest.signature))
        if change > (25 if box is not None else 14):
            return False, "The target region has changed" if box is not None else "The visible page has changed"
        return True, ""
