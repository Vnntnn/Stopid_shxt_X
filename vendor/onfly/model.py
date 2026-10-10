"""BioWhaleLM: SpikeWhale-SNN with BioLIF cells instead of plain LIF.

Same shape as SpikeWhale-SNN-216M -- stacked LIF layers, one tick per token,
recurrent spikes carrying memory instead of position embeddings, tied
embedding / readout, all-layer pre-reset membranes into a tanh readout -- with
three things kept from the Byrne line and one thing replaced:

    kept       looped layers with zero-init gates, HRM refinement, JEPA
    replaced   the cell: BioLIF (types, receptor kinetics, adaptation,
               graded release, short-term depression) in place of LIF

Everything that is new starts as an exact no-op:

    * BioLIF's five parts are identities at init (see biolif.py)
    * every extra loop pass sits behind a zero gate, and each pass has its own
      RANDOM pass embedding -- zero embeddings behind zero gates put both ends
      of a product at zero and neither can move, which is how the fly's loop
      gates stayed dead at +-0.006 for 700 steps
    * the HRM and JEPA heads are gated to zero the same way

so a model with everything enabled is, at step 0, exactly SpikeWhale-SNN.

JEPA predicts the NEXT TOKEN'S membrane state from this one's, with the
sequence mean subtracted from both sides. Without that subtraction the task is
"copy the current state" -- consecutive states are ~98% alike -- and the loss
sits at 0.0065 while the gradient goes nowhere.
"""
from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as F

from biolif import BioLIF, BioLIFConfig
from spikeattn import SpikeAttention
from upstream_lif import spike
from config import BioWhaleConfig


class RMSNorm(nn.Module):
    def __init__(self, d, eps=1e-6):
        super().__init__()
        self.w = nn.Parameter(torch.ones(d))
        self.eps = eps

    def forward(self, x):
        return self.w * x * torch.rsqrt(x.float().pow(2).mean(-1, keepdim=True) + self.eps).to(x.dtype)


class BioLIFStack(nn.Module):
    """The spiking column: `layers` BioLIF populations, one tick per token."""

    def __init__(self, cfg: BioWhaleConfig):
        super().__init__()
        self.cfg = cfg
        h = cfg.hidden
        bio = BioLIFConfig(hidden=h, n_types=cfg.n_types, parts=tuple(cfg.parts),
                           beta=cfg.beta, threshold=cfg.threshold,
                           reset=getattr(cfg, 'reset', True), chunk=getattr(cfg, 'chunk', 64),
                           beta_max=getattr(cfg, 'beta_max', 0.97))
        self.parallel = bool(getattr(cfg, 'parallel', False))
        self.on_layer = None                    # parallel-mode hook, set by DopamineSystem
        self.pre_layer = None                   # DA firing: extra current into PAM / PPL1
        self.cells = nn.ModuleList([BioLIF(bio) for _ in range(cfg.layers)])
        # feed-forward between populations, and the recurrence within each
        self.ff = nn.ModuleList([nn.Linear(h, h, bias=False) for _ in range(cfg.layers)])
        self.rec = nn.ModuleList([nn.Linear(h, h, bias=False) for _ in range(cfg.layers)])
        for m in self.rec:                      # recurrence starts small, as SpikeWhale does
            nn.init.normal_(m.weight, std=cfg.rec_init)
        for m in self.ff:
            nn.init.normal_(m.weight, std=0.02)
        # Layer 0 reads the token embedding (std 0.02), not spikes. At std 0.02 its
        # drive was ~0.015 against a threshold of 1.0: nothing fired, so no layer
        # above it fired either, and the net started dead. Size it so the drive is
        # ~0.3 rms (membrane ~0.7 after integration at beta 0.9); layers above read
        # 0/1 spikes, for which 0.02 already gives that.
        nn.init.normal_(self.ff[0].weight, std=0.3 / (0.02 * h ** 0.5))
        # one pass embedding per loop pass, RANDOM (never zero -- see the header)
        self.pass_embed = nn.Parameter(torch.randn(cfg.loops, h) * 0.02)
        self.pass_gate = nn.Parameter(torch.zeros(cfg.loops))      # pass 0 is ungated below
        # a later pass reads the previous pass's all-layer membranes back as current
        self.loop_proj = nn.Linear(h * cfg.layers, h, bias=False)
        nn.init.normal_(self.loop_proj.weight, std=0.02)           # the GATE is what starts at zero
        # cross-token mixing, on every attn_every-th layer
        self.attn = nn.ModuleList([
            SpikeAttention(h, heads=cfg.attn_heads, head_dim=cfg.attn_head_dim, chunk=cfg.chunk)
            if (cfg.attention and i % max(cfg.attn_every, 1) == 0) else None
            for i in range(cfg.layers)])

    def initial_state(self, batch, device):
        return [c.initial_state(batch, device) for c in self.cells]

    def tick(self, current, state):
        """One token: current [batch, hidden] -> (release, membranes, state)."""
        mems, rel = [], current
        for i, (cell, ff, rec) in enumerate(zip(self.cells, self.ff, self.rec)):
            drive = ff(rel) + rec(state[i]['mem'])
            if self.pre_layer is not None:
                drive = self.pre_layer(i, drive)
            rel, mem, state[i] = cell.step(drive, state[i])
            mems.append(mem)
        return rel, mems, state

    def pass_parallel(self, x):
        """One pass over the whole sequence at once: no tick loop, no recurrence.

        The intra-layer recurrence is what makes the membrane nonlinear in time, so
        parallel mode drops it; cross-token mixing then comes from the decay
        constants alone. Measured in the fly, a one-token perturbation half-decayed
        in 3.5 tokens, so the recurrence was carrying little history to lose.
        """
        rel, mems = x, []
        for i, (cell, ff, att) in enumerate(zip(self.cells, self.ff, self.attn)):
            drive = ff(rel)
            if self.pre_layer is not None:
                drive = self.pre_layer(i, drive)
            if att is not None:                 # the only thing that moves information
                drive = drive + att(rel)        # between tokens; gated to zero at init
            inp = rel
            rel, mem, _ = cell.forward_parallel(drive)
            # dopamine eligibility (see dopamine.attach): only from the judged rollout,
            # which train.py replays under no_grad. Training forwards never recorded
            # anything that survived (start_episode clears it before the replay), and
            # skipping them keeps Python side effects out of the torch.compile graph.
            if self.on_layer is not None and not torch.is_grad_enabled():
                self.on_layer(i, inp, mem)
            mems.append(mem)
        return torch.cat(mems, dim=-1)

    def forward(self, x):
        """x: [batch, seq, hidden] input currents. Returns per-token membranes."""
        b, t, _ = x.shape
        if self.parallel:
            outs = []
            for pass_i in range(self.cfg.loops):
                cur = x + self.pass_embed[pass_i]
                if outs:
                    cur = cur + torch.tanh(self.pass_gate[pass_i]) * self.loop_proj(outs[-1])
                outs.append(self.pass_parallel(cur))
            h = outs[0]
            for pass_i in range(1, self.cfg.loops):
                h = h + torch.tanh(self.pass_gate[pass_i]) * outs[pass_i]
            return h
        outs = []
        for pass_i in range(self.cfg.loops):
            gate = 1.0 if pass_i == 0 else torch.tanh(self.pass_gate[pass_i])
            state = self.initial_state(b, x.device)
            step_out = []
            for j in range(t):
                cur = x[:, j] + self.pass_embed[pass_i]
                if outs:                       # later passes see the previous pass's read
                    cur = cur + gate * self.loop_proj(outs[-1][:, j])
                _, mems, state = self.tick(cur, state)
                step_out.append(torch.cat(mems, dim=-1))
            outs.append(torch.stack(step_out, 1))
        # every pass after the first is added through its own gate
        h = outs[0]
        for pass_i in range(1, self.cfg.loops):
            h = h + torch.tanh(self.pass_gate[pass_i]) * outs[pass_i]
        return h


class HRMRefine(nn.Module):
    """Iterative refinement of the readout features, gated to zero at init."""

    def __init__(self, d_in, d, steps):
        super().__init__()
        self.steps = steps
        self.inp = nn.Linear(d_in, d)
        self.cell = nn.GRUCell(d, d)
        self.out = nn.Linear(d, d_in)
        # the GATE alone is the no-op. `out` keeps a normal init: zeroing both puts
        # both ends of the product at zero and the gate can never move.
        self.gate = nn.Parameter(torch.zeros(1))

    def forward(self, feat):
        b, t, _ = feat.shape
        z = self.inp(feat).reshape(b * t, -1)
        s = torch.zeros_like(z)
        outs = []
        for _ in range(self.steps):
            s = self.cell(z, s)
            outs.append(self.out(s).reshape(b, t, -1))
        return [feat + torch.tanh(self.gate) * o for o in outs]    # deep supervision


class JEPAHead(nn.Module):
    """Predict the next token's membrane state, mean-subtracted on both sides."""

    def __init__(self, d, hidden):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(d, hidden), nn.GELU(), nn.Linear(hidden, d))

    def forward(self, feat):
        """Scale-free: divide by the target's own variance, so the number is
        'fraction of the new information missed' (1.0 = predicting the mean) and
        does not swamp the CE when the membranes happen to be large."""
        if feat.shape[1] < 2:
            return feat.new_zeros(())
        centred = feat - feat.mean(1, keepdim=True)        # what is NEW, not what is shared
        pred = self.net(centred[:, :-1])
        tgt = centred[:, 1:].detach()
        return F.mse_loss(pred, tgt) / tgt.pow(2).mean().clamp_min(1e-6)


class BioWhaleLM(nn.Module):
    def __init__(self, cfg: BioWhaleConfig):
        super().__init__()
        self.cfg = cfg
        self.embed = nn.Embedding(cfg.vocab_size, cfg.hidden)
        nn.init.normal_(self.embed.weight, std=0.02)
        self.stack = BioLIFStack(cfg)
        d_read = cfg.hidden * cfg.layers                    # all-layer pre-reset membranes
        self.norm = RMSNorm(d_read)
        self.read = nn.Linear(d_read, cfg.hidden, bias=False)
        self.out = nn.Linear(cfg.hidden, cfg.vocab_size, bias=False)
        if cfg.tie_embeddings:
            self.out.weight = self.embed.weight
        self.hrm = HRMRefine(d_read, cfg.hrm_dim, cfg.hrm_steps) if cfg.hrm_steps else None
        self.jepa = JEPAHead(d_read, cfg.jepa_dim) if cfg.jepa_weight else None
        self.mtp = nn.Linear(cfg.hidden, cfg.vocab_size, bias=False) if cfg.mtp_weight else None
        # Byrne's Engram (engram.py): hashed 1..3-gram memory added to the embedding.
        # Off unless the config asks; getattr so configs without the field still load.
        self.engram = None
        if getattr(cfg, 'engram', False):
            from engram import Engram
            self.engram = Engram(cfg.hidden, table_size=getattr(cfg, 'engram_table_size', 4096))
        if self.mtp is not None:
            nn.init.zeros_(self.mtp.weight)

    def features(self, tokens):
        x = self.embed(tokens)
        if self.engram is not None:
            x = x + self.engram(x)
        return self.stack(x)

    def head(self, feat):
        return self.out(torch.tanh(self.read(self.norm(feat))))

    def forward(self, tokens, targets=None):
        feat = self.features(tokens)
        logits = self.head(feat)
        if targets is None:
            return logits, {}
        loss = F.cross_entropy(logits.flatten(0, 1).float(), targets.reshape(-1))
        zc = getattr(self.cfg, 'zloss_coef', 0.0)
        if zc:                                  # Byrne's z-loss: keep logsumexp near 0
            loss = loss + zc * torch.logsumexp(logits.float(), -1).pow(2).mean()
        # detached tensors, not floats: float() here is a GPU sync every step, before
        # backward has even been queued. train.py converts them only on log steps.
        parts = {'ce': loss.detach(), 'logits': logits}
        total = loss
        if self.hrm is not None:                              # deep supervision
            hrm_loss = 0.0
            for refined in self.hrm(feat):
                hrm_loss = hrm_loss + F.cross_entropy(self.head(refined).flatten(0, 1).float(),
                                                      targets.reshape(-1))
            hrm_loss = hrm_loss / self.cfg.hrm_steps
            total = total + self.cfg.hrm_weight * hrm_loss
            parts['hrm'] = hrm_loss.detach()
        if self.jepa is not None:
            j = self.jepa(feat)
            total = total + self.cfg.jepa_weight * j
            parts['jepa'] = j.detach()
        if self.mtp is not None and tokens.shape[1] > 2:      # predict the token after next
            m = self.mtp(torch.tanh(self.read(self.norm(feat[:, :-1]))))
            mtp = F.cross_entropy(m.flatten(0, 1).float(), targets[:, 1:].reshape(-1))
            total = total + self.cfg.mtp_weight * mtp
            parts['mtp'] = mtp.detach()
        if self.cfg.firing_weight:
            # SpikeWhale's anti-death regulariser, which the config declared and the
            # model never applied: push the mean firing rate towards firing_target so
            # a layer cannot go silent and stop passing gradient.
            # through the SURROGATE spike, against the threshold: `(feat >= 0).float()`
            # had no gradient at all (the penalty was a logged number, nothing more)
            # and counted a silent membrane of exactly 0 as firing.
            rate = spike(feat.float(), feat.new_tensor(self.cfg.threshold, dtype=torch.float32)).mean()
            dead = (rate - self.cfg.firing_target) ** 2
            total = total + self.cfg.firing_weight * dead
            parts['rate'] = rate.detach()
            parts['firing_penalty'] = dead.detach()
        return total, parts

    @torch.no_grad()
    def generate(self, prompt_ids, n_new=32, temperature=0.0, top_k=40):
        ids = list(prompt_ids)
        for _ in range(n_new):
            logits, _ = self.forward(torch.tensor([ids], device=self.embed.weight.device))
            nxt = logits[0, -1].float()
            if not torch.isfinite(nxt).all():     # fail loudly and catchably, not as a CUDA assert
                raise ValueError('non-finite logits in generate')
            if temperature <= 0:
                ids.append(int(nxt.argmax()))
                continue
            v, i = torch.topk(nxt / temperature, top_k)
            ids.append(int(i[torch.multinomial(torch.softmax(v, -1), 1)]))
        return ids

    def describe_types(self):
        return {f'layer{i}': c.describe() for i, c in enumerate(self.stack.cells)}

    def horizons(self):
        """How far each mechanism can see, in tokens."""
        cell = 1.0 / (1.0 - float(self.stack.cells[0].cell_parameters()[0].max()))
        out = {'cell_decay': round(cell, 1)}
        heads = [a.horizon() for a in self.stack.attn if a is not None]
        if heads:
            out['attention_heads'] = heads[0]
        return out

    def loop_gates(self):
        return [round(float(torch.tanh(g)), 5) for g in self.stack.pass_gate]
