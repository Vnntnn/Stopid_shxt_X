"""Evaluate a decision checkpoint on evidence-choice jsonl: accuracy/Brier/ECE plus bias report.

./venv/bin/python eval_evidence.py --model On-Fly-Jev.pt --data data/evidence/test.jsonl --report runs/baseline_test.json
"""
import argparse
import json
import os

import numpy as np

from agent import DecisionAgent
from evidence import baselines
from evidence.metrics import bias_report, summarize

HERE = os.path.dirname(os.path.abspath(__file__))


def predict_probs(agent, items):
    out = []
    for i, ex in enumerate(items):
        a = agent.predict(ex["state"], {"q": ex["question"]})["answers"]["q"]
        out.append(np.array(list(a["probabilities"].values())))
        if (i + 1) % 200 == 0:
            print("  %d / %d" % (i + 1, len(items)), flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--code-dir", default=HERE)
    ap.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--report", default=None)
    a = ap.parse_args()
    with open(a.data, encoding="utf-8") as f:
        items = [json.loads(l) for l in f if l.strip()]
    if a.limit:
        items = items[: a.limit]
    probs = predict_probs(DecisionAgent(a.model, a.code_dir, a.device), items)
    rep = {"model": a.model, "data": a.data,
           "overall": summarize(probs, [e["target"] for e in items]), **bias_report(items, probs),
           # what a model could score without reading the question (and, for question_aware, without the roll text)
           "question_free": baselines.question_free_report(items),
           "question_free_named": baselines.question_free_report([e for e in items if not e["meta"].get("alias", True)]),
           "question_aware": baselines.question_aware_report(items)}
    print(json.dumps(rep, indent=2))
    if a.report:
        os.makedirs(os.path.dirname(os.path.abspath(a.report)), exist_ok=True)
        with open(a.report, "w") as f:
            json.dump(rep, f, indent=2)


if __name__ == "__main__":
    main()
