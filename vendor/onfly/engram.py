"""Engram: a hashed 1..3-gram memory added to the token embedding.

Adapted from Byrne70M (model_v2.py: TokenCompressor, MultiHeadHashLookup,
DERFContextGate, EngramModule), with its v3 sign-bit LSH hash -- the earlier
truncating hash collapsed every n-gram into bucket 0.

Why it is here: a BioLIF cell's own memory is its leak, ~1/(1-beta) = 10 tokens,
and parallel mode has no recurrence. Engram hands every position a learned
vector for its last 1, 2 and 3 tokens by table lookup -- no sequential work, a
few small matmuls -- so the neurons do not have to spend their short horizon
re-deriving local n-gram statistics.

The gate is DERF (erf-based, init bias -1), as in Byrne: it starts partly open.
"""
from __future__ import annotations

import math

import torch
from torch import nn


class TokenCompressor(nn.Module):
    """Frozen random projection into the hash space, L2-normalised (scale-free)."""

    def __init__(self, embed_dim, compress_dim):
        super().__init__()
        self.proj = nn.Linear(embed_dim, compress_dim, bias=False)
        nn.init.normal_(self.proj.weight, std=embed_dim ** -0.5)
        self.proj.weight.requires_grad_(False)

    def forward(self, x):
        z = self.proj(x)
        return z / (z.norm(dim=-1, keepdim=True) + 1e-6)


class MultiHeadHashLookup(nn.Module):
    """Sign-bit LSH over the compressed n-gram, one table per head, order-sensitive."""

    def __init__(self, num_heads, table_size, compress_dim, out_dim, max_ngram=3):
        super().__init__()
        self.num_heads, self.table_size, self.max_ngram, self.out_dim = num_heads, table_size, max_ngram, out_dim
        # +8 spare bits keep `% table_size` near-uniform; <= 24 so float32 packing is exact
        self.hash_bits = min(24, max(1, math.ceil(math.log2(max(table_size, 2))) + 8))
        self.tables = nn.ModuleList([nn.Embedding(table_size, out_dim) for _ in range(num_heads)])
        for t in self.tables:
            nn.init.normal_(t.weight, std=0.01)
        self.register_buffer('bit_weights', 2.0 ** torch.arange(self.hash_bits, dtype=torch.float32),
                             persistent=False)
        g = torch.Generator().manual_seed(0)
        for n in range(1, max_ngram + 1):
            for k in range(n):
                proj = torch.randn(num_heads, self.hash_bits, compress_dim, generator=g)
                self.register_buffer(f'hash_proj_n{n}_p{k}', proj / (proj.norm(dim=-1, keepdim=True) + 1e-8))

    def _bucket_ids(self, compressed, n, valid_len):
        h = None
        for k in range(n):
            proj = getattr(self, f'hash_proj_n{n}_p{k}')
            term = torch.matmul(compressed[:, k:k + valid_len, :].float(),
                                proj.reshape(self.num_heads * self.hash_bits, -1).t()
                                ).view(-1, valid_len, self.num_heads, self.hash_bits)
            h = term if h is None else h + term
        idx = ((h > 0).float() * self.bit_weights).sum(-1).long()
        return idx % self.table_size

    @torch.no_grad()
    def bucket_occupancy(self, compressed):
        """Fraction of the table actually addressed per order (collapse shows as ~0)."""
        S, out = compressed.shape[1], {}
        for n in range(1, self.max_ngram + 1):
            if S >= n:
                idx = self._bucket_ids(compressed, n, S - n + 1)
                out[f'n{n}'] = round(int(idx.unique().numel()) / min(idx.numel(), self.table_size), 4)
        return out

    def forward(self, compressed):
        B, S, _ = compressed.shape
        out = compressed.new_zeros(B, S, self.out_dim, dtype=torch.float32)
        norm = torch.zeros(S, device=compressed.device)
        for n in range(1, self.max_ngram + 1):
            if S < n:
                continue
            idx = self._bucket_ids(compressed, n, S - n + 1)
            for hd, table in enumerate(self.tables):
                out[:, n - 1:] = out[:, n - 1:] + table(idx[:, :, hd]).float()
            norm[n - 1:] += self.num_heads
        return out / norm.view(1, -1, 1).clamp(min=1)


class DERFContextGate(nn.Module):
    def __init__(self, d, init_bias=-1.0):
        super().__init__()
        self.proj = nn.Linear(2 * d, d)
        self.alpha = nn.Parameter(torch.ones(d))
        self.bias = nn.Parameter(torch.full((d,), init_bias))
        self.gamma = nn.Parameter(torch.ones(d))

    def forward(self, retrieved, x):
        logits = self.proj(torch.cat([retrieved, x], dim=-1))
        return retrieved * self.gamma * ((torch.erf(self.alpha * logits + self.bias) + 1.0) / 2.0)


class Engram(nn.Module):
    def __init__(self, d, compress_dim=32, num_heads=2, table_size=4096, max_ngram=3, gate_bias=-1.0):
        super().__init__()
        self.compressor = TokenCompressor(d, compress_dim)
        self.lookup = MultiHeadHashLookup(num_heads, table_size, compress_dim, d, max_ngram)
        self.gate = DERFContextGate(d, gate_bias)

    def forward(self, x):
        """x: token embeddings [B, S, d] -> gated n-gram read to ADD to them."""
        retrieved = self.lookup(self.compressor(x.detach())).to(x.dtype)
        return self.gate(retrieved, x)

    def occupancy(self, x):
        return self.lookup.bucket_occupancy(self.compressor(x.detach()))
