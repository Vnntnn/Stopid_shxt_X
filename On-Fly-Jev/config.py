"""BioWhale configuration, in the shape of SpikeWhaleConfig.

`base()` is SpikeWhale-SNN-216M's own geometry (4 x 1488, tied embeddings,
16,512-token byte-level vocabulary, one tick per token). `small()` is the same
architecture sized to train on one machine while the wiring is being checked.
"""
from dataclasses import dataclass, field


@dataclass
class BioWhaleConfig:
    # --- geometry (SpikeWhale-SNN-216M) ---
    vocab_size: int = 16512
    hidden: int = 1488
    layers: int = 4
    tie_embeddings: bool = True

    # --- the cell ---
    beta: float = 0.9
    threshold: float = 1.0
    rec_init: float = 0.02
    n_types: int = 8
    # Sequence-parallel training: each layer's membrane is solved as a linear scan
    # over the whole sequence instead of tick by tick. Requires dropping the
    # intra-layer recurrence (it is what makes the scan nonlinear) and the reset.
    # Measured on CPU: 6-12x the sequential cell at 99.90% spike agreement.
    parallel: bool = False
    reset: bool = True
    chunk: int = 64
    beta_max: float = 0.97         # decay ceiling; raise toward 1 for a longer horizon
    # Cross-token mixing. BioLIF's own horizon is ~1/(1-beta) tokens, so without
    # this a long window is throughput, not context. Gated to zero at init.
    attention: bool = False
    attn_heads: int = 8
    attn_head_dim: int = 64
    attn_every: int = 1            # attach to every Nth layer
    # which BioLIF pieces are live. () is plain SpikeWhale LIF, bit for bit.
    parts: tuple = ('types',)

    # --- kept from the Byrne line, all no-ops at init ---
    loops: int = 3                 # looped passes over the spiking stack
    hrm_steps: int = 2
    hrm_dim: int = 256
    hrm_weight: float = 0.5
    jepa_weight: float = 0.1
    jepa_dim: int = 512
    mtp_weight: float = 0.3

    # --- copied fly neurons (see fly100.py) ---
    fly100: str = ''               # path to fly100.pt; '' = plain BioWhale
    fly_noise: float = 0.1         # copy-to-copy spread, relative to the weight scale

    # --- from Byrne70M (engram.py, normuon.py, data.py) ---
    engram: bool = False           # hashed 1..3-gram memory at the embedding
    engram_table_size: int = 4096
    zloss_coef: float = 0.0
    optimizer: str = 'adamw'       # 'adamw' or 'normuon' (NorMuon matrices + AdamW rest)
    grad_accum: int = 1
    min_lr_frac: float = 1.0       # cosine floor; 1.0 = no decay (the old behaviour)
    # 'cosine' (warmup -> cosine to min_lr_frac) or 'wsd' (Byrne IFM-Cooldown:
    # warmup -> flat peak -> cosine to min_lr_frac over the last wsd_decay_frac)
    schedule: str = 'cosine'
    wsd_decay_frac: float = 0.2
    cooldown_blend: bool = False   # wsd only: switch to the math-heavy blend at the decay
    lr_ramp_steps: int = 1000      # on resume, ramp from the checkpoint's lr to the schedule
    blend: str = ''                # 'byrne' = the Byrne pretraining blend (data.py)

    # --- training ---
    firing_target: float = 0.2     # SpikeWhale's anti-death regulariser
    firing_weight: float = 50.0
    seq: int = 256
    batch: int = 8
    lr: float = 1e-3
    muon_lr: float = 0.02
    weight_decay: float = 0.0
    warmup_steps: int = 200
    max_steps: int = 20000
    grad_clip: float = 1.0
    log_every: int = 10
    save_every: int = 250
    keep_checkpoints: int = 0      # >0: keep only the newest N stepN.pt files
    eval_every: int = 250
    sources: tuple = (('HuggingFaceFW/fineweb-edu', 0.75), ('roneneldan/TinyStories', 0.25))


def base(**over):
    cfg = BioWhaleConfig()
    for k, v in over.items():
        setattr(cfg, k, v)
    return cfg


def small(**over):
    """~30M parameters: same architecture, laptop-sized, for checking the wiring."""
    d = dict(hidden=512, layers=4, seq=128, batch=8, hrm_dim=128, jepa_dim=256)
    d.update(over)
    return base(**d)


def parallel(**over):
    """Transformer-style throughput: linear-scan membranes, no intra-layer recurrence,
    spiking linear attention for the cross-token mixing the cell cannot do."""
    # HRM deep supervision and MTP are OFF here: each one recomputes the
    # 16,512-wide output projection, and those extra head calls were ~3/4 of the
    # arithmetic per token -- more than the neurons, the attention and the
    # feed-forward layers put together. Turn them back on (hrm_steps=2,
    # mtp_weight=0.3) once throughput is settled and quality is what is being
    # measured. JEPA stays: it is a small MLP on the read features, not vocab-wide.
    d = dict(parallel=True, reset=False, parts=('types', 'graded', 'synaptic'),
             attention=True, hrm_steps=0, mtp_weight=0.0)
    d.update(over)
    return base(**d)


def full_bio(**over):
    """Every piece of the cell live."""
    d = dict(parts=('types', 'synaptic', 'adapt', 'graded', 'stp'))
    d.update(over)
    return base(**d)


def fly100(**over):
    """100 real MaleCNS neurons, 15 copies each per layer, in the parallel stack.
    Graded release is off: these are central-brain spiking cells, not optic lobe."""
    # loops=1: measured on GPU at 8 x 1024, 6.1 min / 1000 steps (6.6 GB) vs 15.1 min
    # (12.5 GB) at 3 loops. The loop machinery stays in the model; raise it here to use it.
    # Pretraining as Byrne70M ran it: its blend, seq 2048, 49,152 tokens per optimizer
    # step (4 x 2048 x 6 accumulation -- Byrne used 8 x 2048 x 3; the same tokens in
    # half the memory), lr 1.5e-4 with NorMuon, 1,000 warmup, cosine to 10%, wd 0.01,
    # z-loss 1e-4, Engram on.
    d = dict(hidden=1500, fly100='fly100.pt', parts=('types', 'synaptic'), loops=1,
             save_every=500, log_every=100, keep_checkpoints=5,
             # 10B tokens: 203,451 steps x 49,152 = 10,000,023,552. WSD as in Byrne's
             # IFM-Cooldown run: flat 1.5e-4, then cosine to ZERO over the last 20%
             # (from step 162,760), with the math-tripled cooldown blend there.
             blend='byrne', seq=2048, batch=4, grad_accum=6, max_steps=203451,
             schedule='wsd', wsd_decay_frac=0.2, cooldown_blend=True,
             optimizer='normuon', lr=1.5e-4, warmup_steps=1000, min_lr_frac=0.0,
             weight_decay=0.01, zloss_coef=1e-4, engram=True)
    d.update(over)
    return parallel(**d)


def fly100_small(**over):
    """Same, 500 units per layer (5 copies each), for checking the wiring on CPU."""
    d = dict(hidden=500, layers=4, seq=128, batch=8, hrm_dim=128, jepa_dim=256, grad_accum=2,
             log_every=1, save_every=2, warmup_steps=2, max_steps=4)
    d.update(over)
    return fly100(**d)


def fly100_tk_small(**over):
    """Fear smoke test: the fly100_tk.pt circuit (PAM + PPL1 + 24 Tk-GAL4^2 n Vglut
    PROXY cells), 500 units per layer, real data, cosine, CPU-sized. The arms differ
    only in train.py --punish (PPL1 / TK / PPL1+TK)."""
    d = dict(hidden=500, layers=4, seq=256, batch=8, grad_accum=1, hrm_dim=128, jepa_dim=256,
             fly100='fly100_tk.pt', schedule='cosine', cooldown_blend=False, max_steps=400,
             warmup_steps=40, min_lr_frac=0.1, lr=6e-4, log_every=50, save_every=400,
             keep_checkpoints=0)
    d.update(over)
    return fly100(**d)
