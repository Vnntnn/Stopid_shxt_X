"""Put 100 copied MaleCNS neurons into the dense BioWhale network.

Every unit of every spiking layer IS one of the 100 fly neurons (unit i copies
neuron i % 100; at hidden 1500 each neuron has exactly 15 copies per layer).
A copy inherits, from the ORIGINAL conversion only:

    transmitter   -> its cell type (fixed: types are not re-learned)
    receptor tau  -> its synaptic-trace decay (literature value per transmitter)
    sign          -> Dale's law on everything it sends: kept for the whole run
    wiring        -> the dense weights between two layers start as the fly's own
                     100x100 synapse matrix, tiled over the copies
    role          -> PAM / PPL1 copies are the dopamine system's populations

Threshold and leak start at the original's shared values (1.0 / 0.9) because the
original gives every neuron the same ones; the per-type gains may still learn.

The tiling: weight[post, pre] = W_fly[neuron(post), neuron(pre)] * scale + noise.
The noise (10% of the scale) lets copies of one neuron drift apart; a fly
synapse of 0 stays near 0 (noise only), so the circuit's sparsity pattern is
where training starts, not a hard mask.
"""
from __future__ import annotations

import math

import torch

from dopamine import DopamineSystem


def load(path):
    with open(path, "rb") as f:
        if f.read(8).startswith(b"version "):
            raise RuntimeError(
                f"{path} is a Git LFS pointer, not fly100 weights. "
                "Download https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/fly100.pt"
            )
    return torch.load(path, map_location='cpu', weights_only=False)


def template(hidden, n):
    return torch.arange(hidden) % n


def tiled(fly, hidden, std=0.02, noise=0.1, gen=None):
    """[hidden, hidden] weight whose entries follow the fly's 100x100 matrix."""
    t = template(hidden, fly['W'].shape[0])
    w = fly['W'][t][:, t].clone()                        # [post, pre]
    w = w * (std / w.pow(2).mean().sqrt().clamp_min(1e-9))   # same overall size as a random init
    w = w + torch.randn(w.shape, generator=gen) * std * noise
    return w


def apply(model, fly, noise=0.1, seed=0):
    """Initialise a BioWhaleLM from the copied neurons. Returns the Dale signs."""
    stack, cfg = model.stack, model.cfg
    h, n = cfg.hidden, fly['W'].shape[0]
    t = template(h, n)
    gen = torch.Generator().manual_seed(seed)
    nt = fly['identity'].argmax(1)                       # [n] transmitter index
    unit_nt = nt[t]                                      # [hidden]
    sign = fly['sign'][t]                                # [hidden], per PRESYNAPTIC unit
    with torch.no_grad():
        for cell in stack.cells:
            # cell type = the copied neuron's transmitter, one-hot and frozen
            cell.type_logits.copy_(torch.nn.functional.one_hot(unit_nt, cell.cfg.n_types).float() * 12.0)
            cell.type_logits.requires_grad_(False)
            # synaptic trace per type from that transmitter's receptor time constant
            tau = torch.ones(cell.cfg.n_types) * 1.5
            for k, name in enumerate(fly['nt_names']):
                hit = (fly['identity'].argmax(1) == k)
                if hit.any():
                    tau[k] = float(fly['tau_ticks'][hit][0])
            a = torch.exp(-1.0 / tau)
            cell.syn_logit.copy_(torch.log(a / (1 - a)))
            # these are real neurons, so their receptor kinetics start ON (gate
            # tanh(3) = 0.995) instead of behind BioWhale's zero gate
            if 'synaptic' in cell.parts:
                cell.part_gate['synaptic'].fill_(3.0)
        # layer 0 reads the token embedding, not neurons: only layers 1.. get fly wiring
        for i in range(1, cfg.layers):
            w = tiled(fly, h, noise=noise, gen=gen)
            stack.ff[i].weight.copy_(sign.view(1, -1) * w.abs())
        for rec in stack.rec:                            # the within-layer recurrence too
            w = tiled(fly, h, std=cfg.rec_init, noise=noise, gen=gen)
            rec.weight.copy_(sign.view(1, -1) * w.abs())
    model.register_buffer('dale_sign', sign.clone())
    return sign


@torch.no_grad()
def enforce_dale(model):
    """After every optimiser step: a copy of an excitatory neuron stays excitatory.
    Magnitude is learned, sign is the fly's (as in the fly training)."""
    s = model.dale_sign.view(1, -1)
    for i in range(1, model.cfg.layers):
        w = model.stack.ff[i].weight
        w.copy_(s * w.abs())
    for rec in model.stack.rec:
        rec.weight.copy_(s * rec.weight.abs())


def dopamine(model, fly, punish='PPL1', **kw):
    """PAM / PPL1 = the units that are copies of the real PAM / PPL1 cells.

    `punish` picks which copied population carries PUNISHMENT (RPE < 0): 'PPL1' (the
    fly's punishment dopamine cells, the default), 'TK' (the Tk-GAL4^2 n Vglut fear
    PROXY, see extract_fly100.tk_proxy), or 'PPL1+TK'. Reward always goes through PAM.
    """
    t = template(model.cfg.hidden, fly['W'].shape[0])
    role = [fly['role'][int(i)] for i in t]
    want = set(punish.split('+'))
    pam = torch.tensor([i for i, r in enumerate(role) if r == 'PAM'])
    neg = torch.tensor([i for i, r in enumerate(role) if r in want], dtype=torch.long)
    if neg.numel() == 0:
        raise ValueError(f'no copies with role {punish!r} in this circuit (roles: {sorted(set(fly["role"]))})')
    da = DopamineSystem(model.stack, **kw)
    da.pam, da.ppl1 = pam.to(da.pam.device), neg.to(da.ppl1.device)
    return da


def describe(fly):
    from collections import Counter
    return {'neurons': len(fly['role']), 'roles': dict(Counter(fly['role'])),
            'transmitters': dict(Counter(fly['transmitter'])),
            'excitatory': int((fly['sign'] > 0).sum()), 'inhibitory': int((fly['sign'] < 0).sum()),
            'source': fly['source']}
