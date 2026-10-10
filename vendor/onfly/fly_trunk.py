"""FlyNeuron-SNN-96M as a decision-model trunk.

Gives BioWhaleLM the interface the Jev decision core expects from a SpikeWhale:
  trunk.model(input_ids=..., use_cache=False)[0] -> hidden states [B, T, hidden]
  trunk.config.hidden_size
The hidden state is the model's own read-out (tanh(read(norm(features)))), i.e. exactly what its
LM head reads, 1,500-wide. after_step() re-imposes the fly's Dale signs, as FlyNeuron's train.py
does after every optimiser step; the trainer calls it after each update.
"""
import os
import sys
from types import SimpleNamespace

import torch
import torch.nn as nn


class _Features(nn.Module):
    def __init__(self, bio):
        super().__init__()
        self.bio = bio

    def forward(self, input_ids=None, use_cache=False, **_):
        feat = self.bio.features(input_ids)
        return (torch.tanh(self.bio.read(self.bio.norm(feat))),)


class FlyTrunk(nn.Module):
    def __init__(self, bio, fly100_module):
        super().__init__()
        self.bio = bio
        self.model = _Features(bio)
        self._fly100 = fly100_module
        self.config = SimpleNamespace(hidden_size=bio.cfg.hidden, max_position_embeddings=2048,
                                      tie_word_embeddings=False)

    def gradient_checkpointing_enable(self, **_):
        pass        # FlyNeuron has no HF checkpointing hook; its activations fit at decision lengths

    @torch.no_grad()
    def after_step(self):
        self._fly100.enforce_dale(self.bio)


def _fly_modules(code_dir):
    if code_dir not in sys.path:
        sys.path.insert(0, code_dir)
    import config as C          # FlyNeuron's own config.py
    import fly100
    from model import BioWhaleLM
    return C, fly100, BioWhaleLM


def build_fly_trunk(code_dir, state=None):
    C, fly100, BioWhaleLM = _fly_modules(code_dir)
    bio = BioWhaleLM(C.fly100(vocab_size=16512))
    fly100.apply(bio, fly100.load(os.path.join(code_dir, "fly100.pt")))
    if state is not None:
        missing, unexpected = bio.load_state_dict(state, strict=False)
        assert not missing and not unexpected, (missing[:5], unexpected[:5])
    return FlyTrunk(bio, fly100)


def is_fly_checkpoint(c):
    return isinstance(c, dict) and "model" in c and "types" in c
