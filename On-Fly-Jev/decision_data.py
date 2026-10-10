"""Typed-decision training data.

Every example is {"state", "question" (Laya/Jev question dict), "target" (distribution over the
question's options in render order), "source"}.

`typed`  : LocalLLaMA/typed-decisions train split (soft teacher distributions), exactly what the
           Laya fine-tuning notebook trains on.
`mix`    : typed-decisions + public classification/NLI/sentiment/QA sets rewritten as typed
           choice / score / noul questions, to train a GENERAL System-1 decision engine the way
           Jev / base Laya are general (Laya's base training data is not published, so this mix
           is ours). Instruction wording and option descriptions are varied per example so the
           model learns to read the question instead of memorising one template.
"""
import json
import random

from decision_core import gold_to_target

TYPED = ("LocalLLaMA/typed-decisions", "all")


def _typed(split, limit=None):
    from datasets import load_dataset
    out = []
    for row in load_dataset(*TYPED, split=split):
        state = json.loads(row["state"])
        questions, gold = json.loads(row["questions"]), json.loads(row["gold"])
        for qid, q in questions.items():
            if qid in gold:
                target, _ = gold_to_target(q, gold[qid])
                out.append({"state": state, "question": q, "target": target, "source": "typed-decisions",
                            "workflow": row["workflow"]})
        if limit and len(out) >= limit:
            break
    return out


def _stream(path, name, split, n, seed):
    from datasets import load_dataset
    ds = load_dataset(path, name, split=split, streaming=True)
    if split.startswith("train"):
        ds = ds.shuffle(seed=seed, buffer_size=10_000)
    return ds.take(n)


def _onehot(k, i):
    t = [0.0] * k
    t[i] = 1.0
    return t


def _pick(rng, xs):
    return xs[rng.randrange(len(xs))]


def _choice_q(rng, instructions, labels, descs=None):
    crit = {lab: (descs[lab] if descs and rng.random() < 0.7 else None) for lab in labels}
    return {"type": "choice", "instructions": _pick(rng, instructions), "criteria": crit}


def _subsample_labels(rng, all_labels, gold, max_opts):
    others = [l for l in all_labels if l != gold]
    rng.shuffle(others)
    labs = others[: max_opts - 1] + [gold]
    rng.shuffle(labs)
    return labs


# --------------------------------------------------------------------------- #
# Source converters: (hf path, config, train split, eval split, fn(row, rng) -> example)
# --------------------------------------------------------------------------- #
EMOTIONS = ["sadness", "joy", "love", "anger", "fear", "surprise"]
EMO_DESC = {"sadness": "the writer feels sad or down", "joy": "the writer feels happy",
            "love": "the writer feels affection or love", "anger": "the writer feels angry or annoyed",
            "fear": "the writer feels afraid or anxious", "surprise": "the writer feels surprised"}
AG = ["World", "Sports", "Business", "Sci/Tech"]
AG_DESC = {"World": "international news and politics", "Sports": "sport results and athletes",
           "Business": "companies, markets and the economy", "Sci/Tech": "science and technology"}
NLI = ["entailment", "neutral", "contradiction"]
NLI_DESC = {"entailment": "the hypothesis must be true given the premise",
            "neutral": "the hypothesis might or might not be true",
            "contradiction": "the hypothesis cannot be true given the premise"}
STARS = ["very negative (1 star)", "negative (2 stars)", "mixed (3 stars)",
         "positive (4 stars)", "very positive (5 stars)"]


def _emotion(r, rng):
    q = _choice_q(rng, ["Which emotion does the writer express?", "What is the main feeling in this message?",
                        "Classify the emotion of this text."], EMOTIONS, EMO_DESC)
    return r["text"], q, _onehot(6, int(r["label"]))


def _ag(r, rng):
    q = _choice_q(rng, ["Which news section does this article belong to?", "What is the topic of this article?",
                        "Route this story to the right desk."], AG, AG_DESC)
    return r["text"], q, _onehot(4, int(r["label"]))


def _intent(label_key, max_opts, instr):
    def fn(r, rng):
        labels = fn.labels    # full label set, filled from the train split by build()
        gold = str(r[label_key])
        if labels is None or gold not in labels:
            return None
        labs = _subsample_labels(rng, labels, gold, max_opts)
        crit = {l: (l.replace("_", " ") if rng.random() < 0.5 else None) for l in labs}
        return r["text"], {"type": "choice", "instructions": _pick(rng, instr), "criteria": crit}, \
            _onehot(len(labs), labs.index(gold))
    fn.labels = None
    return fn


def _boolq(r, rng):
    q = {"type": "noul", "instructions": r["question"].strip().rstrip("?") + "?"}
    if rng.random() < 0.5:
        q["criteria"] = {"false": "the passage says no", "true": "the passage says yes"}
    y = 1 if r["answer"] else 0
    return {"passage": r["passage"]} if rng.random() < 0.5 else r["passage"], q, [1.0 - y, float(y)]


def _sentiment(text_key):
    def fn(r, rng):
        y = int(r["label"])
        if rng.random() < 0.5:
            q = {"type": "noul", "instructions": _pick(rng, ["Is the sentiment of this text positive?",
                                                             "Is the reviewer happy with it?",
                                                             "The writer is positive about the subject."])}
            return r[text_key], q, [1.0 - y, float(y)]
        q = _choice_q(rng, ["What is the sentiment of this text?", "How does the writer feel about it?"],
                      ["negative", "positive"], {"negative": "unfavourable, critical", "positive": "favourable, pleased"})
        return r[text_key], q, _onehot(2, y)
    return fn


def _yelp(r, rng):
    q = {"type": "score", "instructions": _pick(rng, ["How positive is this review?", "Rate the customer's satisfaction.",
                                                      "How many stars does this review deserve?"]),
         "criteria": STARS}
    return r["text"], q, _onehot(5, int(r["label"]))


def _hate(r, rng):
    y = int(r["label"])
    q = {"type": "noul", "instructions": _pick(rng, ["Does this text contain hate speech?",
                                                     "This message attacks people for who they are."]),
         "criteria": {"false": "no hateful content", "true": "hateful towards a group"}}
    return r["text"], q, [1.0 - y, float(y)]


def _nli(r, rng):
    if int(r["label"]) < 0:
        return None
    q = _choice_q(rng, ["How does the hypothesis relate to the premise?",
                        "Given the premise, is the hypothesis entailed, neutral or contradicted?"], NLI, NLI_DESC)
    return {"premise": r["premise"], "hypothesis": r["hypothesis"]}, q, _onehot(3, int(r["label"]))


SOURCES = {
    # name: (path, config, train split, eval split, converter, label_key for label-set sources)
    "emotion":  ("dair-ai/emotion", "split", "train", "validation", _emotion, None),
    "ag_news":  ("fancyzhx/ag_news", None, "train", "test", _ag, None),
    "banking77": ("mteb/banking77", None, "train", "test",
                  _intent("label_text", 20, ["Which banking intent does the customer have?",
                                             "Route this customer message to the right intent."]), "label_text"),
    "massive":  ("mteb/amazon_massive_intent", "en", "train", "validation",
                 _intent("label", 20, ["What does the user want the assistant to do?",
                                       "Which intent is this voice command?"]), "label"),
    "boolq":    ("google/boolq", None, "train", "validation", _boolq, None),
    "sst2":     ("stanfordnlp/sst2", None, "train", "validation", _sentiment("sentence"), None),
    "imdb":     ("stanfordnlp/imdb", None, "train", "test", _sentiment("text"), None),
    "yelp":     ("Yelp/yelp_review_full", None, "train", "test", _yelp, None),
    "hate":     ("cardiffnlp/tweet_eval", "hate", "train", "validation", _hate, None),
    "mnli":     ("nyu-mll/multi_nli", None, "train", "validation_matched", _nli, None),
}


def _label_set(path, name, key):
    from datasets import load_dataset
    ds = load_dataset(path, name, split="train")
    return sorted({str(x) for x in ds[key]})


def build(kind: str, split: str = "train", per_source: int = 6000, typed_repeat: int = 2, seed: int = 0,
          sources=None):
    """Return a list of examples. split='train' or 'eval' (held-out splits, never trained on)."""
    rng = random.Random(seed + (0 if split == "train" else 7))
    if kind == "jsonl":            # pre-built examples, e.g. doom/collect_doom_states.py output
        out = []
        for path in (sources or []):
            with open(path, encoding="utf-8") as fh:
                out.extend(json.loads(line) for line in fh if line.strip())
        rng.shuffle(out)
        return out
    if kind == "typed":
        return _typed("train" if split == "train" else "test")
    out = []
    typed = _typed("train" if split == "train" else "test")
    out.extend(typed * (typed_repeat if split == "train" else 1))
    for name in (sources or SOURCES):
        path, cfg, tr, ev, fn, label_key = SOURCES[name]
        n = per_source
        try:
            if label_key and fn.labels is None:
                fn.labels = _label_set(path, cfg, label_key)
            got = 0
            for r in _stream(path, cfg, tr if split == "train" else ev, n * 2, seed):
                ex = fn(r, rng)
                if ex is None:
                    continue
                state, q, target = ex
                out.append({"state": state, "question": q, "target": target, "source": name})
                got += 1
                if got >= n:
                    break
            print(f"  [data] {name:10s} {split}: {got}")
        except Exception as e:   # a dead mirror must not kill the whole build
            print(f"  [data] {name}: SKIPPED ({type(e).__name__}: {str(e)[:120]})")
    rng.shuffle(out)
    return out
