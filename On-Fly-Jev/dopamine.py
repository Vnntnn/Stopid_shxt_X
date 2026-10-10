"""PAM / PPL1 dopamine for BioWhale, carried over from the fly.

In the MaleCNS run the reward signal was not a scalar added to the loss. It was
delivered the way the fly delivers it: a judge scored the model's own
continuations, the reward prediction error drove the fly's **PAM** cells when
things went better than expected and its **PPL1** cells when worse, and a
three-factor rule changed the synapses onto the cells those dopamine neurons
actually reach. 316 PAM cells, 16 PPL1, 149,070 dopamine synapses onto 8,615
target cells, 2.6M plastic synapses.

Where the populations come from:
    BioWhale-SNN    no connectome, so they are designated: a slice of one layer is
                    PAM, another PPL1.
    BioWhale-Fly100 the copies of the REAL PAM / PPL1 cells (fly100.dopamine).
Either way, "reach" is read from the weights those units already have: a neuron is
dopamine-receiving in proportion to how strongly that population projects to it.
The rule, as in the fly training:

    RPE      = (judge reward - running mean) / running std, clipped to +-3
    RPE > 0  -> PAM fires,  eligible synapses in PAM's reach are strengthened
    RPE < 0  -> PPL1 fires, eligible synapses in PPL1's reach are weakened
                (never both; the firing population keeps extra current until the
                next judgement, and reaches the network through its own synapses)
    dW_ij    = rel_lr * rms(W) * RPE * shape_ij,  shape = eligibility * reach, unit rms
    eligibility_ij = sum over the judged rollout of presynaptic release_i * post_j

Updates are **magnitude-only**: a weight's sign never changes. In the fly that
was Dale's law -- an excitatory synapse cannot become inhibitory. Here it keeps
dopamine from rewriting the network's structure behind the gradient's back.

This runs alongside backprop, not instead of it. On the fly's mushroom body the
comparison was measured (`analysis/mushroom_body_test.py`, 5 seeds): backprop
0.71, dopamine through the real DAN wiring 0.67, and backprop + dopamine 0.675 --
dopamine is a cheaper, blurrier route to the same credit, and it did NOT improve
on backprop when added to it. It earns its place here for what it did do in the
vision run: pushing `image_gain` from ~0 to +0.114 by rewarding the model for
using information it was ignoring.
"""
from __future__ import annotations

import torch
from torch import nn


class RunningNorm:
    def __init__(self, momentum=0.99):
        self.mean, self.var, self.n, self.m = 0.0, 1.0, 0, momentum

    def rpe(self, reward):
        # Start the running mean AT the first reward, not at 0. The judge's rewards sit
        # around -6, so a mean starting at 0 made every judgement look worse than
        # expected for hundreds of judgements: PPL1 (punishment) fired every time and
        # PAM never did -- after every fresh start and every resume.
        # For the first ~1/(1-m) judgements use the plain average (momentum 1 - 1/n),
        # so one noisy first reward cannot bias the baseline for hundreds of steps.
        if self.n == 0:
            self.mean, self.var = float(reward), 1.0
        self.n += 1
        m = min(self.m, 1.0 - 1.0 / self.n)
        d = reward - self.mean
        self.mean += (1 - m) * d
        self.var = m * self.var + (1 - m) * d * d if self.n > 1 else self.var
        if self.n < 3:
            return 0.0
        return float(d / max(self.var ** 0.5, 1e-6))


def _norm_state(norm):
    return {'mean': norm.mean, 'var': norm.var, 'n': norm.n}


class DopamineSystem(nn.Module):
    """PAM / PPL1 populations and the three-factor rule over a BioLIF stack."""

    def __init__(self, stack, pam_frac=0.02, ppl1_frac=0.001, rel_lr=0.01, drive=0.5,
                 layer=-1, seed=0, max_rpe=3.0):
        super().__init__()
        # rel_lr is RELATIVE to the plastic weights' own rms: one update moves them by
        # ~rel_lr * |RPE| of their size. The old absolute lr=1e-4 moved them 0.016% as
        # much as backprop did over the same 10 steps -- present, but with no effect.
        self.stack, self.rel_lr, self.drive, self.max_rpe = stack, rel_lr, drive, max_rpe
        # extra current into the firing population, one value per neuron. A fixed tensor
        # updated IN PLACE: torch.compile guards on tensor identity, not value, so the
        # changing strength never forces a recompile (a Python float did, every judgement)
        self.register_buffer('drive_vec', torch.zeros(stack.cfg.hidden))
        h = stack.cfg.hidden
        g = torch.Generator().manual_seed(seed)
        perm = torch.randperm(h, generator=g)
        n_pam = max(int(h * pam_frac), 1)
        n_ppl1 = max(int(h * ppl1_frac), 1)
        self.register_buffer('pam', perm[:n_pam])
        self.register_buffer('ppl1', perm[n_pam:n_pam + n_ppl1])
        self.layer = layer % len(stack.cells)
        self.norm = RunningNorm()
        self._elig = None
        self._reach = None

    def norm_state(self):
        """The reward normaliser, for the checkpoint (so a resume keeps its baseline)."""
        return _norm_state(self.norm)

    def load_norm_state(self, s):
        if s:
            self.norm.mean, self.norm.var, self.norm.n = float(s['mean']), float(s['var']), int(s['n'])

    def plastic(self):
        """The synapses dopamine writes to: the recurrence when the model ticks, the
        feed-forward input in parallel mode (which drops the recurrence entirely --
        writing to `rec` there changed a matrix nothing reads)."""
        s = self.stack
        return s.ff[self.layer] if s.parallel else s.rec[self.layer]

    # ------------------------------------------------------------ dopamine --
    def reach(self, pop=None):
        """How strongly each neuron is reached by one DA population (PAM or PPL1),
        or by both when pop is None. In the fly the two reach different compartments,
        so reward and punishment rewrite different synapses."""
        w = self.plastic().weight.detach()                          # [out, in]
        da = torch.cat([self.pam, self.ppl1]) if pop is None else pop
        r = w[:, da].abs().sum(1)
        return r / r.max().clamp_min(1e-9)

    def inject(self, current, rpe):
        """Drive PAM when better than expected, PPL1 when worse -- never both."""
        if rpe == 0:
            return current
        idx = self.pam if rpe > 0 else self.ppl1
        out = current.clone()
        out[:, idx] = out[:, idx] + self.drive * abs(rpe)
        return out

    def attach(self):
        """Record eligibility on every tick of the layer dopamine reaches.

        Without this the rule has no presynaptic factor and `apply` is a no-op --
        a three-factor rule needs all three factors.
        """
        stack, layer = self.stack, self.layer
        if getattr(stack, '_da_attached', False):
            return self
        orig = stack.tick

        def tick(current, state):
            rel, mems, state = orig(current, state)
            self.accumulate(state[layer]['mem'], mems[layer])
            return rel, mems, state

        stack.tick = tick

        # Parallel mode never calls tick(), so without this the eligibility stayed
        # empty and every dopamine update was silently a no-op. There the whole
        # sequence arrives at once; flatten (batch, time) into the sum.
        # Parallel mode has no `rec`, so the plastic synapses are the feed-forward
        # ones INTO this layer: presynaptic = the previous layer's release.
        def on_layer(i, inp, mem):
            if i == layer:                   # same calls as tick(), incl. generate()
                self.accumulate(inp.flatten(0, 1), mem.flatten(0, 1))

        stack.on_layer = on_layer

        # The DA cells FIRE: after a judged rollout, PAM (better than expected) or
        # PPL1 (worse) gets extra current until the next judgement. Their release then
        # reaches the rest of the network through their ordinary synapses.
        def pre_layer(i, drive):
            if i != layer:
                return drive
            return drive + self.drive_vec.to(drive.dtype)     # zero when nothing is firing

        stack.pre_layer = pre_layer
        stack._da_attached = True
        return self

    # --------------------------------------------------------- eligibility --
    def start_episode(self):
        self._elig = None

    def accumulate(self, presyn, post):
        """Hebbian eligibility for this tick: presynaptic release x postsynaptic activity."""
        e = torch.einsum('bi,bj->ji', presyn.detach().float(), post.detach().float())
        self._elig = e if self._elig is None else self._elig + e

    @torch.no_grad()
    def apply(self, reward):
        """The judge's reward -> PAM or PPL1 -> their synapses. Returns what it did.

        RPE > 0 : PAM fires; eligible synapses in PAM's reach are STRENGTHENED.
        RPE < 0 : PPL1 fires; eligible synapses in PPL1's reach are WEAKENED.
        Never both. Eligibility is the activity that produced the judged text
        (train.py resets it before replaying the rollout)."""
        rpe = max(-self.max_rpe, min(self.max_rpe, self.norm.rpe(float(reward))))
        if self._elig is None or rpe == 0:
            self.drive_vec.zero_()
            return {'rpe': rpe, 'dW_rms': 0.0, 'fired': None}
        pop, name = (self.pam, 'PAM') if rpe > 0 else (self.ppl1, 'PPL1')
        self.drive_vec.zero_()
        self.drive_vec[pop] = self.drive * abs(rpe)
        w = self.plastic().weight                                   # [out, in]
        shape = self._elig * self.reach(pop)[:, None]
        shape = shape / shape.pow(2).mean().sqrt().clamp_min(1e-12)     # unit rms
        dw = self.rel_lr * float(w.pow(2).mean().sqrt()) * rpe * shape
        # magnitude-only: move |w|, keep sign (the fly's Dale constraint)
        new_mag = (w.abs() + dw * w.sign().where(w != 0, torch.ones_like(w))).clamp_min(0.0)
        updated = w.sign() * new_mag
        delta = updated - w
        w.copy_(updated)
        self._elig = None
        return {'rpe': round(rpe, 4), 'fired': name, 'cells': int(pop.numel()),
                'dW_rms': float(delta.pow(2).mean().sqrt()),
                'dW_rel': round(float(delta.pow(2).mean().sqrt() / w.pow(2).mean().sqrt()), 5),
                'strengthened_frac': round(float((delta * w.sign() > 0).float().mean()), 4),
                'cells_reached': int((self.reach(pop) > 0.1).sum())}


class JudgeReward:
    """Reward for the model's own continuations, as SmolLM2-360M did for the fly.

    reward = mean log p(continuation | prompt) + variety_weight * (distinct token
    fraction - 1). The second term exists because a judge finds `ack ack ack`
    extremely predictable, and without it the reward is maximised by repeating.
    """

    def __init__(self, model_id='HuggingFaceTB/SmolLM2-360M', device='cpu', variety_weight=2.0):
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.tok = AutoTokenizer.from_pretrained(model_id)
        self.lm = AutoModelForCausalLM.from_pretrained(model_id).to(device).eval()
        self.lm.requires_grad_(False)
        self.device, self.variety_weight = device, variety_weight

    @torch.no_grad()
    def __call__(self, texts):
        rewards = []
        for text in texts:
            ids = self.tok(text, return_tensors='pt').to(self.device)
            if ids.input_ids.shape[1] < 2:
                rewards.append(-10.0)
                continue
            out = self.lm(**ids, labels=ids.input_ids)
            logp = -float(out.loss)
            toks = ids.input_ids[0].tolist()
            distinct = len(set(toks)) / max(len(toks), 1)
            rewards.append(logp + self.variety_weight * (distinct - 1))
        return sum(rewards) / max(len(rewards), 1)


def variety_reward(texts, tokenizer=None):
    """A judge-free fallback: reward token variety alone. Cheap, and enough to
    verify the plumbing before a 360M judge is loaded."""
    total = 0.0
    for t in texts:
        toks = (tokenizer.encode(t, add_special_tokens=False) if tokenizer else list(t))
        total += len(set(toks)) / max(len(toks), 1)
    return total / max(len(texts), 1)
