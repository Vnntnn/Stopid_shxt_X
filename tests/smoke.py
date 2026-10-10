"""Integration checks against the running real-model server (no mock inference)."""
import json
import math
import os
from pathlib import Path
import unittest
import urllib.error
import urllib.request

BASE = os.environ.get("ONFLY_URL", "http://127.0.0.1:8765")

def post(payload, endpoint="/api/decide", origin=None):
    headers = {"Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    request = urllib.request.Request(BASE + endpoint, data=json.dumps(payload).encode(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)

class RealModelSmoke(unittest.TestCase):
    evidence = {}

    def test_health(self):
        health = json.load(urllib.request.urlopen(BASE + "/api/health"))
        self.assertEqual(health["status"], "ready")
        self.assertFalse(health["mock"])
        self.assertEqual(health["checkpoint_sha256"], "9e83bb449d9d4e98b8e035c8d518b0a9d6302413532bebcb5ce10982a1a43e2b")

    def test_all_typed_heads(self):
        payload = {"state": "My card was charged twice for the same order. Please refund the duplicate charge.",
                   "questions": {
                       "route": {"type": "choice", "instructions": "Which team should handle this?", "criteria": {"billing": None, "shipping": None, "technical": None}},
                       "urgency": {"type": "score", "instructions": "How urgent is this request?", "criteria": ["low urgency", "medium urgency", "high urgency"]},
                       "refund": {"type": "noul", "instructions": "Does the customer request a refund?"}}}
        status, out = post(payload, "/v1/systemone")
        self.assertEqual(status, 200, out)
        self.assertEqual(set(out["answers"]), {"route", "urgency", "refund"})
        self.assertIn(out["answers"]["route"]["choice"], payload["questions"]["route"]["criteria"])
        self.assertGreaterEqual(out["answers"]["urgency"]["score"], 0)
        self.assertLessEqual(out["answers"]["urgency"]["score"], 2)
        self.assertTrue(0 <= out["answers"]["refund"]["noul"] <= 1)
        for answer in out["answers"].values():
            for p in answer.get("probabilities", {}).values():
                self.assertTrue(math.isfinite(p) and 0 <= p <= 1)
            if "probabilities" in answer:
                self.assertAlmostEqual(sum(answer["probabilities"].values()), 1, places=3)
        self.assertFalse(out["runtime"]["mock"])
        self.assertFalse(out["runtime"]["external_model_api"])
        self.assertFalse(out["runtime"]["input_truncated"])
        self.evidence["typed_heads"] = {"request": payload, "response": out}

    def test_english_thai_and_order(self):
        examples = {
            "english": ("A hungry fruit fly needs food. Policy A: leave ripe bananas available. Policy B: seal bins and remove all fruit.", "Which policy gives this hungry fly more food?"),
            "thai": ("แมงวันกำลังหิว นโยบาย A: วางกล้วยสุกไว้ให้กิน นโยบาย B: ปิดถังขยะและเก็บผลไม้ทั้งหมด", "นโยบายไหนช่วยให้แมงวันหาอาหารได้มากกว่า?"),
        }
        for language, (state, instructions) in examples.items():
            for order in [("A", "B"), ("B", "A")]:
                payload = {"state": state, "questions": {"vote": {"type": "choice", "instructions": instructions, "criteria": dict.fromkeys(order)}}}
                status, out = post(payload)
                self.assertEqual(status, 200, out)
                self.assertEqual(list(out["answers"]["vote"]["probabilities"]), list(order))
                self.evidence[language + "_" + "".join(order)] = {"request": payload, "response": out}
        # No correctness claim for Thai or political reasoning: record actual outputs.

    def test_reject_invalid_and_truncated_inputs(self):
        question = {"choice": {"type": "choice", "instructions": "Choose a response.", "criteria": {"A": None, "B": None}}}
        for payload in [None, {}, {"state": "", "questions": question},
                        {"state": "context", "questions": {}},
                        {"state": "long context " * 3000, "questions": question},
                        {"state": "context", "questions": {"q": {"type": "choice", "instructions": "Pick", "criteria": {"long text " * 100: None, "short": None}}}}]:
            self.assertEqual(post(payload)[0], 422)
        self.assertEqual(post({"state": "hello", "questions": question}, origin="https://example.com")[0], 403)
        self.assertEqual(post({"state": "x" * 70000, "questions": question})[0], 413)

    @classmethod
    def tearDownClass(cls):
        path = Path(__file__).resolve().parents[1] / ".runtime" / "smoke-evidence.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(cls.evidence, ensure_ascii=False, indent=2) + "\n")

if __name__ == "__main__":
    unittest.main(verbosity=2)
