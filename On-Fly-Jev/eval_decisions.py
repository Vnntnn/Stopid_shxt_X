"""Evaluate a trained decision model.

--suite typed : LocalLLaMA/typed-decisions TEST split (400 cases / 2,000 decisions), with the Laya
                notebook's exact metrics (accuracy, soft accuracy, Brier, ECE, KL, TV, score MAE,
                within-1-level, latency) and its comparison table vs TypeSafe Jev 1.13.0.
--suite mix   : held-out eval splits of every public source in the Jev-like mix (never trained
                on): accuracy + ECE per source.
--suite all   : both.

CPU by default (pass --device cuda to use the GPU).
"""
import argparse
import json
import os
import time

import numpy as np

from agent import DecisionAgent
from decision_core import ece_score

HERE = os.path.dirname(os.path.abspath(__file__))

REFERENCE = [
    {"Model": "TypeSafe Jev 1.13.0", "Kind": "general", "Accuracy": 0.727, "Soft Acc": 0.580, "Brier": 0.148,
     "ECE": 0.144, "Score MAE": 0.391, "Within 1 Level": 0.952, "ms/case": 710},
    {"Model": "Laya typed-decisions (421M)", "Kind": "fine-tuned", "Accuracy": 0.766, "Soft Acc": 0.471,
     "Brier": None, "ECE": None, "Score MAE": None, "Within 1 Level": None, "ms/case": None},
    {"Model": "ModernBERT-base (149M)", "Kind": "specialist", "Accuracy": 0.646, "Soft Acc": 0.542,
     "Brier": 0.119, "ECE": 0.179, "Score MAE": 0.444, "Within 1 Level": 0.931, "ms/case": 349},
    {"Model": "Teacher Self-Agreement", "Kind": "ceiling", "Accuracy": 0.735},
]


def score_typed(agent, limit=None):
    from datasets import load_dataset
    ds = load_dataset("LocalLLaMA/typed-decisions", "all", split="test")
    acc, soft, brier, kl, tv, mae, w1, confs, corr, lat = ([] for _ in range(10))
    per_wf = {}
    for i, row in enumerate(ds):
        if limit and i >= limit:
            break
        state, questions, gold = json.loads(row["state"]), json.loads(row["questions"]), json.loads(row["gold"])
        t0 = time.perf_counter()
        pred = agent.predict(state, questions)["answers"]
        lat.append((time.perf_counter() - t0) * 1000)
        for qid, q in questions.items():
            p, g, t = pred[qid], gold[qid], q["type"]
            if t == "choice":
                keys = list(q["criteria"].keys())
                ok = float(p["choice"] == str(g["label"]))
                pp = np.array([p["probabilities"].get(k, 1e-6) for k in keys]); pp /= pp.sum()
                gg = np.array([g["probabilities"].get(k, 1e-6) for k in keys]); gg /= gg.sum()
                confs.append(float(pp.max()))
            elif t == "noul":
                pv = p["noul"]
                gv = g.get("noul", g.get("probabilities", {}).get("true", 0.5))
                ok = float(("true" if pv >= 0.5 else "false") == str(g["label"]).lower())
                pp, gg = np.array([1 - pv, pv]), np.array([1 - gv, gv])
                confs.append(float(max(pv, 1 - pv)))
            else:
                n = len(q.get("criteria", []))
                ps = np.array([p["probabilities"].get(str(j), 0.0) for j in range(n)])
                g_score = g.get("score", 0.0)
                mae.append(abs(p["score"] - g_score))
                w1.append(float(abs(p["score"] - g_score) <= 1.0))
                if ps.sum() > 0:
                    ps /= ps.sum()
                    lvl = int(ps.argmax())
                    confs.append(float(ps.max()))
                else:
                    lvl = int(round(p["score"]))
                    confs.append(0.5)
                ok = float(lvl == int(g.get("label", int(round(g_score)))))
                pp = None
            acc.append(ok)
            corr.append(ok)
            per_wf.setdefault(row["workflow"], []).append(ok)
            if pp is not None:     # choice + noul: distribution metrics (as in the notebook)
                soft.append(float((pp * gg).sum()))
                brier.append(float(((pp - gg) ** 2).sum()))
                tv.append(float(0.5 * np.abs(pp - gg).sum()))
                kl.append(float((gg * np.log(np.clip(gg / pp, 1e-12, 1e4))).sum()))
        if (i + 1) % 50 == 0:
            print(f"  {i + 1} cases | running accuracy {np.mean(acc):.3f}", flush=True)
    m = {"accuracy": float(np.mean(acc)), "soft_accuracy": float(np.mean(soft)), "brier_score": float(np.mean(brier)),
         "ece": ece_score(confs, corr), "score_mae": float(np.mean(mae)) if mae else 0.0,
         "within_1_level": float(np.mean(w1)) if w1 else 0.0, "kl_divergence": float(np.mean(kl)),
         "total_variation": float(np.mean(tv)), "latency_p50_ms": float(np.percentile(lat, 50)),
         "latency_p95_ms": float(np.percentile(lat, 95)), "n_decisions": len(acc)}
    wf = {k: {"n_decisions": len(v), "accuracy": round(float(np.mean(v)), 4)} for k, v in per_wf.items()}
    return m, wf


def score_mix(agent, per_source):
    import decision_data
    return score_examples(agent, decision_data.build("mix", "eval", per_source=per_source))


def score_examples(agent, exs):
    """Accuracy (argmax of the target) + ECE per `source` for pre-built examples."""
    by_src = {}
    for ex in exs:
        if ex["source"] == "typed-decisions":
            continue
        a = agent.predict(ex["state"], {"q": ex["question"]})["answers"]["q"]
        tgt = int(np.argmax(ex["target"]))
        if a["type"] == "noul":
            pv = a["noul"]; pred, conf = int(pv >= 0.5), max(pv, 1 - pv)
        else:
            probs = list(a["probabilities"].values())
            pred, conf = int(np.argmax(probs)), float(max(probs))
        by_src.setdefault(ex["source"], ([], []))
        by_src[ex["source"]][0].append(float(pred == tgt))
        by_src[ex["source"]][1].append(conf)
    return {s: {"n": len(c), "accuracy": round(float(np.mean(c)), 4), "ece": round(ece_score(cf, c), 4)}
            for s, (c, cf) in sorted(by_src.items())}


def table(m, name):
    cols = ["Model", "Kind", "Accuracy", "Soft Acc", "Brier", "ECE", "Score MAE", "Within 1 Level", "ms/case"]
    ours = {"Model": name, "Kind": "ours", "Accuracy": m["accuracy"], "Soft Acc": m["soft_accuracy"],
            "Brier": m["brier_score"], "ECE": m["ece"], "Score MAE": m["score_mae"],
            "Within 1 Level": m["within_1_level"], "ms/case": m["latency_p50_ms"]}
    fmt = lambda v: "-" if v is None else (f"{v:.3f}" if isinstance(v, float) else str(v))
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in [ours] + REFERENCE:
        lines.append("| " + " | ".join(fmt(r.get(c)) for c in cols) + " |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.path.join(HERE, "jev_out_modal", "model_epoch4.pt"))
    ap.add_argument("--code-dir", default=HERE)
    ap.add_argument("--suite", choices=("typed", "mix", "all", "jsonl"), default="typed")
    ap.add_argument("--jsonl", nargs="*", default=[], help="--suite jsonl: held-out example files")
    ap.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    ap.add_argument("--limit", type=int, default=0, help="typed: only the first N test cases (0 = all 400)")
    ap.add_argument("--per-source", type=int, default=200, help="mix: held-out eval examples per source")
    ap.add_argument("--report", default=None)
    args = ap.parse_args()

    agent = DecisionAgent(args.model, args.code_dir, args.device)
    report = {"model": args.model, "name": agent.name, "device": args.device}
    if args.suite in ("typed", "all"):
        print("Evaluating typed-decisions test split...")
        m, wf = score_typed(agent, args.limit or None)
        report.update(benchmark="LocalLLaMA/typed-decisions", metrics={k: round(v, 4) for k, v in m.items()},
                      per_workflow=wf, comparison=REFERENCE)
        print("\n=== typed-decisions (test) ===\n" + table(m, agent.name))
        print("\nPer workflow:", json.dumps(wf, indent=2))
    if args.suite == "jsonl":
        import decision_data
        exs = decision_data.build("jsonl", sources=args.jsonl)
        print(f"Evaluating {len(exs)} held-out examples from {args.jsonl}...")
        report["jsonl_heldout"] = score_examples(agent, exs)
        print(json.dumps(report["jsonl_heldout"], indent=2))
    if args.suite in ("mix", "all"):
        print("\nEvaluating held-out splits of the mix sources...")
        report["mix_heldout"] = score_mix(agent, args.per_source)
        print(json.dumps(report["mix_heldout"], indent=2))
    out = args.report or os.path.join(os.path.dirname(os.path.abspath(args.model)), f"eval_{args.suite}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport: {out}")


if __name__ == "__main__":
    main()
