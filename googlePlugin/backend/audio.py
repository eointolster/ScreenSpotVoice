from __future__ import annotations

import asyncio
import time

from aiortc import MediaStreamTrack
from av import AudioFrame


class ReturnAudio(MediaStreamTrack):
    kind = "audio"
    RATE = 24000
    SAMPLES = 480  # 20 ms
    BYTES = SAMPLES * 2
    MAX_BUFFER_FRAMES = 400  # Eight seconds of bounded playback for bursty Live output.
    START_FRAMES = 6  # 120 ms jitter buffer before each uninterrupted phrase.

    def __init__(self):
        super().__init__()
        self.queue: asyncio.Queue[tuple[int, bytes]] = asyncio.Queue(maxsize=self.MAX_BUFFER_FRAMES)
        self.generation = 0
        self.pts = 0
        self.next_at = time.monotonic()
        self.remainder = b""
        self.dropped = 0
        self.playing = False
        self.first_queued_at = 0.0

    def clear(self):
        self.generation += 1
        self.remainder = b""
        self.playing = False
        self.first_queued_at = 0.0
        while not self.queue.empty():
            try: self.queue.get_nowait()
            except asyncio.QueueEmpty: break

    def push(self, data: bytes, generation: int):
        if generation != self.generation:
            return
        self.remainder += data
        while len(self.remainder) >= self.BYTES:
            block, self.remainder = self.remainder[:self.BYTES], self.remainder[self.BYTES:]
            if self.queue.empty():
                self.first_queued_at = time.monotonic()
            if self.queue.full():
                self.queue.get_nowait()
                self.dropped += 1
            self.queue.put_nowait((generation, block))

    async def recv(self) -> AudioFrame:
        now = time.monotonic()
        await asyncio.sleep(max(0, self.next_at - now))
        self.next_at = max(self.next_at + 0.02, time.monotonic())
        block = b"\0" * self.BYTES
        if not self.playing and (self.queue.qsize() >= self.START_FRAMES or
                                 (not self.queue.empty() and time.monotonic() - self.first_queued_at >= 0.12)):
            self.playing = True
        if self.playing:
            try:
                generation, queued = self.queue.get_nowait()
                if generation == self.generation:
                    block = queued
            except asyncio.QueueEmpty:
                self.playing = False
        frame = AudioFrame(format="s16", layout="mono", samples=self.SAMPLES)
        frame.planes[0].update(block)
        frame.sample_rate = self.RATE
        frame.pts = self.pts
        frame.time_base = __import__("fractions").Fraction(1, self.RATE)
        self.pts += self.SAMPLES
        return frame
