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
    """Scripted stand-in for app.Runtime. `prefer` = ("key", "A") | ("text", "People's Party") | ("probs", {...})."""

    def __init__(self, prefer=("text", "People's Party"), top=0.7, agent=None, status="ready", bad_choice=None):
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


def answer_json(**over):
    data = {"echo": "I understood: x", "language": "en", "parties": [{"id": "A", "name": "One", "aliases": []},
                                                                      {"id": "B", "name": "Two", "aliases": ["t"]}],
            "criterion": "is ahead in the latest polls",
            "facts": [{"text": "One leads by two points.", "source_title": "T", "source_url": "https://a.example/1"},
                      {"text": "Two is close behind.", "source_title": "", "source_url": ""}], "as_of": "2026-05"}
    data.update(over)
    return data


def or_response(content, annotations=None, usage=None):
    return {"choices": [{"message": {"content": content if isinstance(content, str) else json.dumps(content),
                                     "annotations": annotations or []}}], "usage": usage or {"prompt_tokens": 100, "completion_tokens": 50}}


CITE = [{"type": "url_citation", "url_citation": {"url": "https://c.example/p", "title": "C", "content": "snippet text"}}]


class LLMTests(unittest.IsolatedAsyncioTestCase):
    def make(self, handler, env=None):
        llm = llm_layer.LLM({"OPENROUTER_API_KEY": "or-k", "OPENROUTER_MODEL": "vendor/model", **(env or {})},
                            httpx.MockTransport(handler))
        llm.client.backoff = 0
        return llm

    async def test_single_call_request_shape_with_web_plugin(self):
        seen = []

        def handler(request):
            seen.append((request, json.loads(request.content)))
            return httpx.Response(200, json=or_response(answer_json(), CITE))
        result = await self.make(handler).ask("sys", "usr")
        request, body = seen[0]
        self.assertEqual(len(seen), 1)
        self.assertEqual(request.headers["authorization"], "Bearer or-k")
        self.assertEqual(body["model"], "vendor/model")
        self.assertEqual(body["temperature"], 0)
        self.assertLessEqual(body["max_tokens"], 400)
        self.assertEqual(body["plugins"], [{"id": "web", "max_results": 2}])
        self.assertEqual(body["reasoning"], {"enabled": False})
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertTrue(result["grounded"])
        self.assertEqual(result["sources"], [{"title": "C", "url": "https://c.example/p", "snippet": "snippet text"}])
        self.assertEqual(result["data"]["language"], "en")

    async def test_fenced_json_is_parsed(self):
        llm = self.make(lambda r: httpx.Response(200, json=or_response("```json\n" + json.dumps(answer_json()) + "\n```")))
        self.assertEqual((await llm.ask("s", "u"))["data"]["criterion"], "is ahead in the latest polls")

    async def test_web_failure_retries_once_without_web_plugin(self):
        for status in (402, 429, 500):
            bodies = []

            def handler(request, status=status):
                body = json.loads(request.content)
                bodies.append(body)
                return httpx.Response(status) if "plugins" in body else httpx.Response(200, json=or_response(answer_json(), CITE))
            with self.subTest(status=status):
                result = await self.make(handler).ask("sys", "usr")
                self.assertFalse(result["grounded"])
                self.assertEqual(result["sources"], [])  # citations are never kept for an ungrounded answer
                self.assertNotIn("plugins", bodies[-1])
                self.assertIn("No web access", bodies[-1]["messages"][0]["content"])
                self.assertEqual(bodies[-1]["model"], "vendor/model")

    async def test_timeout_and_transport_errors_fall_back_but_parse_errors_do_not(self):
        calls = []

        def boom(request):
            calls.append(json.loads(request.content))
            if "plugins" in calls[-1]:
                raise httpx.ConnectError("x")
            return httpx.Response(200, json=or_response(answer_json()))
        self.assertFalse((await self.make(boom).ask("s", "u"))["grounded"])
        calls.clear()

        def junk(request):
            calls.append(1)
            return httpx.Response(200, content=b"<html>")
        with self.assertRaises(llm_layer.LLMError) as ctx:
            await self.make(junk).ask("s", "u")
        self.assertEqual((ctx.exception.code, len(calls)), ("bad_response", 1))

    async def test_401_does_not_fall_back_and_both_failing_raises(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(401)
        with self.assertRaises(llm_layer.LLMError) as ctx:
            await self.make(handler).ask("s", "u")
        self.assertEqual((ctx.exception.code, len(calls)), ("http_401", 1))
        with self.assertRaises(llm_layer.LLMError) as ctx:
            await self.make(lambda r: httpx.Response(402)).ask("s", "u")
        self.assertEqual(ctx.exception.code, "http_402")

    async def test_429_is_retried_once_before_giving_up_on_web(self):
        calls = []

        def handler(request):
            calls.append(json.loads(request.content))
            return httpx.Response(429) if len(calls) == 1 else httpx.Response(200, json=or_response(answer_json(), CITE))
        result = await self.make(handler).ask("s", "u")
        self.assertTrue(result["grounded"])
        self.assertEqual(len(calls), 2)

    async def test_provider_selection(self):
        self.assertEqual(llm_layer.LLM({"OPENROUTER_API_KEY": "k", "LLM_PROVIDER": ""}).primary, "openrouter")
        with self.assertRaises(llm_layer.LLMError) as ctx:
            await llm_layer.LLM({"OPENROUTER_API_KEY": "k", "LLM_PROVIDER": "gemini"}).ask("s", "u")
        self.assertEqual(ctx.exception.code, "bad_provider")
        with self.assertRaises(llm_layer.LLMError) as ctx:
            await llm_layer.LLM({}).ask("s", "u")
        self.assertEqual(ctx.exception.code, "not_configured")

    async def test_fake_client_is_labelled_and_deterministic(self):
        llm = llm_layer.LLM({"LLM_PROVIDER": "fake"})
        result = await llm.ask("s", "u", context={"text": DEMO})
        self.assertEqual(len(result["sources"]), 3)
        self.assertTrue(all("FAKE-DEMO" in s["snippet"] for s in result["sources"]))
        self.assertTrue(all("FAKE-DEMO" in f["text"] for f in result["data"]["facts"]))
        self.assertEqual([p["name"] for p in result["data"]["parties"]], ["People's Party", "Bhumjaithai"])
        self.assertEqual(result, await llm.ask("s", "u", context={"text": DEMO}))

    def test_gemini_is_fully_removed(self):
        import re
        for name in ("llm.py", "ask_pipeline.py", "app.py", ".env.example", "stt.py"):
            text = (ROOT / name).read_text()
            self.assertIsNone(re.search(r"GEMINI|GeminiClient|generativelanguage|grounding", text), name)
        self.assertFalse(hasattr(llm_layer, "GeminiClient"))


class ValidationTests(unittest.IsolatedAsyncioTestCase):
    def test_valid_answer_passes(self):
        out = ask_pipeline.validate_answer(answer_json())
        self.assertEqual([p["name"] for p in out["parties"]], ["One", "Two"])
        self.assertEqual(len(out["facts"]), 2)

    def test_extra_top_level_keys_are_dropped(self):
        out = ask_pipeline.validate_answer(answer_json(reasoning="blah", extra=1))
        self.assertNotIn("extra", out)

    def test_more_than_three_facts_truncated_and_long_fact_cut_to_22_words(self):
        facts = [{"text": " ".join(["word"] * 40), "source_title": "", "source_url": ""} for _ in range(6)]
        out = ask_pipeline.validate_answer(answer_json(facts=facts))
        self.assertEqual(len(out["facts"]), 3)
        self.assertEqual(len(out["facts"][0]["text"].split()), 22)
        out = ask_pipeline.validate_answer(answer_json(criterion=" ".join(["w"] * 30) + "?"))
        self.assertEqual(len(out["criterion"].split()), 12)

    def test_wrong_shapes_are_rejected(self):
        bad = [lambda d: d.pop("echo"), lambda d: d.pop("facts"), lambda d: d.update(parties="x"),
               lambda d: d["parties"].append({"id": "C", "name": "Three"}), lambda d: d["parties"][0].update(id="B"),
               lambda d: d.update(facts=[]), lambda d: d.update(facts=[{"text": 5}]),
               lambda d: d.update(criterion="ใครนำ"), lambda d: d["parties"][1].update(name="One"),
               lambda d: d.update(language=7)]
        for mutate in bad:
            data = answer_json()
            mutate(data)
            with self.assertRaises(ask_pipeline.Invalid):
                ask_pipeline.validate_answer(data)

    async def test_invalid_answer_is_repaired_once_with_the_error_in_the_prompt(self):
        prompts = []

        def handler(request):
            prompts.append(json.loads(request.content)["messages"][1]["content"])
            return httpx.Response(200, json=or_response(answer_json(parties=[]) if len(prompts) == 1 else answer_json()))
        llm = llm_layer.LLM({"OPENROUTER_API_KEY": "k"}, httpx.MockTransport(handler))
        answer, _ = await ask_pipeline.ask_llm(llm, "u", {})
        self.assertEqual(len(prompts), 2)
        self.assertIn("exactly 2 parties", prompts[1])
        self.assertEqual(answer["parties"][1]["name"], "Two")

    async def test_non_json_is_repaired_and_second_failure_is_a_clean_error(self):
        texts = iter(["not json", json.dumps(answer_json())])
        llm = llm_layer.LLM({"OPENROUTER_API_KEY": "k"}, httpx.MockTransport(
            lambda r: httpx.Response(200, json=or_response(next(texts)))))
        answer, _ = await ask_pipeline.ask_llm(llm, "u", {})
        self.assertEqual(answer["language"], "en")
        llm = llm_layer.LLM({"OPENROUTER_API_KEY": "k"}, httpx.MockTransport(
            lambda r: httpx.Response(200, json=or_response({"language": "en"}))))
        with self.assertRaises(ask_pipeline.StageError) as ctx:
            await ask_pipeline.ask_llm(llm, "u", {})
        self.assertEqual(ctx.exception.code, "invalid_llm_output")


class PoolTests(unittest.TestCase):
    def answer(self, **over):
        return ask_pipeline.validate_answer(answer_json(**over))

    def test_pool_format_is_exactly_the_measured_one(self):
        pool = ask_pipeline.build_pool(self.answer(), FakeAgent())
        self.assertEqual(pool["state"], "Findings: One leads by two points. Two is close behind.")
        self.assertEqual(pool["instructions"], "Which candidate is ahead in the latest polls?")
        self.assertEqual(pool["candidates"], {"A": "One", "B": "Two", "none": "No clear leader"})
        self.assertEqual(pool["claims"]["A"], "One is ahead in the latest polls")
        payload = ask_pipeline.make_payload(pool, {"A": "B", "B": "A", "none": "none"})
        self.assertEqual(payload["questions"]["vote"]["criteria"], {"A": "Two", "B": "One", "none": "No clear leader"})
        self.assertIsInstance(payload["state"], str)

    def test_state_is_capped_at_400_chars_on_a_word_boundary(self):
        facts = [{"text": " ".join(f"word{i}x{j}" for j in range(22)), "source_title": "", "source_url": ""} for i in range(3)]
        pool = ask_pipeline.build_pool(self.answer(facts=facts), FakeAgent(max_len=2000))
        self.assertLessEqual(len(pool["state"]), 400)
        self.assertTrue(pool["trimmed"])
        self.assertRegex(pool["state"], r"word\d+x\d+$")  # not cut mid-word

    def test_option_over_48_tokens_is_shortened_not_rejected(self):
        name = " ".join(f"w{i}" for i in range(60))
        pool = ask_pipeline.build_pool({**self.answer(), "parties": [{"id": "A", "name": name, "aliases": []},
                                                                       {"id": "B", "name": "Two", "aliases": []}]}, FakeAgent())
        self.assertLessEqual(len(("\n- A: " + pool["candidates"]["A"]).split()), 48)

    def test_state_is_trimmed_to_the_context_and_hopeless_context_errors(self):
        agent = FakeAgent(max_len=40, head_max_len=30)
        pool = ask_pipeline.build_pool(self.answer(), agent)
        from decision_core import tokenize_state
        self.assertLess(len(tokenize_state(agent.tok, pool["state"])), 40)
        with self.assertRaises(ask_pipeline.StageError) as ctx:
            ask_pipeline.build_pool(self.answer(), FakeAgent(max_len=15, head_max_len=30))
        self.assertEqual(ctx.exception.code, "context_too_long")

    def test_real_tokenizer_enforces_the_48_token_option_limit(self):
        from decision_core import load_tokenizer, encode
        try:
            tok = load_tokenizer(str(ROOT / "vendor" / "onfly"))
        except Exception as exc:
            self.skipTest(f"real tokenizer unavailable: {exc}")
        agent = FakeAgent(max_len=1024, head_max_len=256)
        agent.tok = tok
        long_name = "The Very Long Party Name Of The Democratic Peoples Republican Alliance " * 3
        pool = ask_pipeline.build_pool({**self.answer(), "parties": [{"id": "A", "name": long_name.strip()[:60], "aliases": []},
                                                                       {"id": "B", "name": "Two", "aliases": []}]}, agent)
        self.assertLessEqual(len(encode(tok, "\n- A: " + pool["candidates"]["A"])), 48)


def final_of(events):
    assert events[-1]["stage"] == "final", events[-1]
    return events[-1]


class DecisionTests(TmpCacheCase):
    def test_same_candidate_in_both_orders_wins_with_swap_mapped_back(self):
        events = collect(runtime=FakeRuntime(prefer=("text", "People's Party")), cache=self.cache)
        final = final_of(events)["data"]
        self.assertEqual(final["decision"], "A")
        self.assertTrue(final["consistency"]["agree"])
        self.assertEqual([c["id"] for c in final["candidates"]], ["A", "B", "none"])
        self.assertEqual(final["candidates"][0]["label"], "People's Party")
        self.assertEqual(final["candidates"][0]["prob"], 0.7)
        self.assertEqual(final["consistency"]["forward"]["A"], 0.7)
        self.assertEqual(final["consistency"]["swapped"]["A"], 0.7)

    def test_the_other_candidate_also_wins_symmetrically(self):
        final = final_of(collect(runtime=FakeRuntime(prefer=("text", "Bhumjaithai")), cache=self.cache))["data"]
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
        low = FakeRuntime(prefer=("text", "People's Party"), top=0.4)
        self.assertEqual(final_of(collect(runtime=low, cache=self.cache))["data"]["decision"], "inconclusive")
        with patch.dict("os.environ", {"JEV_MIN_CONF": "0.35"}):
            self.assertEqual(final_of(collect(runtime=low, cache=self.cache))["data"]["decision"], "A")
        edge = FakeRuntime(prefer=("text", "People's Party"), top=0.45)
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


class SingleCallPipelineTests(TmpCacheCase):
    def run_with(self, web_ok, text="who leads?", **runtime_kw):
        calls = []

        def handler(request):
            body = json.loads(request.content)
            calls.append(body)
            if "plugins" in body and not web_ok:
                return httpx.Response(402)
            return httpx.Response(200, json=or_response(answer_json(), CITE if "plugins" in body else []))
        llm = llm_layer.LLM({"OPENROUTER_API_KEY": "k", "OPENROUTER_MODEL": "vendor/model"}, httpx.MockTransport(handler))
        llm.client.backoff = 0
        events = collect(text, runtime=FakeRuntime(prefer=("text", "One"), **runtime_kw), llm=llm, cache=self.cache)
        return events, calls

    def test_debug_metadata_search_info_and_adapter_checks(self):
        events, _ = self.run_with(True)
        done = {e["stage"]: e["data"] for e in events if e["status"] == "done" and e["stage"] != "final"}
        self.assertEqual(done["research"]["search"]["engine"], "OpenRouter web plugin")
        self.assertEqual(done["research"]["search"]["max_results"], 2)
        self.assertEqual(done["research"]["search"]["results_returned"], len(done["research"]["sources"]))
        adapter = done["adapter"]
        self.assertEqual(adapter["min_conf"], ask_pipeline.min_conf())
        self.assertEqual([c["ok"] for c in adapter["checks"]][:2], [True, adapter["agree"]])
        self.assertEqual(adapter["top"], max(adapter["mean"], key=adapter["mean"].get))
        events, _ = self.run_with(False)
        search = [e for e in events if e["stage"] == "research" and e["status"] == "done"][0]["data"]["search"]
        self.assertEqual((search["max_results"], search["results_returned"]), (0, 0))

    def test_one_llm_call_and_event_order_with_merged_research(self):
        events, calls = self.run_with(True)
        self.assertEqual(len(calls), 1)
        self.assertEqual([(e["stage"], e["status"]) for e in events],
                         [(s, st) for s in ask_pipeline.STAGES for st in ("start", "done")] + [("final", "done")])
        done = {e["stage"]: e for e in events if e["status"] == "done"}
        self.assertEqual(done["research"]["ms"], 0)
        self.assertEqual(done["research"]["data"]["merged_with"], "interpret")
        self.assertEqual(done["research"]["data"]["facts"][0]["text"], "One leads by two points.")
        self.assertEqual(done["research"]["data"]["sources"][0]["url"], "https://c.example/p")
        self.assertEqual(done["interpret"]["data"]["criterion"], "is ahead in the latest polls")
        self.assertIn("state", done["pool"]["data"])
        final = events[-1]["data"]
        self.assertEqual(final["decision"], "A")
        self.assertEqual(final["research"], {"grounded": True, "provider": "vendor/model"})
        self.assertEqual(final["interpretation"]["question_en"], "Which candidate is ahead in the latest polls?")
        self.assertNotIn("no live web data", final["answer_text"])

    def test_no_web_fallback_is_reported_and_suffixed(self):
        events, calls = self.run_with(False)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("plugins", calls[1])
        final = final_of(events)["data"]
        research = next(e for e in events if e["stage"] == "research" and e["status"] == "done")["data"]
        self.assertEqual((research["grounded"], research["sources"]), (False, []))
        self.assertIn("No live web search", research["notice"])
        self.assertEqual(final["research"]["grounded"], False)
        self.assertEqual(final["sources"], [])
        self.assertTrue(final["answer_text"].endswith(" (no live web data)"))

    def test_both_calls_failing_without_cache_is_a_clean_error_and_with_cache_serves_it(self):
        llm = llm_layer.LLM({"OPENROUTER_API_KEY": "k"}, httpx.MockTransport(lambda r: httpx.Response(402)))
        events = collect("q", runtime=FakeRuntime(), llm=llm, cache=self.cache)
        self.assertEqual((events[-2]["stage"], events[-2]["status"], events[-1]["error"]["code"]), ("interpret", "error", "http_402"))
        self.run_with(True, text="q2")
        events = collect("q2", runtime=FakeRuntime(), llm=llm, cache=self.cache)
        self.assertTrue(events[-1]["data"]["from_cache"])

    def test_thai_suffix(self):
        self.assertTrue(ask_pipeline.answer_text("th", "A", "X", {"A": 0.6, "B": 0.3, "none": 0.1}, None, False).endswith("(ไม่มีข้อมูลค้นเว็บสด)"))


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
        keys = {"OPENROUTER_API_KEY": "sk-or-SECRET-456", "PAXA_API_KEY": "paxa-SECRET-789"}
        with patch.dict("os.environ", keys):
            response = self.client.get("/api/ask/health")
        self.assertEqual(response.status_code, 200)
        for secret in keys.values():
            self.assertNotIn(secret, response.text)
        self.assertNotIn("SECRET", response.text)
        body = response.json()
        self.assertTrue(all(isinstance(v, (bool, int)) for v in body.values()))
        self.assertTrue(body["openrouter"] and body["stt"])
        self.assertNotIn("gemini", body)

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
