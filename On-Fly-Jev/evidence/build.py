"""Build train/dev/test jsonl: ./venv/bin/python -m evidence.build --out data/evidence"""
import argparse
import collections
import json
import os
import sys

from decision_core import load_tokenizer
from evidence import claims, votes
from evidence.schema import fit_state, validate

SPLITS = {"train": ["congress-%d" % c for c in range(110, 117)], "dev": ["congress-117"], "test": ["congress-118"]}
FEVER = {"train": "train", "dev": "validation", "test": "test"}


def voteview_params(split):
    """Per-split Voteview knobs. Train has a few named candidates WITHOUT party tags (names in-distribution, no
    party cue); party tags, nameprobe and the flip probes exist only in the dev/test stress slice."""
    if split not in SPLITS:
        raise KeyError(split)
    stress = split in ("dev", "test")
    return {"name_frac": 0.3 if stress else 0.1, "party_tags": stress, "nameprobe": stress,
            "partyflip_p": 0.3 if stress else 0.0, "askflip_p": 0.3 if stress else 0.0}


def finalize(tok, items, stats):
    out = []
    for ex in items:
        st = fit_state(tok, ex["state"])
        if st is None:
            stats["dropped: state cannot fit"] += 1
            continue
        ex["state"] = st
        try:
            out.append(validate(ex, tok))
        except ValueError as e:
            stats["dropped: " + str(e)[:40]] += 1
    return out


def check_no_group_leak(by_split):
    seen = {}
    for split, items in by_split.items():
        for ex in items:
            g = ex["meta"]["group"]
            if seen.setdefault(g, split) != split:
                raise ValueError("group %s appears in %s and %s" % (g, seen[g], split))


def describe(items):
    c = collections.Counter((e["source"], e["meta"]["variant"]) for e in items)
    return {"n": len(items), "by_source_variant": {"%s/%s" % k: v for k, v in sorted(c.items())},
            "by_variant": dict(sorted(collections.Counter(e["meta"]["variant"] for e in items).items())),
            "none_rate": sum(e["target"][-1] == 1.0 for e in items) / max(1, len(items)),
            "side": dict(collections.Counter(e["meta"]["side"] for e in items))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/evidence")
    ap.add_argument("--code-dir", default=".")
    ap.add_argument("--votes-per-congress", type=int, default=3000)
    ap.add_argument("--fever-train", type=int, default=20000)
    ap.add_argument("--fever-dev", type=int, default=2000)
    ap.add_argument("--fever-test", type=int, default=2000)
    ap.add_argument("--allow-unverified", action="store_true")
    args = ap.parse_args()
    for mod in (votes, claims):
        if mod.LICENSE == "unverified" and not args.allow_unverified:
            sys.exit("%s.LICENSE is still 'unverified': finish Task 1 or pass --allow-unverified" % mod.__name__)

    tok = load_tokenizer(args.code_dir)
    by_split, stats = {s: [] for s in SPLITS}, collections.Counter()
    for split, groups in SPLITS.items():
        for g in groups:
            c = int(g.split("-")[1])
            rc, mem, vt = votes.load(votes.download(c, os.path.join(args.out, "raw", "voteview")))
            by_split[split] += finalize(tok, votes.build_items(rc, mem, vt, g, args.votes_per_congress, seed=c,
                                                          **voteview_params(split)), stats)
    from datasets import load_dataset  # deferred: gate and Voteview run first
    sizes = {"train": args.fever_train, "dev": args.fever_dev, "test": args.fever_test}
    for split, name in FEVER.items():
        ds = load_dataset("copenlu/fever_gold_evidence", split=name).shuffle(seed=0)
        rows = list(ds.select(range(min(len(ds), sizes[split] * 4))))
        by_split[split] += finalize(tok, claims.build_items(rows, "fever-" + name, sizes[split], seed=0), stats)
    check_no_group_leak(by_split)
    os.makedirs(args.out, exist_ok=True)
    for split, items in by_split.items():
        with open(os.path.join(args.out, split + ".jsonl"), "w", encoding="utf-8") as f:
            f.writelines(json.dumps(e, ensure_ascii=False) + "\n" for e in items)
    report = {"splits": {s: describe(i) for s, i in by_split.items()}, "dropped": dict(stats)}
    with open(os.path.join(args.out, "stats.json"), "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
