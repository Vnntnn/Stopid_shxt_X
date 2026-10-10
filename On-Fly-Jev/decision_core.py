"""Typed-decision core for spikewhale models (Laya / Jev style, System 1).

Port of convaiinnovations/laya `laya/common.py` onto our causal decoder trunk.

What is the same as Laya
------------------------
* Question types `choice` / `score` / `noul`, option rendering, criteria rules.
* DecisionModel head: `type_emb` added to every position, a 2-layer
  BIDIRECTIONAL transformer head over the whole sequence (padding-masked), a
  scorer MLP read at one marker position per option, the `act_head`, and a
  per-type `temperature` buffer. All options of a question are scored together
  in ONE forward pass.
* RLCD reward (log + spherical + RPS for ordinal), temperature fitting, ECE,
  the answer/confidence definitions.

What changes for a causal decoder
---------------------------------
Laya's encoder reads the state AFTER the options, and every token sees every
other token. Our trunk is causal, so an option's hidden state can only see what
comes before it. The sequence is therefore reordered so everything an option
needs is to its left:

    <bos> State:\n{state} \n\n{type} question: {ins}\nOptions: \n- opt0 \n- opt1 ...

The marker for option i is the LAST token of its "\n- opt_i" segment (it has
read state, question, earlier options and its own text). The bidirectional
head then lets every marker see every other option, which is what Laya's
encoder gives for free. Batches are RIGHT-padded, so padding never affects a
real token under causal attention and the trunk needs no attention mask (it
keeps the FlashAttention path); only the bidirectional head uses the pad mask.

Because a causal trunk sees options in order, training shuffles the option order
per example (targets permuted to match) so no position is privileged.
"""
import json
import math
import os
import random
import sys
from typing import Dict, List, Optional, Union

import numpy as np
import torch
import torch.nn as nn
from torch.utils.checkpoint import checkpoint

QTYPES = {"choice": 0, "score": 1, "noul": 2}
QTYPE_NAMES = {v: k for k, v in QTYPES.items()}
_DEFAULT_NOUL_LABELS = {"false": "false", "true": "true"}
OPT_MAX_TOKENS = 48

TEMP_MIN, TEMP_MAX = 0.5, 5.0   # Laya's runtime clamp on fitted temperatures


# --------------------------------------------------------------------------- #
# Question rendering (verbatim Laya semantics)
# --------------------------------------------------------------------------- #
def serialize_state(state: Union[str, dict, list]) -> str:
    if isinstance(state, str):
        return state
    return json.dumps(state, ensure_ascii=False)


def render_criterion(value) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "), default=str)


def _resolve_noul_labels(labels=None):
    if labels is None:
        labels = _DEFAULT_NOUL_LABELS
    if not isinstance(labels, dict) or set(labels) != {"false", "true"}:
        raise ValueError("noul labels must map exactly 'false' and 'true' to distinct non-empty strings")
    f, t = labels["false"], labels["true"]
    if not isinstance(f, str) or not isinstance(t, str):
        raise ValueError("noul labels must map exactly 'false' and 'true' to distinct non-empty strings")
    f, t = f.strip(), t.strip()
    if not f or not t or f == t:
        raise ValueError("noul labels must map exactly 'false' and 'true' to distinct non-empty strings")
    return f, t


def render_options(q: Dict) -> List[str]:
    """Option texts in label-index order. Noul order is always [false, true]."""
    t, crit = q["t"], q.get("crit")
    if t == "choice":
        return [k if v is None or v == "" else "%s: %s" % (k, render_criterion(v)) for k, v in crit.items()]
    if t == "score":
        return ["level %d: %s" % (i, render_criterion(c)) for i, c in enumerate(crit)]
    crit = crit or {}
    f, tr = _resolve_noul_labels(q.get("labels"))
    fc, tc = crit.get("false"), crit.get("true")
    return [f + ": " + (render_criterion(fc) if fc not in (None, "") else "no, the statement does not hold"),
            tr + ": " + (render_criterion(tc) if tc not in (None, "") else "yes, the statement holds")]


def check_question(qid: str, qdef) -> None:
    """Reject a malformed question with a message naming it (Laya's rules)."""
    if not isinstance(qdef, dict):
        raise ValueError("question %r: definition must be a dict" % (qid,))
    t = qdef.get("type")
    if t not in QTYPES:
        raise ValueError("question %r: unknown type %r; use one of %s" % (qid, t, sorted(QTYPES)))
    if "instructions" not in qdef:
        raise ValueError("question %r: no 'instructions'" % (qid,))
    crit = qdef.get("criteria")
    if t == "choice":
        if not isinstance(crit, (dict, list)) or not crit:
            raise ValueError("question %r: choice needs non-empty 'criteria' (dict label->desc or list)" % (qid,))
    elif t == "score":
        if not isinstance(crit, list) or not crit:
            raise ValueError("question %r: score needs 'criteria' as a non-empty list of levels" % (qid,))
    elif crit is not None:
        if not isinstance(crit, dict) or not {str(k).lower() for k in crit} <= {"true", "false"}:
            raise ValueError("question %r: noul 'criteria' must be keyed only 'true'/'false'" % (qid,))
    if "labels" in qdef:
        if t != "noul":
            raise ValueError("question %r: 'labels' is only supported for noul questions" % (qid,))
        _resolve_noul_labels(qdef["labels"])


def to_internal(qdef: Dict) -> Dict:
    t, crit = qdef["type"], qdef.get("criteria")
    if t == "choice" and isinstance(crit, list):
        crit = {c: None for c in crit}
    elif t == "noul" and isinstance(crit, dict):
        crit = {str(k).lower(): v for k, v in crit.items()}
    ins = qdef["instructions"]
    if not isinstance(ins, str):
        ins = json.dumps(ins, ensure_ascii=False)
    q = {"t": t, "ins": ins, "crit": crit}
    if "labels" in qdef:
        q["labels"] = qdef["labels"]
    return q


# --------------------------------------------------------------------------- #
# Tokenization / causal sequence layout
# --------------------------------------------------------------------------- #
def encode(tok, text: str) -> List[int]:
    ids = tok.encode(text, add_special_tokens=False)
    return ids.tolist() if hasattr(ids, "tolist") else list(ids)


def tokenize_question(tok, q: Dict) -> Dict:
    """Pre-tokenize the question part once: head ids + one id list per option."""
    head = encode(tok, "\n\n%s question: %s\nOptions:" % (q["t"], q["ins"]))
    opts = [encode(tok, "\n- " + o)[:OPT_MAX_TOKENS] for o in render_options(q)]
    return {"head": head, "opts": opts}


def tokenize_state(tok, state) -> List[int]:
    return encode(tok, "State:\n" + serialize_state(state))


def assemble(bos_id: int, state_ids: List[int], qtok: Dict, max_len: int, head_max_len: int,
             order: Optional[List[int]] = None, truncate_left: bool = False):
    """<bos> state | question | options(in `order`). Returns (ids, markers).

    Same budgeting as Laya's build_sequence: options + question share
    `head_max_len`; if options crowd it out they are cut evenly; the state gets
    whatever room is left of `max_len` (truncated right, or left for chat lists).
    markers[j] is the position of the option `order[j]`.
    """
    opts = qtok["opts"]
    order = list(range(len(opts))) if order is None else order
    opt_ids = [opts[i] for i in order]
    budget = head_max_len - sum(len(o) for o in opt_ids)
    if budget < 16:
        per = max(4, (head_max_len - 16) // max(1, len(opt_ids)))
        opt_ids = [o[:per] for o in opt_ids]
        budget = head_max_len - sum(len(o) for o in opt_ids)
    head = qtok["head"][: max(8, budget)]
    tail = list(head)
    rel_markers = []
    for o in opt_ids:
        tail.extend(o)
        rel_markers.append(len(tail) - 1)
    room = max(0, max_len - 1 - len(tail))
    st = state_ids[max(0, len(state_ids) - room):] if truncate_left else state_ids[:room]
    ids = [bos_id] + st + tail
    off = 1 + len(st)
    markers = [off + m for m in rel_markers]
    ids = ids[:max_len]
    return ids, [m for m in markers if m < max_len]


def collate(rows: List[Dict], pad_id: int):
    """rows: dicts with ids, markers, qtype, optional target. Right padding."""
    n, L = len(rows), max(len(r["ids"]) for r in rows)
    kmax = max(len(r["markers"]) for r in rows)
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    target = torch.zeros((n, kmax), dtype=torch.float32)
    teacher = torch.zeros((n, kmax), dtype=torch.float32)
    has_teacher = torch.zeros(n, dtype=torch.bool)
    for i, r in enumerate(rows):
        ids[i, :len(r["ids"])] = torch.tensor(r["ids"])
        att[i, :len(r["ids"])] = 1
        k = len(r["markers"])
        mpos[i, :k] = torch.tensor(r["markers"])
        mmask[i, :k] = True
        if "target" in r:
            target[i, :len(r["target"])] = torch.tensor(r["target"], dtype=torch.float32)
        if "teacher" in r:
            teacher[i, :len(r["teacher"])] = torch.tensor(r["teacher"], dtype=torch.float32)
            has_teacher[i] = True
    return {"input_ids": ids, "attention_mask": att, "marker_pos": mpos, "marker_mask": mmask,
            "target": target, "teacher": teacher, "has_teacher": has_teacher,
            "qtype": torch.tensor([r["qtype"] for r in rows])}


# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #
class SpikeDecisionModel(nn.Module):
    """Causal spikewhale trunk + Laya's typed decision head."""

    def __init__(self, lm: nn.Module, head_layers: int = 2, n_act: int = 2, dropout: float = 0.1,
                 head_dim: int = None):
        super().__init__()
        self.lm = lm
        d_in = lm.config.hidden_size
        d = head_dim or d_in
        # FlyNeuron: project its 1,500-wide read-out down to the Byrne-Jev head width so the head
        # stays ~8.5M params (trained at the head learning rate, not the trunk's).
        self.in_proj = nn.Linear(d_in, d) if d != d_in else None
        nhead = next(n for n in range(max(1, d // 64), 0, -1) if d % n == 0)
        layer = nn.TransformerEncoderLayer(d, nhead, 4 * d, dropout, batch_first=True, norm_first=True)
        self.head = nn.TransformerEncoder(layer, head_layers, enable_nested_tensor=False) if head_layers > 0 else None
        self.type_emb = nn.Embedding(3, d)
        self.scorer = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, d), nn.GELU(), nn.Linear(d, 1))
        self.act_head = nn.Sequential(nn.Linear(d + 4, 256), nn.GELU(), nn.Linear(256, n_act))
        self.register_buffer("temperature", torch.ones(3))
        self.head_checkpointing = False

    def forward(self, input_ids, attention_mask, marker_pos, marker_mask, qtype, detach_encoder: bool = False):
        # Right-padded + causal: pads come after every real token, so no mask needed.
        h = self.lm.model(input_ids=input_ids, use_cache=False)[0]
        if self.in_proj is not None:
            h = self.in_proj(h)
        if detach_encoder:
            h = h.detach()
        h = h + self.type_emb(qtype)[:, None, :].to(h.dtype)
        if self.head is not None:
            pad = ~attention_mask.bool()
            for layer in self.head.layers:
                if self.head_checkpointing and self.training and torch.is_grad_enabled():
                    h = checkpoint(layer, h, src_key_padding_mask=pad, use_reentrant=False)
                else:
                    h = layer(h, src_key_padding_mask=pad)
        idx = marker_pos.clamp(min=0)[:, :, None].expand(-1, -1, h.size(-1))
        m = torch.gather(h, 1, idx)
        logits = self.scorer(m).squeeze(-1).float().masked_fill(~marker_mask, -1e4)

        p = torch.softmax(logits.detach(), -1)
        k = marker_mask.sum(-1).clamp(min=2).float()
        ent = -(p * torch.log(p.clamp_min(1e-9))).sum(-1) / torch.log(k)
        if p.size(-1) >= 2:
            top2 = p.topk(2, -1).values
        else:
            top1 = p.topk(1, -1).values
            top2 = torch.cat([top1, torch.zeros_like(top1)], dim=-1)
        feats = torch.stack([top2[:, 0], top2[:, 0] - top2[:, 1], ent, k / 255.0], -1)
        pooled = h[:, 0].float()   # <bos> position (causal: sees only itself; kept for API parity)
        act_logits = self.act_head(torch.cat([pooled, feats], -1))
        return logits, act_logits


def load_base_lm(code_dir: str, ckpt: str, device):
    """Build SpikeWhaleLM from a training checkpoint (same path as run_eval.load_family)."""
    if code_dir not in sys.path:
        sys.path.insert(0, code_dir)
    c = torch.load(ckpt, map_location="cpu", weights_only=False)
    from fly_trunk import build_fly_trunk, is_fly_checkpoint
    if is_fly_checkpoint(c):                     # FlyNeuron (or its OPD output)
        return build_fly_trunk(code_dir, c["model"]).to(device), {"trunk": "fly", "source": os.path.basename(ckpt)}
    from config import SpikeWhaleConfig
    from model_v2 import SpikeWhaleLM
    raw = dict(c["config"] if "config" in c else c["lm_config"])
    for k in ("architectures", "transformers_version", "dtype", "torch_dtype",
              "id2label", "label2id", "_name_or_path"):
        raw.pop(k, None)
    lm = SpikeWhaleLM(SpikeWhaleConfig(**raw))
    state = c.get("model_state")
    if state is not None:
        missing, unexpected = lm.load_state_dict(state, strict=False)
        real_missing = [m for m in missing if "lm_head" not in m]
        if real_missing:
            print(f"  [warn] {len(real_missing)} missing trunk keys (e.g. {real_missing[:3]})")
    if getattr(lm.config, "tie_word_embeddings", True):
        lm.tie_weights()
    return lm.to(device), raw


def load_tokenizer(code_dir: str):
    if code_dir not in sys.path:
        sys.path.insert(0, code_dir)
    from spike_tokenizer import SpikeTokenizer
    return SpikeTokenizer(vocab_file=os.path.join(code_dir, "tokenizer.json"))


def save_decision_model(path: str, model: SpikeDecisionModel, lm_config: Dict, decision_cfg: Dict):
    """Atomic save: write a temp file, then rename. A kill mid-save never corrupts `path`."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    torch.save({"kind": "spike_decision", "lm_config": lm_config, "decision_cfg": decision_cfg,
                "model_state": {k: v.detach().cpu() for k, v in model.state_dict().items()}}, tmp)
    os.replace(tmp, path)


def load_decision_model(code_dir: str, path: str, device):
    with open(path, "rb") as f:
        head = f.read(8)
    if head.startswith(b"version "):
        raise RuntimeError(
            f"{path} is a Git LFS pointer, not a checkpoint. "
            "Download the real file (~1 GB), e.g. "
            "https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/On-Fly-Jev.pt"
        )
    c = torch.load(path, map_location="cpu", weights_only=False)
    if code_dir not in sys.path:
        sys.path.insert(0, code_dir)
    dcfg = c["decision_cfg"]
    if c["lm_config"].get("trunk") == "fly":
        from fly_trunk import build_fly_trunk
        lm = build_fly_trunk(code_dir)
    else:
        from config import SpikeWhaleConfig
        from model_v2 import SpikeWhaleLM
        lm = SpikeWhaleLM(SpikeWhaleConfig(**c["lm_config"]))
    model = SpikeDecisionModel(lm, dcfg.get("head_layers", 2), dcfg.get("n_act", 2), head_dim=dcfg.get("head_dim"))
    model.load_state_dict(c["model_state"], strict=True)
    if getattr(lm.config, "tie_word_embeddings", True):
        lm.tie_weights()
    return model.to(device).eval(), dcfg, c["lm_config"]


# --------------------------------------------------------------------------- #
# RLCD objective, calibration, metrics (verbatim Laya)
# --------------------------------------------------------------------------- #
def proper_reward(q, target, qtype, mask, w_sph: float = 0.5, w_rps: float = 1.0, log_floor: float = -9.21):
    q = q * mask
    logq = torch.log(q.clamp_min(1e-12)).clamp_min(log_floor)
    r = (target * logq).sum(-1) + w_sph * (target * q).sum(-1) / q.norm(dim=-1).clamp_min(1e-9)
    is_score = (qtype == QTYPES["score"]).float()
    k = mask.sum(-1).clamp(min=2).float()
    rps = (((torch.cumsum(q, -1) - torch.cumsum(target, -1)) ** 2) * mask).sum(-1) / (k - 1)
    return r - w_rps * rps * is_score


def rlcd_loss(logits, target, qtype, mask, sigma: float, group: int = 4, w_sph: float = 0.75,
              w_rps: float = 1.0, ce_weight: float = 1.0):
    """The Laya notebook's loss: GRPO-style REINFORCE on noisy logits + soft CE."""
    k = mask.sum(-1, keepdim=True).float()
    eps = torch.randn((group,) + logits.shape, device=logits.device) * sigma * mask
    eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
    z = logits.detach().unsqueeze(0) + eps
    q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
    with torch.no_grad():
        r = proper_reward(q, target.unsqueeze(0), qtype, mask, w_sph=w_sph, w_rps=w_rps)
        adv = r - r.mean(0, keepdim=True)
        adv = adv / (adv.std() + 1e-6)
    logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
    loss_rl = -(adv * logp).mean()
    loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
    return loss_rl + ce_weight * loss_ce, r.mean()


def fit_one_temp(sel) -> float:
    if len(sel) < 10:
        return 1.0
    kmax = max(len(z) for z, _ in sel)
    Z = torch.full((len(sel), kmax), -1e4)
    T = torch.zeros((len(sel), kmax))
    for i, (z, t) in enumerate(sel):
        Z[i, :len(z)] = torch.tensor(np.asarray(z), dtype=torch.float32)
        T[i, :len(t)] = torch.tensor(t, dtype=torch.float32)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = -(T * torch.log_softmax(Z / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss
    opt.step(closure)
    return float(torch.clamp(log_t.exp(), 0.1, 10.0).item())


def temp_bucket(qtype: int, k: int) -> str:
    size = "2" if k <= 2 else "3-5" if k <= 5 else "6-10" if k <= 10 else "11+"
    return "%s:%s" % (QTYPE_NAMES[int(qtype)], size)


def clamp_temperature(t, lo: float = TEMP_MIN, hi: float = TEMP_MAX) -> float:
    try:
        t = float(t)
    except (TypeError, ValueError):
        return 1.0
    if t != t or t in (float("inf"), float("-inf")):
        return 1.0
    return min(hi, max(lo, t))


def ece_score(conf, correct, bins: int = 15) -> float:
    conf, correct = np.asarray(conf), np.asarray(correct)
    if len(conf) == 0:
        return float("nan")
    edges = np.linspace(0, 1, bins + 1)
    e = 0.0
    for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
        sel = (conf >= lo if i == 0 else conf > lo) & (conf <= hi)
        if sel.any():
            e += sel.mean() * abs(conf[sel].mean() - correct[sel].mean())
    return float(e)


def answer_confidence(p, k: int) -> float:
    return 1.0 if k < 1 else float(np.clip(np.max(p[:k]), 0.0, 1.0))


def confidence_from_probs(p, k: int) -> float:
    if k < 2:
        return 1.0
    p = p[:k]
    ent = -(p * np.log(np.clip(p, 1e-12, 1.0))).sum()
    return float(np.clip(1.0 - ent / math.log(k), 0.0, 1.0))


# --------------------------------------------------------------------------- #
# Rig detection (3060 Linux / 3060 Windows / 5060 Ti Windows)
# --------------------------------------------------------------------------- #
def rig_microbatch(effective: int = 64, device_type: str = "cuda"):
    """Micro-batch x accum for decision training (seq <= 1024). Effective batch fixed."""
    import platform
    if device_type != "cuda" or not torch.cuda.is_available():
        return "cpu", 2, effective // 2
    gpu = torch.cuda.get_device_name(0)
    vram = torch.cuda.get_device_properties(0).total_memory / 2**30
    # >=40 GB (RTX PRO 6000 96 GB, A100/H100) -> 32 x 2; 5060 Ti 16 GB -> 8 x 8; 3060 12 GB -> 4 x 16.
    micro = 32 if vram >= 40 else 8 if ("5060" in gpu or vram >= 15) else 4
    micro = min(micro, effective)
    return f"{gpu} ({vram:.0f} GB, {platform.system()})", micro, max(1, effective // micro)


def gold_to_target(q: Dict, gold_q: Dict):
    """typed-decisions gold -> (soft target over options in render order, argmax label)."""
    t, crit = q["type"], q.get("criteria", {})
    probs = gold_q.get("probabilities", {})
    if t == "choice":
        keys = list(crit.keys()) if isinstance(crit, dict) else list(crit)
        target = [probs.get(k, 0.0) for k in keys]
    elif t == "noul":
        target = [probs.get("false", 0.5), probs.get("true", 0.5)]
    else:
        n = len(crit) if isinstance(crit, list) else 4
        target = [probs.get(str(i), 0.0) for i in range(n)]
    s = sum(target)
    target = [v / s for v in target] if s > 0 else [1.0 / len(target)] * len(target)
    return target, target.index(max(target))


def seed_all(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
