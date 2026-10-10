import base64
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from voice.worker import _box_from_model, _ollama_calls, ask, ask_gemini, ask_local


class WorkerContractTests(unittest.TestCase):
    def test_ollama_string_box_is_normalized_for_overlay_validation(self):
        calls = _ollama_calls([{"function": {"name": "highlight_region", "arguments": {
            "box_2d": "[210, 62, 435, 412]", "label": "Transactions"}}}])
        self.assertEqual(calls, [{"name": "highlight_region", "arguments": {
            "box_2d": [210.0, 62.0, 435.0, 412.0], "label": "Transactions"}}])
        self.assertEqual(_box_from_model("not a box"), "not a box")

    def test_named_coordinates_keep_vertical_and_horizontal_axes_distinct(self):
        calls = _ollama_calls([{"function": {"name": "highlight_region", "arguments": {
            "label": "Lucas.jpg", "ymin": 70, "xmin": 800, "ymax": 130, "xmax": 860}}}])
        self.assertEqual(calls[0]["arguments"]["box_2d"], [70.0, 800.0, 130.0, 860.0])

    def test_prose_without_tool_gets_a_structured_grounding_retry(self):
        requests = []
        class FakeResponse:
            def __init__(self, message): self.message = message
            def raise_for_status(self): pass
            def json(self): return {"message": self.message}
        class FakeClient:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def post(self, url, json, **_):
                requests.append(json)
                if len(requests) == 1:
                    return FakeResponse({"content": "I highlighted Lucas.jpg in the upper right."})
                return FakeResponse({"content": '{"found":true,"label":"Lucas.jpg","ymin":70,"xmin":815,"ymax":180,"xmax":865}'})
        with patch("httpx.Client", return_value=FakeClient()):
            result = ask_local({"model": "qwen3.8:27b", "question": "Highlight Lucas dot j on the screen please.", "image": "synthetic-jpeg"})
        self.assertEqual(len(requests), 2)
        self.assertIn("format", requests[1])
        self.assertEqual(result["tool_calls"][0]["arguments"]["box_2d"], [70.0, 815.0, 180.0, 865.0])
        self.assertEqual(result["text"], "I highlighted Lucas.jpg.")

    def test_failed_grounding_does_not_claim_a_highlight(self):
        class FakeResponse:
            def __init__(self, message): self.message = message
            def raise_for_status(self): pass
            def json(self): return {"message": self.message}
        class FakeClient:
            calls = 0
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def post(self, url, json, **_):
                self.calls += 1
                if self.calls == 1:
                    return FakeResponse({"content": "I highlighted the icon."})
                return FakeResponse({"content": '{"found":false,"label":"","ymin":0,"xmin":0,"ymax":0,"xmax":0}'})
        with patch("httpx.Client", return_value=FakeClient()):
            result = ask_local({"model": "qwen3.8:27b", "question": "Highlight a missing icon.", "image": "synthetic-jpeg"})
        self.assertEqual(result["tool_calls"], [])
        self.assertNotIn("highlighted", result["text"])

    def test_unknown_provider_cannot_start_a_model_request(self):
        image = base64.b64encode(b"\xff\xd8" + b"x" * 60).decode("ascii")
        with self.assertRaisesRegex(ValueError, "Unknown model provider"):
            ask({"provider": "untrusted", "question": "Where?", "image": image})

    def test_gemini_image_request_uses_interactions_without_storage(self):
        seen = {}
        class FakeClient:
            def __init__(self):
                self.interactions = SimpleNamespace(create=self.create)
            def create(self, **kwargs):
                seen.update(kwargs)
                return SimpleNamespace(output_text='{"reply":"Look at Transactions.","found":true,"label":"Transactions","ymin":200,"xmin":100,"ymax":400,"xmax":500}')
            def close(self):
                seen["closed"] = True
        with patch("google.genai.Client", return_value=FakeClient()):
            result = ask_gemini({"gemini_key": "TEST_KEY_NOT_SENT", "model": "gemini-3.8-flash",
                                 "question": "Where are Transactions?",
                                 "image": base64.b64encode(b"\xff\xd8" + b"x" * 60).decode("ascii")})
        self.assertEqual(result["tool_calls"][0]["arguments"]["box_2d"], [200, 100, 400, 500])
        self.assertEqual(result["text"], "Look at Transactions.")
        self.assertEqual(seen["model"], "gemini-3.8-flash")
        self.assertFalse(seen["store"])
        self.assertEqual(seen["input"][1]["mime_type"], "image/jpeg")
        self.assertEqual(seen["response_format"]["mime_type"], "application/json")
        self.assertEqual(seen["generation_config"]["thinking_level"], "low")
        self.assertIn("found", seen["response_format"]["schema"]["required"])
        self.assertTrue(seen["closed"])


    def test_fast_gemini_model_uses_minimal_thinking_and_rejects_unsafe_box(self):
        seen = {}
        class FakeClient:
            def __init__(self): self.interactions = SimpleNamespace(create=self.create)
            def create(self, **kwargs):
                seen.update(kwargs)
                return SimpleNamespace(output_text='{"reply":"The icon is there.","found":true,"label":"Lucas.jpg","ymin":0,"xmin":0,"ymax":1000,"xmax":1000}')
            def close(self): pass
        with patch("google.genai.Client", return_value=FakeClient()):
            result = ask_gemini({"gemini_key": "TEST_KEY_NOT_SENT", "model": "gemini-3.5-flash-lite",
                                 "question": "Find Lucas.jpg", "image": "synthetic-jpeg"})
        self.assertEqual(seen["generation_config"], {"thinking_level": "minimal"})
        self.assertEqual(result["tool_calls"], [])
        self.assertIn("could not find a reliable box", result["text"])

    def test_fast_gemini_draws_box_when_target_was_located(self):
        class FakeClient:
            def __init__(self): self.interactions = SimpleNamespace(create=self.create)
            def create(self, **_):
                return SimpleNamespace(output_text='{"reply":"I cannot find it.","found":true,"label":"Lucas.jpg","ymin":55,"xmin":10,"ymax":160,"xmax":95}')
            def close(self): pass
        with patch("google.genai.Client", return_value=FakeClient()):
            result = ask_gemini({"gemini_key": "TEST_KEY_NOT_SENT", "model": "gemini-3.5-flash-lite",
                                 "question": "Find Lucas.jpg", "image": "synthetic-jpeg"})
        self.assertEqual(result["tool_calls"][0]["arguments"]["box_2d"], [55, 10, 160, 95])
        self.assertEqual(result["text"], "I cannot find it.")

    def test_gemini_guidance_receives_recent_turns_and_keeps_actionable_reply(self):
        seen = {}
        class FakeClient:
            def __init__(self): self.interactions = SimpleNamespace(create=self.create)
            def create(self, **kwargs):
                seen.update(kwargs)
                return SimpleNamespace(output_text='{"reply":"In the Geometry Nodes editor, click New to create a node tree.","found":true,"label":"New","ymin":100,"xmin":200,"ymax":130,"xmax":240}')
            def close(self): pass
        with patch("google.genai.Client", return_value=FakeClient()):
            result = ask_gemini({"gemini_key": "TEST_KEY_NOT_SENT", "model": "gemini-3.5-flash",
                                 "question": "What do I do next?",
                                 "history": [{"user": "I opened Geometry Nodes.", "assistant": "You are in Geometry Nodes."}],
                                 "image": "synthetic-jpeg"})
        self.assertIn("click New", result["text"])
        self.assertEqual(result["tool_calls"][0]["arguments"]["label"], "New")
        self.assertIn("I opened Geometry Nodes.", seen["input"][0]["text"])
        self.assertEqual(seen["generation_config"]["thinking_level"], "low")

    def test_live_model_is_rejected_before_a_one_shot_image_request(self):
        with self.assertRaisesRegex(ValueError, "streaming voice session"):
            ask_gemini({"gemini_key": "TEST_KEY_NOT_SENT", "model": "gemini-3.8-live",
                        "question": "Where?", "image": "not-needed"})


if __name__ == "__main__":
    unittest.main()
