import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.server import Settings, create_app


ORIGIN_A = "chrome-extension://" + "a" * 32
ORIGIN_B = "chrome-extension://" + "b" * 32
HELLO = {"type": "hello", "token": "correct-pairing-code-123", "session_id": "session-123",
         "source_id": "source-123", "view": {"documentId": "document-123", "revision": 0,
         "width": 1280, "height": 720, "dpr": 1.0, "zoom": 1.0}}


def test_websocket_requires_extension_origin_and_pairing_code():
    app = create_app(Settings(), HELLO["token"])
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers={"origin": ORIGIN_A}) as ws:
                ws.send_json({**HELLO, "token": "wrong-pairing-code-123"})
                ws.receive_json()
        with client.websocket_connect("/ws", headers={"origin": ORIGIN_A}) as ws:
            ws.send_json(HELLO)
            assert ws.receive_json()["mode"] == "calibration"
            ws.send_json({"type": "text", "text": "Hello", "unexpected": True})
            assert ws.receive_json()["status"] == "Error"
            ws.send_json({"type": "end"})
        assert app.state.bound_extension_id == "a" * 32
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers={"origin": ORIGIN_B}) as ws:
                ws.receive_json()
