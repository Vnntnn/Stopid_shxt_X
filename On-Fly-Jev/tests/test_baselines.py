import pytest

from evidence import baselines, votes
from fixtures import realistic_votes_fixture, votes_fixture

PARTY = {"D": "Democrat", "R": "Republican", "I": "Independent"}


def mk(labels, target, parties=None, variant="base", source="voteview"):
    """target: index of the answer or None for 'none'."""
    keys = list("ABCD"[:len(labels)])
    crit = {k: ("Pat %s (%s)" % (k, PARTY[parties[i]]) if parties else "Candidate %s" % k) for i, k in enumerate(keys)}
    crit["none"] = "None of the candidates"
    tgt = [0.0] * len(crit)
    tgt[len(keys) if target is None else target] = 1.0
    rec = "; ".join("%s: %s" % (crit[k].split(" (")[0], lab) for k, lab in zip(keys, labels))
    return {"source": source, "state": {"evidence": [{"id": "E1", "text": "roll"}, {"id": "E2", "text": rec}]},
            "question": {"criteria": crit}, "target": tgt, "meta": {"variant": variant}}


def test_unique_label_policy():
    p = baselines.unique_label_policy
    assert p(mk(["Yea", "Nay", "Nay"], 0)) == 0
    assert p(mk(["Nay", "Yea", "Yea"], 0)) == 0
    assert p(mk(["Yea", "Nay", "Not voting"], 0)) == 0           # several unique -> the first
    assert p(mk(["Yea", "Yea", "Nay", "Nay"], None)) == 4       # none unique -> none


def test_record_lacks_yea_or_nay_policy():
    p = baselines.record_lacks_yea_or_nay_policy
    assert p(mk(["Yea", "Not voting", "Not voting"], 0)) == 3    # lacks Nay -> none
    assert p(mk(["Nay", "Nay", "Not voting"], None)) == 3        # lacks Yea -> none
    assert p(mk(["Yea", "Yea", "Nay", "Not voting"], 2)) == 2    # both present: the unique Nay
    assert p(mk(["Yea", "Nay", "Nay"], 0)) == 0                  # both present: the unique Yea
    assert p(mk(["Yea", "Yea", "Nay", "Nay"], None)) == 4        # nothing unique -> none


def test_lone_party_avoid_policy():
    p = baselines.lone_party_avoid_policy
    assert p(mk(["Yea", "Not voting", "Nay"], 0, ["D", "D", "R"])) == 0        # R is lone, idx1 did not vote
    assert p(mk(["Not voting", "Not voting", "Yea"], None, ["D", "D", "R"])) == 3
    assert p(mk(["Yea", "Nay", "Nay"], 0, ["D", "R", "I"])) == 0               # no lone candidate: nobody dropped
    assert p(mk(["Not voting", "Yea", "Nay"], 1)) == 1                          # alias: only non-voters dropped


def test_lone_party_pick_policy():
    p = baselines.lone_party_pick_policy
    assert p(mk(["Yea", "Nay", "Nay"], 0, ["R", "D", "D"])) == 0
    assert p(mk(["Yea", "Nay", "Nay"], None, ["D", "R", "I"])) == 3          # no single lone candidate -> none
    assert p(mk(["Yea", "Nay", "Nay"], 0)) == 3                               # alias items carry no party


def test_ask_only_policy_reads_the_question_not_the_record():
    a, b = mk(["Yea", "Nay", "Nay"], 0), mk(["Yea", "Nay", "Nay"], None)
    a["question"]["instructions"] = "Which candidate voted Yea on this measure?"
    b["question"]["instructions"] = "Which candidate did not vote on this measure?"
    assert baselines.ask_only_policy(a) == 0 and baselines.ask_only_policy(b) == 3


def test_always_none_and_accuracy():
    items = [mk(["Yea", "Nay", "Nay"], 0), mk(["Yea", "Yea", "Nay"], None), mk(["Nay", "Nay", "Nay"], None)]
    assert baselines.accuracy(baselines.always_none_policy, items) == pytest.approx(2 / 3)
    assert baselines.accuracy(baselines.unique_label_policy, items) == pytest.approx(2 / 3)


def test_best_question_free_accuracy_uses_only_voteview_answerable_variants():
    items = [mk(["Yea", "Nay", "Nay"], 0), mk(["Yea", "Yea", "Nay"], None, variant="nomatch"),
             mk(["Yea", "Nay", "Nay"], None, variant="ablate"), mk(["Yea", "Nay", "Nay"], None, source="fever")]
    r = baselines.question_free_report(items)
    assert r["n"] == 2 and r["always_none"] == 0.5 and r["unique_label"] == 0.5
    assert baselines.best_question_free_accuracy(items) == max(v for k, v in r.items() if k not in ("n",))
    assert baselines.question_free_report([mk(["Yea", "Nay", "Nay"], 0, source="fever")]) == {"n": 0}


def test_policies_run_on_generated_items():
    rc, mem, vt = votes_fixture()
    items = votes.build_items(rc, mem, vt, "g", n=100, seed=0, name_frac=0.5)
    r = baselines.question_free_report(items)
    assert r["n"] > 5 and all(0.0 <= r[k] <= 1.0 for k in ("unique_label", "record_lacks_yea_or_nay",
                                                            "lone_party_avoid", "lone_party_pick", "ask_only", "always_none"))


def test_best_question_free_accuracy_on_a_realistic_roll_set_is_low():
    rc, mem, vt = realistic_votes_fixture()
    items = votes.build_items(rc, mem, vt, "g", n=100000, seed=3, name_frac=0.3, swap_p=0.5)
    r = baselines.question_free_report(items)
    assert r["n"] > 1000
    assert baselines.best_question_free_accuracy(items) <= 0.70, r


def asking(ex, text):
    ex["question"]["instructions"] = "Which candidate %s on this measure?" % text
    return ex


def test_presence_odd_one_out_policy_reads_only_whether_the_asked_label_is_present():
    p = baselines.presence_odd_one_out_policy
    assert p(asking(mk(["Yea", "Nay", "Nay"], 0), "voted Yea")) == 0
    assert p(asking(mk(["Yea", "Nay", "Nay"], None), "did not vote")) == 3     # asked label absent -> none
    assert p(asking(mk(["Yea", "Nay", "Not voting"], 2), "did not vote")) == 0  # present: first unique, not the asked one
    assert p(asking(mk(["Yea", "Yea", "Nay", "Nay"], None), "voted Nay")) == 4  # present but nothing unique -> none


def test_question_aware_report_uses_voteview_answerable_variants_only():
    items = [asking(mk(["Yea", "Nay", "Nay"], 0), "voted Yea"),
             asking(mk(["Yea", "Nay", "Nay"], None, variant="nomatch"), "did not vote"),
             asking(mk(["Yea", "Nay", "Nay"], None, variant="ablate"), "voted Nay"),
             asking(mk(["Yea", "Nay", "Nay"], None, source="fever"), "voted Nay")]
    assert baselines.question_aware_report(items) == {"n": 2, "presence_odd_one_out": 1.0}
    assert baselines.question_aware_report([items[2]]) == {"n": 0}
