"""Voteview roll calls -> evidence-choice items (T1: which candidate voted how).

Labels come from the roll-call record. Alias items hide names and party; the name slice shows both
and exists to test for name/party priors.
"""
import csv
import os
import random
import re
import urllib.request
import warnings

URL = "https://voteview.com/static/data/out/{kind}/HS{congress}_{kind}.csv"
LICENSE = "unverified"          # replace with the Task 1 verdict before a real build
CAST = {1: "Yea", 2: "Yea", 3: "Yea", 4: "Nay", 5: "Nay", 6: "Nay", 7: "Present", 8: "Present", 9: "Not voting"}
PARTY = {100: "D", 200: "R"}
PARTY_NAME = {"D": "Democrat", "R": "Republican", "I": "Independent"}
PARTY_WORDS = re.compile(r"\b(democrat\w*|republican\w*|gop)\b", re.I)
ASK = {"Yea": "voted Yea", "Nay": "voted Nay", "Not voting": "did not vote"}


def _num(s):
    """Parse '200', '200.0', ' 7 ' -> int; None if unparseable (some congresses write floats)."""
    try:
        return int(float(s))
    except (TypeError, ValueError, OverflowError):
        return None


def _key(s):
    n = _num(s)
    return None if n is None else str(n)


def download(congress, dest):
    os.makedirs(dest, exist_ok=True)
    paths = {}
    for kind in ("rollcalls", "members", "votes"):
        p = os.path.join(dest, "HS%s_%s.csv" % (congress, kind))
        if not os.path.exists(p):
            part = p + ".part"
            try:
                urllib.request.urlretrieve(URL.format(kind=kind, congress=congress), part)
                os.replace(part, p)
            except BaseException:
                if os.path.exists(part):
                    os.remove(part)
                raise
        paths[kind] = p
    return paths


def _warn_skipped(skipped, total, what, cols, path):
    if total and skipped / total > 0.01:
        warnings.warn("votes.load: skipped %d of %d %s rows (unparseable %s) in %s"
                      % (skipped, total, what, cols, path), RuntimeWarning)


def load(paths):
    def rd(p):
        with open(p, encoding="utf-8", newline="") as f:
            return list(csv.DictReader(f))
    mrows = rd(paths["members"])
    members = {k: m for m in mrows if (k := _key(m["icpsr"])) is not None}
    _warn_skipped(len(mrows) - len(members), len(mrows), "member", "icpsr", paths["members"])
    votes = {}
    vrows = rd(paths["votes"])
    skipped = 0
    for v in vrows:
        roll, who, cast = _key(v["rollnumber"]), _key(v["icpsr"]), _num(v["cast_code"])
        if roll is None or who is None or cast is None:
            skipped += 1
            continue
        votes.setdefault((v["chamber"], roll), []).append((who, cast))
    _warn_skipped(skipped, len(vrows), "vote", "cast_code/icpsr/rollnumber", paths["votes"])
    return rd(paths["rollcalls"]), members, votes


def person(m):
    last, _, rest = m["bioname"].partition(", ")
    return ("%s %s" % (rest.split()[0].strip(",") if rest else "", last.title())).strip()


def side(m):
    return PARTY.get(_num(m["party_code"]) or 0, "I")


def roll_text(rc):
    parts = ["%s roll call %s on %s." % (rc["chamber"], _key(rc["rollnumber"]) or rc["rollnumber"], rc["date"])]
    for label, key in (("Question", "vote_question"), ("Bill", "bill_number"),
                       ("Subject", "vote_desc"), ("Detail", "dtl_desc")):
        if rc[key].strip():
            parts.append("%s: %s." % (label, rc[key].strip().rstrip(".")))
    if rc["vote_result"].strip():
        parts.append("Result: %s." % rc["vote_result"].strip())
    return " ".join(parts)


FLIP = {"D": "R", "R": "D"}


def _lone_party(mv):
    """Index of the one candidate whose party differs from all the others, when exactly one does; else None."""
    sides = [side(m) for m, _ in mv]
    lone = [i for i, s in enumerate(sides) if sides.count(s) == 1]
    return lone[0] if len(lone) == 1 and len(set(sides)) == 2 else None


def _make(rc, mv, keys, ask, answer, alias, variant, pair_id, group, party_tags=True):
    """mv: [(member_row, 'Yea'|'Nay'|...)] aligned with keys; answer: index into mv, or None for 'none'.
    variant 'partyflip' is a named item whose party tags are swapped (D <-> R)."""
    names = ["Candidate %s" % k if alias else person(m) for k, (m, _) in zip(keys, mv)]
    tag = (lambda m: FLIP.get(side(m), side(m))) if variant == "partyflip" else side
    descs = names if alias or not party_tags else ["%s (%s)" % (person(m), PARTY_NAME[tag(m)]) for m, _ in mv]
    ev = [{"id": "E1", "type": "roll_call", "date": rc["date"], "text": roll_text(rc)}]
    if variant not in ("ablate", "nameprobe"):
        ev.append({"id": "E2", "type": "vote_record", "date": rc["date"],
                   "text": "; ".join("%s: %s" % (n, lab) for n, (_, lab) in zip(names, mv))})
    crit = dict(zip(keys, descs))
    crit["none"] = "None of the candidates"
    target = [0.0] * len(crit)
    target[len(crit) - 1 if answer is None else answer] = 1.0
    return {"state": {"task": "Pick the candidate the evidence supports", "evidence": ev},
            "question": {"type": "choice",
                         "instructions": "Which candidate %s on this measure? Choose none if the evidence "
                                         "does not say." % ASK[ask],
                         "criteria": crit},
            "target": target, "source": "voteview",
            "meta": {"id": "%s-%s" % (pair_id, variant), "pair_id": pair_id, "variant": variant, "group": group,
                     "alias": alias, "side": side(mv[answer][0]) if answer is not None else None,
                     "lone_party_idx": _lone_party(mv) if party_tags and not alias else None,
                     "n_singletons": sum(len(_matches(mv, l)) == 1 for l in ASK),
                     "lang": "en", "label_method": "record", "license": LICENSE}
            | ({} if alias else {"party_tags": party_tags})}


def _leaks(rc, mv):
    """True when the roll-call text would reveal party or a chosen candidate's surname (alias items)."""
    text = roll_text(rc)
    return bool(PARTY_WORDS.search(text)) or any(
        re.search(r"\b%s\b" % re.escape(m["bioname"].partition(",")[0].title()), text, re.I) for m, _ in mv)


def _feasible(mv):
    """A record that does not reveal the target by itself: it can answer some question with a member AND some
    question with none, or it has several singleton labels (so the odd-one-out is ambiguous)."""
    cs = [len(_matches(mv, l)) for l in ASK]
    return (0 in cs and 1 in cs) or cs.count(1) >= 2


def _matches(mv, ask):
    return [i for i, (_, lab) in enumerate(mv) if lab == ask]


def build_items(rollcalls, members, votes, group, n, seed, name_frac=0.3, swap_p=0.5, ablate_p=0.25,
                partyflip_p=0.0, askflip_p=0.0, party_tags=True, nameprobe=True):
    """Per roll call the asked label is drawn uniformly over Yea / Nay / Not voting, then the target class
    (none / member, so that none is half of base+swap+nomatch) and, for members, the composition class (half the
    records have >= 2 singleton labels, so "the odd one out" is ambiguous) are drawn, then k random voters
    conditionally. Roll calls for which no such record exists are skipped, so the asked-label mix on real data
    is NOT uniform (it is a prior, not an exploitable leak: asked label + roll text ~ always-none; measure with
    evidence.baselines). `party_tags=False` shows named candidates by name only."""
    rng = random.Random(seed)
    members = {k: m for i, m in members.items() if (k := _key(i)) is not None}
    norm = {}
    for (ch, roll), rows in votes.items():
        r = _key(roll)
        for i, c in rows:
            w, cc = _key(i), _num(c)
            if r is not None and w is not None and cc is not None:
                norm.setdefault((ch, r), []).append((w, cc))
    votes = norm
    total = sum(len(r) for r in votes.values())
    joined = sum(1 for r in votes.values() for i, _ in r if i in members)
    if total and joined < 0.5 * total:
        raise ValueError("votes failed to join members: %d of %d vote rows matched a member "
                         "(check icpsr formatting in the raw CSVs)" % (joined, total))
    pool = [rc for rc in rollcalls
            if rc["chamber"] in ("House", "Senate") and (rc["vote_desc"] + rc["dtl_desc"]).strip()]
    rng.shuffle(pool)
    out = []
    for rc in pool:
        if len(out) >= n:
            break
        voters = [(members[i], CAST[c]) for i, c in votes.get((rc["chamber"], _key(rc["rollnumber"])), [])
                  if i in members and c in CAST]
        k = rng.choice([3, 4])
        if len(voters) < k:
            continue
        alias = rng.random() >= name_frac
        ask = rng.choice(list(ASK))
        # alias base items may get a `swap` twin, so answered items are thinned to keep none ~ half of all items
        want = 1 if rng.random() < 1 / (2 + (swap_p if alias else 0)) else 0
        mv = None
        multi = want == 1 and rng.random() < 0.5
        for tries, want_multi in ((100, True), (100, False)) if multi else ((100, False),):
            for _ in range(tries):
                cand = rng.sample(voters, k)
                if len(_matches(cand, ask)) != want or not _feasible(cand):
                    continue
                if want == 1 and (sum(len(_matches(cand, l)) == 1 for l in ASK) >= 2) != want_multi:
                    continue
                if not alias and len({person(m) for m, _ in cand}) < k:
                    continue
                if alias and _leaks(rc, cand):
                    continue    # the roll-call text would leak identity into an alias item
                mv = cand
                break
            if mv is not None:
                break
        if mv is None:
            continue
        hit = _matches(mv, ask)
        answer = hit[0] if hit else None
        keys = list("ABCD"[:k])
        pid = "%s-%s-%s" % (group, rc["chamber"], _key(rc["rollnumber"]))
        out.append(_make(rc, mv, keys, ask, answer, alias, "base" if hit else "nomatch", pid, group, party_tags))
        if answer is not None:
            if alias and rng.random() < swap_p:
                perm = list(range(k))
                while perm.index(answer) == answer:      # the answer must move, or the pair teaches nothing
                    rng.shuffle(perm)
                out.append(_make(rc, [mv[i] for i in perm], keys, ask, perm.index(answer), alias, "swap", pid, group,
                                      party_tags))
            if rng.random() < ablate_p and (alias or nameprobe):
                out.append(_make(rc, mv, keys, ask, None, alias, "ablate" if alias else "nameprobe", pid, group,
                                 party_tags))
            if partyflip_p and party_tags and not alias and rng.random() < partyflip_p and any(side(m) in FLIP for m, _ in mv):
                out.append(_make(rc, mv, keys, ask, answer, alias, "partyflip", pid, group, party_tags))
        if askflip_p and rng.random() < askflip_p:
            others = [l for l in ASK if l != ask]
            rng.shuffle(others)
            for l2 in others:
                h2 = _matches(mv, l2)
                if len(h2) <= 1 and (h2[0] if h2 else None) != answer:      # same records, different target
                    out.append(_make(rc, mv, keys, l2, h2[0] if h2 else None, alias, "askflip", pid, group,
                                     party_tags))
                    break
    return out
