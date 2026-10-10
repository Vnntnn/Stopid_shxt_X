"""BioLIF: a neuron standard for SpikeWhale-style SNNs.

SpikeWhale's LIF is one state variable and three per-neuron numbers:

    mem[t] = beta * mem[t-1] + input ;  spike if mem >= threshold ;  soft reset

That is the whole cell. Every neuron differs only in (threshold, beta, gain).
Measured on the MaleCNS fly (167,565 real neurons wired from the connectome),
that model leaves most of the biology on the table -- roughly three orders of
magnitude of per-neuron state -- and, measurably:

  * 95.6% of neurons never spiked on text, and 96% of the silent ones sat below
    a tenth of their threshold: unreached, not merely gated;
  * a one-token perturbation half-decayed in 3.5 tokens, so the recurrence
    carried almost no history by itself;
  * switching the three frozen knobs on -- 24 numbers, synapses untouched --
    moved held-out CE 3.0331 -> 2.8648 and produced a sensible E/I split by
    itself (excitatory majority damped, inhibition made easier to fire).

BioLIF keeps SpikeWhale's forward contract exactly and adds five pieces of cell
biology, each acting on per-neuron vectors so the matmuls are untouched:

    types       every neuron gets a soft assignment over `n_types` cell types;
                threshold, leak and input gain are per type, learned
    synaptic    a synaptic trace per neuron (receptor kinetics): what the cell
                releases decays over ticks instead of vanishing in one
    adapt       spike-frequency adaptation through an adaptive threshold
    graded      graded (non-spiking) release, as much of the fly's optic lobe
                uses: emit tanh(mem/threshold) instead of a 0/1 spike, mixed
                in per type
    stp         presynaptic short-term depression (Tsodyks-Markram style)

**Every part sits behind its own zero-init gate**, so with all of them enabled
but untrained a BioLIF layer reproduces the LIF layer bit for bit and an existing
SpikeWhale checkpoint can be resumed into this neuron without a discontinuity.
The gate is what makes the no-op exact while leaving the part's gradient alive;
`test_equivalence.py` asserts both.

The surrogate gradient, the soft clamp and the spike function are SpikeWhale's
own (`upstream_lif.py`), unchanged: this is a different cell, not a different
gradient.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
from torch import nn

from upstream_lif import soft_clamp, spike

PARTS = ('types', 'synaptic', 'adapt', 'graded', 'stp')


@dataclass
class BioLIFConfig:
    hidden: int = 1488
    n_types: int = 8                 # cell types per layer (the fly had 8 transmitters)
    parts: tuple = ()                # which pieces are live; () == plain SpikeWhale LIF
    beta: float = 0.9
    threshold: float = 1.0
    max_threshold: float = 1.5       # keep a type from silencing itself
    beta_max: float = 0.97           # decay ceiling: horizon ~ 1/(1-beta) tokens
    min_threshold: float = 0.25
    mem_clamp: float = 30.0
    mem_grad_clip: float = 1.0       # per-tick cap on the membrane gradient (0 = off)
    reset: bool = True               # subtract the threshold after a spike
    chunk: int = 64                  # parallel-mode chunk length (0 = whole sequence at once)
    type_noise: float = 0.02         # tiny spread so types can differentiate
    tau_init: float = 1.5            # synaptic trace, in ticks, once enabled


class BioLIF(nn.Module):
    """One layer of BioLIF cells. Drop-in for a SpikeWhale LIF layer.

    state = (mem, trace, adapt, resources); `step` takes the input current and
    returns (release, mem_pre_reset, state). `release` is what the next layer
    receives -- spikes for a plain LIF, and for a graded cell a continuous value.
    """

    def __init__(self, cfg: BioLIFConfig):
        super().__init__()
        self.cfg = cfg
        self.parts = set(cfg.parts)
        h, k = cfg.hidden, cfg.n_types

        # Soft type assignment: [hidden, n_types]. Near-uniform at init, so every
        # neuron starts as the average type -- which is the single type LIF has.
        self.type_logits = nn.Parameter(torch.randn(h, k) * cfg.type_noise)

        # Per-type knobs, all zero => exp(0)=1 => SpikeWhale's own values.
        self.thr_gain = nn.Parameter(torch.zeros(k))
        self.beta_gain = nn.Parameter(torch.zeros(k))
        self.in_gain = nn.Parameter(torch.zeros(k))

        # Each switchable part has its own ZERO-INIT GATE, and its internal
        # parameters start at biologically sensible values -- never at zero.
        #
        # Gating is what makes the no-op EXACT: a part scaled by 0 changes nothing,
        # yet d(loss)/d(gate) is the part's own effect, which is non-zero, so the
        # gate can move. Making the part itself "nearly zero" instead (sigmoid(-6))
        # is worse on both counts: it still shifts thresholds enough to flip
        # marginal spikes, and a zero effect behind a zero gate has zero gradient
        # on both ends -- the trap that left the fly's loop gates dead for 700 steps.
        self.part_gate = nn.ParameterDict({n: nn.Parameter(torch.zeros(1)) for n in PARTS[1:]})
        a0 = math.exp(-1.0 / max(cfg.tau_init, 1e-3))              # trace decay for tau_init
        self.syn_logit = nn.Parameter(torch.full((k,), math.log(a0 / (1 - a0))))
        self.adapt_w = nn.Parameter(torch.full((k,), -1.0))        # softplus(-1) = 0.31
        self.adapt_decay = nn.Parameter(torch.zeros(k))            # sigmoid(0) = 0.5
        self.graded_logit = nn.Parameter(torch.zeros(k))           # half graded, once opened
        self.stp_use = nn.Parameter(torch.full((k,), -1.0))
        self.stp_recover = nn.Parameter(torch.full((k,), 2.0))

    def gate(self, name):
        return torch.tanh(self.part_gate[name]) if name in self.parts else None

    # ---------------------------------------------------------------- types --
    def type_weights(self):
        return torch.softmax(self.type_logits, dim=-1)              # [hidden, types]

    def _per_neuron(self, per_type):
        return self.type_weights() @ per_type                       # [hidden]

    def cell_parameters(self):
        """(beta, threshold, gain) per neuron."""
        c = self.cfg
        if 'types' not in self.parts:
            h = c.hidden
            dev = self.thr_gain.device
            return (torch.full((h,), c.beta, device=dev),
                    torch.full((h,), c.threshold, device=dev),
                    torch.ones(h, device=dev))
        thr = (c.threshold * torch.exp(self._per_neuron(self.thr_gain))).clamp(c.min_threshold, c.max_threshold)
        beta = torch.sigmoid(torch.logit(torch.tensor(c.beta, device=thr.device))
                             + self._per_neuron(self.beta_gain)).clamp(0.5, c.beta_max)
        gain = torch.exp(self._per_neuron(self.in_gain)).clamp(0.3, 3.0)
        return beta, thr, gain

    # ---------------------------------------------------------------- state --
    def initial_state(self, batch, device, dtype=torch.float32):
        z = torch.zeros(batch, self.cfg.hidden, device=device, dtype=dtype)
        return {'mem': z, 'trace': None, 'adapt': None, 'res': None}

    # ----------------------------------------------------------------- step --
    def step(self, current, state):
        """current: [batch, hidden] input current for this tick."""
        beta, thr, gain = self.cell_parameters()

        thr_eff = thr
        if 'adapt' in self.parts and state['adapt'] is not None:
            thr_eff = thr + self.gate('adapt') * state['adapt']

        mem = beta * state['mem'] + gain * current
        # Backprop through a long recurrence multiplies the membrane gradient tick
        # after tick; on the fly this reached 1e11-1e14 and killed runs. Capping the
        # gradient AT EACH TICK (not just the global norm at the end) is what fixed
        # it: a late explosion has already destroyed the earlier ticks' signal by
        # the time a global clip sees it.
        if self.cfg.mem_grad_clip and mem.requires_grad:
            mem.register_hook(_clip_hook(self.cfg.mem_grad_clip))
        spikes = spike(mem, thr_eff)
        new_mem = soft_clamp(mem - spikes * thr_eff if self.cfg.reset else mem, self.cfg.mem_clamp)

        release = spikes
        if 'graded' in self.parts:                      # non-spiking release
            mix = self.gate('graded') * self._per_neuron(torch.sigmoid(self.graded_logit))
            release = (1 - mix) * release + mix * torch.tanh(mem / thr_eff.clamp_min(1e-6))

        res = state['res']
        if 'stp' in self.parts:                         # presynaptic depression
            use = self._per_neuron(torch.sigmoid(self.stp_use))
            rec = self._per_neuron(torch.sigmoid(self.stp_recover))
            res = torch.ones_like(release) if res is None else res
            release = release * (1 - self.gate('stp') * (1 - res))       # gate 0 => unchanged
            res = (res + (1 - res) * rec - use * res * spikes).clamp(0, 1)

        trace = state['trace']
        if 'synaptic' in self.parts:                    # receptor kinetics
            a = self._per_neuron(torch.sigmoid(self.syn_logit))
            trace = release * (1 - a) if trace is None else trace * a + release * (1 - a)
            release = release + self.gate('synaptic') * (trace - release)

        adapt = state['adapt']
        if 'adapt' in self.parts:
            d = self._per_neuron(torch.sigmoid(self.adapt_decay))
            w = self._per_neuron(nn.functional.softplus(self.adapt_w))
            adapt = torch.zeros_like(spikes) if adapt is None else adapt
            adapt = adapt * d + w * spikes

        return release, mem, {'mem': new_mem, 'trace': trace, 'adapt': adapt, 'res': res}

    # ---------------------------------------------------------- parallel ----
    def forward_parallel(self, current, state=None):
        """The whole sequence at once, instead of one tick at a time.

        `mem[t] = beta*mem[t-1] + gain*I[t]` is a first-order LINEAR recurrence, so
        without the reset it is an exponential convolution:

            mem[t] = sum_{s<=t} beta^(t-s) * gain * I[s]

        which is one lower-triangular [T, T] matmul per chunk -- no sequential
        dependency at all. Spikes are then elementwise. This is what makes an SNN
        train at transformer speed (cf. Parallel Spiking Neurons, Fang et al. 2023);
        the price is that the RESET, which depends on the spikes it causes, is no
        longer exact within a chunk.

        `cfg.reset=False`  : exact, and the fastest. The cell is then a decaying
                             integrator with a spiking readout.
        `cfg.reset=True`   : a chunk-local correction -- spikes are computed from the
                             unreset membrane and their reset is applied causally
                             inside the chunk. Chunk boundaries stay exact because the
                             carry is passed sequentially between chunks, so a short
                             `cfg.chunk` converges to the sequential result.

        current: [batch, T, hidden] -> (release [batch, T, hidden], mem, state)
        """
        b, T, h = current.shape
        beta, thr, gain = self.cell_parameters()
        dtype = current.dtype
        current = current.float()               # the scans run in float32 even under autocast
        carry = (state or {}).get('mem')
        if not self.cfg.reset:
            # exact, and every chunk at once: no Python loop over chunks, no GPU sync
            mem = _scan(current * gain, beta, carry, self.cfg.chunk or T, floor=0.5)
        else:
            mem = self._reset_scan(current, beta, thr, gain, carry)
        if self.cfg.mem_grad_clip and mem.requires_grad:
            mem.register_hook(_clip_hook(self.cfg.mem_grad_clip))
        release, spikes = self.release(mem, thr)
        release, mem, spikes = release.to(dtype), mem.to(dtype), spikes.to(dtype)
        new_state = {'mem': soft_clamp(mem[:, -1] - spikes[:, -1] * thr if self.cfg.reset else mem[:, -1],
                                       self.cfg.mem_clamp),
                     'trace': None, 'adapt': None, 'res': None}
        return release, mem, new_state

    def release(self, mem, thr=None):
        """What the cell sends, given its membrane over the sequence: spikes, mixed
        with graded release, through the synaptic trace. Split out of
        forward_parallel so a caller that changes the membrane linearly (the hybrid's
        lateral hop) can recompute the release without re-running the scan."""
        if thr is None:
            thr = self.cell_parameters()[1]
        T = mem.shape[1]
        spikes = spike(mem, thr)
        release = spikes
        if 'graded' in self.parts:
            mix = self.gate('graded') * self._per_neuron(torch.sigmoid(self.graded_logit))
            release = (1 - mix) * release + mix * torch.tanh(mem / thr.clamp_min(1e-6))
        if 'synaptic' in self.parts:            # the trace is the same linear scan
            a_ = self._per_neuron(torch.sigmoid(self.syn_logit))
            trace = _decay_scan(release * (1 - a_), a_, self.cfg.chunk or T)
            release = release + self.gate('synaptic') * (trace - release)
        return release, spikes

    def _reset_scan(self, current, beta, thr, gain, carry):
        """reset=True: chunk-local reset correction, carry passed between chunks."""
        b, T, h = current.shape
        chunk = min(self.cfg.chunk or T, _max_chunk(0.5))
        if carry is None:
            carry = current.new_zeros(b, h)
        mems = []
        for c0 in range(0, T, chunk):
            x = current[:, c0:c0 + chunk] * gain
            L = x.shape[1]
            t = torch.arange(L, device=x.device, dtype=x.dtype).view(1, L, 1)
            pw = beta.view(1, 1, h) ** t
            mem = pw * (carry.unsqueeze(1) * beta.view(1, 1, h) + torch.cumsum(x / pw, dim=1))
            # spikes from the unreset membrane; their reset decays forward inside
            # the chunk (causal, one more cumsum). Exact at chunk boundaries.
            sp = spike(mem, thr)
            back = pw * torch.cumsum(sp * thr / pw, dim=1)
            mem = mem - (back - sp * thr)                   # a spike does not reset itself
            mems.append(mem)
            carry = mem[:, -1] - spike(mem[:, -1], thr) * thr
        return torch.cat(mems, 1)

    # -------------------------------------------------------------- reports --
    def describe(self):
        """What the types became, for logging."""
        beta, thr, gain = [t.detach() for t in self.cell_parameters()]
        w = self.type_weights().detach()
        owner = w.argmax(-1)
        out = {}
        for t in range(self.cfg.n_types):
            m = owner == t
            if int(m.sum()) == 0:
                continue
            out[f'type{t}'] = {'neurons': int(m.sum()),
                               'threshold': round(float(thr[m].mean()), 4),
                               'leak': round(float(beta[m].mean()), 4),
                               'gain': round(float(gain[m].mean()), 4),
                               'tau_ticks': round(float(_tau(self.syn_logit, w, m)), 2)
                               if 'synaptic' in self.parts else None,
                               'graded': round(float((w[m] @ torch.sigmoid(self.graded_logit.detach())).mean()), 3)
                               if 'graded' in self.parts else None}
        return out


def _max_chunk(floor, cap=1e15):
    """Longest chunk whose floor^-chunk stays under `cap`.

    The cumsum form divides by decay^t, so a chunk must not overflow float32. The
    decays are clamped from below, so the bound is static (a live `beta.min()` here
    was a GPU->CPU sync per layer per call).

    cap is 1e15, not 1e20, because of the BACKWARD pass: d(x / pw)/d(pw) = -x / pw^2,
    so the gradient carries decay^(-2t). With cap 1e20 that reached ~1e38 once a
    decay sat at its floor (0.5^-126), overflowed float32 to inf, and inf times the
    clamp's zero gradient is NaN. Fly100 hit exactly this at step 18636: the model
    had learned short-memory neurons (cell_decay 9.9 -> 2.5, beta at the 0.5 floor),
    and every gradient from then on was NaN while the forward loss stayed finite.
    1e15 squared is 1e30, under float32's 3.4e38 with room for the other factors.
    Chunks become 49 at a 0.5 floor, 24 at 0.25. Results are identical."""
    return max(2, int(math.log(cap) / -math.log(floor)))


def _scan(x, a, carry=None, chunk=64, floor=0.5):
    """y[t] = a*y[t-1] + x[t], per neuron, over [batch, T, hidden], float32.

    All chunks are computed in ONE batched cumsum; only the carry between chunks is
    sequential, and that is T/chunk tiny [batch, hidden] ops instead of T/chunk
    full-size passes."""
    b, T, h = x.shape
    a = a.clamp(floor, 0.9999)
    chunk = max(2, min(chunk or T, _max_chunk(floor), T))
    n = -(-T // chunk)
    if n * chunk != T:                                     # zero-padding the end is causal
        x = nn.functional.pad(x, (0, 0, 0, n * chunk - T))
    xc = x.view(b, n, chunk, h)
    t = torch.arange(chunk, device=x.device, dtype=x.dtype).view(1, 1, chunk, 1)
    pw = a.view(1, 1, 1, h) ** t                           # a^t
    local = pw * torch.cumsum(xc / pw, dim=2)              # each chunk from a zero carry
    c = x.new_zeros(b, h) if carry is None else carry.float()
    aL = a ** chunk
    carries = []
    for k in range(n):
        carries.append(c)
        c = aL * c + local[:, k, -1]
    y = local + (pw * a.view(1, 1, 1, h)) * torch.stack(carries, 1).unsqueeze(2)
    return y.reshape(b, n * chunk, h)[:, :T]


def _decay_scan(x, a, chunk=64):
    """The synaptic trace. Its decay is not clamped by cell_parameters, so floor it
    here: a < 0.25 is a trace shorter than 0.7 ticks, i.e. no trace at all."""
    return _scan(x, a, None, chunk, floor=0.25)


def _clip_hook(limit):
    # no Python branch on a GPU value: `if n > limit` forced a sync per layer in backward
    def hook(g):
        g = torch.nan_to_num(g)
        return g * (limit / g.norm().clamp_min(limit))
    return hook


def _tau(logit, w, m):
    a = (w[m] @ torch.sigmoid(logit.detach())).mean().clamp(1e-6, 1 - 1e-6)
    return -1.0 / math.log(float(a))
