import re

import numpy as np

from evidence import claims
from fixtures import fever_rows


def items(n=200):
    return claims.build_items(fever_rows(), "fever-train", n=n, seed=3)


def own_number(ex):
    return int(re.search(r"Evidence sentence (\d+)", ex["state"]["evidence"][0]["text"]).group(1))


def test_supported_claim_gets_the_target_and_others_get_none():
    out = items()
    assert {e["meta"]["label"] for e in out} == {"SUPPORTS", "REFUTES", "NOT ENOUGH INFO"}
    for e in out:
        crit, tgt = e["question"]["criteria"], int(np.argmax(e["target"]))
        keys = list(crit)
        if e["meta"]["label"] == "SUPPORTS":
            assert crit[keys[tgt]] == "Claim number %d about topic %d." % (own_number(e), own_number(e))
        else:
            assert keys[tgt] == "none"


def test_distractors_come_from_other_pages():
    for e in items():
        nums = {int(re.search(r"number (\d+)", v).group(1))
                for k, v in e["question"]["criteria"].items() if k != "none"}
        assert own_number(e) in nums or e["meta"]["label"] != "SUPPORTS"
        others = nums - {own_number(e)}
        assert others and len(others) == len(nums) - (1 if own_number(e) in nums else 0)


def test_markup_is_cleaned_and_empty_evidence_rows_never_used_as_source():
    for e in items():
        assert "-LRB-" not in str(e["state"]) and "-RRB-" not in str(e["state"])
        assert "Claim without evidence." not in str(e["question"])    # evidence-less rows are never used at all
        assert e["state"]["evidence"], "every item needs evidence"


def test_option_count_is_three_to_four_with_none_last():
    for e in items():
        keys = list(e["question"]["criteria"])
        assert 3 <= len(keys) <= 4 and keys[-1] == "none"


def test_label_mix_is_roughly_half_supports():
    out = claims.build_items(fever_rows(6000), "fever-train", n=2000, seed=3)   # pool >> n: sampling is without replacement
    assert len(out) == 2000
    share = np.mean([e["meta"]["label"] == "SUPPORTS" for e in out])
    assert 0.4 < share < 0.6


def _row(i, claim, page, label="SUPPORTS", evidence=None):
    ev = [[page, "0", "Evidence sentence %d." % i]] if evidence is None else evidence
    return {"claim": claim, "label": label, "evidence": ev, "id": "r%d" % i}


def test_rows_with_empty_first_evidence_entry_do_not_crash():
    rows = fever_rows()
    for i in range(0, 40, 2):
        rows[i]["evidence"] = [[]] + rows[i]["evidence"]
    out = claims.build_items(rows, "g", n=200, seed=1)
    assert out
    assert any(e["state"]["evidence"][0]["id"] == "E2" for e in out)   # such rows do appear as sources


def test_repeated_claim_text_never_duplicates_options():
    rows = [_row(i, "Same claim." if i % 2 else "Own claim %d." % i, "P%d" % i,
                 label=["SUPPORTS", "REFUTES", "NOT ENOUGH INFO"][i % 3]) for i in range(30)]
    out = claims.build_items(rows, "g", n=300, seed=2)
    assert out
    for e in out:
        texts = [v for k, v in e["question"]["criteria"].items() if k != "none"]
        assert len(texts) == len(set(texts))
        if e["meta"]["label"] == "SUPPORTS":
            own = next(r["claim"] for r in rows if r["id"] == e["meta"]["id"])
            assert texts.count(own) == 1 and e["question"]["criteria"][list(e["question"]["criteria"])[
                int(np.argmax(e["target"]))]] == own


def test_no_distractor_available_never_emits_a_two_option_item():
    from decision_core import load_tokenizer
    from evidence.schema import validate
    import os
    tok = load_tokenizer(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    rows = [_row(0, "A claim.", "Same_Page"), _row(1, "B claim.", "Same_Page", label="REFUTES")]
    out = claims.build_items(rows, "g", n=20, seed=0)
    assert out == []
    mixed = rows + [_row(2, "C claim.", "Other_Page")]
    out = claims.build_items(mixed, "g", n=50, seed=0)
    assert out
    for e in out:
        assert len(e["question"]["criteria"]) >= 3
        validate(e, tok)


def test_empty_usable_rows_raise():
    import pytest
    with pytest.raises(ValueError, match="no usable"):
        claims.build_items([{"claim": "x", "label": "SUPPORTS", "evidence": [], "id": "a"}], "g", n=5, seed=0)


def test_sampling_is_without_replacement():
    out = claims.build_items(fever_rows(300), "g", n=200, seed=5)
    ids = [e["meta"]["id"] for e in out]
    assert len(out) == 200 and len(ids) == len(set(ids))


def test_pool_smaller_than_n_yields_each_usable_row_once():
    rows = fever_rows(40)                       # 40 usable rows + 1 without evidence
    out = claims.build_items(rows, "g", n=500, seed=6)
    ids = [e["meta"]["id"] for e in out]
    assert len(ids) == len(set(ids)) == 40
    assert "idx" not in ids
