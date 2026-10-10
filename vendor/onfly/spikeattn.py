"""Spiking linear attention: the cross-token mixing BioLIF cannot do by itself.

The BioLIF cell is the point of this project, and it is a *local* device: its only
memory is its own decay, so the horizon is about 1/(1-beta) -- roughly 10 tokens at
beta 0.9, 33 at the 0.97 ceiling. Measured on the fly, a one-token perturbation
half-decayed in 3.5 tokens. Feed-forward layers act per token and mix nothing. So
without something else, a 1024-token window is 1024 tokens of throughput and ~10
tokens of context.

SpikeWhale-SNN-216M already carries `SpikeAttn` for exactly this reason. This is that
piece, written to match the rest of BioWhale:

  * **linear attention**, not softmax: with a decay per head it is a running state
    `S[t] = gamma*S[t-1] + k[t]^T v[t]`, `out[t] = q[t] S[t]` -- O(T) not O(T^2), and
    it is the same linear recurrence the membrane is, so it parallelises the same way.
  * **chunkwise** (RetNet / GLA style): inside a chunk the quadratic form with a decay
    mask, exact and fully parallel; between chunks one state carried sequentially. At
    chunk 64 a 1024-token sequence is 16 sequential steps instead of 1024.
  * **spiking queries and keys**: q and k are passed through the surrogate spike, so
    what attends is a spike pattern, not a dense projection. v stays graded, because a
    binary value vector throws away the magnitude the readout needs.
  * **gated to zero at init**, like every other addition here, so a model with
    attention enabled starts exactly as the model without it.

The decay `gamma` is per head and learned. Small gamma is a short window, gamma near 1
is a long one -- the head chooses its own horizon, which is the part BioLIF's single
beta cannot express.
"""
from __future__ import annotations

import math

import torch
from torch import nn

from upstream_lif import spike


class SpikeAttention(nn.Module):
    def __init__(self, hidden, heads=8, head_dim=None, chunk=64, spiking_qk=True):
        super().__init__()
        self.h = heads
        self.d = head_dim or max(hidden // heads, 16)
        self.chunk = chunk
        self.spiking_qk = spiking_qk
        inner = self.h * self.d
        self.q = nn.Linear(hidden, inner, bias=False)
        self.k = nn.Linear(hidden, inner, bias=False)
        self.v = nn.Linear(hidden, inner, bias=False)
        self.o = nn.Linear(inner, hidden, bias=False)
        # per-head decay: sigmoid(gamma_logit) spread over (0.5, 0.999) at init, so
        # different heads start with different horizons instead of all the same one
        g = torch.linspace(1.0, 4.0, heads)
        self.gamma_logit = nn.Parameter(g)
        self.thr = nn.Parameter(torch.zeros(1))      # spiking threshold for q / k
        self.gate = nn.Parameter(torch.zeros(1))     # zero => exactly a no-op

    def gammas(self):
        return torch.sigmoid(self.gamma_logit).clamp(0.5, 0.999)

    def horizon(self):
        """Tokens each head can reach, 1/(1-gamma)."""
        return [round(float(1.0 / (1.0 - g)), 1) for g in self.gammas()]

    def forward(self, x):
        """x: [b, T, hidden] -> [b, T, hidden], added through the gate by the caller."""
        b, T, _ = x.shape
        q = self.q(x).view(b, T, self.h, self.d)
        k = self.k(x).view(b, T, self.h, self.d)
        v = self.v(x).view(b, T, self.h, self.d)
        if self.spiking_qk:                            # what attends is a spike pattern
            q = spike(q, self.thr)
            k = spike(k, self.thr)
        q = q / math.sqrt(self.d)

        with torch.autocast(x.device.type, enabled=False):
            y = self._scan(q.float(), k.float(), v.float())
        y = y.to(x.dtype).reshape(b, T, self.h * self.d)
        return torch.tanh(self.gate) * self.o(y)

    def _scan(self, q, k, v):
        """Chunkwise decayed linear attention, all chunks batched.

        The intra-chunk quadratic form and each chunk's key/value summary are one
        einsum over every chunk at once; only the running state between chunks is
        sequential -- T/chunk small [b, heads, d, d] updates. Float32 throughout."""
        b, T, H, D = q.shape
        L = min(self.chunk or T, T)
        n = -(-T // L)
        if n * L != T:                     # pad AFTER the spike: a zero query/key/value
            pad = (0, 0, 0, 0, 0, n * L - T)        # contributes nothing and sees nothing
            q, k, v = (torch.nn.functional.pad(z, pad) for z in (q, k, v))
        q, k, v = (z.view(b, n, L, H, D) for z in (q, k, v))
        g = self.gammas().float()                                  # [H]
        idx = torch.arange(L, device=q.device, dtype=torch.float32)
        rel = (idx[:, None] - idx[None, :])
        dec = torch.where(rel >= 0, g.view(H, 1, 1) ** rel.clamp_min(0), torch.zeros((), device=q.device))
        att = torch.einsum('bnihd,bnjhd->bnhij', q, k) * dec       # causal, decayed
        out = torch.einsum('bnhij,bnjhd->bnihd', att, v)
        # each chunk's summary, decayed to the chunk's end
        w = (g.view(1, H) ** (L - 1 - idx).view(L, 1)).view(1, 1, L, H, 1)
        kv = torch.einsum('bnjhd,bnjhe->bnhde', k * w, v)
        gL = (g ** L).view(1, H, 1, 1)
        S = q.new_zeros(b, H, D, D)
        states = []
        for c in range(n):
            states.append(S)
            S = S * gL + kv[:, c]
        S = torch.stack(states, 1)                                 # state entering each chunk
        qd = q * (g.view(1, H) ** (idx + 1).view(L, 1)).view(1, 1, L, H, 1)
        out = out + torch.einsum('bnihd,bnhde->bnihe', qd, S)
        return out.reshape(b, n * L, H, D)[:, :T]
