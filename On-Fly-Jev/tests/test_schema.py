import os

import pytest

from decision_core import load_tokenizer
from evidence.schema import STATE_BUDGET, fit_state, validate
from decision_core import tokenize_state

TOK = load_tokenizer(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LONG = "The quick brown fox jumps over the lazy dog. " * 300


def item(**over):
    ex = {"state": {"task": "t", "evidence": [{"id": "E1", "type": "roll_call", "text": "Bill passed."}]},
          "question": {"type": "choice", "instructions": "Which candidate voted Nay?",
                       "criteria": {"A": "Candidate A", "B": "Candidate B", "none": "None of the candidates"}},
          "target": [0.0, 1.0, 0.0], "source": "t", "meta": {}}
    ex.update(over)
    return ex


def test_valid_item_passes():
    assert validate(item(), TOK)


def test_rejects_missing_none():
    q = item()["question"]
    q["criteria"] = {"A": "a", "B": "b", "C": "c"}
    with pytest.raises(ValueError, match="none"):
        validate(item(question=q), TOK)


def test_rejects_non_choice():
    q = item()["question"]
    q["type"] = "noul"
    with pytest.raises(ValueError):
        validate(item(question=q), TOK)


def test_rejects_bad_target():
    with pytest.raises(ValueError, match="target"):
        validate(item(target=[0.5, 0.2, 0.2]), TOK)


def test_rejects_option_over_48_tokens():
    q = item()["question"]
    q["criteria"]["A"] = "word " * 80
    with pytest.raises(ValueError, match="option"):
        validate(item(question=q), TOK)


def test_rejects_state_over_budget():
    st = {"task": "t", "evidence": [{"id": "E1", "type": "x", "text": LONG}]}
    with pytest.raises(ValueError, match="state"):
        validate(item(state=st), TOK)


def test_fit_state_trims_english_to_budget_and_keeps_original():
    st = {"task": "t", "evidence": [{"id": "E1", "type": "x", "text": LONG}]}
    out = fit_state(TOK, st)
    assert len(tokenize_state(TOK, out)) <= STATE_BUDGET
    assert len(out["evidence"][0]["text"]) < len(LONG) and st["evidence"][0]["text"] == LONG


THAI = "ผู้สมัครคนใดได้รับการสนับสนุนจากหลักฐาน" * 40      # ~1,600 chars ~ 4,800 tokens


def test_rejects_thai_state_over_budget():
    st = {"task": "t", "evidence": [{"id": "E1", "type": "x", "text": THAI}]}
    with pytest.raises(ValueError, match="state"):
        validate(item(state=st), TOK)


def test_thai_evidence_is_trimmed_hard_not_passed_through():
    st = {"task": "t", "evidence": [{"id": "E1", "type": "x", "text": THAI}]}
    out = fit_state(TOK, st)
    assert out is not None and len(out["evidence"][0]["text"]) < 300
    assert len(tokenize_state(TOK, out)) <= STATE_BUDGET


def test_fit_state_returns_none_when_it_cannot_fit():
    assert fit_state(TOK, item()["state"], budget=5) is None
