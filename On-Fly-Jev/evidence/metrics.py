"""Accuracy / Brier / ECE and the bias report. `none` is always the last option."""
import collections

import numpy as np

from decision_core import ece_score


def summarize(probs, targets):
    if not len(probs):
        return {"n": 0}
    p = [np.asarray(x, dtype=float) for x in probs]
    t = [np.asarray(x, dtype=float) for x in targets]
    correct = [float(a.argmax() == b.argmax()) for a, b in zip(p, t)]
    return {"n": len(p), "accuracy": float(np.mean(correct)),
            "soft_accuracy": float(np.mean([float((a * b).sum()) for a, b in zip(p, t)])),
            "brier": float(np.mean([((a - b) ** 2).sum() for a, b in zip(p, t)])),
            "ece": ece_score([a.max() for a in p], correct)}


def _hit(ex, p):
    return float(np.argmax(p) == np.argmax(ex["target"]))


def _acc(pairs):
    return {"n": len(pairs), "accuracy": float(np.mean(pairs))}


def _gap(groups):
    """|D - R| accuracy gap; None unless both sides are present."""
    return abs(float(np.mean(groups["D"])) - float(np.mean(groups["R"]))) if groups.get("D") and groups.get("R") else None


def bias_report(items, probs):
    var = collections.defaultdict(list)
    for ex, p in zip(items, probs):
        var[ex["meta"].get("variant", "base")].append((ex, np.asarray(p, dtype=float)))
    rep = {"by_variant": {v: summarize([p for _, p in xs], [e["target"] for e, _ in xs]) for v, xs in var.items()},
           "none_rate": {v: float(np.mean([p.argmax() == len(p) - 1 for _, p in var[v]]))
                         for v in ("ablate", "nameprobe", "nomatch") if v in var}}
    src = collections.defaultdict(list)
    for ex, p in zip(items, probs):
        src[ex.get("source", "unknown")].append((ex, np.asarray(p, dtype=float)))
    rep["by_source"] = {s: summarize([p for _, p in xs], [e["target"] for e, _ in xs]) for s, xs in src.items()}
    # share of none targets; it is also the accuracy of an always-none policy
    rep["none_share"] = {s: {"n": len(xs), "share": float(np.mean([e["target"][-1] == 1.0 for e, _ in xs]))}
                         for s, xs in src.items()}
    side, pos = collections.defaultdict(list), collections.defaultdict(list)
    by_alias = {True: collections.defaultdict(list), False: collections.defaultdict(list)}
    picks, lone, sing = collections.Counter(), [], collections.defaultdict(list)
    for v in ("base", "swap"):
        for ex, p in var.get(v, []):
            m = ex["meta"]
            if m.get("side"):
                side[m["side"]].append(_hit(ex, p))
                if m.get("alias") in by_alias:
                    by_alias[m["alias"]][m["side"]].append(_hit(ex, p))
            if np.argmax(ex["target"]) != len(ex["target"]) - 1:
                pos[int(np.argmax(ex["target"]))].append(_hit(ex, p))
            picks["none" if np.argmax(p) == len(p) - 1 else str(int(np.argmax(p)))] += 1
            if m.get("n_singletons") is not None:
                sing["1" if m["n_singletons"] == 1 else "2+"].append(_hit(ex, p))
            if m.get("lone_party_idx") is not None:
                lone.append((int(np.argmax(p)) == m["lone_party_idx"], _hit(ex, p),
                             int(np.argmax(ex["target"])) == m["lone_party_idx"]))
    rep["by_side"] = {s: _acc(x) for s, x in side.items()}
    rep["side_n"] = {s: len(x) for s, x in side.items()}
    rep["side_gap"] = _gap(side)
    rep["side_gap_alias"] = _gap(by_alias[True])
    rep["side_gap_named"] = _gap(by_alias[False])
    rep["by_target_position"] = {k: _acc(x) for k, x in sorted(pos.items())}
    total = sum(picks.values())
    rep["pred_position_rate"] = {k: c / total for k, c in sorted(picks.items())}
    rep["lone_party"] = ({"n": len(lone), "pick_rate": float(np.mean([a for a, _, _ in lone])),
                          "accuracy": float(np.mean([b for _, b, _ in lone])),
                          "answer_is_lone_rate": float(np.mean([c for _, _, c in lone]))} if lone else None)
    rep["by_singletons"] = {k: _acc(sing[k]) for k in ("1", "2+") if sing[k]}
    conflict = [(int(np.argmax(p)) == ex["meta"]["lone_party_idx"], _hit(ex, p))
                for v in ("base", "swap", "nomatch", "askflip") for ex, p in var.get(v, [])
                if ex["meta"].get("lone_party_idx") is not None
                and int(np.argmax(ex["target"])) != ex["meta"]["lone_party_idx"]]
    rep["lone_party_conflict"] = ({"n": len(conflict), "accuracy": float(np.mean([h for _, h in conflict])),
                                   "pick_rate": float(np.mean([pk for pk, _ in conflict]))} if conflict else None)
    base = {ex["meta"]["pair_id"]: (_hit(ex, p), int(np.argmax(p)))
            for ex, p in var.get("base", []) if ex["meta"].get("pair_id") is not None}
    both = [_hit(ex, p) for ex, p in var.get("swap", [])
            if base.get(ex["meta"].get("pair_id"), (0.0,))[0] == 1.0]
    rep["swap_consistency"] = {"n": len(both), "rate": float(np.mean(both))} if both else None
    same = [int(np.argmax(p)) == base[ex["meta"]["pair_id"]][1] for ex, p in var.get("partyflip", [])
            if ex["meta"].get("pair_id") in base]
    rep["party_flip_consistency"] = {"n": len(same), "rate": float(np.mean(same))} if same else None
    ref = {ex["meta"]["pair_id"]: (_hit(ex, p), int(np.argmax(p)))
           for v in ("base", "nomatch") for ex, p in var.get(v, []) if ex["meta"].get("pair_id") is not None}
    pairs = [(ref[ex["meta"]["pair_id"]], _hit(ex, p), int(np.argmax(p))) for ex, p in var.get("askflip", [])
             if ex["meta"].get("pair_id") in ref]
    rep["ask_flip_consistency"] = ({"n": len(pairs),
                                    "changed_rate": float(np.mean([r[1] != a for r, _, a in pairs])),
                                    "both_correct_rate": float(np.mean([r[0] == 1.0 and h == 1.0 for r, h, _ in pairs]))}
                                   if pairs else None)
    return rep
