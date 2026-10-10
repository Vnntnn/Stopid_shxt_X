"""Evidence-choice example schema: validation and token-budget fitting."""
import copy

from decision_core import (OPT_MAX_TOKENS, check_question, encode, render_options, to_internal,
                           tokenize_question, tokenize_state)

NONE_KEY = "none"
MAX_LEN, HEAD_MAX_LEN = 1024, 256                 # decision_config.json
STATE_BUDGET = MAX_LEN - 1 - HEAD_MAX_LEN - 7     # <bos>, head budget, slack


def validate(ex, tok):
    """Raise ValueError if `ex` cannot be trained on as written. Returns ex."""
    for k in ("state", "question", "target", "source", "meta"):
        if k not in ex:
            raise ValueError("missing %r" % k)
    q = ex["question"]
    check_question("q", q)
    if q["type"] != "choice":
        raise ValueError("type must be 'choice'")
    crit = q["criteria"]
    if not isinstance(crit, dict) or list(crit)[-1:] != [NONE_KEY] or not 3 <= len(crit) <= 6:
        raise ValueError("criteria must be 2-5 candidates followed by a last 'none' option")
    t = ex["target"]
    if len(t) != len(crit) or min(t) < 0 or abs(sum(t) - 1) > 1e-6:
        raise ValueError("target must be a distribution over the options")
    internal = to_internal(q)
    if any(len(encode(tok, "\n- " + o)) > OPT_MAX_TOKENS for o in render_options(internal)):
        raise ValueError("option longer than %d tokens" % OPT_MAX_TOKENS)
    qt = tokenize_question(tok, internal)
    if len(qt["head"]) + sum(len(o) for o in qt["opts"]) > HEAD_MAX_LEN:
        raise ValueError("question + options exceed head_max_len")
    if len(tokenize_state(tok, ex["state"])) > STATE_BUDGET:
        raise ValueError("state exceeds %d tokens" % STATE_BUDGET)
    return ex


def fit_state(tok, state, budget=STATE_BUDGET):
    """Shrink the longest evidence text until the state fits `budget`; None if it cannot."""
    state = copy.deepcopy(state)
    ev = state["evidence"]
    while len(tokenize_state(tok, state)) > budget:
        longest = max(ev, key=lambda e: len(e["text"]), default=None)
        if longest is None or len(longest["text"]) < 40:
            return None
        # ponytail: character cut, may end mid-word; sentence-aware trimming if eval shows it matters
        longest["text"] = longest["text"][: int(len(longest["text"]) * 0.85)].rstrip()
    return state
