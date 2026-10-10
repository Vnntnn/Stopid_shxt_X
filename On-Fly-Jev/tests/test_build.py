import collections
import os
import sys

import pytest

from decision_core import load_tokenizer, tokenize_state
from evidence import build, claims, votes
from evidence.schema import STATE_BUDGET, validate
from fixtures import fever_rows, votes_fixture

TOK = load_tokenizer(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def vote_items():
    rc, mem, vt = votes_fixture()
    return votes.build_items(rc, mem, vt, "congress-118", n=50, seed=0)


def test_finalize_trims_long_evidence_and_output_validates():
    items = vote_items()
    items[0]["state"]["evidence"][0]["text"] += " filler words go here" * 400
    stats = collections.Counter()
    out = build.finalize(TOK, items, stats)
    assert len(out) == len(items) and not stats
    assert len(tokenize_state(TOK, out[0]["state"])) <= STATE_BUDGET
    for ex in out:
        validate(ex, TOK)


def test_finalize_drops_unfittable_items_and_counts_them():
    items = claims.build_items(fever_rows(), "fever-train", n=5, seed=0)
    items[0]["question"]["criteria"]["A"] = "word " * 80
    stats = collections.Counter()
    out = build.finalize(TOK, items, stats)
    assert len(out) == 4 and sum(stats.values()) == 1


def test_group_leak_is_rejected():
    a, b = vote_items()[:1], vote_items()[:1]
    with pytest.raises(ValueError, match="congress-118"):
        build.check_no_group_leak({"train": a, "test": b})


def test_split_groups_are_disjoint_by_construction():
    seen = [g for gs in build.SPLITS.values() for g in gs]
    assert len(seen) == len(set(seen))


def test_licence_gate_blocks_before_download(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise AssertionError("download reached while licence unverified")
    monkeypatch.setattr(votes, "LICENSE", "unverified")
    monkeypatch.setattr(votes, "download", boom)
    monkeypatch.setattr(sys, "argv", ["build", "--out", str(tmp_path)])
    with pytest.raises(SystemExit) as e:
        build.main()
    msg = str(e.value)
    assert "votes" in msg and "unverified" in msg


def test_allow_unverified_bypasses_gate(monkeypatch, tmp_path):
    class Sentinel(Exception):
        pass

    def reached(*a, **k):
        raise Sentinel()
    monkeypatch.setattr(votes, "LICENSE", "unverified")
    monkeypatch.setattr(votes, "download", reached)
    monkeypatch.setattr(sys, "argv", ["build", "--out", str(tmp_path), "--allow-unverified"])
    with pytest.raises(Sentinel):
        build.main()


def test_voteview_params_per_split():
    assert build.voteview_params("train") == {"name_frac": 0.1, "party_tags": False, "nameprobe": False,
                                              "partyflip_p": 0.0, "askflip_p": 0.0}
    for s in ("dev", "test"):
        assert build.voteview_params(s) == {"name_frac": 0.3, "party_tags": True, "nameprobe": True,
                                            "partyflip_p": 0.3, "askflip_p": 0.3}
    with pytest.raises(KeyError):
        build.voteview_params("bogus")


def test_main_passes_voteview_params_to_build_items(monkeypatch, tmp_path):
    seen = {}

    class Stop(Exception):
        pass

    def fake_build(rc, mem, vt, g, n, seed, **kw):
        seen.setdefault(g, kw)
        if len(seen) == sum(len(v) for v in build.SPLITS.values()):
            raise Stop()
        return []
    monkeypatch.setattr(votes, "download", lambda c, d: {})
    monkeypatch.setattr(votes, "load", lambda p: ([], {}, {}))
    monkeypatch.setattr(votes, "build_items", fake_build)
    monkeypatch.setattr(sys, "argv", ["build", "--out", str(tmp_path), "--allow-unverified"])
    with pytest.raises(Stop):
        build.main()
    assert seen["congress-110"] == build.voteview_params("train")
    assert seen["congress-117"] == build.voteview_params("dev")
    assert seen["congress-118"] == build.voteview_params("test")


def test_describe_counts_variants():
    rc, mem, vt = votes_fixture()
    items = votes.build_items(rc, mem, vt, "g", n=100, seed=1, name_frac=0.5, partyflip_p=1.0, askflip_p=1.0)
    d = build.describe(items)
    by_var = collections.Counter(e["meta"]["variant"] for e in items)
    assert d["by_variant"] == dict(sorted(by_var.items())) and {"nomatch", "partyflip", "askflip"} <= set(d["by_variant"])
    assert "distractors_one_label_share" not in d
