import collections
import json
import os
import re

import numpy as np
import pytest

from evidence import votes
from fixtures import realistic_votes_fixture, rich_votes_fixture, votes_fixture


def asked(ex):
    ins = ex["question"]["instructions"]
    return "Yea" if "voted Yea" in ins else "Nay" if "voted Nay" in ins else "Not voting"


def build(**kw):
    rc, mem, vt = votes_fixture()
    return mem, votes.build_items(rc, mem, vt, "congress-118", n=1000, seed=1, **kw)


def record(ex):
    return dict(p.split(": ") for p in ex["state"]["evidence"][1]["text"].split("; "))


def test_label_matches_the_record_with_a_unique_winner():
    _, items = build(name_frac=0.0)
    checked = 0
    for ex in items:
        if ex["meta"]["variant"] not in ("base", "swap"):
            continue
        ask = asked(ex)
        winners = [k for k, v in record(ex).items() if v == ask]
        assert len(winners) == 1
        keys = list(ex["question"]["criteria"])
        assert keys[int(np.argmax(ex["target"]))] == winners[0].split()[1]
        checked += 1
    assert checked > 5


def test_alias_items_carry_no_identity():
    mem, items = build()
    alias = [e for e in items if e["meta"]["alias"]]
    assert alias
    for e in alias:
        blob = json.dumps([e["state"], e["question"]])
        for m in mem.values():
            assert m["bioname"].split(",")[0].title() not in blob
        assert "Democrat" not in blob and "Republican" not in blob
    rc, mem, vt = votes_fixture()
    for i, r in enumerate(rc):
        if i % 2:
            r["vote_desc"] = "Republican substitute amendment" if i % 4 == 1 else "GOP motion to table"
    mixed = votes.build_items(rc, mem, vt, "g", n=1000, seed=3, name_frac=0.0)
    assert [e for e in mixed if e["meta"]["alias"]]
    for e in mixed:
        assert not re.search(r"democrat|republican|gop", json.dumps([e["state"], e["question"]]), re.I)


def test_swap_has_same_pair_and_moves_the_answer():
    _, items = build(name_frac=0.0, swap_p=1.0)
    base = {e["meta"]["pair_id"]: e for e in items if e["meta"]["variant"] == "base"}
    swaps = [e for e in items if e["meta"]["variant"] == "swap"]
    assert swaps
    for s in swaps:
        assert np.argmax(s["target"]) != np.argmax(base[s["meta"]["pair_id"]]["target"])


def test_ablate_and_nameprobe_drop_the_record_and_target_none():
    _, items = build(name_frac=0.5, ablate_p=1.0)
    abl = [e for e in items if e["meta"]["variant"] in ("ablate", "nameprobe")]
    assert {e["meta"]["variant"] for e in abl} == {"ablate", "nameprobe"}
    for e in abl:
        assert len(e["state"]["evidence"]) == 1
        assert np.argmax(e["target"]) == len(e["target"]) - 1


def test_name_slice_shows_names_and_party_in_options():
    _, items = build(name_frac=1.0)
    ex = next(e for e in items if e["meta"]["variant"] == "base")
    assert not ex["meta"]["alias"]
    assert any("Democrat" in v or "Republican" in v for v in ex["question"]["criteria"].values())


def test_too_few_voters_is_skipped():
    rc, mem, _ = votes_fixture(2)
    few = {("House", "1"): [("1", 1), ("2", 6)], ("House", "2"): [("1", 1)]}
    assert votes.build_items(rc, mem, few, "g", n=10, seed=0) == []


def test_rollcall_without_description_is_skipped():
    rc, mem, vt = votes_fixture(3)
    for r in rc:
        r["vote_desc"] = ""
    assert votes.build_items(rc, mem, vt, "g", n=10, seed=0) == []


def test_duplicate_display_names_are_skipped_in_name_slice():
    rc, mem, vt = votes_fixture(6)
    for m in mem.values():
        m["bioname"] = "SMITH, Ann Q"
    items = votes.build_items(rc, mem, vt, "g", n=100, seed=0, name_frac=1.0)
    assert items == []


def test_alias_skips_rollcalls_whose_text_names_a_party_or_chosen_member():
    rc, mem, vt = votes_fixture(6)
    for r in rc:
        r["vote_desc"] = "Censure of Rep. Smith, Democratic motion"
    assert votes.build_items(rc, mem, vt, "g", n=100, seed=0, name_frac=0.0) == []
    named = votes.build_items(rc, mem, vt, "g", n=100, seed=0, name_frac=1.0)
    assert named and not any(e["meta"]["alias"] for e in named)


def test_download_is_atomic(tmp_path, monkeypatch):
    calls = []

    def bad(url, path):
        calls.append(path)
        with open(path, "wb") as f:
            f.write(b"abc")
        raise OSError("short transfer")

    monkeypatch.setattr(votes.urllib.request, "urlretrieve", bad)
    with pytest.raises(OSError):
        votes.download(118, str(tmp_path))
    assert os.listdir(tmp_path) == []

    def good(url, path):
        calls.append(path)
        with open(path, "wb") as f:
            f.write(b"ok")

    monkeypatch.setattr(votes.urllib.request, "urlretrieve", good)
    paths = votes.download(118, str(tmp_path))
    assert len(calls) == 4 and all(os.path.exists(p) for p in paths.values())
    assert not [f for f in os.listdir(tmp_path) if f.endswith(".part")]


def _floaty(rc, mem, vt):
    rc = [dict(r, rollnumber=r["rollnumber"] + ".0") for r in rc]
    mem = {k + ".0": dict(m, party_code=m["party_code"] + ".0") for k, m in mem.items()}
    vt = {(ch, r + ".0"): [(i + ".0", str(c) + ".0") for i, c in rows] for (ch, r), rows in vt.items()}
    return rc, mem, vt


def test_float_formatted_numerics_give_identical_items():
    plain = votes.build_items(*votes_fixture(), "g", n=1000, seed=2, name_frac=0.5)
    floaty = votes.build_items(*_floaty(*votes_fixture()), "g", n=1000, seed=2, name_frac=0.5)
    assert plain and json.dumps(plain) == json.dumps(floaty)


def test_member_and_vote_icpsr_formats_may_differ():
    rc, mem, vt = votes_fixture()
    vt = {k: [(i + ".0", c) for i, c in rows] for k, rows in vt.items()}   # members stay "1".."6"
    assert votes.build_items(rc, mem, vt, "g", n=1000, seed=2) == votes.build_items(
        *votes_fixture(), "g", n=1000, seed=2)
    assert votes.build_items(rc, mem, vt, "g", n=1000, seed=2)


@pytest.mark.filterwarnings("ignore::RuntimeWarning")   # the 50% skipped rows warn by design
def test_load_skips_unparseable_cast_code_and_reads_float_columns(tmp_path):
    def w(name, text):
        p = tmp_path / name
        p.write_text(text, encoding="utf-8")
        return str(p)
    paths = {
        "members": w("m.csv", "congress,chamber,icpsr,party_code,bioname\n115,House,10713.0,200.0,\"SMITH, Ann Q\"\n"),
        "rollcalls": w("r.csv", "congress,chamber,rollnumber,date,bill_number,vote_result,vote_desc,vote_question,dtl_desc\n"
                                "115,House,1.0,2017-01-03,HR1,Passed,Rule,On Passage,\n"),
        "votes": w("v.csv", "congress,chamber,rollnumber,icpsr,cast_code,prob\n"
                            "115,House,1.0,10713.0,1.0,95\n115,House,1.0,10714.0,abc,95\n"),
    }
    rc, mem, vt = votes.load(paths)
    assert list(mem) == ["10713"] and votes.side(mem["10713"]) == "R"
    assert vt == {("House", "1"): [("10713", 1)]}


def _csvs(tmp_path, bad, good):
    def w(name, text):
        p = tmp_path / name
        p.write_text(text, encoding="utf-8")
        return str(p)
    rows = "".join("115,House,1,1,%s,95\n" % c for c in ["abc"] * bad + ["1"] * good)
    return {"members": w("m.csv", "congress,chamber,icpsr,party_code,bioname\n115,House,1,200,\"SMITH, Ann Q\"\n"),
            "rollcalls": w("r.csv", "congress,chamber,rollnumber,date,bill_number,vote_result,vote_desc,"
                                    "vote_question,dtl_desc\n"),
            "votes": w("v.csv", "congress,chamber,rollnumber,icpsr,cast_code,prob\n" + rows)}


def test_load_warns_when_many_vote_rows_are_skipped(tmp_path):
    import warnings
    with pytest.warns(RuntimeWarning, match=r"skipped 5 of 10 vote rows"):
        votes.load(_csvs(tmp_path, bad=5, good=5))
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        votes.load(_csvs(tmp_path, bad=0, good=10))


def test_build_items_raises_when_votes_do_not_join_members():
    rc, mem, _ = votes_fixture()
    vt = {("House", "1"): [(str(900 + i), 1) for i in range(1, 7)]}
    with pytest.raises(ValueError, match="failed to join"):
        votes.build_items(rc, mem, vt, "g", n=10, seed=0)


def test_join_guard_threshold_is_half_of_vote_rows():
    rc, mem, _ = votes_fixture()
    rows = [(str(i), 1) for i in range(1, 4)] + [("901", 1), ("902", 1)]   # 3 of 5 = 60% join
    votes.build_items(rc, mem, {("House", "1"): rows}, "g", n=10, seed=0)
    rows = [("1", 1), ("2", 1)] + [("90%d" % i, 1) for i in range(1, 4)]   # 2 of 5 = 40%
    with pytest.raises(ValueError):
        votes.build_items(rc, mem, {("House", "1"): rows}, "g", n=10, seed=0)


# ---- round 2: question-independent record composition ---------------------------------------------

def rich(**kw):
    rc, mem, vt = rich_votes_fixture(n_rolls=150)
    kw.setdefault("n", 1000)
    return mem, votes.build_items(rc, mem, vt, "congress-118", seed=4, **kw)


def party_of(desc):
    m = re.search(r"\((Democrat|Republican|Independent)\)$", desc)
    return m.group(1) if m else None


def big(**kw):
    rc, mem, vt = realistic_votes_fixture()
    return votes.build_items(rc, mem, vt, "g", n=100000, seed=7, **kw)


def test_every_item_has_zero_or_one_matching_candidate_and_target_follows_the_record():
    _, items = rich(name_frac=0.5, swap_p=1.0, askflip_p=1.0)
    seen = collections.Counter()
    for ex in items:
        v = ex["meta"]["variant"]
        if v in ("ablate", "nameprobe"):
            continue
        labels = list(record(ex).values())
        hits = [i for i, lab in enumerate(labels) if lab == asked(ex)]
        assert len(hits) <= 1
        assert int(np.argmax(ex["target"])) == (hits[0] if hits else len(labels))
        assert (v == "nomatch") == (not hits) or v == "askflip"
        seen[v] += 1
    assert {"base", "swap", "nomatch", "askflip"} <= set(seen)


def test_synthetic_set_asked_label_is_roughly_uniform_and_the_question_alone_does_not_predict_none():
    # SYNTHETIC fixture only: on real roll calls the asked-label mix is not uniform (some labels cannot be built)
    items = [e for e in big() if e["meta"]["variant"] in ("base", "nomatch")]
    assert len(items) > 1000
    for label in ("Yea", "Nay", "Not voting"):
        sel = [e for e in items if asked(e) == label]
        assert abs(len(sel) / len(items) - 1 / 3) < 0.07, label                    # tolerance 7 points
        none = np.mean([e["meta"]["variant"] == "nomatch" for e in sel])
        assert 0.35 < none < 0.65, (label, none)                                  # none share per asked label


def test_none_is_about_half_of_base_swap_and_nomatch_items():
    items = [e for e in big(swap_p=0.5) if e["meta"]["variant"] in ("base", "swap", "nomatch")]
    share = np.mean([e["meta"]["variant"] == "nomatch" for e in items])
    assert 0.40 < share < 0.60, share                                            # tolerance 10 points


def test_records_could_answer_with_either_outcome():
    items = [e for e in big() if e["meta"]["variant"] in ("base", "nomatch")]
    for e in items:
        counts = collections.Counter(record(e).values())
        cs = [counts.get(l, 0) for l in ("Yea", "Nay", "Not voting")]
        assert (0 in cs and 1 in cs) or cs.count(1) >= 2          # relaxed in round 3: multi-singleton records


def test_train_params_give_names_only_named_items_and_no_probes():
    from evidence import build
    rc, mem, vt = realistic_votes_fixture(300)
    items = votes.build_items(rc, mem, vt, "g", n=1000, seed=1, **build.voteview_params("train"))
    named = [e for e in items if not e["meta"]["alias"]]
    assert named and len(named) < len(items)
    for e in named:
        assert e["meta"]["party_tags"] is False and e["meta"]["lone_party_idx"] is None
        assert not any(party_of(v) for v in e["question"]["criteria"].values())
        assert "(" not in json.dumps(e["question"]["criteria"])
    assert {e["meta"]["variant"] for e in items} <= {"base", "swap", "nomatch", "ablate"}


def test_party_tags_false_shows_names_only_and_no_partyflip():
    _, items = rich(name_frac=1.0, party_tags=False, partyflip_p=1.0)
    assert items
    for e in items:
        assert e["meta"]["party_tags"] is False and e["meta"]["lone_party_idx"] is None
        assert all(party_of(v) is None and "(" not in v for v in e["question"]["criteria"].values())
        assert e["meta"]["variant"] != "partyflip"
    _, tagged = rich(name_frac=1.0)
    assert all(e["meta"]["party_tags"] is True for e in tagged)
    assert any(party_of(v) for e in tagged for v in e["question"]["criteria"].values())
    _, alias = rich(name_frac=0.0)
    assert all("party_tags" not in e["meta"] for e in alias)


def test_nameprobe_can_be_switched_off():
    _, on = rich(name_frac=1.0, ablate_p=1.0)
    _, off = rich(name_frac=1.0, ablate_p=1.0, nameprobe=False)
    assert any(e["meta"]["variant"] == "nameprobe" for e in on)
    assert not any(e["meta"]["variant"] == "nameprobe" for e in off)


def test_person_strips_suffix_commas():
    assert votes.person({"bioname": "MANCHIN, Joe, III"}) == "Joe Manchin"
    assert votes.person({"bioname": "SMITH, Ann Q"}) == "Ann Smith"


def singletons(e):
    counts = collections.Counter(record(e).values())
    return sum(counts.get(l, 0) == 1 for l in ("Yea", "Nay", "Not voting"))


def test_n_singletons_meta_is_recomputable_on_every_item():
    _, items = rich(name_frac=0.5, swap_p=1.0, ablate_p=1.0, askflip_p=1.0, partyflip_p=1.0)
    for e in items:
        if e["meta"]["variant"] in ("ablate", "nameprobe"):
            continue
        assert e["meta"]["n_singletons"] == singletons(e)
    assert all("n_singletons" in e["meta"] for e in items)
    assert {1, 2} <= {e["meta"]["n_singletons"] for e in items}


def test_about_half_of_answered_records_have_several_singleton_labels():
    items = [e for e in big() if e["meta"]["variant"] == "base"]
    share = np.mean([e["meta"]["n_singletons"] >= 2 for e in items])
    assert 0.35 < share < 0.65, share                                              # tolerance 15 points


def test_presence_check_plus_odd_one_out_no_longer_solves_the_answered_items():
    from evidence import baselines
    items = big()
    assert baselines.question_aware_report(items)["presence_odd_one_out"] < 0.88


def test_askflip_includes_member_to_member_flips():
    items = big(askflip_p=1.0)
    ref = {e["meta"]["pair_id"]: e for e in items if e["meta"]["variant"] in ("base", "nomatch")}
    kinds = collections.Counter()
    for e in items:
        if e["meta"]["variant"] == "askflip":
            a, b = ref[e["meta"]["pair_id"]]["meta"]["variant"], e["target"][-1] == 1
            kinds[("member" if a == "base" else "none", "none" if b else "member")] += 1
    assert kinds[("member", "member")] > 20 and kinds[("member", "none")] > 20 and kinds[("none", "member")] > 20, kinds


def test_lone_party_idx_matches_recomputation_and_may_be_the_answer():
    _, items = rich(name_frac=1.0, swap_p=1.0)
    named = [e for e in items if e["meta"]["variant"] in ("base", "swap")]
    assert len(named) > 20
    answer_lone = other = none_seen = 0
    for ex in named:
        parties = [party_of(v) for k, v in ex["question"]["criteria"].items() if k != "none"]
        lone = [i for i, p in enumerate(parties) if parties.count(p) == 1]
        expected = lone[0] if len(lone) == 1 and len(set(parties)) == 2 else None
        assert ex["meta"]["lone_party_idx"] == expected
        if expected is None:
            none_seen += 1
        elif expected == int(np.argmax(ex["target"])):
            answer_lone += 1
        else:
            other += 1
    assert answer_lone and other and none_seen       # no same-party rule: the lone candidate can be the answer


def test_alias_items_have_no_lone_party_idx():
    _, items = rich(name_frac=0.0)
    assert items and all(e["meta"]["lone_party_idx"] is None for e in items)


def test_nomatch_alias_items_carry_no_identity():
    mem, items = rich(name_frac=0.0)
    nm = [e for e in items if e["meta"]["variant"] == "nomatch"]
    assert nm
    for e in nm:
        blob = json.dumps([e["state"], e["question"]])
        assert "Democrat" not in blob and "Republican" not in blob
        assert not any(m["bioname"].split(",")[0].title() in blob for m in mem.values())
        assert e["meta"]["side"] is None


def test_askflip_keeps_state_and_options_but_changes_question_and_target():
    _, items = rich(name_frac=0.5, askflip_p=1.0)
    ref = {e["meta"]["pair_id"]: e for e in items if e["meta"]["variant"] in ("base", "nomatch")}
    af = [e for e in items if e["meta"]["variant"] == "askflip"]
    assert len(af) > 20
    kinds = set()
    for e in af:
        b = ref[e["meta"]["pair_id"]]
        assert e["state"] == b["state"] and e["question"]["criteria"] == b["question"]["criteria"]
        assert e["question"]["instructions"] != b["question"]["instructions"]
        assert e["target"] != b["target"]
        assert e["meta"]["alias"] == b["meta"]["alias"]
        kinds.add(b["meta"]["variant"])
    assert kinds == {"base", "nomatch"}


def test_askflip_never_keeps_the_target_even_when_two_asked_labels_match_nobody():
    rc, mem, _ = votes_fixture(40)
    vt = {("House", str(r)): [("1", 1), ("2", 7), ("3", 7)] for r in range(1, 41)}      # Yea, Present, Present
    items = votes.build_items(rc, mem, vt, "g", n=100, seed=2, askflip_p=1.0, name_frac=0.0)
    ref = {e["meta"]["pair_id"]: e for e in items if e["meta"]["variant"] in ("base", "nomatch")}
    af = [e for e in items if e["meta"]["variant"] == "askflip"]
    assert any(ref[e["meta"]["pair_id"]]["meta"]["variant"] == "nomatch" for e in af)
    assert all(e["target"] != ref[e["meta"]["pair_id"]]["target"] for e in af)


SWAP_TAGS = {"(Democrat)": "(Republican)", "(Republican)": "(Democrat)"}


def flip(text):
    return re.sub(r"\((Democrat|Republican)\)", lambda m: SWAP_TAGS[m.group(0)], text)


def test_partyflip_swaps_party_tags_only_and_exists_for_named_items_only():
    _, items = rich(name_frac=0.5, partyflip_p=1.0)
    base = {e["meta"]["pair_id"]: e for e in items if e["meta"]["variant"] == "base"}
    pf = [e for e in items if e["meta"]["variant"] == "partyflip"]
    assert len(pf) > 10
    changed = 0
    for e in pf:
        b = base[e["meta"]["pair_id"]]
        assert not b["meta"]["alias"] and not e["meta"]["alias"]
        assert e["target"] == b["target"] and e["state"] == b["state"]
        assert e["question"]["instructions"] == b["question"]["instructions"]
        assert list(e["question"]["criteria"]) == list(b["question"]["criteria"])
        assert e["question"]["criteria"] == {k: flip(v) for k, v in b["question"]["criteria"].items()}
        assert e["meta"]["lone_party_idx"] == b["meta"]["lone_party_idx"]
        changed += e["question"]["criteria"] != b["question"]["criteria"]
    assert changed == len(pf)
    assert not any(e["meta"]["variant"] == "partyflip" and e["meta"]["alias"] for e in items)


def test_flip_variants_are_off_by_default():
    _, items = rich()
    assert {e["meta"]["variant"] for e in items} <= {"base", "swap", "ablate", "nameprobe", "nomatch"}


def test_swap_only_for_answered_items_and_ablate_targets_none():
    _, items = rich(name_frac=0.0, swap_p=1.0, ablate_p=1.0)
    ids = {e["meta"]["pair_id"]: e["meta"]["variant"] for e in items if e["meta"]["variant"] in ("base", "nomatch")}
    for e in items:
        if e["meta"]["variant"] == "swap":
            assert ids[e["meta"]["pair_id"]] == "base"
        if e["meta"]["variant"] == "ablate":
            assert ids[e["meta"]["pair_id"]] == "base" and len(e["state"]["evidence"]) == 1


def test_alias_skips_rollcalls_whose_text_names_every_candidate_even_without_a_party_word():
    rc, mem, vt = votes_fixture(6)
    for r in rc:
        r["vote_desc"] = "Resolution honoring Smith Jones Brown Davis Evans Clark"
    assert votes.build_items(rc, mem, vt, "g", n=100, seed=0, name_frac=0.0) == []
    assert votes.build_items(rc, mem, vt, "g", n=100, seed=0, name_frac=1.0)


def test_record_composition_does_not_depend_on_the_party_of_the_answer():
    # no same-party / label-diversity constraint: the answer's party is not forced to repeat
    _, items = rich(name_frac=1.0)
    alone = 0
    for ex in items:
        if ex["meta"]["variant"] != "base":
            continue
        parties = [party_of(v) for k, v in ex["question"]["criteria"].items() if k != "none"]
        alone += parties.count(parties[int(np.argmax(ex["target"]))]) == 1
    assert alone > 5
