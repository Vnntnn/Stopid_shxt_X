# Fly Decision Lab

Local Web UI running the actual [On-Fly-Jev checkpoint](https://huggingface.co/Quazim0t0/On-Fly-Jev) by Dean Byrne / Quazim0t0. This is a trained, fly-inspired typed decision model; it is not a full fly-brain simulation. The earlier HTML mocks remain separate from this app.

## Run

Already installed on this machine:

```sh
./run.sh
```

Open **http://127.0.0.1:8765**. The model loads once at startup; the UI shows readiness. Stop with Ctrl+C. To use another port: `PORT=8766 ./run.sh`. Default inference uses CPU and four PyTorch threads. `ONFLY_THREADS=2 ./run.sh` changes the thread count.

The Fly Ask page is served at `/`; old `/fly` links redirect to `/` with their query parameters preserved. Use `/?mock=1` to preview with mock responses. `./run-fly.sh` starts the same page on port 8766. The earlier decision and election-project UI described below remains available at `/static/index.html`.

Fly Ask supports choices across topics: give two alternatives and a goal or constraint, such as “walk or drive to a nearby shop while minimizing fuel cost.” DeepSeek interprets the question into `options` A/B, a criterion, and short facts; the local Jev model makes the choice using two swapped runs. Open-ended questions generate two suggested alternatives, and comparisons with more than two alternatives explicitly identify the pair being compared. The third result is “No clear choice” when neither option is supported. Old political-prompt cache entries are ignored. Open `/` without `?mock` for actual questions; mock mode shows a labeled, fixed tea/coffee example.

Each option has an English `name` for Jev and a `label` in the question's language for display. Thai questions show Thai labels on the landing flowers, result bars, answer and speech, while preserving option IDs and probabilities. Both names are produced in the same DeepSeek call. Cache version 3 ignores older results without localized labels.

The camera features from `fly-ask-pipeline` are integrated into main's Thai theme and textured Housefly: local MediaPipe pose/hand tracking, attention following, “ทำท่าตามฉัน” (Copy me), gesture actions and meme overlays. Prepare the pinned browser runtime and models once with `sh scripts/fetch_camera_assets.sh`, then open `/` and press “เปิดกล้อง”. Camera access starts only on that button; frames stay in the browser. Enable “ทำท่าตามฉัน” to animate the Housefly's head, wings and front legs. Pose control pauses while the fly answers and resumes after landing. `/?cam=mock` previews scripted camera poses without a webcam; add `&mock=1` only if you also want example answers. Downloaded camera models are ignored by Git, so run the fetch script on each new development/deployment machine.

The 3D character uses [Housefly by Schmoldt5000 / schmoldt.art](https://sketchfab.com/3d-models/housefly-5fe7cbd25f9a446d8bae005893d010dd), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The local `web/models/housefly/` asset includes the original body, hair, and wing textures (about 6.8 MB total). Its display pedestal is removed, and authored pivots animate wings, six legs, and head with the app's listening, thinking, and landing states. Attribution is visible on the page; source credits, license, and checksums live beside the model. To rebuild from the downloaded glTF folder: `.venv/bin/python scripts/import_housefly.py /path/to/housefly`. The page keeps a procedural fly as a loading/error fallback.

For a fresh checkout, use Python 3.11 or newer:

```sh
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/download_model.py
./run.sh
```

The downloader fetches a pinned snapshot (approximately 1 GB of weights). It verifies SHA-256 hashes for both tensor files. Downloads are atomic. Only `torch.load(..., weights_only=True)` differs from the upstream runtime; model weights and inference calculations are unchanged. Startup checks both hashes again. The environment and model weights are ignored by Git.

## Use

- **นโยบาย A / B:** edit the fly's situation, selection criterion, names, and policies. The entire policy text goes into the model's state; the answer choices are short IDs A/B.
- **เลือกคำตอบทั่วไป:** text state, a question, and 2–8 distinct answer options.
- **JSON API:** edit `state` and typed `questions`; supports `choice`, `score`, and `noul`.
- **ลองสลับลำดับตัวเลือกด้วย:** two real calls to the same model, with the choice order reversed. It does not simulate two flies.
- Results include option probabilities, inference time, input tokens, and the original request/response. Download them as JSON.

## Election projects

Create one project per election, then open the **เปรียบเทียบ** tab to choose parties and policies in two side-by-side cards. Selecting a supported official party downloads and saves its policies directly in that project; the card shows loading, errors, and retry without opening the data-import screen. Each side has a search field, policy text, and source link. Empty projects also offer a direct two-party mock example. Templates, import previews, and the complete policy list live in the **ชุดข้อมูล** tab; prior model decisions live in **หน้าสรุป**.

Comparing requires campaign data from at least two parties in that election; the API also rejects same-party pairs and tracker records. The source choices keep Bangkok campaign pages separate from national-election pages. Mock data contains two fictional parties with five policy topics each. Custom campaign URLs can be assigned a party name when the source parser cannot identify one. Project, policy, and comparison records are stored in `.runtime/projects.sqlite3` (override with `ONFLY_PROJECT_DB`).

Available templates:

- **Mock data:** ten Thai-language example policies.
- **Thai election policy:** official People’s Party and Pheu Thai campaign policies, Bhumjaithai policy records embedded in its official page, and Democrat Party policy posts from its public WordPress API. Another public URL can be entered.
- **Bangkok policy tracker:** imports the Bangkok Metropolitan Administration’s tracker table. This is explicitly labeled as policy/action-plan tracking data, separate from candidates’ campaign promises.
- **Bangkok candidate policy:** imports People’s Party Bangkok campaign summaries and Democrat Party Bangkok policy posts, or another public candidate URL. National and Bangkok records remain separate in the comparison selectors.

Imported rows retain their source URL and source label. The data tab's importer shows a preview before writing records; the summary groups them by category and source and lists prior model comparisons. When a long policy is compared, the model receives at most its first 240 characters, reducing both excerpts equally until the checkpoint's tokenizer confirms the complete request fits its 1,024-token context limit; the full imported text remains saved and visible in the dataset.

Project API: `GET/POST /api/projects`, `GET /api/projects/{id}/policies`, `POST /api/data/preview`, `POST /api/projects/{id}/policies`, `POST /api/projects/{id}/compare`, and `GET /api/projects/{id}/summary`.

Requests run directly through upstream `DecisionAgent.predict`. There is no translation, handcrafted policy score, Claude call, or hosted Jev call. The UI uses Google Fonts; input text is sent only to the local inference server. Network access is needed to install packages and download the model, but inference works offline.

The model's 1,024-token context and 256-token question/options budget are preserved. This app rejects inputs that would be silently truncated, including options over the author's 48-token limit. Put long option descriptions into the state. Thai commonly consumes more tokens.

Probabilities describe the model's choice distribution, not real voter proportions, political quality, or correctness. Both input language and option ordering can affect results. A first run on this M3 selected A for the English food-policy example and B for the corresponding Thai example; these are observations, not a language benchmark.

## API and verification

`GET /api/health` reports model status, device, pinned revision, and verified checkpoint hash. `POST /api/decide` and `POST /v1/systemone` accept the same request:

```json
{
  "state": "My card was charged twice for one order.",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {"billing": null, "shipping": null, "technical": null}
    }
  }
}
```

Run integration checks while the server is running:

```sh
.venv/bin/python tests/smoke.py
```

Run the local project/importer unit tests with:

```sh
.venv/bin/python -m unittest tests.test_project_data
```

Checks exercise the real checkpoint with English/Thai inputs, reversed option order, all three typed heads, invalid requests, context-limit rejection, and cross-origin rejection. They record actual outputs in `.runtime/smoke-evidence.json` and do not assert that the model is semantically correct. The server binds to localhost, rejects foreign origins, and serializes inference.

Browser QA on this machine also verified all three UI modes, two-call comparison, JSON export, blank-input validation, no JavaScript errors, and a 390px mobile layout without horizontal overflow.

## Model provenance

- Upstream: `Quazim0t0/On-Fly-Jev`, Apache-2.0, Dean Byrne / Quazim0t0.
- Revision: `e11d5a2a328b34aab7956ae4891b6b34b98425b5`.
- Checkpoint SHA-256: `9e83bb449d9d4e98b8e035c8d518b0a9d6302413532bebcb5ce10982a1a43e2b`.
- Attribution, architecture, training history, and limitations: [upstream model card](vendor/onfly/README.md).
- Snapshot and local loader patch: [snapshot.json](vendor/onfly/snapshot.json).
