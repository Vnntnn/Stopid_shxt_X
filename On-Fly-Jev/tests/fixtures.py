"""Hand-made rows shaped like Voteview / FEVER files (no network)."""

FIRST = ["Ann", "Bob", "Cy", "Di", "Ed", "Flo"]
LAST = ["Smith", "Jones", "Brown", "Davis", "Evans", "Clark"]
CAST = [1, 6, 6, 9, 1, 6]          # members 1..6 -> Yea, Nay, Nay, Not voting, Yea, Nay


def votes_fixture(n_rolls=12):
    members = {str(i + 1): {"party_code": "100" if i % 2 == 0 else "200",
                            "bioname": "%s, %s Q" % (LAST[i].upper(), FIRST[i])} for i in range(6)}
    rollcalls = [{"chamber": "House", "rollnumber": str(r), "date": "2023-01-%02d" % r,
                  "bill_number": "HR%d" % r, "vote_result": "Passed", "vote_desc": "Rule number %d" % r,
                  "vote_question": "On Passage", "dtl_desc": ""} for r in range(1, n_rolls + 1)]
    votes = {("House", str(r)): [(str(i + 1), c) for i, c in enumerate(CAST)] for r in range(1, n_rolls + 1)}
    return rollcalls, members, votes


def fever_rows(n=40):
    labels = ["SUPPORTS", "REFUTES", "NOT ENOUGH INFO"]
    rows = [{"claim": "Claim number %d about topic %d." % (i, i), "label": labels[i % 3],
             "evidence": [["Page_%d_-LRB-x-RRB-" % i, "0", "Evidence sentence %d -LRB- note -RRB- ." % i]],
             "id": "id%d" % i, "verifiable": "VERIFIABLE"} for i in range(n)]
    rows.append({"claim": "Claim without evidence.", "label": "SUPPORTS", "evidence": [], "id": "idx",
                 "verifiable": "NOT VERIFIABLE"})
    return rows


RICH_LAST = ["Adams", "Baker", "Carter", "Dixon", "Ellis", "Foster", "Grant", "Hayes", "Irwin", "Jensen",
             "Keller", "Lopez", "Moore", "Nolan"]


def rich_votes_fixture(n_rolls=40, seed=0):
    """14 members over 3 parties (D/R/I) and a pseudo-random Yea/Nay/Not voting/Present mix per roll."""
    import random
    rnd = random.Random(seed)
    parties = ["100", "200", "100", "200", "328", "100", "200", "100", "200", "328", "100", "200", "100", "200"]
    members = {str(i + 1): {"party_code": parties[i], "bioname": "%s, Pat%s Q" % (RICH_LAST[i].upper(), "xyz"[i % 3])}
               for i in range(14)}
    rollcalls = [{"chamber": "House", "rollnumber": str(r), "date": "2023-02-%02d" % (r % 28 + 1),
                  "bill_number": "HR%d" % r, "vote_result": "Passed", "vote_desc": "Rule number %d" % r,
                  "vote_question": "On Passage", "dtl_desc": ""} for r in range(1, n_rolls + 1)]
    votes = {("House", str(r)): [(str(i + 1), rnd.choice([1, 1, 6, 6, 6, 9, 9, 7])) for i in range(14)]
             for r in range(1, n_rolls + 1)}
    return rollcalls, members, votes


def realistic_votes_fixture(n_rolls=1500, n_members=120, seed=0):
    """Party-line-ish roll calls: ~93% Yea/Nay, ~5% Not voting, ~2% Present, 3 parties (45% D / 50% R / 5% I)."""
    import random
    rnd = random.Random(seed)
    party = ["100"] * 54 + ["200"] * 60 + ["328"] * 6
    members = {str(i + 1): {"party_code": party[i % len(party)] if i < len(party) else "100",
                            "bioname": "ZQ%03d, Kim Q" % i} for i in range(n_members)}
    rollcalls, votes = [], {}
    for r in range(1, n_rolls + 1):
        rollcalls.append({"chamber": "House", "rollnumber": str(r), "date": "2023-03-%02d" % (r % 28 + 1),
                          "bill_number": "HR%d" % r, "vote_result": "Passed", "vote_desc": "Rule number %d" % r,
                          "vote_question": "On Passage", "dtl_desc": ""})
        lean = {c: rnd.choice([0.95, 0.05, 0.5]) for c in ("100", "200", "328")}
        rows = []
        for i in range(n_members):
            x = rnd.random()
            cast = 9 if x < 0.05 else 7 if x < 0.07 else (1 if rnd.random() < lean[members[str(i + 1)]["party_code"]] else 6)
            rows.append((str(i + 1), cast))
        votes[("House", str(r))] = rows
    return rollcalls, members, votes
