"""Fit per-bucket temperatures on DEV and store them in the checkpoint (DecisionAgent reads them).

./venv/bin/python calibrate_evidence.py --model runs/ev1/epoch3.pt --dev data/evidence/dev.jsonl --out runs/ev1/final.pt
Only writes temperatures if they lower dev ECE; verify on test afterwards with eval_evidence.py.
"""
import argparse
import collections
import json

import numpy as np
import torch

from decision_core import (QTYPES, clamp_temperature, fit_one_temp, load_decision_model, load_tokenizer,
                           save_decision_model, temp_bucket)
from evidence.metrics import summarize
from train_evidence import load_jsonl, prep, score_logits


def softmax(z, t=1.0):
    e = np.exp((z - z.max()) / t)
    return e / e.sum()


def fit_temperatures(logits, targets):
    """Pure part: per option-count bucket temperatures plus dev metrics before/after. -> (temps, before, after)."""
    bucket = lambda z: temp_bucket(QTYPES["choice"], len(z))
    buckets = collections.defaultdict(list)
    for z, t in zip(logits, targets):
        buckets[bucket(z)].append((z, t))
    temps = {b: clamp_temperature(fit_one_temp(sel)) for b, sel in buckets.items()}
    before = summarize([softmax(z) for z in logits], targets)
    after = summarize([softmax(z, temps[bucket(z)]) for z in logits], targets)
    return temps, before, after


def choose_dcfg(dcfg, temps, before, after):
    """Temperatures go into the checkpoint only if they lowered dev ECE; otherwise stale ones are removed."""
    if after["ece"] < before["ece"]:
        return dict(dcfg, temperature_by_options=temps)
    return {k: v for k, v in dcfg.items() if k != "temperature_by_options"}


def require_examples(preps):
    if not preps:
        raise ValueError("no dev examples after prep")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--code-dir", default=".")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    a = ap.parse_args()
    dev = torch.device(a.device)
    tok = load_tokenizer(a.code_dir)
    model, dcfg, lm_cfg = load_decision_model(a.code_dir, a.model, dev)
    preps = [p for p in (prep(tok, e, dcfg.get("max_len", 1024), dcfg.get("head_max_len", 256))
                         for e in load_jsonl(a.dev)) if p]
    require_examples(preps)
    logits = score_logits(model, preps, tok.pad_token_id, dev, micro=16)
    temps, before, after = fit_temperatures(logits, [p["target"] for p in preps])
    print(json.dumps({"temperatures": temps, "dev_before": before, "dev_after": after}, indent=2))
    had_stale = "temperature_by_options" in dcfg
    dcfg = choose_dcfg(dcfg, temps, before, after)
    if "temperature_by_options" not in dcfg:
        print("temperatures did not lower dev ECE; saving without them%s"
              % ("; removed the stale temperatures from the input checkpoint" if had_stale else ""))
    save_decision_model(a.out, model, lm_cfg, dcfg)


if __name__ == "__main__":
    main()
