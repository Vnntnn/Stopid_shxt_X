"""FEVER (copenlu/fever_gold_evidence) -> evidence-choice items (T2: which claim does the evidence support).

SUPPORTS -> target on the claim. REFUTES / NOT ENOUGH INFO -> target on 'none'. Distractor claims come
from other evidence pages so they are not supported by this evidence. An item whose distractor pool ends up
empty is skipped, and rows are consumed without replacement (an exhausted label is
dropped), so build_items may return fewer than n items.
"""
import random

LICENSE = "Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0). Derived from FEVER (https://fever.ai/download/fever/license.html; annotations incorporate Wikipedia material licensed under the Wikipedia Copyright Policy) via copenlu/fever_gold_evidence (Atanasova, Wright, Augenstein, EMNLP 2020)."
FIX = {"-LRB-": "(", "-RRB-": ")", "-LSB-": "[", "-RSB-": "]", "-LCB-": "{", "-RCB-": "}"}
INSTR = "Which claim is supported by the evidence? Choose none if the evidence does not support any claim."
WEIGHTS = {"SUPPORTS": 0.5, "REFUTES": 0.25, "NOT ENOUGH INFO": 0.25}


def clean(s):
    for a, b in FIX.items():
        s = s.replace(a, b)
    return " ".join(s.split())


def _evidence(row):
    return [{"id": "E%d" % (i + 1), "type": "fact_check", "page": clean(e[0].replace("_", " ")),
             "text": clean(e[-1])} for i, e in enumerate(row["evidence"]) if e and e[-1].strip()]


def _pages(row):
    return {e[0] for e in row["evidence"] if isinstance(e, list) and e and isinstance(e[0], str)}


def build_items(rows, group, n, seed):
    rng = random.Random(seed)
    usable = [r for r in rows if _evidence(r)]
    by_label = {l: [r for r in usable if r["label"] == l] for l in WEIGHTS}
    labels = [l for l in WEIGHTS if by_label[l]]
    if not labels:
        raise ValueError("no usable FEVER rows")
    queues = {l: rng.sample(by_label[l], len(by_label[l])) for l in labels}    # sampled WITHOUT replacement
    out = []
    while len(out) < n and queues:
        label = rng.choices(list(queues), weights=[WEIGHTS[l] for l in queues])[0]
        r = queues[label].pop()
        if not queues[label]:
            del queues[label]
        own = clean(r["claim"])
        pages = _pages(r)
        others = [clean(x["claim"]) for x in rng.sample(usable, min(50, len(usable))) if not _pages(x) & pages]
        others = [c for c in dict.fromkeys(others) if c != own]
        if not others:
            continue
        cl = [own] + others[: rng.choice([1, 2])]
        rng.shuffle(cl)
        keys = list("ABC"[: len(cl)])
        crit = dict(zip(keys, cl))
        crit["none"] = "None of the claims"
        target = [0.0] * len(crit)
        target[cl.index(own) if label == "SUPPORTS" else len(crit) - 1] = 1.0
        out.append({"state": {"task": "Pick the claim the evidence supports", "evidence": _evidence(r)},
                    "question": {"type": "choice", "instructions": INSTR, "criteria": crit},
                    "target": target, "source": "fever",
                    "meta": {"id": r["id"], "pair_id": r["id"], "variant": "base", "group": group, "alias": True,
                             "side": None, "lang": "en", "label_method": "annotators", "label": label,
                             "license": LICENSE}})
    return out
