"""Question-free baselines for Voteview items: policies that never read the question text (plus `ask_only`, the
mirror image that never reads the record).

If one of them scores well, the item design leaks the answer through the record composition (or the party
tags) and a model could reach the same score without reading the question.
Each policy maps an item to a predicted option index (the last index is `none`).
"""
import re

import numpy as np

PARTY_TAG = re.compile(r"\((Democrat|Republican|Independent)\)$")
KINDS = ("base", "swap", "nomatch")


def _labels(ex):
    rec = next((e["text"] for e in ex["state"]["evidence"] if e["id"] == "E2"), "")
    return [line.rpartition(": ")[2] for line in rec.split("; ")] if rec else []


def _none(ex):
    return len(ex["target"]) - 1


def unique_label_policy(ex):
    """The candidate whose vote label is unique among the candidates (first if several); none if no such one."""
    labels = _labels(ex)
    return next((i for i, l in enumerate(labels) if labels.count(l) == 1), _none(ex))


def record_lacks_yea_or_nay_policy(ex):
    """none iff the record lacks Yea or lacks Nay; otherwise the unique Yea (else unique Nay) member."""
    labels = _labels(ex)
    if "Yea" not in labels or "Nay" not in labels:
        return _none(ex)
    for want in ("Yea", "Nay"):
        if labels.count(want) == 1:
            return labels.index(want)
    return _none(ex)


def lone_party_avoid_policy(ex):
    """Drop the lone-party candidate (named items) and non-voters; take the first one left, else none."""
    labels = _labels(ex)
    crit = [v for k, v in ex["question"]["criteria"].items() if k != "none"]
    parties = [m.group(1) if (m := PARTY_TAG.search(v)) else None for v in crit]
    drop = {i for i, l in enumerate(labels) if l == "Not voting"}
    if all(parties):
        lone = [i for i, p in enumerate(parties) if parties.count(p) == 1]
        if len(lone) == 1 and len(set(parties)) == 2:
            drop.add(lone[0])
    return next((i for i in range(len(labels)) if i not in drop), _none(ex))


def lone_party_pick_policy(ex):
    """The reverse cue: pick the lone-party candidate (named items); none when there is none."""
    crit = [v for k, v in ex["question"]["criteria"].items() if k != "none"]
    parties = [m.group(1) if (m := PARTY_TAG.search(v)) else None for v in crit]
    lone = [i for i, p in enumerate(parties) if p and parties.count(p) == 1]
    return lone[0] if all(parties) and len(lone) == 1 and len(set(parties)) == 2 else _none(ex)


def ask_only_policy(ex):
    """Record-free: none iff the question asks who did not vote, else the first candidate."""
    return _none(ex) if "did not vote" in ex["question"].get("instructions", "") else 0


def always_none_policy(ex):
    return _none(ex)


def _asked(ex):
    ins = ex["question"].get("instructions", "")
    return "Yea" if "voted Yea" in ins else "Nay" if "voted Nay" in ins else "Not voting" if "did not vote" in ins else None


def presence_odd_one_out_policy(ex):
    """Reads only WHICH label is asked: none if nobody cast it, else the first uniquely labelled candidate.
    (Solved every answered item before multi-singleton records.) Not question-free, so it is reported apart."""
    labels = _labels(ex)
    if _asked(ex) not in labels:
        return _none(ex)
    return next((i for i, l in enumerate(labels) if labels.count(l) == 1), _none(ex))


POLICIES = {"unique_label": unique_label_policy, "record_lacks_yea_or_nay": record_lacks_yea_or_nay_policy,
            "lone_party_avoid": lone_party_avoid_policy, "lone_party_pick": lone_party_pick_policy,
            "ask_only": ask_only_policy, "always_none": always_none_policy}


def accuracy(policy, items):
    return float(np.mean([policy(ex) == int(np.argmax(ex["target"])) for ex in items])) if items else 0.0


def question_free_report(items):
    """Accuracy of every policy on the voteview base/swap/nomatch items; {"n": 0} when there are none."""
    sel = [e for e in items if e.get("source") == "voteview" and e["meta"]["variant"] in KINDS]
    if not sel:
        return {"n": 0}
    return {"n": len(sel), **{name: accuracy(p, sel) for name, p in POLICIES.items()}}


def best_question_free_accuracy(items):
    r = question_free_report(items)
    return max((v for k, v in r.items() if k != "n"), default=0.0)


def question_aware_report(items):
    """Accuracy of the shallow question-aware policies (they read the asked label, not the roll text)."""
    sel = [e for e in items if e.get("source") == "voteview" and e["meta"]["variant"] in KINDS]
    return {"n": len(sel), "presence_odd_one_out": accuracy(presence_odd_one_out_policy, sel)} if sel else {"n": 0}
