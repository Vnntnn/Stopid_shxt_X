"""Fine-tune On-Fly-Jev on evidence-choice data (choice only).

./venv/bin/python train_evidence.py --train data/evidence/train.jsonl --dev data/evidence/dev.jsonl --out runs/ev1
Spec: docs/superpowers/specs/2026-10-10-evidence-choice-finetune-design.md

Overnight-run safety (all optional):
  --max-minutes N      wall-clock budget for the whole run (train + evals). When spent, the current optimiser step
                       finishes, <out>/stopped.pt is saved, ONE dev eval runs, a time_budget_reached line is printed,
                       exit 0.
  --save-every-steps K every K global optimiser steps <out>/latest.pt is (over)written atomically. The optimiser
                       state is NOT saved: resume = a new run with `--base <out>/latest.pt` (fresh AdamW + schedule).
  --log-every N        a "progress" JSON line every N steps (examples_per_sec = examples since the start of the
                       current epoch / seconds since then; evaluations are not counted in it).
A CUDA OOM in the peak-memory warm-up (oom_warmup) or on the first optimiser step (oom_first_step) of EACH phase
(head_only, full) prints a JSON line and exits 2 (no silent micro shrink). A non-finite loss exits 3 without writing
any checkpoint. Any other exception after >= 1 step saves <out>/crashed.pt and re-raises.

Practical notes for an 8 GB card:
  * launch with PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
  * without --micro, cards under 12 GB default to micro 2 (rig_microbatch would say 8 for any "5060")
  * --max-minutes overshoots by the final save plus one dev eval: budget ~10 extra minutes
  * the budget stop does NOT anneal the LR: choose --epochs/--limit so the planned run fits the night
  * projected_total_min comes from the first head-only step and is optimistic (full steps are ~2-3x slower):
    trust examples_per_sec from the epoch-2 progress lines
"""
import argparse
import json
import math
import os
import random
import sys
import time

import numpy as np
import torch

from decision_core import (QTYPES, assemble, check_question, collate, load_decision_model, load_tokenizer,
                           rig_microbatch, rlcd_loss, save_decision_model, seed_all, to_internal,
                           tokenize_question, tokenize_state)
from evidence.metrics import summarize

DATA_LICENSE = ("voteview: no stated licence; user decision 2026-10-10 = local train/eval use only; do not "
                "redistribute the data or weights trained on it. fever: CC BY-SA 3.0")
KEYS = ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")


def build_out_cfg(dcfg, base_path):
    """decision_cfg written into every saved checkpoint: input cfg plus model name, base and data licence."""
    return dict(dcfg, model_name="on-fly-jev-evidence", base_checkpoint=os.path.basename(base_path),
                data_license=DATA_LICENSE)


class Deadline:
    """Wall-clock budget. max_minutes <= 0 means no budget (never expires). Clock is injectable for tests."""

    def __init__(self, max_minutes, clock=time.monotonic):
        self.max_minutes, self.clock = max_minutes, clock
        self.t0 = clock()

    def elapsed_min(self):
        return (self.clock() - self.t0) / 60.0

    def expired(self):
        return self.max_minutes > 0 and self.elapsed_min() >= self.max_minutes


class StopFlag:
    """Set by train_epoch when its should_stop callable fired."""
    stopped = False


def should_save(step, every):
    return every > 0 and step > 0 and step % every == 0


def clamp_head_only(epochs, head_only):
    if head_only > epochs:
        return epochs, "note: --head-only-epochs %d > --epochs %d, clamped to %d" % (head_only, epochs, epochs)
    return head_only, None


def startup_event(total_steps, micro, accum, n_train, n_dev, gpu):
    """gpu: (name, vram_gb) or None."""
    return {"event": "startup", "total_steps": total_steps, "micro": micro, "accum": accum,
            "train_examples": n_train, "dev_examples": n_dev,
            "gpu": None if gpu is None else {"name": gpu[0], "vram_gb": gpu[1]}}


def progress_event(epoch, step, examples_seen, epoch_examples, epoch_seconds, elapsed_min, loss, lrs, cuda_mem_gb):
    return {"event": "progress", "epoch": epoch, "step": step, "examples_seen": examples_seen,
            "examples_per_sec": round(epoch_examples / epoch_seconds, 2) if epoch_seconds > 0 else None,
            "elapsed_min": round(elapsed_min, 2),
            "rlcd_loss": round(loss, 4) if math.isfinite(loss) else None,
            "lr_trunk": finite_or_none(lrs[0]), "lr_head": finite_or_none(lrs[-1]), "cuda_mem_gb": cuda_mem_gb}


def projection_event(sec_per_step, total_steps):
    return {"event": "first_step", "sec_per_step": round(sec_per_step, 3), "total_steps": total_steps,
            "projected_total_min": round(sec_per_step * total_steps / 60.0, 1),
            "note": "rough projection from ONE step (training only, excludes evals, includes CUDA warm-up); "
                    "later progress lines are more reliable"}


class FirstStepOOM:
    """Wraps optimiser-step bodies; an OOM in the very first one is reported and exits 2. Later steps pass through."""

    def __init__(self, micro, emit, oom_types=(torch.cuda.OutOfMemoryError,), phase=None, event="oom_first_step"):
        self.micro, self.emit, self.oom_types, self.done = micro, emit, oom_types, False
        self.phase, self.event = phase, event

    def __call__(self, fn):
        if self.done:
            return fn()
        try:
            r = fn()
        except self.oom_types:
            self.emit({"event": self.event, "phase": self.phase, "micro": self.micro,
                       "hint": "rerun with a smaller --micro (e.g. halve it) or --head-only-epochs <epochs>"})
            raise SystemExit(2)
        self.done = True
        return r


class NonFiniteLoss(RuntimeError):
    pass


def finite_or_none(x):
    return x if x is None or math.isfinite(x) else None


def default_micro(vram_gb, rig_micro):
    """rig_microbatch is too generous for 8 GB cards: under 12 GB use micro 2."""
    return min(rig_micro, 2) if vram_gb is not None and vram_gb < 12 else rig_micro


def emit_json(d):
    print(json.dumps(d), flush=True)


def load_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def prep(tok, ex, max_len, head_max_len):
    """Tokenise once. None if the example cannot be rendered within the budgets or is malformed."""
    try:
        check_question("q", ex["question"])
        q = to_internal(ex["question"])
        qtok = tokenize_question(tok, q)
        st = tokenize_state(tok, ex["state"])
        _, markers = assemble(tok.bos_token_id, st, qtok, max_len, head_max_len)
    except (ValueError, KeyError):
        return None
    if len(markers) != len(qtok["opts"]) or len(ex["target"]) != len(qtok["opts"]):
        return None
    return {"st": st, "qtok": qtok, "target": list(ex["target"]), "max_len": max_len,
            "hml": head_max_len, "bos": tok.bos_token_id}


def make_row(p, rng=None):
    """rng given: shuffle option order (training); None: options as written (eval)."""
    k = len(p["qtok"]["opts"])
    order = list(range(k))
    if rng is not None:
        rng.shuffle(order)
    ids, markers = assemble(p["bos"], p["st"], p["qtok"], p["max_len"], p["hml"], order=order)
    return {"ids": ids, "markers": markers, "qtype": QTYPES["choice"],
            "target": [p["target"][i] for i in order], "order": order}


def batches(rows, micro, rng):
    """Length-bucketed micro-batches of row indices."""
    idx = list(range(len(rows)))
    rng.shuffle(idx)
    out = []
    for i in range(0, len(idx), micro * 50):
        chunk = sorted(idx[i:i + micro * 50], key=lambda j: len(rows[j]["ids"]))
        out += [chunk[j:j + micro] for j in range(0, len(chunk), micro)]
    rng.shuffle(out)
    return out


def train_epoch(model, rows, pad_id, opt, sched, micro, accum, sigma, head_only, dev, rng,
                should_stop=None, stop=None, on_step=None, step_guard=None):
    """One epoch. Optional keywords (defaults keep the old behaviour):
    should_stop: callable checked after every optimiser step (after on_step); True ends the epoch early,
        never mid-backward; stop.stopped is then set. LR schedule is untouched (planned totals).
    on_step(info): info = step_in_epoch, examples (this epoch so far), loss (mean so far), lrs.
    step_guard(fn): wraps each optimiser-step body (used for the first-step OOM report)."""
    model.train()
    bs = batches(rows, micro, rng)
    total, n, step = 0.0, 0, 0

    def run_step(group):
        nonlocal total, n
        n_tot = sum(len(b) for b in group)
        group_loss = 0.0
        for b in group:
            batch = collate([rows[i] for i in b], pad_id)
            with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == "cuda"):
                logits, _ = model(*(batch[k].to(dev) for k in KEYS), detach_encoder=head_only)
            loss, _ = rlcd_loss(logits.float(), batch["target"].to(dev), batch["qtype"].to(dev),
                                batch["marker_mask"].to(dev), sigma=sigma)
            (loss * len(b) / n_tot).backward()
            total += float(loss.detach()) * len(b)
            group_loss += float(loss.detach()) * len(b) / n_tot
            n += len(b)
        if not math.isfinite(group_loss):          # never step (or later save) on a poisoned loss
            raise NonFiniteLoss(group_loss)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        if hasattr(model.lm, "after_step"):      # FlyTrunk: re-impose Dale signs after every step
            model.lm.after_step()

    for s in range(0, len(bs), accum):
        group = bs[s:s + accum]
        if step_guard is None:
            run_step(group)
        else:
            step_guard(lambda: run_step(group))
        step += 1
        if on_step is not None:
            on_step({"step_in_epoch": step, "examples": n, "loss": total / max(1, n),
                     "lrs": [g["lr"] for g in opt.param_groups]})
        if should_stop is not None and should_stop():
            if stop is not None:
                stop.stopped = True
            break
    return total / max(1, n)


def peak_warmup(model, rows, pad_id, sigma, head_only, dev, micro, opt):
    """Forward+backward on the `micro` LONGEST rows with this phase's settings, then drop the grads: the peak
    activation/grad memory is hit now, not hours later. No optimiser or scheduler step (weights/opt state unchanged)."""
    model.train()
    longest = sorted(range(len(rows)), key=lambda i: len(rows[i]["ids"]), reverse=True)[:micro]
    batch = collate([rows[i] for i in longest], pad_id)
    with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == "cuda"):
        logits, _ = model(*(batch[k].to(dev) for k in KEYS), detach_encoder=head_only)
    loss, _ = rlcd_loss(logits.float(), batch["target"].to(dev), batch["qtype"].to(dev),
                        batch["marker_mask"].to(dev), sigma=sigma)
    loss.backward()
    opt.zero_grad(set_to_none=True)


@torch.no_grad()
def score_logits(model, preps, pad_id, dev, micro):
    model.eval()
    out = []
    for i in range(0, len(preps), micro):
        rows = [make_row(p) for p in preps[i:i + micro]]
        b = collate(rows, pad_id)
        with torch.autocast(dev.type, dtype=torch.bfloat16, enabled=dev.type == "cuda"):
            logits, _ = model(*(b[k].to(dev) for k in KEYS))
        out += [z[:len(r["markers"])].float().cpu().numpy() for r, z in zip(rows, logits)]
    return out


def evaluate(model, preps, pad_id, dev, micro):
    probs = [np.exp(z - z.max()) / np.exp(z - z.max()).sum() for z in score_logits(model, preps, pad_id, dev, micro)]
    return summarize(probs, [p["target"] for p in preps])


def schedule_total(n_examples, micro, accum, epochs):
    """Optimizer steps over the whole run (LR schedule length)."""
    if n_examples == 0:
        raise ValueError("no training examples after prep")
    return epochs * -(-(-(-n_examples // micro)) // accum)


def replay_examples(n_new, frac, seed):
    """Choice-type items from the existing mix, so the trunk does not forget the old tasks."""
    import decision_data
    want = int(n_new * frac / (1 - frac))
    pool = [e for e in decision_data.build("mix", "train", per_source=want // 10 + 1, seed=seed)
            if e["question"]["type"] == "choice"]
    random.Random(seed).shuffle(pool)
    return pool[:want]


def run_epochs(model, tr, dv, pad_id, opt, sched, trunk, micro, accum, sigma, epochs, head_only_epochs, dev, rng,
               out_dir, save, deadline, save_every, log_every, total_steps, emit=emit_json, clock=time.monotonic):
    """The epoch loop. save(path) writes a checkpoint atomically. Returns True if the time budget stopped the run.
    Per phase (head_only / full): a peak-memory warm-up, then a first-step OOM guard. Exit 2 = OOM, 3 = NaN loss."""
    step, examples_seen, last_saved = 0, 0, None
    guards = {}
    cuda = dev.type == "cuda"
    epoch = 0

    def save_ckpt(name):
        nonlocal last_saved
        save(os.path.join(out_dir, name))
        last_saved = step

    def budget_stop(ep, evaluate_now):
        if last_saved != step:                     # else the weights are already on disk (latest/epoch checkpoint)
            save_ckpt("stopped.pt")
        if evaluate_now:
            emit({"event": "stopped_dev", "epoch": ep, "dev": evaluate(model, dv, pad_id, dev, micro)})
        emit({"event": "time_budget_reached", "epoch": ep, "step": step,
              "elapsed_min": round(deadline.elapsed_min(), 2)})
        return True

    try:
        for epoch in range(epochs):
            if deadline.expired():                 # budget ran out in the previous epoch's evaluation
                return budget_stop(epoch, False)
            head_only = epoch < head_only_epochs
            phase = "head_only" if head_only else "full"
            # ponytail: SpikeDecisionModel detaches AFTER in_proj, so in_proj also waits for the unfrozen epochs
            for p in trunk:
                p.requires_grad_(not head_only)
            rows = [make_row(p, rng) for p in tr]                  # fresh option order every epoch
            if phase not in guards:
                guards[phase] = FirstStepOOM(micro, emit, phase=phase)
                FirstStepOOM(micro, emit, phase=phase, event="oom_warmup")(
                    lambda: peak_warmup(model, rows, pad_id, sigma, head_only, dev, micro, opt))
                emit({"event": "warmup_peak", "phase": phase,
                      "cuda_mem_gb": round(torch.cuda.max_memory_allocated() / 2 ** 30, 3) if cuda else None})
                if cuda:
                    torch.cuda.reset_peak_memory_stats()
            t_ep, base_seen = clock(), examples_seen

            def on_step(info):
                nonlocal step, examples_seen
                step += 1
                examples_seen = base_seen + info["examples"]
                if step == 1:
                    emit(projection_event(clock() - t_ep, total_steps))
                if log_every > 0 and step % log_every == 0:
                    emit(progress_event(epoch + 1, step, examples_seen, info["examples"], clock() - t_ep,
                                        deadline.elapsed_min(), info["loss"], info["lrs"],
                                        round(torch.cuda.max_memory_allocated() / 2 ** 30, 3) if cuda else None))
                if should_save(step, save_every):
                    save_ckpt("latest.pt")
                    emit({"event": "saved_latest", "step": step, "epoch": epoch + 1,
                          "elapsed_min": round(deadline.elapsed_min(), 2)})

            stop = StopFlag()
            loss = train_epoch(model, rows, pad_id, opt, sched, micro, accum, sigma, head_only, dev, rng,
                               should_stop=deadline.expired, stop=stop, on_step=on_step, step_guard=guards[phase])
            if stop.stopped:
                return budget_stop(epoch + 1, True)
            m = evaluate(model, dv, pad_id, dev, micro)
            # rlcd_loss is an RL-surrogate + CE value (can be <= 0), not comparable to dev CE/Brier;
            # judge convergence on the dev metrics.
            emit({"epoch": epoch + 1, "head_only": head_only, "rlcd_loss": round(loss, 4), "dev": m})
            save_ckpt("epoch%d.pt" % (epoch + 1))
    except NonFiniteLoss as e:
        emit({"event": "nan_loss", "epoch": epoch + 1, "steps_completed": step, "loss": str(float(e.args[0]))})
        raise SystemExit(3)
    except SystemExit:
        raise
    except BaseException as e:                     # incl. KeyboardInterrupt: keep the work done so far
        if step > 0:
            emit({"event": "crashed", "epoch": epoch + 1, "step": step, "error": "%s: %s" % (type(e).__name__, e)})
            try:
                save(os.path.join(out_dir, "crashed.pt"))
            except BaseException as se:            # never mask the original error
                emit({"event": "crash_save_failed", "error": "%s: %s" % (type(se).__name__, se)})
        raise
    return False


def main():
    ap =argparse.ArgumentParser()
    ap.add_argument("--base", default="On-Fly-Jev.pt")
    ap.add_argument("--train", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--code-dir", default=".")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--head-only-epochs", type=int, default=1)
    ap.add_argument("--lr-trunk", type=float, default=3e-5)
    ap.add_argument("--lr-head", type=float, default=1e-4)
    ap.add_argument("--sigma", type=float, default=1.0)    # RLCD noise; the original value is not in this repo
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--micro", type=int, default=0, help="0 = pick from the GPU via rig_microbatch (cards < 12 GB: 2)")
    ap.add_argument("--replay", type=float, default=0.25)
    ap.add_argument("--limit", type=int, default=0, help="use only the first N train/dev items (smoke test)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=0, help="wall-clock budget for the whole run (overshoots by final save + one dev eval); 0 = off")
    ap.add_argument("--save-every-steps", type=int, default=0, help="write <out>/latest.pt every K steps; 0 = off")
    ap.add_argument("--log-every", type=int, default=20, help="progress line every N optimiser steps; 0 = off")
    a = ap.parse_args()
    deadline = Deadline(a.max_minutes)
    if a.epochs < 1:
        ap.error("--epochs must be >= 1, got %d" % a.epochs)
    if a.max_minutes < 0 or a.save_every_steps < 0 or a.log_every < 0:
        ap.error("--max-minutes, --save-every-steps and --log-every must be >= 0")
    a.head_only_epochs, note = clamp_head_only(a.epochs, a.head_only_epochs)
    if note:
        print(note)
    if not 0 <= a.replay < 1:
        ap.error("--replay must be in [0, 1), got %s" % a.replay)

    seed_all(a.seed)
    rng, dev = random.Random(a.seed), torch.device(a.device)
    tok = load_tokenizer(a.code_dir)
    model, dcfg, lm_cfg = load_decision_model(a.code_dir, a.base, dev)
    max_len, hml = dcfg.get("max_len", 1024), dcfg.get("head_max_len", 256)

    train_ex, dev_ex = load_jsonl(a.train), load_jsonl(a.dev)
    if a.limit:
        train_ex, dev_ex = train_ex[:a.limit], dev_ex[:a.limit]
    if a.replay > 0:
        n_new = len(train_ex)
        train_ex += replay_examples(n_new, a.replay, a.seed)
        print("replay: requested %d, got %d" % (int(n_new * a.replay / (1 - a.replay)), len(train_ex) - n_new))
    tr = [p for p in (prep(tok, e, max_len, hml) for e in train_ex) if p]
    dv = [p for p in (prep(tok, e, max_len, hml) for e in dev_ex) if p]
    print("train %d (dropped %d)  dev %d (dropped %d)" % (len(tr), len(train_ex) - len(tr), len(dv), len(dev_ex) - len(dv)))

    gpu = None
    if dev.type == "cuda":
        gpu = (torch.cuda.get_device_name(0), round(torch.cuda.get_device_properties(0).total_memory / 2 ** 30, 2))
    _, micro, accum = rig_microbatch(a.batch, dev.type)
    if gpu and not a.micro and default_micro(gpu[1], micro) != micro:
        micro = default_micro(gpu[1], micro)
        accum = max(1, a.batch // micro)
        emit_json({"event": "micro_default", "micro": micro, "vram_gb": gpu[1]})
    if a.micro:
        micro, accum = a.micro, max(1, a.batch // a.micro)
        if a.batch % a.micro:
            print("warning: --batch %d is not a multiple of --micro %d; effective batch is %d"
                  % (a.batch, a.micro, micro * accum), file=sys.stderr)
    trunk = [p for p in model.lm.parameters() if p.requires_grad]        # frozen cell types stay frozen
    head = [p for n, p in model.named_parameters() if not n.startswith("lm.") and p.requires_grad]
    # ponytail: AdamW for all params; the trunk was pretrained with NorMuon (normuon.py), switch if fine-tune stalls
    opt = torch.optim.AdamW([{"params": trunk, "lr": a.lr_trunk}, {"params": head, "lr": a.lr_head}],
                            weight_decay=0.01)
    total = schedule_total(len(tr), micro, accum, a.epochs)
    warm = max(1, total // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * max(0.0, 1 - s / total))

    emit_json(startup_event(total, micro, accum, len(tr), len(dv), gpu))

    os.makedirs(a.out, exist_ok=True)
    out_cfg = build_out_cfg(dcfg, a.base)
    run_epochs(model, tr, dv, tok.pad_token_id, opt, sched, trunk, micro, accum, a.sigma, a.epochs,
               a.head_only_epochs, dev, rng, a.out, lambda path: save_decision_model(path, model, lm_cfg, out_cfg),
               deadline, a.save_every_steps, a.log_every, total)


if __name__ == "__main__":
    main()
