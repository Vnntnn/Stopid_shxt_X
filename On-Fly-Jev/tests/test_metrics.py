import numpy as np
import pytest

from evidence.metrics import bias_report, summarize


def ex(variant, target, pair="p1", side="D"):
    return {"target": target, "meta": {"variant": variant, "pair_id": pair, "side": side}}


def test_summarize():
    r = summarize([[0.9, 0.1], [0.2, 0.8]], [[1, 0], [0, 1]])
    assert r["n"] == 2 and r["accuracy"] == 1.0 and r["brier"] == pytest.approx(0.05)


def test_summarize_empty():
    assert summarize([], []) == {"n": 0}


def test_bias_report_swap_none_side_and_position():
    items = [ex("base", [0, 1, 0]), ex("swap", [1, 0, 0]), ex("ablate", [0, 0, 1], pair="p2", side=None),
             ex("base", [1, 0, 0], pair="p3", side="R")]
    probs = [np.array(p) for p in ([0.1, 0.8, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8], [0.7, 0.2, 0.1])]
    r = bias_report(items, probs)
    assert r["swap_consistency"] == {"n": 1, "rate": 0.0}          # base right, swap wrong
    assert r["none_rate"] == {"ablate": 1.0}
    assert r["by_side"]["D"]["accuracy"] == 0.5 and r["by_side"]["R"]["accuracy"] == 1.0
    assert r["side_gap"] == pytest.approx(0.5)
    assert r["by_target_position"][0]["n"] == 2 and r["by_target_position"][1]["n"] == 1
    assert set(r["by_variant"]) == {"base", "swap", "ablate"}


def test_bias_report_without_pairs_or_sides():
    r = bias_report([ex("base", [0, 1, 0], side=None)], [np.array([0.2, 0.7, 0.1])])
    assert r["swap_consistency"] is None and r["by_side"] == {} and r["side_gap"] is None


# ---- fix wave: shortcut-aware metrics --------------------------------------------------------------

def it(variant, target, pair="p", side="D", source="voteview", alias=True, lone=None, one=None, ns=None):
    meta = {"variant": variant, "side": side, "alias": alias, "lone_party_idx": lone}
    if ns is not None:
        meta["n_singletons"] = ns
    if pair is not None:
        meta["pair_id"] = pair
    if one != "absent":
        meta["distractors_one_label"] = one
    return {"source": source, "target": target, "meta": meta}


A, B, N = [1, 0, 0], [0, 1, 0], [0, 0, 1]          # targets: option 0, option 1, none
PA, PB, PN = [0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8]


def test_summarize_soft_accuracy():
    r = summarize([[0.9, 0.1], [0.2, 0.8]], [[1, 0], [0, 1]])
    assert r["soft_accuracy"] == pytest.approx(0.85)
    assert r["n"] == 2 and "ece" in r and "brier" in r


def test_side_gap_is_d_vs_r_only_with_n_and_alias_named_splits():
    items = [it("base", A, "a", "D", alias=True), it("base", A, "b", "D", alias=False),
             it("base", A, "c", "R", alias=True), it("base", A, "d", "R", alias=False),
             it("base", A, "e", "I", alias=True), it("base", A, "f", "I", alias=True)]
    probs = [PA, PB, PB, PB, PA, PA]          # D: 1/2 right; R: 0/2; I: 2/2 (counting I would make the gap 1.0)
    r = bias_report(items, probs)
    assert r["by_side"] == {"D": {"n": 2, "accuracy": 0.5}, "R": {"n": 2, "accuracy": 0.0},
                            "I": {"n": 2, "accuracy": 1.0}}
    assert r["side_n"] == {"D": 2, "R": 2, "I": 2}
    assert r["side_gap"] == pytest.approx(0.5)
    assert r["side_gap_alias"] == pytest.approx(1.0)       # alias: D 1/1 right, R 0/1
    assert r["side_gap_named"] == pytest.approx(0.0)       # named: D 0/1, R 0/1


def test_side_gap_is_none_when_d_or_r_is_missing():
    items = [it("base", A, "a", "D"), it("base", A, "b", "I")]
    r = bias_report(items, [PA, PB])
    assert r["side_gap"] is None and r["side_gap_alias"] is None and r["side_gap_named"] is None
    assert r["side_n"] == {"D": 1, "I": 1}


def test_by_source_and_none_share():
    items = [it("base", A, "a", source="voteview"), it("ablate", N, "a", source="voteview", side=None),
             it("nomatch", N, "a", source="voteview", side=None), it("base", B, "b", source="voteview"),
             it("base", N, "f1", source="fever", side=None), it("base", N, "f2", source="fever", side=None),
             it("base", A, "f3", source="fever", side=None)]
    probs = [PA, PN, PA, PB, PN, PA, PA]
    r = bias_report(items, probs)
    assert r["by_source"]["voteview"]["n"] == 4 and r["by_source"]["voteview"]["accuracy"] == pytest.approx(0.75)
    assert r["by_source"]["fever"]["n"] == 3 and r["by_source"]["fever"]["accuracy"] == pytest.approx(2 / 3)
    # none_share is {n, share} only: the share of none targets IS the accuracy of an always-none policy
    assert r["none_share"]["voteview"] == {"n": 4, "share": 0.5}
    assert r["none_share"]["fever"] == {"n": 3, "share": pytest.approx(2 / 3)}


def test_none_rate_covers_ablate_nameprobe_and_nomatch():
    items = [it("ablate", N, "a", side=None), it("ablate", N, "b", side=None), it("nameprobe", N, "c", side=None),
             it("nomatch", N, "d", side=None), it("nomatch", N, "e", side=None), it("nomatch", N, "f", side=None),
             it("nomatch", N, "g", side=None)]
    r = bias_report(items, [PN, PA, PN, PN, PA, PA, PA])
    assert r["none_rate"] == {"ablate": 0.5, "nameprobe": 1.0, "nomatch": 0.25}


def test_pred_position_rate_over_base_and_swap():
    items = [it("base", A, "a"), it("swap", B, "a"), it("base", B, "b"), it("base", N, "c", side=None),
             it("ablate", N, "d", side=None)]
    r = bias_report(items, [PA, PB, PA, PN, PA])
    assert r["pred_position_rate"] == {"0": 0.5, "1": 0.25, "none": 0.25}     # option index vs none never mixed
    assert bias_report([it("base", A), it("swap", [1, 0, 0, 0])], [PA, [0.1, 0.1, 0.1, 0.7]])[
        "pred_position_rate"] == {"0": 0.5, "none": 0.5}


def test_party_flip_consistency_compares_argmax_of_base_and_partyflip():
    items = [it("base", A, "p1", alias=False), it("partyflip", A, "p1", alias=False),
             it("base", A, "p2", alias=False), it("partyflip", A, "p2", alias=False),
             it("base", A, "p3", alias=False),
             it("base", A, "p4", alias=False), it("partyflip", A, "p4", alias=False)]
    # p1 same pick; p2 pick moves 0 -> 1; p4 pick moves 1 -> 2 (both wrong: a hit-based comparison would say "same")
    r = bias_report(items, [PA, [0.7, 0.2, 0.1], PA, PB, PB, PB, PN])
    assert r["party_flip_consistency"] == {"n": 3, "rate": pytest.approx(1 / 3)}
    assert bias_report([it("base", A)], [PA])["party_flip_consistency"] is None


def test_lone_party_pick_rate_accuracy_and_base_rate():
    items = [it("base", A, "a", alias=False, lone=1), it("base", B, "b", alias=False, lone=1),
             it("swap", A, "c", alias=False, lone=2), it("base", A, "g", alias=False, lone=0),
             it("base", A, "d", alias=False, lone=None), it("base", A, "e", alias=True, lone=None)]
    r = bias_report(items, [PB, PB, PB, PB, PB, PA])
    # picks: a yes, b yes, c no, g no -> 2/4; hits: only b -> 1/4;
    # answer_is_lone (target idx == lone idx): b and g -> 2/4. g has target == lone but a MISS: a mutant that
    # derives the base rate from `hit` would say 1/4.
    assert r["lone_party"] == {"n": 4, "pick_rate": pytest.approx(0.5), "accuracy": pytest.approx(0.25),
                               "answer_is_lone_rate": pytest.approx(0.5)}
    assert bias_report([it("base", A)], [PA])["lone_party"] is None


def test_ask_flip_consistency_pairs_askflip_with_base_or_nomatch():
    items = [it("base", A, "p1"), it("askflip", N, "p1"),          # argmax 0 -> 2: changed, both correct
             it("base", A, "p2"), it("askflip", B, "p2"),          # 0 -> 0: unchanged, base right, flip wrong
             it("nomatch", N, "p3"), it("askflip", A, "p3"),       # 2 -> 1: changed, base right, flip wrong
             it("base", A, "p4"), it("swap", B, "p4"),             # swap is not a pair member
             it("askflip", A, "p9"),                               # no reference item: ignored
             it("base", A, "p5"), it("askflip", N, "p5"),          # 1 -> 0: changed, both wrong (hits equal)
             it("base", A, "p6"), it("askflip", B, "p6"),          # 1 -> 1: unchanged, base wrong, flip right
             it("base", A, "p7"), it("askflip", B, "p7")]          # 0 -> 0: unchanged, base right, flip wrong
    probs = [PA, PN, PA, PA, PN, PB, PA, PB, PA, PB, PA, PB, PB, PA, PA]
    r = bias_report(items, probs)
    assert r["ask_flip_consistency"] == {"n": 6, "changed_rate": pytest.approx(3 / 6),
                                         "both_correct_rate": pytest.approx(1 / 6)}
    assert bias_report([it("base", A)], [PA])["ask_flip_consistency"] is None


def test_distractor_diversity_metric_is_gone():
    assert "by_distractor_diversity" not in bias_report([it("base", A)], [PA])


def test_items_without_pair_id_are_skipped_in_swap_consistency():
    items = [it("base", A, None), it("swap", B, None), it("base", A, "p"), it("swap", B, "p")]
    r = bias_report(items, [PA, PB, PA, PB])
    assert r["swap_consistency"] == {"n": 1, "rate": 1.0}


def test_lone_party_conflict_counts_named_items_whose_target_is_not_the_lone_candidate():
    items = [it("base", A, "a", alias=False, lone=1),            # conflict, picks the lone candidate (wrong)
             it("base", A, "b", alias=False, lone=1),            # conflict, right
             it("nomatch", N, "c", alias=False, lone=1),         # target none counts as "not the lone candidate"
             it("askflip", B, "d", alias=False, lone=1),         # target IS the lone candidate: excluded
             it("partyflip", A, "e", alias=False, lone=1),       # not one of the four variants: excluded
             it("base", A, "f", alias=True, lone=None), it("base", A, "g", alias=False, lone=None)]
    r = bias_report(items, [PB, PA, PN, PB, PB, PB, PB])
    assert r["lone_party_conflict"] == {"n": 3, "accuracy": pytest.approx(2 / 3), "pick_rate": pytest.approx(1 / 3)}
    assert bias_report([it("base", B, lone=1)], [PB])["lone_party_conflict"] is None


def test_cue_follower_drops_on_conflict_items_while_party_flip_consistency_stays_one():
    targets = [A, B, A, B, A, B]
    lone = [0, 1, 1, 0, 0, 1]                    # items 0,1,4,5 agree with the lone candidate; 2,3 conflict
    items = [it("base", t, "p%d" % i, alias=False, lone=l) for i, (t, l) in enumerate(zip(targets, lone))]
    items += [it("partyflip", t, "p%d" % i, alias=False, lone=l) for i, (t, l) in enumerate(zip(targets, lone))]
    oracle = [PA if t == A else PB for t in targets]
    follower = [PA if l == 0 else PB for l in lone]            # always picks the lone-party candidate
    ro, rf = bias_report(items, oracle + oracle), bias_report(items, follower + follower)
    assert ro["lone_party_conflict"]["accuracy"] == 1.0 and rf["lone_party_conflict"]["accuracy"] == 0.0
    assert rf["lone_party_conflict"]["pick_rate"] == 1.0
    assert rf["lone_party"]["accuracy"] == pytest.approx(2 / 3)
    assert rf["party_flip_consistency"] == {"n": 6, "rate": 1.0}


def test_by_singletons_splits_base_and_swap_items_and_omits_missing_groups():
    items = [it("base", A, "a", ns=1), it("base", A, "b", ns=1), it("swap", A, "c", ns=2), it("base", A, "d", ns=3),
             it("ablate", N, "e", ns=1), it("base", A, "f")]            # ablate ignored; no n_singletons ignored
    r = bias_report(items, [PA, PB, PA, PB, PA, PA])
    assert r["by_singletons"] == {"1": {"n": 2, "accuracy": 0.5}, "2+": {"n": 2, "accuracy": 0.5}}
    assert bias_report([it("base", A, ns=1)], [PA])["by_singletons"] == {"1": {"n": 1, "accuracy": 1.0}}
    assert bias_report([it("base", A)], [PA])["by_singletons"] == {}
