import os
import random
from types import SimpleNamespace

import numpy as np
import torch
import torch.nn as nn

from decision_core import SpikeDecisionModel, load_tokenizer
from train_evidence import DATA_LICENSE, batches, build_out_cfg, make_row, prep, schedule_total, score_logits, train_epoch

TOK = load_tokenizer(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def example(i, yes_key):
    crit = {"A": "no", "B": "no", "C": "no", "none": "no"}
    crit[yes_key] = "yes"
    keys = list(crit)
    return {"state": {"task": "t", "evidence": [{"id": "E1", "type": "x", "text": "item %d" % i}]},
            "question": {"type": "choice", "instructions": "Which option says yes?", "criteria": crit},
            "target": [1.0 if k == yes_key else 0.0 for k in keys], "source": "t", "meta": {}}


def test_make_row_permutes_target_with_option_order():
    ex = {"state": "s", "question": {"type": "choice", "instructions": "q",
                                     "criteria": {"A": "alpha", "B": "beta", "none": "gamma"}},
          "target": [0.0, 1.0, 0.0]}
    p = prep(TOK, ex, 1024, 256)
    ident = make_row(p)
    assert ident["order"] == [0, 1, 2] and ident["target"] == [0.0, 1.0, 0.0]
    seen = set()
    for seed in range(20):
        row = make_row(p, random.Random(seed))
        order = row["order"]
        seen.add(tuple(order))
        assert sorted(order) == [0, 1, 2] and len(row["markers"]) == 3
        assert row["markers"] == sorted(row["markers"])
        assert row["target"] == [ex["target"][i] for i in order]
        text = TOK.decode(row["ids"])
        words = ["alpha", "beta", "gamma"]
        pos = [text.index(words[i]) for i in order]
        assert pos == sorted(pos)                      # rendered option order == `order`
    assert len(seen) > 1


def test_prep_returns_none_for_a_malformed_question():
    ex = example(0, "A")
    del ex["question"]["criteria"]
    assert prep(TOK, ex, 1024, 256) is None


def test_batches_cover_every_row_once():
    rows = [{"ids": [0] * (i % 7 + 1)} for i in range(53)]
    flat = sorted(i for b in batches(rows, 4, random.Random(0)) for i in b)
    assert flat == list(range(53))


class StubLM(nn.Module):
    def __init__(self, vocab=16512, d=64):
        super().__init__()
        self.emb = nn.Embedding(vocab, d)
        self.config = SimpleNamespace(hidden_size=d)
        self.model = lambda input_ids, use_cache=False: (self.emb(input_ids),)


def test_train_epoch_reduces_loss_on_a_learnable_task():
    torch.manual_seed(0)
    model = SpikeDecisionModel(StubLM(), head_layers=1, dropout=0.0)
    preps = [prep(TOK, example(i, "ABC"[i % 3]), 1024, 256) for i in range(12)]
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: 1.0)
    rng, dev = random.Random(0), torch.device("cpu")
    def mean_ce():
        z = score_logits(model, preps, TOK.pad_token_id, dev, micro=4)
        return float(np.mean([-np.sum(np.array(p["target"]) * (zz - np.log(np.exp(zz - zz.max()).sum()) - zz.max()))
                              for zz, p in zip(z, preps)]))

    ce0 = mean_ce()
    losses = [train_epoch(model, [make_row(p, rng) for p in preps], TOK.pad_token_id, opt, sched,
                          micro=4, accum=1, sigma=1.0, head_only=False, dev=dev, rng=rng) for _ in range(40)]
    assert all(np.isfinite(losses))
    # train_epoch's own return value mixes a noisy RL surrogate (can be negative), so compare the plain CE
    assert mean_ce() < 0.5 * ce0
    z = score_logits(model, preps, TOK.pad_token_id, dev, micro=4)
    hits = [int(np.argmax(zz) == int(np.argmax(p["target"]))) for zz, p in zip(z, preps)]
    assert np.mean(hits) > 0.8


def stub_model():
    torch.manual_seed(0)
    return SpikeDecisionModel(StubLM(), head_layers=1, dropout=0.0)


def tiny_setup(model, n=4):
    preps = [prep(TOK, example(i, "ABC"[i % 3]), 1024, 256) for i in range(n)]
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: 1.0)
    return preps, opt, sched


def test_head_only_epoch_leaves_trunk_untouched_but_trains_head():
    model = stub_model()
    # trunk deliberately left trainable: only detach_encoder=True keeps it still (weight decay skips grad-less params)
    preps, opt, sched = tiny_setup(model)
    emb0 = model.lm.emb.weight.detach().clone()
    head0 = model.scorer[1].weight.detach().clone()
    rng = random.Random(0)
    train_epoch(model, [make_row(p, rng) for p in preps], TOK.pad_token_id, opt, sched,
                micro=2, accum=1, sigma=1.0, head_only=True, dev=torch.device("cpu"), rng=rng)
    assert torch.equal(model.lm.emb.weight, emb0)
    assert not torch.equal(model.scorer[1].weight, head0)


def test_after_step_called_once_per_optimiser_step():
    model = stub_model()
    calls = []
    model.lm.after_step = lambda: calls.append(1)
    preps, opt, sched = tiny_setup(model, n=8)
    rng = random.Random(0)
    train_epoch(model, [make_row(p, rng) for p in preps], TOK.pad_token_id, opt, sched,
                micro=2, accum=2, sigma=1.0, head_only=False, dev=torch.device("cpu"), rng=rng)
    assert len(calls) == 2          # 4 micro-batches / accum 2


def test_evaluate_returns_summary_keys():
    from train_evidence import evaluate
    model = stub_model()
    preps, _, _ = tiny_setup(model)
    m = evaluate(model, preps, TOK.pad_token_id, torch.device("cpu"), micro=2)
    assert {"n", "accuracy", "brier", "ece"} <= set(m)


def test_prep_rejects_target_length_mismatch():
    ex = example(0, "A")                               # 4 options
    short = dict(ex, target=ex["target"][:3])
    assert prep(TOK, short, 1024, 256) is None
    assert prep(TOK, ex, 1024, 256) is not None


def test_schedule_total_counts_optimizer_steps():
    assert schedule_total(10, 4, 2, 3) == 6            # 3 * ceil(ceil(10/4)/2) = 3 * 2
    assert schedule_total(1, 4, 2, 3) == 3
    assert schedule_total(8, 4, 1, 2) == 4
    assert schedule_total(9, 4, 4, 1) == 1


def test_schedule_total_rejects_zero_examples():
    import pytest
    with pytest.raises(ValueError, match="no training examples after prep"):
        schedule_total(0, 4, 2, 3)


def test_build_out_cfg_adds_provenance_without_mutating_input():
    dcfg = {"max_len": 7, "temperature_by_options": {"choice:3-5": 1.2}}
    out = build_out_cfg(dcfg, "/some/dir/On-Fly-Jev.pt")
    assert out["data_license"] == DATA_LICENSE and "local train/eval use only" in DATA_LICENSE
    assert out["model_name"] == "on-fly-jev-evidence" and out["base_checkpoint"] == "On-Fly-Jev.pt"
    assert out["max_len"] == 7 and out["temperature_by_options"] == {"choice:3-5": 1.2}
    assert dcfg == {"max_len": 7, "temperature_by_options": {"choice:3-5": 1.2}}
