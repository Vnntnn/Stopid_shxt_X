import json
import random

import pytest
import torch

from tests.test_train import TOK, stub_model, tiny_setup
from train_evidence import (Deadline, FirstStepOOM, StopFlag, clamp_head_only, make_row, progress_event,
                            projection_event, run_epochs, should_save, startup_event, train_epoch)

CPU = torch.device("cpu")


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_deadline_off_never_expires():
    c = FakeClock()
    d = Deadline(0, clock=c)
    c.t = 1e9
    assert not d.expired()


def test_deadline_expires_after_budget_and_reports_elapsed():
    c = FakeClock()
    d = Deadline(2.0, clock=c)
    c.t = 119.9
    assert not d.expired()
    c.t = 120.0
    assert d.expired() and d.elapsed_min() == pytest.approx(2.0)


def test_should_save():
    assert [s for s in range(0, 11) if should_save(s, 3)] == [3, 6, 9]
    assert not any(should_save(s, 0) for s in range(0, 10))


def test_clamp_head_only():
    assert clamp_head_only(3, 1) == (1, None)
    v, note = clamp_head_only(2, 5)
    assert v == 2 and "clamp" in note


def test_progress_event_schema_and_rate():
    e = progress_event(epoch=1, step=20, examples_seen=1000, epoch_examples=400, epoch_seconds=8.0,
                       elapsed_min=1.5, loss=-0.123456, lrs=[1e-5, 1e-4], cuda_mem_gb=None)
    assert e["event"] == "progress" and e["examples_per_sec"] == 50.0
    assert e["lr_trunk"] == 1e-5 and e["lr_head"] == 1e-4 and e["cuda_mem_gb"] is None
    assert e["rlcd_loss"] == -0.1235
    json.dumps(e)
    assert progress_event(1, 1, 1, 1, 0.0, 0, 0.0, [1.0], 2.0)["examples_per_sec"] is None


def test_projection_event():
    e = projection_event(sec_per_step=3.0, total_steps=1200)
    assert e["event"] == "first_step" and e["projected_total_min"] == 60.0 and "rough" in e["note"]


def test_startup_event_includes_gpu_only_when_given():
    e = startup_event(100, 4, 16, 1000, 50, None)
    assert e["total_steps"] == 100 and e["micro"] == 4 and e["accum"] == 16
    assert e["train_examples"] == 1000 and e["dev_examples"] == 50 and e["gpu"] is None
    assert startup_event(1, 1, 1, 1, 1, ("RTX", 8.0))["gpu"] == {"name": "RTX", "vram_gb": 8.0}


def _run(model, n, **kw):
    preps, opt, sched = tiny_setup(model, n=n)
    rng = random.Random(0)
    loss = train_epoch(model, [make_row(p, rng) for p in preps], TOK.pad_token_id, opt, sched,
                       micro=2, accum=1, sigma=1.0, head_only=False, dev=CPU, rng=rng, **kw)
    return loss, sched


def test_train_epoch_stops_after_exactly_two_steps():
    seen = []
    stop = StopFlag()
    loss, sched = _run(stub_model(), 8, stop=stop, on_step=lambda info: seen.append(info["step_in_epoch"]),
                       should_stop=lambda: len(seen) >= 2)
    assert sched.last_epoch == 2 and seen == [1, 2]
    assert stop.stopped and torch.isfinite(torch.tensor(loss))


def test_train_epoch_without_stop_runs_all_steps():
    stop = StopFlag()
    _, sched = _run(stub_model(), 8, stop=stop, should_stop=lambda: False)
    assert sched.last_epoch == 4 and not stop.stopped


def test_first_step_oom_reports_and_exits_nonzero(capsys):
    out = []
    guard = FirstStepOOM(micro=8, emit=out.append)

    def boom():
        raise torch.cuda.OutOfMemoryError("fake")
    with pytest.raises(SystemExit) as ei:
        guard(boom)
    assert ei.value.code not in (0, None)
    assert out[0]["event"] == "oom_first_step" and out[0]["micro"] == 8 and "--micro" in out[0]["hint"]


def test_oom_after_first_step_is_not_caught():
    guard = FirstStepOOM(micro=8, emit=lambda e: None)
    guard(lambda: None)

    def boom():
        raise torch.cuda.OutOfMemoryError("late")
    with pytest.raises(torch.cuda.OutOfMemoryError):
        guard(boom)


def test_first_step_guard_ignores_other_errors():
    guard = FirstStepOOM(micro=8, emit=lambda e: None)
    with pytest.raises(ValueError):
        guard(lambda: (_ for _ in ()).throw(ValueError("x")))


def test_train_epoch_first_step_oom_through_guard():
    out = []
    model = stub_model()

    def boom(*a, **k):
        raise torch.cuda.OutOfMemoryError("fake")
    model.forward = boom
    with pytest.raises(SystemExit):
        _run(model, 4, step_guard=FirstStepOOM(2, out.append))
    assert out and out[0]["event"] == "oom_first_step"


def _epochs(model, tmp, n=8, epochs=2, head_only=0, deadline=None, save_every=0, log_every=0, clock=None,
            emit_into=None, saves_into=None, save_fn=None, **kw):
    preps, opt, sched = tiny_setup(model, n=n)
    saves = saves_into if saves_into is not None else []
    events = emit_into if isinstance(emit_into, list) else []
    r = run_epochs(model, preps, preps[:2], TOK.pad_token_id, opt, sched, trunk=list(model.lm.parameters()),
                   micro=2, accum=1, sigma=1.0, epochs=epochs, head_only_epochs=head_only, dev=CPU,
                   rng=random.Random(0), out_dir="out", save=save_fn or saves.append, deadline=deadline or Deadline(0),
                   save_every=save_every, log_every=log_every, total_steps=epochs * (n // 2),
                   emit=emit_into if callable(emit_into) else events.append, clock=clock or FakeClock(), **kw)
    return r, saves, events


def test_periodic_save_at_k_and_2k_global_steps():
    _, saves, events = _epochs(stub_model(), None, n=8, epochs=2, save_every=3)
    latest = [s for s in saves if s.endswith("latest.pt")]
    assert len(latest) == 2                                   # global steps 3 and 6 of 8 (crosses the epoch edge)
    saved_ev = [e for e in events if e.get("event") == "saved_latest"]
    assert [e["step"] for e in saved_ev] == [3, 6] and saved_ev[0]["epoch"] == 1 and saved_ev[1]["epoch"] == 2
    assert [s for s in saves if s.endswith("epoch1.pt") or s.endswith("epoch2.pt")] == ["out/epoch1.pt", "out/epoch2.pt"]


def test_progress_logged_every_n_and_first_step_projection():
    _, _, events = _epochs(stub_model(), None, n=8, epochs=1, log_every=2)
    assert [e["step"] for e in events if e.get("event") == "progress"] == [2, 4]
    assert len([e for e in events if e.get("event") == "first_step"]) == 1


def test_run_epochs_time_budget_stops_saves_and_evaluates_once():
    c = FakeClock()
    d = Deadline(1.0, clock=c)                                  # 60 s
    seen = []
    # expire the budget as soon as 2 global optimiser steps happened
    orig = d.expired
    d.expired = lambda: (c.__setattr__("t", 61.0) if len(seen) >= 2 else None) or orig()
    model = stub_model()
    preps, opt, sched = tiny_setup(model, n=8)
    saves, events = [], []

    def save(p):
        saves.append(p)
    import train_evidence
    real_eval = train_evidence.evaluate
    evals = []
    train_evidence.evaluate = lambda *a, **k: (evals.append(1), real_eval(*a, **k))[1]
    try:
        r = run_epochs(model, preps, preps[:2], TOK.pad_token_id, opt, sched, trunk=list(model.lm.parameters()),
                       micro=2, accum=1, sigma=1.0, epochs=3, head_only_epochs=0, dev=CPU, rng=random.Random(0),
                       out_dir="out", save=save, deadline=d, save_every=0, log_every=1, total_steps=12,
                       emit=lambda e: (events.append(e), seen.append(1) if e.get("event") == "progress" else None),
                       clock=c)
    finally:
        train_evidence.evaluate = real_eval
    assert r is True and sched.last_epoch == 2
    assert saves == ["out/stopped.pt"] and len(evals) == 1
    ev = events[-1]
    assert ev["event"] == "time_budget_reached" and ev["epoch"] == 1 and ev["step"] == 2 and ev["elapsed_min"] > 1


def test_run_epochs_without_budget_completes_and_saves_each_epoch():
    r, saves, _ = _epochs(stub_model(), None, n=4, epochs=2)
    assert r is False and saves == ["out/epoch1.pt", "out/epoch2.pt"]


def test_first_step_projection_is_emitted_right_after_step_one():
    _, _, events = _epochs(stub_model(), None, n=8, epochs=1, log_every=1)
    names = [e.get("event") for e in events]
    assert names[:3] == ["warmup_peak", "first_step", "progress"] and events[2]["step"] == 1


def test_budget_spent_during_epoch_eval_stops_before_next_epoch_without_second_eval():
    saves = []
    d = Deadline(1.0, clock=FakeClock())
    d.expired = lambda: "out/epoch1.pt" in saves
    model = stub_model()
    preps, opt, sched = tiny_setup(model, n=4)
    events = []
    r = run_epochs(model, preps, preps[:2], TOK.pad_token_id, opt, sched, trunk=list(model.lm.parameters()),
                   micro=2, accum=1, sigma=1.0, epochs=3, head_only_epochs=0, dev=CPU, rng=random.Random(0),
                   out_dir="out", save=saves.append, deadline=d, save_every=0, log_every=0, total_steps=6,
                   emit=events.append, clock=FakeClock())
    assert r is True and saves == ["out/epoch1.pt"] and sched.last_epoch == 2   # epoch1.pt == stopped weights
    assert events[-1]["event"] == "time_budget_reached" and events[-1]["epoch"] == 1
    assert not any(e.get("event") == "stopped_dev" for e in events)


# ---- fix round ----
import math

from train_evidence import NonFiniteLoss, default_micro, peak_warmup
from tests.test_train import example


def hook_forward(model, fn):
    orig, calls = model.forward, [0]

    def f(*a, **k):
        calls[0] += 1
        return fn(calls[0], orig, a, k)
    model.forward = f
    return calls


def test_peak_warmup_uses_longest_rows_and_changes_nothing():
    model = stub_model()
    exs = []
    for i in range(6):
        e = example(i, "ABC"[i % 3])
        e["state"]["task"] = "word " * (i * 15 + 1)
        exs.append(e)
    from train_evidence import prep
    preps = [prep(TOK, e, 1024, 256) for e in exs]
    rng = random.Random(0)
    rows = [make_row(p, rng) for p in preps]
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    shapes = []
    hook_forward(model, lambda n, orig, a, k: (shapes.append(tuple(a[0].shape)), orig(*a, **k))[1])
    before = {n: p.detach().clone() for n, p in model.named_parameters()}
    peak_warmup(model, rows, TOK.pad_token_id, 1.0, False, CPU, micro=2, opt=opt)
    assert shapes == [(2, max(len(r["ids"]) for r in rows))]
    assert all(torch.equal(before[n], p) for n, p in model.named_parameters())
    assert len(opt.state) == 0 and all(p.grad is None for p in model.parameters())


def test_each_phase_gets_a_warmup_peak_before_its_first_step():
    _, _, events = _epochs(stub_model(), None, n=4, epochs=2, head_only=1, log_every=1)
    names = [(e["event"], e.get("phase")) for e in events if e.get("event") in ("warmup_peak", "first_step")]
    assert names == [("warmup_peak", "head_only"), ("first_step", None), ("warmup_peak", "full")]
    assert events[0]["event"] == "warmup_peak" and events[0]["cuda_mem_gb"] is None


def test_oom_in_full_phase_warmup_reports_phase_and_exits_2():
    model = stub_model()

    def fn(n, orig, a, k):
        if k.get("detach_encoder") is False:
            raise torch.cuda.OutOfMemoryError("fake")
        return orig(*a, **k)
    hook_forward(model, fn)
    events = []
    with pytest.raises(SystemExit) as ei:
        _epochs(model, None, n=4, epochs=2, head_only=1, emit_into=events)
    assert ei.value.code == 2
    oom = [e for e in events if e.get("event", "").startswith("oom")]
    assert [(e["event"], e["phase"]) for e in oom] == [("oom_warmup", "full")]
    assert "--micro" in oom[0]["hint"]
    assert any(e.get("event") == "warmup_peak" and e["phase"] == "head_only" for e in events)


def test_oom_on_first_full_step_is_guarded_with_phase():
    model = stub_model()
    seen_full = []

    def fn(n, orig, a, k):
        if k.get("detach_encoder") is False:
            seen_full.append(1)
            if len(seen_full) == 2:                      # 1 = warm-up, 2 = first real full step
                raise torch.cuda.OutOfMemoryError("fake")
        return orig(*a, **k)
    hook_forward(model, fn)
    events = []
    with pytest.raises(SystemExit) as ei:
        _epochs(model, None, n=4, epochs=2, head_only=1, emit_into=events)
    assert ei.value.code == 2
    assert [e["phase"] for e in events if e.get("event") == "oom_first_step"] == ["full"]
    assert not any(e.get("event") == "crashed" for e in events)      # the OOM exit must not look like a crash


def test_crash_after_steps_saves_crashed_pt_and_reraises():
    model = stub_model()

    def fn(n, orig, a, k):
        if n == 4:                                       # call 1 = warm-up, 2-3 = steps 1-2
            raise RuntimeError("boom")
        return orig(*a, **k)
    hook_forward(model, fn)
    events = []
    saves = []
    with pytest.raises(RuntimeError, match="boom"):
        _epochs(model, None, n=8, epochs=1, emit_into=events, saves_into=saves)
    assert saves == ["out/crashed.pt"]
    c = [e for e in events if e.get("event") == "crashed"]
    assert len(c) == 1 and "RuntimeError" in c[0]["error"] and "boom" in c[0]["error"] and c[0]["step"] == 2


def test_crash_before_any_step_saves_nothing():
    model = stub_model()
    hook_forward(model, lambda n, orig, a, k: (_ for _ in ()).throw(RuntimeError("early")) if n == 2
                 else orig(*a, **k))
    saves, events = [], []
    with pytest.raises(RuntimeError):
        _epochs(model, None, n=8, epochs=1, emit_into=events, saves_into=saves)
    assert saves == [] and not any(e.get("event") == "crashed" for e in events)


def test_keyboard_interrupt_saves_and_a_failing_save_does_not_mask_it():
    model = stub_model()
    hook_forward(model, lambda n, orig, a, k: (_ for _ in ()).throw(KeyboardInterrupt()) if n == 3
                 else orig(*a, **k))
    saves = []
    with pytest.raises(KeyboardInterrupt):
        _epochs(model, None, n=8, epochs=1, saves_into=saves)
    assert saves == ["out/crashed.pt"]

    model = stub_model()
    hook_forward(model, lambda n, orig, a, k: (_ for _ in ()).throw(RuntimeError("orig")) if n == 3
                 else orig(*a, **k))

    def bad_save(p):
        raise OSError("disk full")
    with pytest.raises(RuntimeError, match="orig"):
        _epochs(model, None, n=8, epochs=1, save_fn=bad_save)


def test_nan_loss_writes_no_checkpoint_and_exits_3():
    model = stub_model()

    def fn(n, orig, a, k):
        lg, aux = orig(*a, **k)
        return (lg * float("nan") if n == 4 else lg), aux      # call 4 = optimiser step 3
    hook_forward(model, fn)
    saves, events = [], []
    with pytest.raises(SystemExit) as ei:
        _epochs(model, None, n=8, epochs=1, save_every=2, saves_into=saves, emit_into=events)
    assert ei.value.code == 3
    assert saves == ["out/latest.pt"]                           # step 2 only; nothing after the NaN
    n = [e for e in events if e.get("event") == "nan_loss"]
    assert len(n) == 1 and n[0]["loss"] == "nan" and n[0]["steps_completed"] == 2
    json.dumps(n[0], allow_nan=False)


def test_train_epoch_raises_before_stepping_on_nonfinite_loss():
    model = stub_model()
    hook_forward(model, lambda n, orig, a, k: (orig(*a, **k)[0] * float("nan"), None))
    with pytest.raises(NonFiniteLoss):
        _, sched = _run(model, 4)


def test_progress_event_is_json_safe_for_nonfinite():
    e = progress_event(1, 1, 1, 1, 1.0, 0.1, float("nan"), [float("inf")], None)
    json.dumps(e, allow_nan=False)
    assert e["rlcd_loss"] is None


def test_default_micro_for_small_cards():
    assert default_micro(8.0, 8) == 2 and default_micro(11.9, 8) == 2
    assert default_micro(12.0, 8) == 8 and default_micro(24.0, 16) == 16
    assert default_micro(8.0, 1) == 1


def test_no_redundant_stopped_pt_when_weights_were_just_saved():
    c = FakeClock()
    d = Deadline(1.0, clock=c)
    steps = []
    d.expired = lambda: len(steps) >= 2
    saves, events = [], []
    r = _epochs(stub_model(), None, n=8, epochs=3, deadline=d, save_every=2, log_every=1,
                saves_into=saves, emit_into=steps_and(events, steps))[0]
    assert r is True and saves == ["out/latest.pt"]
    assert events[-1]["event"] == "time_budget_reached" and events[-1]["step"] == 2


def steps_and(events, steps):
    return lambda e: (events.append(e), steps.append(1) if e.get("event") == "progress" else None)


def test_first_step_projection_measures_the_step_not_the_warmup():
    c = FakeClock()
    model = stub_model()

    def fn(n, orig, a, k):
        c.t += 3.0                                       # every forward costs 3 s (warm-up included)
        return orig(*a, **k)
    hook_forward(model, fn)
    events = []
    _epochs(model, None, n=8, epochs=1, clock=c, emit_into=events)
    fs = [e for e in events if e.get("event") == "first_step"][0]
    assert fs["sec_per_step"] == 3.0 and fs["projected_total_min"] == 0.2
