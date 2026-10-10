"""fastino/fast-decisions development split on On-Fly-Jev.

The files on the Hub are the development split (100 rows x 17 domains). The
test split is held out. A score from this script is not that benchmark.

Scoring matches the card: one head is correct when the predicted label set
equals true_label. Single-label heads are one choice question whose criteria
are the row's full label list. Multi-label heads are one yes/no question per
candidate label; a label is predicted when noul >= 0.5.
"""
import argparse
import json
import os
import time

import numpy as np

from agent import DecisionAgent

HERE = os.path.dirname(os.path.abspath(__file__))
DOMAINS = [
    "support_intent", "support_topic", "document_type", "review_sentiment",
    "agent_handoff", "email_triage", "ticket_route", "product_feedback",
    "banking_intent", "clinic_request", "travel_request", "news_topic",
    "paper_field", "sports_recap", "restaurant_review", "benefits_request",
    "screen_tags",
]


def questions_for(heads):
    questions = {}
    plan = []
    for i, head in enumerate(heads):
        task = head["task"]
        labels = [str(x) for x in head["labels"]]
        if head["multi_label"]:
            ids = []
            for j, lab in enumerate(labels):
                qid = "m%d_%d" % (i, j)
                questions[qid] = {
                    "type": "noul",
                    "instructions": "For the task %s, does the label %s apply to the text?" % (task, lab),
                    "criteria": {"true": "the label applies", "false": "the label does not apply"},
                    "labels": {"true": "yes", "false": "no"},
                }
                ids.append((qid, lab))
            plan.append(("multi", task, ids, [str(x) for x in head["true_label"]]))
        else:
            qid = "s%d" % i
            questions[qid] = {
                "type": "choice",
                "instructions": "Choose the single %s label that fits the text. Use only the given labels." % task,
                "criteria": {lab: "" for lab in labels},
            }
            plan.append(("single", task, qid, [str(x) for x in head["true_label"]]))
    return questions, plan


def predicted_set(answers, kind, spec):
    if kind == "single":
        return [answers[spec]["choice"]]
    return [lab for qid, lab in spec if answers[qid]["noul"] >= 0.5]


def peak_rss_mb():
    try:
        import psutil
        return psutil.Process().memory_info().rss / (1024 * 1024)
    except Exception:
        return 0.0


def one_head(head, index):
    questions, plan = questions_for([head])
    return questions, plan[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.path.join(HERE, "On-Fly-Jev.pt"))
    ap.add_argument("--device", default="cuda", choices=("cpu", "cuda"))
    ap.add_argument("--domains", nargs="*", default=DOMAINS)
    ap.add_argument("--limit", type=int, default=0, help="rows per domain (0 = all)")
    ap.add_argument("--report", default=os.path.join(HERE, "eval_fast_decisions.json"))
    args = ap.parse_args()

    from datasets import load_dataset

    t_load = time.perf_counter()
    agent = DecisionAgent(args.model, HERE, args.device)
    load_s = time.perf_counter() - t_load
    rss = peak_rss_mb()
    per_domain = {}
    hits_all, conf_all, lat_all = [], [], []
    print("model %s device %s load %.1fs" % (args.model, args.device, load_s), flush=True)
    print("split: development (published files). Not the held-out test benchmark.", flush=True)
    print("timing: one head per call, batch 1", flush=True)
    for name in args.domains:
        ds = load_dataset("fastino/fast-decisions", name, split="train")
        if args.limit:
            ds = ds.select(range(min(args.limit, len(ds))))
        hits, confs, lat, per_task = [], [], [], {}
        for row in ds:
            for i, head in enumerate(row["output"]["classifications"]):
                questions, (kind, task, spec, gold) = one_head(head, i)
                t0 = time.perf_counter()
                answers = agent.predict(row["input"], questions)["answers"]
                lat.append((time.perf_counter() - t0) * 1000.0)
                rss = max(rss, peak_rss_mb())
                got = predicted_set(answers, kind, spec)
                ok = float(sorted(got) == sorted(gold))
                hits.append(ok)
                per_task.setdefault(task, []).append(ok)
                if kind == "single":
                    confs.append(float(max(answers[spec]["probabilities"].values())))
                else:
                    yes = [answers[qid]["noul"] for qid, _ in spec]
                    confs.append(float(np.mean([max(p, 1.0 - p) for p in yes])) if yes else 0.5)
        acc = float(np.mean(hits)) if hits else 0.0
        per_domain[name] = {
            "n_rows": len(ds),
            "n_heads": len(hits),
            "exact_match": round(acc, 4),
            "latency_p50_ms": round(float(np.percentile(lat, 50)), 2) if lat else 0.0,
            "heads": {t: {"n": len(v), "exact_match": round(float(np.mean(v)), 4)} for t, v in per_task.items()},
        }
        hits_all.extend(hits)
        conf_all.extend(confs)
        lat_all.extend(lat)
        print("  %s  exact %.3f  heads %d  p50 %.1f ms" % (name, acc, len(hits), per_domain[name]["latency_p50_ms"]), flush=True)

    n = len(hits_all)
    wall_s = float(np.sum(lat_all)) / 1000.0 if lat_all else 0.0
    report = {
        "benchmark": "fastino/fast-decisions",
        "split": "development",
        "note": "Published files only. Not the held-out test benchmark (300 per domain).",
        "model": args.model,
        "name": agent.name,
        "device": args.device,
        "precision": "fp32" if args.device == "cpu" else "bf16",
        "metric": "exact set match per head",
        "multi_label": "one noul question per candidate; predicted when noul >= 0.5",
        "batch": 1,
        "n_heads": n,
        "exact_match": round(float(np.mean(hits_all)), 4) if hits_all else 0.0,
        "mean_confidence": round(float(np.mean(conf_all)), 4) if conf_all else 0.0,
        "latency_p50_ms": round(float(np.percentile(lat_all, 50)), 1) if lat_all else 0.0,
        "latency_p95_ms": round(float(np.percentile(lat_all, 95)), 1) if lat_all else 0.0,
        "decisions_per_s": round(n / wall_s, 1) if wall_s else 0.0,
        "peak_rss_mb": round(rss, 0),
        "load_s": round(load_s, 1),
        "threads": int(__import__("torch").get_num_threads()),
        "per_domain": per_domain,
    }
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    acc = 100.0 * report["exact_match"]
    print("overall exact %.4f on %d heads" % (report["exact_match"], report["n_heads"]), flush=True)
    print("| # | model | precision | accuracy | p50 ms | p95 ms | decisions/s | peak RSS MB | load s | Pareto |", flush=True)
    print("|--:|---|---|--:|--:|--:|--:|--:|--:|:-:|", flush=True)
    print("| 1 | %s | %s | %.1f %% | %.1f | %.1f | %.1f | %.0f | %.1f | ✓ |" % (
        agent.name, report["precision"], acc, report["latency_p50_ms"], report["latency_p95_ms"],
        report["decisions_per_s"], report["peak_rss_mb"], report["load_s"]), flush=True)
    print("report %s" % args.report, flush=True)


if __name__ == "__main__":
    main()
