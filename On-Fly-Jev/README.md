---
license: apache-2.0
library_name: pytorch
pipeline_tag: text-classification
tags:
  - spiking-neural-network
  - snn
  - connectome
  - drosophila
  - typed-decisions
  - jev
  - vizdoom
  - model-merging
  - research
datasets:
  - LocalLLaMA/typed-decisions
  - ZefanCai/Open-Jev
  - openai/gsm8k
base_model_relation: merge
---

# On-Fly-Jev

<p align="center">
  <img src="logo.png" alt="On-Fly-Jev" width="280"/>
</p>

Typed-decision model on a spiking fly-neuron language model. You give it a state (text or JSON) and typed questions
(`choice`, `score`, `noul`). It returns calibrated probabilities in **one forward pass**. Nothing is generated.

The trunk is **FlyNeuron-SNN-96M**: 96M, every unit is a copy of one of **100 real fruit-fly neurons** from the
Janelia / Google MaleCNS v1.0 connectome.

This is my **second** Jev-style model. First was [Byrne-Jev](https://huggingface.co/Quazim0t0/Byrne-Jev-79M)
(70M SpikeWhale). This one was for **speed**: about **3x faster than Byrne-Jev**, same calibration, better
typed-decisions accuracy.

**~137 decisions per second (7.3 ms p50).** Best ECE in the comparison group.

50 / 50 weight average of two checkpoints from the same lineage: previous best FlyNeuron-Jev, and that model after
two more epochs on the full new mix. Merge kept the best of each.

## Decision speed

| | On-Fly-Jev |
|---|---|
| **Decisions per second (p50)** | **~137** |
| Latency per decision (p50) | **7.3 ms** |
| Latency per case, 5 decisions (p50 / p95) | **36.6 ms / 53.5 ms** |
| Cases per second (p50) | ~27 |
| Live game loop, ViZDoom (1 question per tick, incl. game I/O) | 23.4 ms -> ~43 decisions/s |

Typed-decisions test split (400 cases, 2,000 decisions, 5 questions per case, one forward pass per case), local GPU.
Every answer is one forward pass.

## Comparison

Typed-decisions test split (LocalLLaMA/typed-decisions, 2,000 decisions). Speed = p50 time per case of 5 decisions.

| Model | Params | Accuracy | Soft acc. | Brier ↓ | ECE ↓ | ms / case (p50) | **Decisions / s** |
|---|---|---|---|---|---|---|---|
| **On-Fly-Jev** (this model, spiking) | 96M | 0.666 | 0.528 | 0.132 | **0.045** | **36.6** | **~137** |
| [Byrne-Jev](https://huggingface.co/Quazim0t0/Byrne-Jev-79M) | 70M | 0.630 | 0.509 | 0.134 | **0.045** | 110.7 | ~45 |
| TypeSafe Jev 1.13.0 | - | 0.727 | **0.580** | 0.148 | 0.144 | 710 | ~7 |
| ModernBERT-base (specialist) | 149M | 0.646 | 0.542 | **0.119** | 0.179 | 349 | ~14 |
| Laya typed-decisions (fine-tuned) | 421M | **0.766** | 0.471 | - | - | - | - |
| Teacher self-agreement (ceiling) | - | 0.735 | | | | | |

- **Speed:** about **19x faster than TypeSafe Jev**, **9.5x faster than ModernBERT-base**, **3x faster than Byrne-Jev**
  per case.
- **Accuracy:** above ModernBERT-base and Byrne-Jev; below TypeSafe Jev and Laya (larger or hosted).
- **Calibration:** ties Byrne-Jev for lowest ECE (0.045). About a third of TypeSafe Jev, a quarter of ModernBERT.
- TypeSafe Jev, Laya and ModernBERT numbers are the published typed-decisions references. TypeSafe Jev is a hosted API,
  so its time includes network. Laya reports no calibration or speed.
- On the 10 held-out public sources, Byrne-Jev is stronger (mean 0.746 vs 0.682).

## fastino/fast-decisions

Development split only. 100 rows x 17 domains, **2,900 heads**. Their test split (300 per domain) is held out, so this is not that benchmark.

Single-label is a choice over the full label list. Multi-label (`product_area`, `aspects`, `genres`) is one yes/no per candidate label. A label counts when noul >= 0.5. Score is exact set match.

GPU first. Local CUDA, bf16. Every head on a row in one forward, so the times below are **per row**, not per head. No RSS or load time on that run.

| # | model | precision | accuracy | p50 ms | p95 ms | decisions/s | peak RSS MB | load s | Pareto |
|--:|---|---|--:|--:|--:|--:|--:|--:|:-:|
| 1 | On-Fly-Jev | bf16 | 24.6 % | 22.7 | 42.5 | - | - | - | - |

- support_intent 0.040
- support_topic 0.050
- document_type 0.080
- review_sentiment 0.440
- agent_handoff 0.520
- email_triage 0.347
- ticket_route 0.250
- product_feedback 0.105
- banking_intent 0.090
- clinic_request 0.280
- travel_request 0.100
- news_topic 0.140
- paper_field 0.100
- sports_recap 0.283
- restaurant_review 0.330
- benefits_request 0.285
- screen_tags 0.290

CPU next. Same score, one head per call, batch 1. 12th Gen Intel Core i5-12600KF, PyTorch fp32, 10 threads.

Under load. `extract_think_dataset.py` was converting a corpus on this CPU the whole run.

| # | model | precision | accuracy | p50 ms | p95 ms | decisions/s | peak RSS MB | load s | Pareto |
|--:|---|---|--:|--:|--:|--:|--:|--:|:-:|
| 1 | On-Fly-Jev | fp32 | 25.0 % | 174.4 | 977.9 | 3.9 | 2102 | 3.2 | ✓ |

Second run, that conversion job was not running. A one-shot CPU reading before launch was still 44%.

| # | model | precision | accuracy | p50 ms | p95 ms | decisions/s | peak RSS MB | load s | Pareto |
|--:|---|---|--:|--:|--:|--:|--:|--:|:-:|
| 1 | On-Fly-Jev | fp32 | 25.0 % | 167.7 | 984.5 | 4.0 | 2103 | 2.9 | ✓ |

GPU **24.6%**, CPU **25.0%**. Same story. Wide label sets (support intent, topic, document type) sit near chance. Two- and three-way heads are the ones above that. CPU p95 is the multi-label heads.

## Watch it play ViZDoom

Every decision below is one forward pass (**23.4 ms** on GPU). No game-specific training beyond the decision data
further down. ViZDoom state goes in as JSON. The model picks the action.

<p align="center">
  <img src="https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/logo.png" alt="On-Fly-Jev" width="220"/>
</p>

<p align="center">
<video controls width="320">
  <source src="https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/videos/flyneuron-jev_deadly_corridor_e2_20260927-0650.mp4" type="video/mp4">
</video>
<video controls width="320">
  <source src="https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/videos/flyneuron-jev_deadly_corridor_e1_20260927-0650.mp4" type="video/mp4">
</video>
<video controls width="320">
  <source src="https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/videos/flyneuron-jev_defend_the_center_e1_20260927-0650.mp4" type="video/mp4">
</video>
</p>
<p align="center">Deadly corridor e2 (6 kills) · Deadly corridor e1 (6 kills) · Defend the center e1 (12 kills)</p>

<p align="center">
<video controls width="320">
  <source src="https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/videos/flyneuron-jev_defend_the_center_e2_20260927-0650.mp4" type="video/mp4">
</video>
<video controls width="320">
  <source src="https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/videos/flyneuron-jev_defend_the_line_e2_20260927-0650.mp4" type="video/mp4">
</video>
<video controls width="320">
  <source src="https://huggingface.co/Quazim0t0/On-Fly-Jev/resolve/main/videos/flyneuron-jev_defend_the_line_e3_20260927-0650.mp4" type="video/mp4">
</video>
</p>
<p align="center">Defend the center e2 (10 kills) · Defend the line e2 (26 kills) · Defend the line e3 (16 kills)</p>

### ViZDoom summary (3 episodes each, 2,151 decisions)

| Scenario | On-Fly-Jev | FlyNeuron-Jev FT2 epoch 4 | FT2 merge (epochs 1 + 4) |
|---|---|---|---|
| Basic | 3 / 3 cleared | - | - |
| Defend the center, avg kills | **10.7** | 10.0 | 9.3 |
| Defend the line, avg kills | 21.3 | **31.0** | 22.0 |
| Deadly corridor, finished | 2 / 3 | 2 / 3 | **3 / 3** |

Full per-step logs (state, probabilities, chosen action) and `.lmp` demos are in `doom_runs/`.

## Benchmarks

Typed-decisions test split (2,000 decisions) plus 200 held-out items from each of 10 public sources.
All numbers from `eval_decisions.py --suite all` on GPU. Reports in `eval/`.

| | Old FlyNeuron-Jev | New-mix epoch 2 | **On-Fly-Jev** |
|---|---|---|---|
| Typed accuracy | 0.6655 | 0.651 | **0.666** |
| Brier score | 0.144 | **0.130** | 0.132 |
| ECE | 0.050 | 0.052 | **0.045** |
| Held-out mean | 0.679 | **0.682** | **0.682** |
| AG News | 0.835 | **0.860** | 0.850 |
| Banking77 | 0.835 | **0.845** | **0.845** |
| BoolQ | **0.645** | 0.555 | 0.635 |
| Emotion | 0.625 | **0.640** | 0.615 |
| Hate | 0.635 | **0.685** | 0.650 |
| IMDB | 0.980 | **0.985** | **0.985** |
| MASSIVE | **0.750** | 0.740 | 0.745 |
| MNLI | 0.370 | 0.390 | **0.395** |
| SST-2 | **0.700** | **0.700** | 0.680 |
| Yelp | 0.415 | 0.420 | **0.425** |

See **Comparison** above for TypeSafe Jev, Laya, Byrne-Jev and ModernBERT.

## Neurons and architecture

### The 100 fly neurons (`fly100.pt`, `fly100.json`)

100 neurons from the original, untrained conversion of MaleCNS v1.0. Each keeps its body ID, transmitter, Dale sign,
receptor time constant, role, and synapses to the other 99 (signed 100x100 matrix).

| | |
|---|---|
| Transmitters | 36 acetylcholine, 27 glutamate, 21 GABA, 14 dopamine, 2 octopamine |
| Sign | 52 excitatory, 48 inhibitory |
| Roles | 6 PAM, 6 PPL1 (dopamine), 2 Kenyon cells, 86 other |
| Wiring among them | 2,760 synapses (27.6% of possible pairs), mean non-zero weight 0.50; every neuron's outgoing synapses agree with its Dale sign |

### How the neurons become the network

Every spiking layer has 1,500 units. **Unit i is a copy of fly neuron i mod 100**, so each real neuron shows up 15
times per layer. A copy inherits:

- **Cell type**: frozen one-hot of its transmitter. Types are never re-learned.
- **Receptor timing**: synaptic-trace decay from that transmitter's receptor time constant (1.5, 3, 6 or 30 ticks).
  Trace starts on.
- **Dale's law**: every weight a copy sends has the fly neuron's sign. After every optimiser step, weights go back to
  |w| x sign. Pretraining and every Jev stage.
- **Wiring**: weights between layers 1-3, and within each layer, start as the fly's 100x100 matrix tiled over the
  copies, rescaled to a normal init, plus 10% noise so copies can drift. A fly synapse of zero starts near zero. The
  fly's sparsity is where training starts, not a hard mask. Layer 0 reads the token embedding, so it has no fly wiring.
- **Threshold and leak** start at the conversion's shared values (1.0 and 0.9). Per-type gains learn.
- **Role**: PAM copies carry the dopamine reward signal. PPL1 copies carry punishment.

BioLIF cells, parallel linear scan (no reset). Cell types and synaptic trace on. Graded release off (these are
central-brain spiking cells). Spiking linear attention (8 heads x 64 per layer, learned per-head decay) mixes across
tokens. Engram n-gram memory and a JEPA auxiliary loss are on.

### The decision head (`fly_trunk.py`, `decision_core.py`)

- **Input to the head:** trunk's 1,500-wide read-out, tanh(read(norm(features))). Same signal the LM head reads.
- **Projection:** linear to 576 (head ~8.5M params), plus a question-type embedding (choice / score / noul).
- **Head layers:** 2 pre-norm Transformer encoder layers (9 heads, 4x feed-forward).
- **Sequence:** `<bos>` state | question | options. Question and options share a 256-token budget. State gets the rest
  of 1,024.
- **Scoring:** each option scored at its last token by LayerNorm -> Linear -> GELU -> Linear -> one logit. Softmax
  over options.
- **Action head:** small head on `<bos>` plus four confidence features (top-1, margin over runner-up, entropy, option
  count).
- **RLCD loss:** proper scoring rules (spherical and ranked probability scores, log floor).
- **Calibration:** `On-Fly-Jev.pt` runs at temperature 1.0 (no fitted temperatures), and every number in this card uses it. It is well calibrated on typed decisions (ECE 0.045) but overconfident on the held-out benchmarks (mean ECE 0.197). `calibrated/On-Fly-Jev_calibrated.pt` has the same weights with temperatures fitted on 4,093 benchmark items kept apart from the eval: held-out mean ECE 0.085, typed ECE 0.245, accuracy unchanged. It is not a general fix: the 2-option buckets fit at the 5.0 ceiling because BoolQ / Hate / SST2 want T of 5 to 10 while IMDB wants about 1 (its ECE goes from 0.014 to 0.166). One temperature per bucket cannot serve both, so use the calibrated copy only for BoolQ / Hate / SST2-style inputs.

### Lesion test

Silence a group in the pretrained trunk (FlyNeuron-SNN-96M, final step 203,451). Held-out CE, baseline 2.84. Each group
vs a random lesion of the same number of units.

| Silenced | Units | CE | Beyond random lesion |
|---|---:|---:|---:|
| Glutamate copies | 405 | 10.16 | **+6.06** |
| GABA copies | 315 | 7.49 | **+3.24** |
| Acetylcholine copies | 540 | 4.91 | +0.66 |
| Octopamine copies | 30 | 3.42 | **+0.51** |
| Dopamine copies | 210 | 3.39 | +0.07 |
| Every neuron | 1,500 x 4 | 9.72 | = uniform guessing (ln 16,512) |

- **Inhibitory cell types carry the network.** Silence the 405 glutamate copies (CE 10.16) and it is *worse* than
  silencing every neuron.
- **The two octopamine neurons are the most critical single cells.** Silence all 15 copies of either one: 0.25 / 0.22
  nats (body IDs 10110 and 10041), against 0.03 for a random 15. 66 of the 100 fly neurons are worse to lose than a
  random set of the same size.
- **Dopamine cells barely matter for prediction.** Their job is learning, through reward and punishment.
- **Nothing reaches the output except through the fly cells.** Silence every neuron and you are exactly at chance.

Early in pretraining (step 35,500) the cell types mattered far less (glutamate +0.79, GABA +0.50 beyond random).
Training rewired the fly's synapses but kept its cell identities. The excitatory / inhibitory split from the real
transmitters became the backbone of the finished trunk.

## How it was made

### 1. The trunk: FlyNeuron-SNN-96M

- 4 spiking layers x 1,500 BioLIF neurons. Neuron i is a copy of fly neuron i mod 100. Keeps that neuron's transmitter,
  receptor timing, **Dale sign** (re-imposed after every optimiser step) and initial wiring.
- Spiking linear attention, Engram n-gram memory, JEPA auxiliary loss, and a PAM / PPL1 dopamine system driven by a
  judge model.
- Pretrained from scratch on **10.0B tokens** (DCLM, TxT360, IFM Math-Reasoning / Pretrain-Behaviors, FineMath),
  NorMuon + AdamW, 203,451 steps.

### 2. On-policy distillation (1,000 steps)

The student samples its own completions on ARC-Easy / ARC-Challenge / ArithMark prompts. Loss is
KL(teacher || student) over those tokens. Teacher: the **Byrne-Jev base** (70M SpikeWhale, same tokenizer). The
1,000-step checkpoint is the base of every FlyNeuron-Jev.

### 3. The decision head and the FlyNeuron-Jev lineage

Single-pass decision head (1,500-wide read-out projected to 576, 2 layers). RLCD loss on typed-decisions + 10 public
classification sources. Length-bucketed batches. Per-type / per-bucket temperature calibration. Trunk trains too
(NorMuon). Dale signs enforced every step. Each stage started from the best evaluated checkpoint of the one before:

| Stage | Data / teacher | Epochs, LR | Kept |
|---|---|---|---|
| Jev v0 | typed-decisions + 10 sources, fresh head | 4, 1e-4 | epoch 4 |
| + 5 epochs | same | 5, 1e-4 | epoch 3 |
| KD | Byrne-Jev decision model as teacher, KL(teacher || student) | 4 | epoch 4 |
| FT2 | plain fine-tune, no teacher, no IMDB | 5 | epoch 4 |
| Blend | labels blended 50/50 with Jev 1.13 labels | 3, 3e-5 | epoch 3 |
| Jev-teacher 2 | Jev 1.13 as stored teacher on the benchmarks, typed-decisions and ViZDoom games | - | epoch 2 |
| KD4 | Byrne-Jev teacher on Emotion / MNLI / MASSIVE / Yelp / SST-2 | 3, 3e-5 | epoch 1 |
| Everything (**old FlyNeuron-Jev**) | all data below except Open-Jev / GSM8K | 3, 3e-5 | epoch 1 |
| **New mix** (Modal, RTX PRO 6000) | the full data mix below, no Byrne teacher | 4 planned, 3e-5 | epoch 2 |

The new-mix run was stopped after epoch 3 (epochs 1-3 evaluated; epoch 2 merged best).

### 4. The data mix (train splits only)

- **typed-decisions** and 10 sources: AG News, Banking77, BoolQ, Emotion, Hate, IMDB, MASSIVE, MNLI, SST-2, Yelp.
- **Jev 1.13 labels** (OpenRouter decisions API) on those sources and typed-decisions, stored teacher distribution:
  about 7k Emotion, 7.6k MNLI, 1k each for the others, 6k typed-decisions.
- **Jev typed sets:** Emotion, MNLI, BoolQ and MASSIVE rewritten as typed questions, about 2.2k states each.
- **Jev game runs:** complete ViZDoom scenario runs (action, priority, danger, fire questions) and complete Minecraft
  runs (requirement, next-skill questions) played by Jev 1.13.
- **Open-Jev** (CC0 records): browser / drone / reasoning controls, Snake, tic-tac-toe, platformer, T-Rex, ViZDoom
  Basic, workflow controls, and citation / IR / mailroom / sponsor-segment / silent-failure / context-retention /
  entity-alignment controls.
- **GSM8K train** as 4-way "which final answer is correct" questions.

190,420 items in total. 117,012 of them with a stored teacher distribution.

### 5. The merge

On-Fly-Jev = 0.5 x old FlyNeuron-Jev + 0.5 x new-mix epoch 2. Plain average of every floating-point tensor.
This only works because epoch 2 was trained *from* the old model. An earlier average of two separately trained
FlyNeuron-Jevs (different decision heads) collapsed to 0.54 typed accuracy. Averaging two points of one run recovered
the old model's typed accuracy and BoolQ, kept epoch 2's gains on the held-out sources, MNLI and Banking77, and gave
the best calibration of any FlyNeuron-Jev (ECE 0.045).

## Usage

```python
from agent import DecisionAgent

agent = DecisionAgent("On-Fly-Jev.pt", code_dir=".", device="cuda")   # or device="cpu"
out = agent.predict(
    {"ticket": "My card was charged twice for the same order."},
    {"route": {"type": "choice", "instructions": "Which team should handle this?",
               "criteria": {"billing": None, "shipping": None, "technical": None}},
     "urgent": {"type": "noul", "instructions": "Is this urgent?"}},
)
print(out["answers"])
```

HTTP server (TypeSafe Jev `/v1/systemone` protocol): `JEV_MODEL=On-Fly-Jev.pt JEV_DEVICE=cuda python serve.py`.
Evaluation: `python eval_decisions.py --model On-Fly-Jev.pt --code-dir . --suite all --device cuda` (needs the
evaluation datasets).

## Files

| File | What |
|---|---|
| `On-Fly-Jev.pt` | the model (trunk + decision head + calibration, ~1.0 GB) |
| `agent.py`, `decision_core.py`, `fly_trunk.py`, `serve.py`, `eval_decisions.py`, `decision_data.py` | decision runtime |
| `model.py`, `config.py`, `biolif.py`, `fly100.py`, `spikeattn.py`, `engram.py`, `dopamine.py`, `upstream_lif.py`, `normuon.py` | FlyNeuron-SNN code |
| `fly100.pt`, `fly100.json` | the 100 MaleCNS neurons: signed synapse matrix, body IDs, transmitters, roles |
| `tokenizer.json`, `spike_tokenizer.py` | tokenizer (16,512 tokens) |
| `eval/` | full evaluation reports for On-Fly-Jev and both merge parents |
| `logo.png` | card logo |
| `videos/` | the 6 ViZDoom episodes on the card |
| `doom_runs/` | per-decision logs and `.lmp` demos of those episodes |

## Limitations

- Research artifact. Typed accuracy is below Jev 1.13 (0.666 vs 0.727). MNLI (0.395) and Yelp (0.425) are weak.
- Decision model, not a chat model. It scores options. It does not generate text.
- Game results are 3 episodes per scenario. Expect variance.
- Individual predictions can be confidently wrong on short, simple inputs.

## Citation

If you use this model, the code, or the write-up, please cite **Dean Byrne (Quazim0t0)**.

```bibtex
@misc{byrne2026onflyjev,
  title        = {On-Fly-Jev: a typed-decision model on a 96M fly-neuron spiking LM},
  author       = {Byrne, Dean},
  year         = {2026},
  howpublished = {Hugging Face},
  url          = {https://huggingface.co/Quazim0t0/On-Fly-Jev},
  note         = {Quazim0t0 / Dean Byrne}
}
```


<a href="https://hfviewer.com/Quazim0t0/On-Fly-Jev?utm_source=huggingface&amp;utm_medium=embedded_model_card&amp;utm_campaign=Quazim0t0__On-Fly-Jev_card&amp;utm_content=embedded_card_open_viewer&amp;from=embedded-model-card" target="_blank" rel="noopener">
  <img
    src="https://hfviewer.com/api/card.svg?source=Quazim0t0%2FOn-Fly-Jev&amp;granularity=auto&amp;v=20260516-title-pills-card"
    alt="Architecture graph for Quazim0t0/On-Fly-Jev. Open in hfviewer"
    width="100%"
  />
</a>