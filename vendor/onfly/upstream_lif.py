"""Leaky integrate-and-fire (LIF) primitives with a surrogate gradient.

A spiking neuron emits a binary spike when its membrane potential crosses a
threshold. The spike is a step function, whose derivative is zero almost
everywhere and undefined at the threshold -- useless for gradient descent. The
standard fix (Neftci et al. 2019; Zenke & Ganguli 2018) is the **surrogate
gradient**: use the hard threshold on the forward pass, but a smooth surrogate
derivative on the backward pass. Here we use the "fast sigmoid" surrogate

    forward :  S = 1[ mem >= thresh ]
    backward:  dS/d(mem)    =  1 / (1 + slope * |mem - thresh|)^2
               dS/d(thresh) = -1 / (1 + slope * |mem - thresh|)^2

Passing a gradient to `thresh` is what lets the gene-program modulation (which
sets each neuron's threshold) be trained end-to-end.
"""

from __future__ import annotations

import math

import torch

# sqrt(pi)/2 makes d/dx [b*erf(x*k/b)] == 1 at x=0, so soft_clamp is the identity for
# small inputs (no per-step gain to compound over the recurrence) and saturates to +/-b.
_ERF_K = math.sqrt(math.pi) / 2.0


def soft_clamp(x, bound):
    """DERF (erf-based) smooth bound to (-bound, bound). Unlike a hard clamp it has a
    NON-ZERO gradient everywhere, so it bounds activations (collapse impossible) WITHOUT
    creating the dead-gradient zones that starve downstream blocks. Identity near 0."""
    return bound * torch.erf(x * (_ERF_K / bound))


SURROGATE_SLOPE = 20.0
# |mem - thresh| past this contributes a surrogate gradient of ~(1/(20*C))^2 ~ 0, so
# clamping the saved value here is lossless yet keeps (slope*|v|+1)^2 from overflowing.
_V_CLAMP = 30.0


class SpikeFn(torch.autograd.Function):
    @staticmethod
    def forward(ctx, mem, thresh):
        ctx.save_for_backward(mem - thresh)
        return (mem >= thresh).to(mem.dtype)

    @staticmethod
    def backward(ctx, grad_output):
        (v,) = ctx.saved_tensors
        # NUMERICAL SAFETY: v = mem - thresh can grow huge over a long recurrence.
        # For large |v| the surrogate is ~0, so clamping v to a finite range is
        # lossless -- but it prevents (slope*|v|+1)^2 from OVERFLOWING float32 to
        # inf, which made sg=0 and then 0*inf = NaN, poisoning every gradient.
        # We also sanitise grad_output and the result so a single bad value can't
        # propagate NaN through backprop-through-time. (This was the true cause of
        # the step-~2840 "non-finite grad norm" stall.)
        v = torch.nan_to_num(v, nan=0.0, posinf=_V_CLAMP, neginf=-_V_CLAMP).clamp(-_V_CLAMP, _V_CLAMP)
        grad_in = torch.nan_to_num(grad_output, nan=0.0, posinf=0.0, neginf=0.0)
        sg = 1.0 / (SURROGATE_SLOPE * v.abs() + 1.0) ** 2      # always in (0, 1]
        grad = grad_in * sg
        # gradient flows to membrane (+) and threshold (-); thresh may broadcast
        grad_thresh = -grad
        if grad_thresh.shape != v.shape:  # defensive; shapes match in practice
            grad_thresh = grad_thresh.sum_to_size(v.shape)
        return grad, grad_thresh


def spike(mem, thresh):
    """Heaviside spike with surrogate-gradient backward."""
    return SpikeFn.apply(mem, thresh)
