"""NorMuon for the weight matrices, AdamW for everything else.

Adapted from Byrne70M (train_blend_muon-50m.py: _zeropower_via_newtonschulz5,
Muon(normuon=True), build_muon_optimizers). NorMuon (arXiv:2510.05491, Alg. 1):
EMA momentum -> Newton-Schulz orthogonalisation -> per-ROW second-moment
normalisation -> RMS rescale to an Adam-sized update. A row of a weight matrix
is one postsynaptic neuron's incoming synapses, so the per-row step is a
per-neuron normalisation.

It self-normalises its step size, so it takes the AdamW-scale base lr directly
(Byrne ran 1.5e-4). Embeddings and Engram tables go to AdamW at lr/10, scalars,
norms and every BioLIF per-type / gate parameter to AdamW at lr -- as in Byrne.

Dale's law is unaffected: fly100.enforce_dale() re-imposes the signs after
every optimiser step whichever optimiser produced it.
"""
from __future__ import annotations

import torch


def _zeropower_via_newtonschulz5(G, steps=5):
    a, b, c = (3.4445, -4.7750, 2.0315)
    X = G.float()
    X = X / (X.norm() + 1e-7)
    if X.size(0) > X.size(1):
        X = X.T
    for _ in range(steps):
        A = X @ X.T
        X = a * X + b * A @ X + c * A @ A @ X
    if G.size(0) > G.size(1):
        X = X.T
    return X.to(G.dtype)


class NorMuon(torch.optim.Optimizer):
    def __init__(self, params, lr=1.5e-4, weight_decay=0.0, ns_steps=5, beta1=0.95, beta2=0.95, eps=1e-8):
        super().__init__(params, dict(lr=lr, weight_decay=weight_decay, ns_steps=ns_steps,
                                      beta1=beta1, beta2=beta2, eps=eps))

    @torch.no_grad()
    def step(self, closure=None):
        for group in self.param_groups:
            lr, wd = group['lr'], group['weight_decay']
            b1, b2, eps = group['beta1'], group['beta2'], group['eps']
            for p in group['params']:
                if p.grad is None:
                    continue
                g = p.grad
                st = self.state[p]
                if 'm' not in st:
                    st['m'] = torch.zeros_like(g, dtype=torch.float32)
                    st['v'] = torch.zeros(g.size(0), device=g.device, dtype=torch.float32)
                M, v = st['m'], st['v']
                M.mul_(b1).add_(g.float(), alpha=1.0 - b1)
                O = _zeropower_via_newtonschulz5(M, group['ns_steps'])
                v.mul_(b2).add_((O * O).mean(dim=1), alpha=1.0 - b2)     # per-neuron second moment
                O = O / (v.add(eps).sqrt().unsqueeze(1))
                eta = 0.2 * lr * (g.size(0) * g.size(1)) ** 0.5 / (O.norm() + 1e-12)
                if wd:
                    p.mul_(1.0 - lr * wd)
                p.add_((O * -eta).to(p.dtype))


def build(model, lr, weight_decay, fused=False):
    """-> (NorMuon over weight matrices, AdamW over the rest). Returns both."""
    matrices, scalars, tables = [], [], []
    seen = set()
    for name, p in model.named_parameters():
        if not p.requires_grad or id(p) in seen:
            continue
        seen.add(id(p))                                   # tied embedding counted once
        if 'embed' in name or 'lookup.tables' in name:
            tables.append(p)
        elif p.dim() == 2 and 'type_logits' not in name:
            matrices.append(p)
        else:
            scalars.append(p)
    muon = NorMuon(matrices, lr=lr, weight_decay=weight_decay)
    adam = torch.optim.AdamW([{'params': scalars, 'lr': lr, 'weight_decay': 0.0},
                              {'params': tables, 'lr': lr / 10, 'weight_decay': 0.0}],
                             lr=lr, betas=(0.9, 0.95), eps=1e-8, fused=fused)
    # remember each group's share of the base lr, so the schedule can scale them all
    for opt in (muon, adam):
        for g in opt.param_groups:
            g['lr_scale'] = g['lr'] / lr
    return muon, adam, {'matrices': len(matrices), 'scalars': len(scalars), 'tables': len(tables)}
