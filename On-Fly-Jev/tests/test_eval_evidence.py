import json
import sys

import numpy as np

import eval_evidence


def mk(variant, target, pair, side):
    return {"state": {"s": 1}, "question": {"criteria": ["a", "b", "none"]}, "target": target,
            "meta": {"variant": variant, "pair_id": pair, "side": side}}


ITEMS = [mk("base", [0, 1, 0], "p1", "D"), mk("swap", [1, 0, 0], "p1", "D"), mk("ablate", [0, 0, 1], "p2", None)]
PROBS = [[0.1, 0.8, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]]


class FakeAgent:
    def __init__(self, *args, **kw):
        self.i = 0

    def predict(self, state, questions):
        p = PROBS[self.i]
        self.i += 1
        assert set(questions) == {"q"}
        return {"answers": {"q": {"probabilities": dict(zip(["a", "b", "none"], p))}}}


def test_predict_probs():
    out = eval_evidence.predict_probs(FakeAgent(), ITEMS)
    assert len(out) == 3 and all(isinstance(x, np.ndarray) for x in out)
    assert np.allclose(out[2], [0.1, 0.1, 0.8])


def test_main_writes_report(tmp_path, monkeypatch):
    data, rep = tmp_path / "d.jsonl", tmp_path / "out" / "r.json"
    data.write_text("\n".join(json.dumps(x) for x in ITEMS) + "\n")
    monkeypatch.setattr(eval_evidence, "DecisionAgent", FakeAgent)
    monkeypatch.setattr(sys, "argv", ["eval_evidence.py", "--model", "m.pt", "--data", str(data), "--report", str(rep)])
    eval_evidence.main()
    r = json.loads(rep.read_text())
    for k in ("overall", "by_variant", "none_rate", "by_side", "side_gap", "by_target_position", "swap_consistency"):
        assert k in r
    assert r["overall"]["n"] == 3 and r["none_rate"] == {"ablate": 1.0}
    assert r["swap_consistency"] == {"n": 1, "rate": 0.0}


def test_report_includes_question_free_baselines_and_named_subset(tmp_path, monkeypatch):
    sys.path.insert(0, "tests")
    from evidence import votes
    from fixtures import votes_fixture
    rc, mem, vt = votes_fixture()
    items = votes.build_items(rc, mem, vt, "g", n=100, seed=0, name_frac=0.5)

    class Uniform(FakeAgent):
        def predict(self, state, questions):
            crit = questions["q"]["criteria"]
            return {"answers": {"q": {"probabilities": {k: 1.0 / len(crit) for k in crit}}}}
    data, rep = tmp_path / "d.jsonl", tmp_path / "r.json"
    data.write_text("\n".join(json.dumps(x) for x in items) + "\n")
    monkeypatch.setattr(eval_evidence, "DecisionAgent", Uniform)
    monkeypatch.setattr(sys, "argv", ["eval_evidence.py", "--model", "m.pt", "--data", str(data), "--report", str(rep)])
    eval_evidence.main()
    r = json.loads(rep.read_text())
    named = [e for e in items if not e["meta"]["alias"] and e["meta"]["variant"] in ("base", "swap", "nomatch")]
    assert named and r["question_free"]["n"] > r["question_free_named"]["n"] == len(named)
    for k in ("unique_label", "record_lacks_yea_or_nay", "lone_party_avoid", "always_none"):
        assert 0.0 <= r["question_free"][k] <= 1.0 and k in r["question_free_named"]
    assert "presence_odd_one_out" in r["question_aware"]


def test_report_question_free_sections_are_empty_without_voteview_items(tmp_path, monkeypatch):
    data, rep = tmp_path / "d.jsonl", tmp_path / "r.json"
    data.write_text("\n".join(json.dumps(x) for x in ITEMS) + "\n")
    monkeypatch.setattr(eval_evidence, "DecisionAgent", FakeAgent)
    monkeypatch.setattr(sys, "argv", ["eval_evidence.py", "--model", "m.pt", "--data", str(data), "--report", str(rep)])
    eval_evidence.main()
    r = json.loads(rep.read_text())
    assert r["question_free"] == {"n": 0} and r["question_free_named"] == {"n": 0}
