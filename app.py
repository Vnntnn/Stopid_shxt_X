"""Local Web UI and typed decision API backed by the real On-Fly-Jev checkpoint."""
import asyncio
from contextlib import asynccontextmanager
import json
import logging
import os
from pathlib import Path
import sys
import threading
import time
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "vendor" / "onfly"
sys.path.insert(0, str(MODEL_DIR))
import envload
envload.load_env(ROOT / ".env")
import ask_pipeline
import llm as llm_layer
import project_store
import scrapers
import stt
log = logging.getLogger("onfly")


class Runtime:
    def __init__(self):
        self.agent = None
        self.status = "loading"
        self.error = None
        self.lock = threading.Lock()
        self.load_seconds = None
        self.snapshot = {}

    def load(self):
        try:
            import torch
            from agent import DecisionAgent
            from scripts.download_model import HASHES, sha256
            start = time.perf_counter()
            for name, expected in HASHES.items():
                if sha256(MODEL_DIR / name) != expected:
                    raise RuntimeError(f"Checkpoint checksum mismatch: {name}")
            self.snapshot = json.loads((MODEL_DIR / "snapshot.json").read_text())
            torch.set_num_threads(int(os.environ.get("ONFLY_THREADS", "4")))
            torch.set_num_interop_threads(1)
            device = os.environ.get("ONFLY_DEVICE", "cpu")
            agent = DecisionAgent(str(MODEL_DIR / "On-Fly-Jev.pt"), code_dir=str(MODEL_DIR), device=device)
            self.agent = agent
            self.load_seconds = round(time.perf_counter() - start, 2)
            self.status = "ready"
            log.warning("On-Fly-Jev ready on %s in %.2fs", device, self.load_seconds)
        except Exception as exc:
            self.error = str(exc)
            self.status = "error"
            log.exception("Model load failed")

    def health(self):
        return {"status": self.status, "error": self.error, "model": "On-Fly-Jev",
                "device": str(self.agent.device) if self.agent else None,
                "load_seconds": self.load_seconds, "mock": False,
                "revision": self.snapshot.get("revision"),
                "checkpoint_sha256": self.snapshot.get("sha256", {}).get("On-Fly-Jev.pt"),
                "max_tokens": self.agent.max_len if self.agent else 1024}

    def predict(self, payload):
        if self.status != "ready":
            raise HTTPException(503, self.error or "Model is loading. Please try again shortly.")
        if not isinstance(payload, dict):
            raise HTTPException(422, "Send a JSON object containing state and questions.")
        state, questions = payload.get("state"), payload.get("questions")
        if not isinstance(state, (str, dict, list)) or not state:
            raise HTTPException(422, "State must be non-empty text or JSON.")
        if isinstance(state, str) and not state.strip():
            raise HTTPException(422, "State must not be blank.")
        if not isinstance(questions, dict) or not 1 <= len(questions) <= 8:
            raise HTTPException(422, "Provide 1 to 8 questions.")
        if not self.lock.acquire(blocking=False):
            raise HTTPException(503, "Another inference is running. Please wait and try again.")
        try:
            from decision_core import (OPT_MAX_TOKENS, check_question, encode,
                                       render_options, to_internal, tokenize_question, tokenize_state)
            state_ids = tokenize_state(self.agent.tok, state)
            # Refuse silent truncation: the entire submitted state, instruction,
            # and every option must fit the author's context budgets.
            for qid, definition in questions.items():
                check_question(qid, definition)
                if not isinstance(definition.get("instructions"), str) or not definition["instructions"].strip():
                    raise ValueError(f"{qid}: instructions must be non-empty text")
                q = to_internal(definition)
                opts = render_options(q)
                if not 2 <= len(opts) <= 8:
                    raise ValueError(f"{qid}: use 2 to 8 options or score levels")
                for option in opts:
                    if len(encode(self.agent.tok, "\n- " + option)) > OPT_MAX_TOKENS:
                        raise ValueError(f"{qid}: an option exceeds {OPT_MAX_TOKENS} tokens; put its full description in State and use a short option name")
                qt = tokenize_question(self.agent.tok, q)
                head_tokens = len(qt["head"]) + sum(map(len, qt["opts"]))
                if head_tokens > self.agent.head_max_len:
                    raise ValueError(f"{qid}: question and options exceed {self.agent.head_max_len} tokens")
                if len(state_ids) + head_tokens + 1 > self.agent.max_len:
                    raise ValueError(f"{qid}: input exceeds {self.agent.max_len} tokens; shorten the State (Thai often uses more tokens)")
            start = time.perf_counter()
            result = self.agent.predict(state, questions)
            result["runtime"] = {**self.health(), "inference_ms": round((time.perf_counter() - start) * 1000, 1),
                                 "engine": "pytorch", "external_model_api": False,
                                 "input_truncated": False}
            return result
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, str(exc)) from exc
        finally:
            self.lock.release()


runtime = Runtime()

@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=runtime.load, daemon=True).start()
    yield

app = FastAPI(title="On-Fly-Jev Local Lab", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"])
app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")
project_store.init_db()


def _json_object(value, message="ส่งข้อมูลเป็น JSON object"):
    if not isinstance(value, dict):
        raise HTTPException(422, message)
    return value


async def _request_json(request: Request):
    body = await request.body()
    if len(body) > 16 * 1024 * 1024:
        raise HTTPException(413, "Request too large.")
    try:
        return _json_object(json.loads(body))
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(422, "ส่งข้อมูลเป็น JSON ที่ถูกต้อง") from exc


def _check_same_origin(request: Request):
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).netloc != request.headers.get("host"):
        raise HTTPException(403, "Cross-origin project changes are not allowed.")


def _project_or_404(project_id):
    project = project_store.get_project(project_id)
    if not project:
        raise HTTPException(404, "ไม่พบโปรเจกต์นี้")
    return project

@app.get("/")
def index():
    return FileResponse(ROOT / "web" / "index.html")

@app.get("/api/health")
def health():
    return runtime.health()


@app.get("/api/projects")
def projects():
    return {"projects": project_store.list_projects()}


@app.post("/api/projects")
async def create_project(request: Request):
    _check_same_origin(request)
    payload = await _request_json(request)
    name = str(payload.get("name", "")).strip()
    election = str(payload.get("election", "")).strip()
    year = str(payload.get("year", "")).strip()
    location = str(payload.get("location", "")).strip()
    if not name or not election:
        raise HTTPException(422, "กรุณาระบุชื่อโปรเจกต์และการเลือกตั้ง")
    if len(name) > 120 or len(election) > 160 or len(year) > 20 or len(location) > 120:
        raise HTTPException(422, "ข้อความมีความยาวเกินกำหนด")
    return {"project": project_store.create_project(name, election, year, location)}


@app.get("/api/projects/{project_id}")
def project_detail(project_id: int):
    return {"project": _project_or_404(project_id)}


@app.get("/api/projects/{project_id}/policies")
def project_policies(project_id: int):
    _project_or_404(project_id)
    return {"policies": project_store.list_policies(project_id)}


@app.get("/api/projects/{project_id}/summary")
def project_summary(project_id: int):
    result = project_store.summary(project_id)
    if result is None:
        raise HTTPException(404, "ไม่พบโปรเจกต์นี้")
    return result


@app.post("/api/data/preview")
async def preview_data(request: Request):
    _check_same_origin(request)
    payload = await _request_json(request)
    template = str(payload.get("template", ""))
    url = str(payload.get("url", "")).strip()
    if len(url) > 2048:
        raise HTTPException(422, "URL ยาวเกินกำหนด")
    try:
        result = await asyncio.to_thread(scrapers.scrape, template, url)
        result["count"] = len(result["policies"])
        return result
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/projects/{project_id}/policies")
async def save_project_policies(project_id: int, request: Request):
    _check_same_origin(request)
    _project_or_404(project_id)
    payload = await _request_json(request)
    policies = payload.get("policies")
    if not isinstance(policies, list) or not 1 <= len(policies) <= 1000:
        raise HTTPException(422, "ส่งรายการนโยบาย 1 ถึง 1,000 รายการ")
    clean = []
    for index, item in enumerate(policies, start=1):
        if not isinstance(item, dict):
            raise HTTPException(422, f"รายการที่ {index} ไม่ใช่ object")
        title = str(item.get("title", "")).strip()
        if not title or len(title) > 500:
            raise HTTPException(422, f"รายการที่ {index} ไม่มีชื่อนโยบาย หรือชื่อยาวเกินกำหนด")
        content = str(item.get("content", ""))
        if len(content) > 50000:
            raise HTTPException(422, f"เนื้อหารายการที่ {index} ยาวเกินกำหนด")
        clean.append({
            "title": title, "content": content, "party": str(item.get("party", ""))[:200],
            "candidate": str(item.get("candidate", ""))[:200], "category": str(item.get("category", ""))[:300],
            "source_kind": str(item.get("source_kind", ""))[:80], "source_url": str(item.get("source_url", ""))[:2048],
            "source_label": str(item.get("source_label", ""))[:300],
            "source_meta": item.get("source_meta") if isinstance(item.get("source_meta"), dict) else {},
        })
    ids = project_store.save_policies(project_id, clean)
    return {"saved": len(ids or []), "ids": ids or []}


def _model_excerpt(text, limit=240):
    text = " ".join((text or "").split())
    excerpt = text[:limit]
    if len(text) > limit:
        excerpt = excerpt.rsplit(" ", 1)[0] if " " in excerpt else excerpt
    return excerpt, len(text) > len(excerpt)


def _fit_project_request(model_request, contents, agent):
    """Reduce both policy excerpts equally using this checkpoint's tokenizer."""
    from decision_core import to_internal, tokenize_question, tokenize_state
    if agent is None:
        raise HTTPException(503, "โมเดลยังไม่พร้อม กรุณาลองอีกครั้ง")
    question = tokenize_question(agent.tok, to_internal(model_request["questions"]["vote"]))
    head_tokens = len(question["head"]) + sum(map(len, question["opts"]))
    if head_tokens > agent.head_max_len:
        raise HTTPException(422, "เกณฑ์เปรียบเทียบยาวเกิน context ของโมเดล กรุณาย่อเกณฑ์")
    for limit in range(240, 0, -16):
        cuts = {}
        for side, content in zip(("A", "B"), contents):
            excerpt, cuts[side] = _model_excerpt(content, limit)
            model_request["state"][f"policy_{side}"]["source_excerpt"] = excerpt
        if len(tokenize_state(agent.tok, model_request["state"])) + head_tokens + 1 <= agent.max_len:
            return model_request, cuts
    raise HTTPException(422, "ข้อมูลประกอบยาวเกิน context ของโมเดล กรุณาย่อสถานการณ์หรือชื่อโปรเจกต์/นโยบาย")


@app.post("/api/projects/{project_id}/compare")
async def compare_project_policies(project_id: int, request: Request):
    _check_same_origin(request)
    project = _project_or_404(project_id)
    payload = await _request_json(request)
    try:
        policy_a_id = int(payload.get("policy_a_id"))
        policy_b_id = int(payload.get("policy_b_id"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, "เลือกนโยบาย A และ B ก่อนรัน") from exc
    if policy_a_id == policy_b_id:
        raise HTTPException(422, "เลือกนโยบายสองรายการที่แตกต่างกัน")
    policy_a = project_store.get_policy(project_id, policy_a_id)
    policy_b = project_store.get_policy(project_id, policy_b_id)
    if not policy_a or not policy_b:
        raise HTTPException(404, "ไม่พบนโยบายที่เลือกในโปรเจกต์นี้")
    party_a = " ".join(policy_a["party"].split()).lower()
    party_b = " ".join(policy_b["party"].split()).lower()
    if not party_a or not party_b or any(p["source_kind"] == "bma_tracker" for p in (policy_a, policy_b)):
        raise HTTPException(422, "เลือกนโยบายหาเสียงที่ระบุพรรคทั้งสองฝั่ง ข้อมูลตัวติดตาม กทม. ใช้ดูประกอบในชุดข้อมูลได้")
    if party_a == party_b:
        raise HTTPException(422, "เลือกนโยบายจากสองพรรคที่แตกต่างกัน")
    criterion = str(payload.get("criterion", "")).strip()
    situation = str(payload.get("situation", "")).strip()
    if not criterion or len(criterion) > 600 or len(situation) > 600:
        raise HTTPException(422, "กรุณาระบุเกณฑ์ไม่เกิน 600 ตัวอักษร")
    state = {
        "election": f"{project['election']} {project['year']} {project['location']}".strip(),
        "situation": situation or f"เปรียบเทียบนโยบายในการเลือกตั้ง {project['election']}",
        "policy_A": {"title": policy_a["title"], "party": policy_a["party"], "category": policy_a["category"], "source_excerpt": ""},
        "policy_B": {"title": policy_b["title"], "party": policy_b["party"], "category": policy_b["category"], "source_excerpt": ""},
    }
    model_request = {"state": state, "questions": {"vote": {
        "type": "choice", "instructions": criterion, "criteria": {"A": None, "B": None}}}}
    model_request, cuts = _fit_project_request(model_request,
        (policy_a["content"] or policy_a["title"], policy_b["content"] or policy_b["title"]), runtime.agent)
    response = await asyncio.to_thread(runtime.predict, model_request)
    answer = response.get("answers", {}).get("vote", {})
    choice = answer.get("choice")
    winner_id = policy_a_id if choice == "A" else policy_b_id if choice == "B" else None
    record = {"request": model_request, "response": response,
              "excerpted": cuts, "at": project_store.now()}
    comparison_id = project_store.save_comparison(project_id, policy_a_id, policy_b_id, criterion,
                                                  situation, winner_id, record)
    return {"comparison_id": comparison_id, "winner_id": winner_id, "choice": choice,
            "probabilities": answer.get("probabilities", {}), "excerpted": record["excerpted"],
            "runtime": response.get("runtime", {}), "response": response}

@app.post("/v1/systemone")
@app.post("/api/decide")
async def decide(request: Request):
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).netloc != request.headers.get("host"):
        raise HTTPException(403, "Cross-origin inference is not allowed.")
    body = await request.body()
    if len(body) > 64000:
        raise HTTPException(413, "Request too large.")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(422, "Invalid JSON.") from exc
    return await asyncio.to_thread(runtime.predict, payload)


@app.get("/fly")
def fly_page():
    page = ROOT / "web" / "fly.html"
    if not page.is_file():
        raise HTTPException(404, "The Fly page (web/fly.html) has not been built yet.")
    return FileResponse(page)


@app.get("/api/ask/health")
def ask_health():
    llm = llm_layer.LLM()
    return {"gemini": llm.configured["gemini"], "openrouter": llm.configured["openrouter"],
            "fake": llm.configured["fake"], "stt": bool((os.environ.get("PAXA_API_KEY") or "").strip()),
            "model_ready": runtime.status == "ready", "cache_entries": ask_pipeline.AskCache().size()}


@app.post("/api/ask")
async def ask(request: Request):
    _check_same_origin(request)
    body = await request.body()
    if len(body) > 8192:
        raise HTTPException(413, "Request too large.")
    try:
        payload = _json_object(json.loads(body))
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(422, "Send a JSON object with a text field.") from exc
    text = payload.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 500:
        raise HTTPException(422, "text must be 1 to 500 characters.")
    replay = payload.get("replay", False)
    if not isinstance(replay, bool):
        raise HTTPException(422, "replay must be true or false.")

    async def stream():
        try:
            async for event in ask_pipeline.run_ask(text.strip(), runtime=runtime, llm=llm_layer.LLM(), replay=replay):
                yield (json.dumps(event, ensure_ascii=False) + "\n").encode()
        except Exception:
            log.exception("Ask stream failed")
            yield (json.dumps(ask_pipeline._final_error("internal_error", "Unexpected error."), ensure_ascii=False) + "\n").encode()

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.post("/api/stt")
async def speech_to_text(request: Request):
    _check_same_origin(request)
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > stt.MAX_AUDIO_BYTES + 65536:
        return JSONResponse({"error": "audio_too_large", "message": "Audio must be 10 MB or smaller."}, status_code=413)
    if not (os.environ.get("PAXA_API_KEY") or "").strip():
        return JSONResponse({"error": "stt_not_configured"}, status_code=503)
    try:
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > stt.MAX_AUDIO_BYTES + 65536:
                raise stt.STTError(413, "audio_too_large", "Audio must be 10 MB or smaller.")
        fields = stt.parse_multipart(request.headers.get("content-type"), bytes(body))
        if "audio" not in fields:
            raise stt.STTError(422, "audio_missing", "Send the recording in the 'audio' field.")
        filename, content_type, audio = fields["audio"]
        language = fields["language"][2].decode("utf-8", "replace").strip() if "language" in fields else "th"
        return await stt.transcribe(audio, filename or "audio.webm", content_type, language or "th")
    except stt.STTError as exc:
        return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.status)
