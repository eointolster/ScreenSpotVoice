import asyncio
import math
from fractions import Fraction

from aiortc import AudioStreamTrack, RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from av import AudioFrame, AudioResampler, VideoFrame

from backend.protocol import Hello, Offer
from backend.server import Call, Settings


class SyntheticVideo(VideoStreamTrack):
    def __init__(self):
        super().__init__()
        self.number = 0

    async def recv(self):
        await asyncio.sleep(1 / 12)
        self.number += 1
        frame = VideoFrame(width=640, height=360, format="yuv420p")
        for plane in frame.planes:
            plane.update(bytes(plane.buffer_size))
        frame.pts = self.number * 7500
        frame.time_base = Fraction(1, 90000)
        return frame


class SyntheticAudio(AudioStreamTrack):
    def __init__(self):
        super().__init__()
        self.number = 0

    async def recv(self):
        await asyncio.sleep(0.02)
        frame = AudioFrame(format="s16", layout="mono", samples=960)
        frame.planes[0].update(bytes(1920))
        frame.sample_rate = 48000
        frame.pts = self.number * 960
        frame.time_base = Fraction(1, 48000)
        self.number += 1
        return frame


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, data):
        self.messages.append(data)

    async def close(self):
        pass


def test_real_peer_receives_synthetic_audio_video_and_returns_audio():
    asyncio.run(scenario())


async def scenario():
    ws = FakeWebSocket()
    hello = Hello.model_validate({"type": "hello", "token": "a" * 24,
        "session_id": "session-test", "source_id": "source-test",
        "view": {"documentId": "document-test", "revision": 0, "width": 640, "height": 360, "dpr": 1.0, "zoom": 1.0}})
    server = Call(ws, hello, Settings())
    browser = RTCPeerConnection()
    received = []
    browser.on("track", lambda track: received.append(track))
    browser.addTrack(SyntheticVideo())
    browser.addTrack(SyntheticAudio())
    browser.addTransceiver("audio", direction="recvonly")
    try:
        offer = await browser.createOffer()
        await browser.setLocalDescription(offer)
        await server.handle(Offer(type="offer", sdp=browser.localDescription.sdp))
        answer = next(message["sdp"] for message in ws.messages if message["type"] == "answer")
        await browser.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
        for _ in range(60):
            if server.video_frames > 3 and server.audio_frames > 3 and any(t.kind == "audio" for t in received):
                break
            await asyncio.sleep(0.1)
        assert server.video_frames > 3, [(m.get("type"), m.get("status"), m.get("detail")) for m in ws.messages]
        assert server.audio_frames > 3
        assert any(t.kind == "audio" for t in received)
        assert server.grounding.latest is not None
        tone = b"".join(int(8000 * math.sin(2 * math.pi * 440 * i / 24000)).to_bytes(2, "little", signed=True)
                        for i in range(24000))
        server.audio_out.push(tone, server.audio_out.generation)
        remote_audio = next(t for t in received if t.kind == "audio")
        resampler = AudioResampler(format="s16", layout="mono", rate=24000)
        peak = 0
        for _ in range(40):
            returned = await asyncio.wait_for(remote_audio.recv(), timeout=2)
            for converted in resampler.resample(returned):
                pcm = bytes(converted.planes[0])[:converted.samples * 2]
                samples = [int.from_bytes(pcm[i:i+2], "little", signed=True) for i in range(0, len(pcm), 2)]
                peak = max(peak, max((abs(value) for value in samples), default=0))
            if peak > 1000:
                break
        assert peak > 1000, "return WebRTC audio stayed silent after a known PCM tone"
        stats = await browser.getStats()
        assert any(s.type == "inbound-rtp" and s.kind == "audio" and s.packetsReceived > 0 for s in stats.values())
    finally:
        await browser.close()
        await server.close()
