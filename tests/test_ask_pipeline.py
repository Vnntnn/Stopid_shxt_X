"""Tests for the Fly Ask backend: env loader, LLM layer, STT proxy, pipeline, cache and routes.
No real API keys or model are needed: providers use httpx.MockTransport and Jev is a scripted fake."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "onfly"))
import app as app_module
import ask_pipeline
import envload
import llm as llm_layer
import stt

DEMO = "ระหว่างพรรคของคุณพิธากับพรรคของเสี่ยหนู ใครจะชนะ?"


class FakeTok:
    """One token per whitespace-separated word (enough to exercise the limits)."""
    bos_token_id = 0

    def encode(self, text, add_special_tokens=False):
        return list(range(len(text.split())))


class FakeAgent:
    def __init__(self, max_len=400, head_max_len=120):
        self.tok, self.max_len, self.head_max_len = FakeTok(), max_len, head_max_len


class FakeRuntime:
    """Scripted stand-in for app.Runtime. `prefer` = ("key", "A") | ("text", "People's Party ahead") | ("probs", {...})."""

    def __init__(self, prefer=("text", "People's Party ahead"), top=0.7, agent=None, status="ready", bad_choice=None):
        self.agent, self.status, self.error = agent or FakeAgent(), status, None
        self.prefer, self.top, self.bad_choice, self.payloads = prefer, top, bad_choice, []

    def predict(self, payload):
        self.payloads.append(payload)
        criteria = payload["questions"]["vote"]["criteria"]
        kind, value = self.prefer
        if kind == "key":
            chosen = value
        else:
            chosen = next(k for k, text in criteria.items() if value in text)
        rest = (1 - self.top) / 2
        probs = {k: (self.top if k == chosen else rest) for k in criteria}
        return {"answers": {"vote": {"choice": self.bad_choice or chosen, "probabilities": probs}},
                "runtime": {"inference_ms": 10.0}}


def collect(text=DEMO, runtime=None, llm=None, cache=None, replay=False):
    async def go():
        return [e async for e in ask_pipeline.run_ask(text, runtime=runtime or FakeRuntime(),
                                                       llm=llm or llm_layer.LLM({"LLM_PROVIDER": "fake"}),
                                                       replay=replay, cache=cache)]
    return asyncio.run(go())


class TmpCacheCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = ask_pipeline.AskCache(Path(self.tmp.name) / "ask_cache.json")

    def tearDown(self):
        self.tmp.cleanup()


class EnvLoaderTests(unittest.TestCase):
    def test_parses_quotes_comments_and_never_overrides(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("# comment\nFLY_T1=plain # trailing\nFLY_T2=\"quoted # kept\"\nexport FLY_T3='single'\n"
                            "FLY_T4=\nbad line\nFLY_T5=already\n")
            with patch.dict("os.environ", {"FLY_T5": "set-before"}, clear=False):
                keys = envload.load_env(path)
                import os
                self.assertEqual([os.environ[k] for k in ("FLY_T1", "FLY_T2", "FLY_T3", "FLY_T4", "FLY_T5")],
                                 ["plain", "quoted # kept", "single", "", "set-before"])
                self.assertNotIn("FLY_T5", keys)
                for k in ("FLY_T1", "FLY_T2", "FLY_T3", "FLY_T4"):
                    os.environ.pop(k, None)

    def test_missing_file_is_fine(self):
        self.assertEqual(envload.load_env(Path("/nonexistent/.env")), [])


def gemini_json(obj):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps(obj)}]}}]}


VALID_INTERP = {"language": "en", "intent": "compare", "time_scope": "now", "question_en": "Who leads?", "echo": "I understood: x",
                "parties": [{"id": "A", "name": "One", "aliases": []}, {"id": "B", "name": "Two", "aliases": []}]}


class LLMTests(unittest.IsolatedAsyncioTestCase):
    async def test_gemini_json_request_shape_and_no_tools(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json=gemini_json({"ok": 1}))
        llm = llm_layer.LLM({"GEMINI_API_KEY": "k-test", "GEMINI_MODEL": "m-test"}, httpx.MockTransport(handler))
        self.assertEqual(await llm.json("x", "sys", "usr"), {"ok": 1})
        request, body = seen[0], json.loads(seen[0].content)
        self.assertTrue(str(request.url).endswith("/models/m-test:generateContent"))
        self.assertEqual(request.headers["x-goog-api-key"], "k-test")
        self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")
        self.assertNotIn("tools", body)

    async def test_gemini_research_uses_search_tool_not_json_mode(self):
        seen = []

        def handler(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "notes"}]}, "groundingMetadata": {
                "groundingChunks": [{"web": {"uri": "https://a.example/1", "title": "A"}},
                                    {"web": {"uri": "https://a.example/1", "title": "dup"}}, {"web": {"uri": "https://b.example", "title": "B"}}]}}]})
        llm = llm_layer.LLM({"GEMINI_API_KEY": "k"}, httpx.MockTransport(handler))
        result = await llm.research("s", "u")
        self.assertEqual(seen[0]["tools"], [{"google_search": {}}])
        self.assertNotIn("generationConfig", seen[0])
        self.assertEqual(result["text"], "notes")
        self.assertEqual([s["url"] for s in result["sources"]], ["https://a.example/1", "https://b.example"])

    async def test_openrouter_json_and_online_research_with_citations(self):
        seen = []

        def handler(request):
            body = json.loads(request.content)
            seen.append((request, body))
            if "response_format" in body:
                return httpx.Response(200, json={"choices": [{"message": {"content": "{\"a\": 1}"}}]})
            return httpx.Response(200, json={"choices": [{"message": {"content": "notes", "annotations": [
                {"type": "url_citation", "url_citation": {"url": "https://c.example", "title": "C", "content": "snip"}}]}}]})
        llm = llm_layer.LLM({"LLM_PROVIDER": "openrouter", "OPENROUTER_API_KEY": "or-k", "OPENROUTER_MODEL": "vendor/model:online"},
                            httpx.MockTransport(handler))
        self.assertEqual(await llm.json("t", "s", "u"), {"a": 1})
        research = await llm.research("s", "u")
        self.assertEqual(seen[0][1]["model"], "vendor/model")  # no web search for the JSON stages
        self.assertEqual(seen[0][1]["response_format"], {"type": "json_object"})
        self.assertEqual(seen[0][0].headers["authorization"], "Bearer or-k")
        self.assertEqual(seen[1][1]["model"], "vendor/model:online")
        self.assertEqual(research["sources"], [{"title": "C", "url": "https://c.example", "snippet": "snip"}])

    async def test_retry_once_on_429_then_success(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(429) if len(calls) == 1 else httpx.Response(200, json=gemini_json({"ok": True}))
        llm = llm_layer.LLM({"GEMINI_API_KEY": "k"}, httpx.MockTransport(handler))
        llm.chain[0].backoff = 0
        self.assertEqual(await llm.json("t", "s", "u"), {"ok": True})
        self.assertEqual(len(calls), 2)

    async def test_fallback_to_other_provider_on_http_error(self):
        hosts = []

        def handler(request):
            hosts.append(request.url.host)
            if request.url.host == "generativelanguage.googleapis.com":
                return httpx.Response(500)
            return httpx.Response(200, json={"choices": [{"message": {"content": "{\"from\": \"or\"}"}}]})
        llm = llm_layer.LLM({"GEMINI_API_KEY": "g", "OPENROUTER_API_KEY": "o"}, httpx.MockTransport(handler))
        for client in llm.chain:
            client.backoff = 0
        self.assertEqual(await llm.json("t", "s", "u"), {"from": "or"})
        self.assertEqual(llm.used, "openrouter")
        self.assertEqual(hosts.count("generativelanguage.googleapis.com"), 2)  # one retry, then fallback

    async def test_no_fallback_without_other_key_and_error_is_mapped(self):
        llm = llm_layer.LLM({"GEMINI_API_KEY": "g"}, httpx.MockTransport(lambda r: httpx.Response(401)))
        with self.assertRaises(llm_layer.LLMError) as ctx:
            await llm.json("t", "s", "u")
        self.assertEqual(ctx.exception.code, "http_401")
        with self.assertRaises(llm_layer.LLMError) as ctx:
            await llm_layer.LLM({}).json("t", "s", "u")
        self.assertEqual(ctx.exception.code, "not_configured")

    async def test_fake_client_is_labelled_and_deterministic(self):
        llm = llm_layer.LLM({"LLM_PROVIDER": "fake"})
        research = await llm.research("s", "u")
        self.assertEqual(len(research["sources"]), 3)
        self.assertTrue(all("FAKE-DEMO" in s["title"] and "FAKE-DEMO" in s["snippet"] for s in research["sources"]))
        interp = await llm.json("interpret", "s", "u", context={"text": DEMO})
        self.assertEqual([p["name"] for p in interp["parties"]], ["People's Party", "Bhumjaithai"])
        self.assertEqual(interp, await llm.json("interpret", "s", "u", context={"text": DEMO}))


class RepairTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_json_is_repaired_once_with_the_error_in_the_prompt(self):
        prompts = []
        bad = dict(VALID_INTERP, parties=VALID_INTERP["parties"] + [{"id": "C", "name": "Three", "aliases": []}])

        def handler(request):
            prompts.append(json.loads(request.content)["contents"][0]["parts"][0]["text"])
            return httpx.Response(200, json=gemini_json(bad if len(prompts) == 1 else VALID_INTERP))
        llm = llm_layer.LLM({"GEMINI_API_KEY": "k"}, httpx.MockTransport(handler))
        result = await ask_pipeline.llm_json(llm, "interpret", "s", "u", ask_pipeline.validate_interpretation, {})
        self.assertEqual(len(prompts), 2)
        self.assertIn("exactly 2 parties", prompts[1])
        self.assertEqual(result["parties"][1]["name"], "Two")

    async def test_second_failure_is_a_clean_stage_error(self):
        llm = llm_layer.LLM({"GEMINI_API_KEY": "k"}, httpx.MockTransport(
            lambda r: httpx.Response(200, json=gemini_json({"language": "en"}))))
        with self.assertRaises(ask_pipeline.StageError) as ctx:
            await ask_pipeline.llm_json(llm, "interpret", "s", "u", ask_pipeline.validate_interpretation, {})
        self.assertEqual(ctx.exception.code, "invalid_llm_output")

    async def test_non_json_text_is_repaired_too(self):
        texts = iter(["not json at all", json.dumps(VALID_INTERP)])
        llm = llm_layer.LLM({"GEMINI_API_KEY": "k"}, httpx.MockTransport(lambda r: httpx.Response(
            200, json={"candidates": [{"content": {"parts": [{"text": next(texts)}]}}]})))
        result = await ask_pipeline.llm_json(llm, "interpret", "s", "u", ask_pipeline.validate_interpretation, {})
        self.assertEqual(result["language"], "en")

    def test_validators_reject_wrong_shapes(self):
        for mutate in (lambda d: d.pop("echo"), lambda d: d.update(parties="x"),
                       lambda d: d["parties"][0].update(id="B"), lambda d: d.update(question_en="ใครชนะ")):
            data = json.loads(json.dumps(VALID_INTERP))
            mutate(data)
            with self.assertRaises(ask_pipeline.Invalid):
                ask_pipeline.validate_interpretation(data)
        pool = {"as_of": "x", "candidates": {"A": "a", "B": "b", "none": "n", "C": "c"},
                "evidence": [{"id": "E1", "source": "S1", "text": "t"}, {"id": "E2", "source": "S1", "text": "t"}]}
        with self.assertRaises(ask_pipeline.Invalid):
            ask_pipeline.validate_pool_shape(pool, {"S1"})  # extra candidate
        del pool["candidates"]["C"]
        pool["evidence"][0]["source"] = "S9"
        with self.assertRaises(ask_pipeline.Invalid):
            ask_pipeline.validate_pool_shape(pool, {"S1"})  # unknown source id


class LimitTests(unittest.TestCase):
    def pool(self, cand="The sources show One ahead of Two.", evidence_words=10):
        text = " ".join(f"w{i}" for i in range(evidence_words))
        return {"as_of": "now", "candidates": {"A": cand, "B": "The sources show Two ahead of One.", "none": "No clear leader."},
                "evidence": [{"id": "E1", "source": "S1", "text": text}, {"id": "E2", "source": "S1", "text": text}]}

    def test_candidate_over_48_tokens_is_rejected_for_repair(self):
        with self.assertRaises(ask_pipeline.Invalid) as ctx:
            ask_pipeline.fit_pool(self.pool(cand=" ".join(["word"] * 60)), "Who leads?", FakeAgent())
        self.assertIn("48", str(ctx.exception))

    def test_option_at_the_limit_is_accepted(self):
        ask_pipeline.fit_pool(self.pool(cand=" ".join(["w"] * 45)), "Who leads?", FakeAgent())  # "\n- A:" adds 2 words

    def test_overlong_evidence_is_trimmed_not_rejected(self):
        agent = FakeAgent(max_len=150)
        fitted = ask_pipeline.fit_pool(self.pool(evidence_words=400), "Who leads?", agent)
        self.assertTrue(fitted["trimmed"])
        from decision_core import tokenize_state
        self.assertLessEqual(len(tokenize_state(agent.tok, fitted["state"])) + 40, 150)
        self.assertTrue(all(e["text"] for e in fitted["evidence"]))

    def test_evidence_budget_of_600_tokens(self):
        fitted = ask_pipeline.fit_pool(self.pool(evidence_words=500), "Q?", FakeAgent(max_len=5000))
        self.assertLessEqual(sum(len(e["text"].split()) for e in fitted["evidence"]), 600)

    def test_hopeless_context_is_a_clean_error(self):
        with self.assertRaises(ask_pipeline.StageError) as ctx:
            ask_pipeline.fit_pool(self.pool(), "Who leads?", FakeAgent(max_len=30))
        self.assertEqual(ctx.exception.code, "context_too_long")

    def test_real_tokenizer_enforces_the_48_token_option_limit(self):
        from decision_core import load_tokenizer
        try:
            tok = load_tokenizer(str(ROOT / "vendor" / "onfly"))
        except Exception as exc:  # tokenizer stack not installed
            self.skipTest(f"real tokenizer unavailable: {exc}")
        agent = FakeAgent(max_len=1024, head_max_len=256)
        agent.tok = tok
        ask_pipeline.fit_pool(self.pool(), "Who leads?", agent)
        with self.assertRaises(ask_pipeline.Invalid):
            ask_pipeline.fit_pool(self.pool(cand="The sources show One ahead of Two. " * 30), "Who leads?", agent)


def final_of(events):
    assert events[-1]["stage"] == "final", events[-1]
    return events[-1]


class DecisionTests(TmpCacheCase):
    def test_same_candidate_in_both_orders_wins_with_swap_mapped_back(self):
        events = collect(runtime=FakeRuntime(prefer=("text", "People's Party ahead")), cache=self.cache)
        final = final_of(events)["data"]
        self.assertEqual(final["decision"], "A")
        self.assertTrue(final["consistency"]["agree"])
        self.assertEqual([c["id"] for c in final["candidates"]], ["A", "B", "none"])
        self.assertEqual(final["candidates"][0]["label"], "People's Party")
        self.assertEqual(final["candidates"][0]["prob"], 0.7)
        self.assertEqual(final["consistency"]["forward"]["A"], 0.7)
        self.assertEqual(final["consistency"]["swapped"]["A"], 0.7)

    def test_the_other_candidate_also_wins_symmetrically(self):
        final = final_of(collect(runtime=FakeRuntime(prefer=("text", "Bhumjaithai ahead")), cache=self.cache))["data"]
        self.assertEqual(final["decision"], "B")
        self.assertEqual(final["candidates"][1]["prob"], 0.7)

    def test_always_key_a_is_inconclusive_because_runs_name_different_candidates(self):
        runtime = FakeRuntime(prefer=("key", "A"))
        final = final_of(collect(runtime=runtime, cache=self.cache))["data"]
        self.assertEqual(final["decision"], "inconclusive")
        self.assertFalse(final["consistency"]["agree"])
        self.assertEqual(len(runtime.payloads), 2)
        first, second = (p["questions"]["vote"]["criteria"] for p in runtime.payloads)
        self.assertEqual((first["A"], first["B"]), (second["B"], second["A"]))  # texts really swapped
        self.assertEqual(first["none"], second["none"])

    def test_none_stays_none(self):
        final = final_of(collect(runtime=FakeRuntime(prefer=("key", "none")), cache=self.cache))["data"]
        self.assertEqual(final["decision"], "none")
        self.assertEqual(final["candidates"][2]["prob"], 0.7)

    def test_low_confidence_is_inconclusive_and_threshold_is_configurable(self):
        low = FakeRuntime(prefer=("text", "People's Party ahead"), top=0.4)
        self.assertEqual(final_of(collect(runtime=low, cache=self.cache))["data"]["decision"], "inconclusive")
        with patch.dict("os.environ", {"JEV_MIN_CONF": "0.35"}):
            self.assertEqual(final_of(collect(runtime=low, cache=self.cache))["data"]["decision"], "A")
        edge = FakeRuntime(prefer=("text", "People's Party ahead"), top=0.45)
        self.assertEqual(final_of(collect(runtime=edge, cache=self.cache))["data"]["decision"], "A")  # >= threshold

    def test_choice_not_among_the_sent_keys_is_rejected(self):
        events = collect(runtime=FakeRuntime(bad_choice="C"), cache=self.cache)
        self.assertEqual(events[-1]["stage"], "final")
        self.assertEqual(events[-1]["status"], "error")
        self.assertEqual(events[-1]["error"]["code"], "invalid_model_output")
        self.assertEqual(events[-2]["stage"], "jev")
        self.assertIsNone(self.cache.get(DEMO))

    def test_adapter_unit_rules(self):
        probs = {"A": 0.5, "B": 0.3, "none": 0.2}
        self.assertEqual(ask_pipeline.adapt(("A", probs), ("B", probs), 0.45)["decision"], "inconclusive")
        self.assertEqual(ask_pipeline.adapt(("A", probs), ("A", probs), 0.45)["decision"], "A")
        self.assertEqual(ask_pipeline.adapt(("A", probs), ("A", probs), 0.51)["decision"], "inconclusive")
        with self.assertRaises(ask_pipeline.Invalid):
            ask_pipeline.read_answer({"answers": {"vote": {"choice": "Z", "probabilities": probs}}}, {"A": "A", "B": "B", "none": "none"})

    def test_event_shapes_and_templates(self):
        events = collect(runtime=FakeRuntime(), cache=self.cache)
        stages = [(e["stage"], e["status"]) for e in events]
        self.assertEqual(stages, [(s, st) for s in ask_pipeline.STAGES for st in ("start", "done")] + [("final", "done")])
        self.assertTrue(all(isinstance(e["ms"], int) for e in events[:-1]))
        final = events[-1]["data"]
        self.assertIn("People's Party", final["answer_text"])
        self.assertEqual(final["disclaimer"], "Entertainment demo - not a prediction")
        self.assertEqual(final["interpretation"]["language"], "th")
        self.assertRegex(final["answer_text"], "แหล่งข้อมูล")
        self.assertEqual(final["candidates"][2]["label"], "ไม่มีผู้นำที่ชัดเจน")
        self.assertTrue(all("FAKE-DEMO" in s["title"] for s in final["sources"]))

    def test_order_is_seeded_by_text(self):
        self.assertEqual(ask_pipeline.key_maps("Hello  World"), ask_pipeline.key_maps("hello world"))
        orders = {ask_pipeline.key_maps(f"question {i}")[0]["A"] for i in range(40)}
        self.assertEqual(orders, {"A", "B"})  # neither party is always key A

    def test_model_not_ready_is_a_stage_error_not_an_exception(self):
        runtime = FakeRuntime(status="loading")
        runtime.agent = None
        events = collect(runtime=runtime, cache=self.cache)
        self.assertEqual(events[-2]["stage"], "pool")
        self.assertEqual(events[-2]["status"], "error")
        self.assertEqual(events[-1]["error"]["code"], "model_not_ready")

    def test_jev_rejection_becomes_stage_error(self):
        class Rejecting(FakeRuntime):
            def predict(self, payload):
                raise HTTPException(422, "an option exceeds 48 tokens")
        events = collect(runtime=Rejecting(), cache=self.cache)
        self.assertEqual(events[-1]["error"]["code"], "jev_input_rejected")


class CacheTests(TmpCacheCase):
    def test_live_result_is_cached_and_replay_serves_it_without_llm_or_model(self):
        live = final_of(collect(runtime=FakeRuntime(), cache=self.cache))["data"]
        self.assertFalse(live["from_cache"])
        self.assertEqual(self.cache.get("  ระหว่างพรรคของคุณพิธากับพรรคของเสี่ยหนู   ใครจะชนะ?  "), live)  # normalised key
        dead_runtime, no_llm = FakeRuntime(status="loading"), llm_layer.LLM({})
        events = collect(runtime=dead_runtime, llm=no_llm, cache=self.cache, replay=True)
        self.assertEqual([e["stage"] for e in events if e["status"] == "done"][:5], list(ask_pipeline.STAGES))
        self.assertTrue(all(e["data"]["cached"] for e in events[:-1] if e["status"] == "done"))
        replayed = events[-1]["data"]
        self.assertTrue(replayed["from_cache"])
        self.assertEqual({**replayed, "from_cache": False}, live)

    def test_provider_failure_with_cache_hit_returns_cached_final(self):
        live = final_of(collect(runtime=FakeRuntime(), cache=self.cache))["data"]
        events = collect(runtime=FakeRuntime(), llm=llm_layer.LLM({}), cache=self.cache)  # nothing configured
        self.assertEqual(events[-1]["status"], "done")
        self.assertTrue(events[-1]["data"]["from_cache"])
        self.assertEqual(events[-1]["data"]["decision"], live["decision"])
        self.assertEqual(events[0], {"stage": "interpret", "status": "start", "ms": 0, "data": {}})

    def test_provider_failure_without_cache_is_a_clean_error(self):
        events = collect(runtime=FakeRuntime(), llm=llm_layer.LLM({}), cache=self.cache)
        self.assertEqual(events[-1], {"stage": "final", "status": "error", "error": {
            "code": "not_configured", "message": events[-1]["error"]["message"]}})

    def test_replay_without_hit_runs_live(self):
        self.assertFalse(final_of(collect(runtime=FakeRuntime(), cache=self.cache, replay=True))["data"]["from_cache"])

    def test_cache_file_is_valid_json_without_leftover_temp_files(self):
        collect(runtime=FakeRuntime(), cache=self.cache)
        json.loads(self.cache.path.read_text())
        self.assertEqual([p.name for p in self.cache.path.parent.iterdir()], ["ask_cache.json"])


def paxa_client(handler):
    real = httpx.AsyncClient
    return patch.object(stt.httpx, "AsyncClient", lambda **kw: real(**{**kw, "transport": httpx.MockTransport(handler)}))


class STTTests(unittest.IsolatedAsyncioTestCase):
    async def test_forwards_multipart_with_bearer_and_returns_text(self):
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json={"text": " สวัสดี "})
        with paxa_client(handler):
            result = await stt.transcribe(b"audio-bytes", "a.webm", "audio/webm", "th", env={"PAXA_API_KEY": "paxa-k"})
        self.assertEqual(result, {"text": "สวัสดี"})
        request = seen[0]
        self.assertEqual(str(request.url), "https://api.paxalabs.com/v1/audio/transcriptions")
        self.assertEqual(request.headers["authorization"], "Bearer paxa-k")
        for part in (b'name="file"', b"audio-bytes", b"paxa-stt-lite-v1-preview", b'name="language"', b"json"):
            self.assertIn(part, request.content)

    async def test_error_mapping(self):
        cases = [(401, "unauthorized", 401), (402, "insufficient_credits", 402), (403, "key_limit", 403),
                 (413, "audio_too_large", 413), (400, "audio_invalid", 400), (400, "audio_too_long", 400),
                 (429, "rate_limited", 429)]
        for upstream, code, expected in cases:
            with self.subTest(code=code), paxa_client(lambda r, u=upstream, c=code: httpx.Response(u, json={"error": {"code": c}})):
                with self.assertRaises(stt.STTError) as ctx:
                    await stt.transcribe(b"x", env={"PAXA_API_KEY": "k"})
                self.assertEqual((ctx.exception.status, ctx.exception.code), (expected, code))
        with paxa_client(lambda r: httpx.Response(503, text="down")):
            with self.assertRaises(stt.STTError) as ctx:
                await stt.transcribe(b"x", env={"PAXA_API_KEY": "k"})
            self.assertEqual((ctx.exception.status, ctx.exception.code), (502, "stt_upstream_error"))
        with paxa_client(lambda r: httpx.Response(400, json={"error": "audio_too_long"})):
            with self.assertRaises(stt.STTError) as ctx:
                await stt.transcribe(b"x", env={"PAXA_API_KEY": "k"})
            self.assertEqual(ctx.exception.code, "audio_too_long")

    async def test_missing_key_and_oversize(self):
        with self.assertRaises(stt.STTError) as ctx:
            await stt.transcribe(b"x", env={})
        self.assertEqual((ctx.exception.status, ctx.exception.code), (503, "stt_not_configured"))
        with self.assertRaises(stt.STTError) as ctx:
            await stt.transcribe(b"x" * (stt.MAX_AUDIO_BYTES + 1), env={"PAXA_API_KEY": "k"})
        self.assertEqual(ctx.exception.status, 413)


class RouteTests(TmpCacheCase):
    def setUp(self):
        super().setUp()
        self.client = TestClient(app_module.app)
        self.patches = [patch.object(ask_pipeline, "CACHE_PATH", self.cache.path),
                        patch.object(app_module, "runtime", FakeRuntime()),
                        patch.dict("os.environ", {"LLM_PROVIDER": "fake"})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        super().tearDown()

    def test_ask_streams_ndjson_and_validates_input(self):
        response = self.client.post("/api/ask", json={"text": DEMO})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("application/x-ndjson"))
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[-1]["stage"], "final")
        self.assertEqual(events[-1]["data"]["decision"], "A")
        self.assertEqual(self.client.post("/api/ask", json={"text": ""}).status_code, 422)
        self.assertEqual(self.client.post("/api/ask", json={"text": "x" * 501}).status_code, 422)
        self.assertEqual(self.client.post("/api/ask", json={"text": "hi", "replay": "yes"}).status_code, 422)
        self.assertEqual(self.client.post("/api/ask", content=b"x" * 9000).status_code, 413)
        self.assertEqual(self.client.post("/api/ask", json={"text": DEMO}, headers={"origin": "http://evil.example"}).status_code, 403)

    def test_ask_with_model_not_ready_streams_a_stage_error(self):
        not_ready = FakeRuntime(status="loading")
        not_ready.agent = None
        with patch.object(app_module, "runtime", not_ready):
            response = self.client.post("/api/ask", json={"text": "another question"})
        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[-1]["error"]["code"], "model_not_ready")

    def test_health_has_booleans_and_no_key_text(self):
        keys = {"GEMINI_API_KEY": "AIza-SECRET-gemini-123", "OPENROUTER_API_KEY": "sk-or-SECRET-456", "PAXA_API_KEY": "paxa-SECRET-789"}
        with patch.dict("os.environ", keys):
            response = self.client.get("/api/ask/health")
        self.assertEqual(response.status_code, 200)
        for secret in keys.values():
            self.assertNotIn(secret, response.text)
        self.assertNotIn("SECRET", response.text)
        body = response.json()
        self.assertTrue(all(isinstance(v, (bool, int)) for v in body.values()))
        self.assertTrue(body["gemini"] and body["openrouter"] and body["stt"])

    def test_fly_page_404_until_built(self):
        with patch.object(app_module, "ROOT", Path(self.tmp.name)):
            response = self.client.get("/fly")
        self.assertEqual(response.status_code, 404)
        self.assertIn("fly.html", response.json()["detail"])

    def test_stt_route(self):
        files = {"audio": ("rec.webm", b"fake-opus-bytes", "audio/webm")}
        with patch.dict("os.environ", {"PAXA_API_KEY": ""}):
            response = self.client.post("/api/stt", files=files)
        self.assertEqual((response.status_code, response.json()), (503, {"error": "stt_not_configured"}))
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json={"text": "ผลลัพธ์"})
        with patch.dict("os.environ", {"PAXA_API_KEY": "paxa-k"}), paxa_client(handler):
            ok = self.client.post("/api/stt", files=files, data={"language": "en"})
            missing = self.client.post("/api/stt", files={"other": ("x", b"y")})
            cross = self.client.post("/api/stt", files=files, headers={"origin": "http://evil.example"})
        self.assertEqual((ok.status_code, ok.json()), (200, {"text": "ผลลัพธ์"}))
        self.assertIn(b"fake-opus-bytes", seen[0].content)
        self.assertIn(b"en", seen[0].content)
        self.assertEqual(missing.status_code, 422)
        self.assertEqual(cross.status_code, 403)
        with patch.dict("os.environ", {"PAXA_API_KEY": "k"}), paxa_client(lambda r: httpx.Response(402, json={"error": {"code": "insufficient_credits"}})):
            self.assertEqual(self.client.post("/api/stt", files=files).status_code, 402)
        with patch.dict("os.environ", {"PAXA_API_KEY": "k"}):
            big = self.client.post("/api/stt", files={"audio": ("big.webm", b"0" * (stt.MAX_AUDIO_BYTES + 1), "audio/webm")})
        self.assertEqual(big.status_code, 413)


if __name__ == "__main__":
    unittest.main()
