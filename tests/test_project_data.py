"""Local tests for project persistence and built-in data templates."""
import tempfile
import json
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest.mock import patch

import project_store
import scrapers


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "projects.sqlite3"
        self.patch_path = patch.object(project_store, "DB_PATH", self.path)
        self.patch_path.start()
        project_store.init_db()

    def tearDown(self):
        self.patch_path.stop()
        self.tmp.cleanup()

    def test_project_policy_and_comparison_round_trip(self):
        project = project_store.create_project("กทม.", "เลือกตั้ง กทม.", "2569", "กรุงเทพมหานคร")
        self.assertEqual(project["election"], "เลือกตั้ง กทม.")
        policies = [
            {"title":"รถเมล์ไฟฟ้า", "content":"ค่าโดยสารราคาเดียว", "category":"เดินทาง", "party":"พรรคสมมติ A", "source_kind":"mock", "source_label":"mock", "source_meta":{}},
            {"title":"ทางเท้าปลอดภัย", "content":"ซ่อมทางเท้า", "category":"เมือง", "party":"พรรคสมมติ B", "source_kind":"mock", "source_label":"mock", "source_meta":{}},
        ]
        ids = project_store.save_policies(project["id"], policies)
        self.assertEqual(len(project_store.list_policies(project["id"])), 2)
        project_store.save_comparison(project["id"], ids[0], ids[1], "เกณฑ์", "สถานการณ์", ids[0],
                                      {"response":{"answers":{"vote":{"choice":"A"}}}})
        summary = project_store.summary(project["id"])
        self.assertEqual(summary["policy_count"], 2)
        self.assertEqual(summary["categories"], {"เดินทาง":1,"เมือง":1})
        self.assertEqual(summary["decisions"][0]["winner_id"], ids[0])
        self.assertEqual(summary["decisions"][0]["policy_b_title"], "ทางเท้าปลอดภัย")
        self.assertEqual(summary["decisions"][0]["policy_a_party"], "พรรคสมมติ A")

    def test_compare_api_requires_distinct_identified_campaign_parties(self):
        import app
        from fastapi.testclient import TestClient
        from decision_core import load_tokenizer
        agent = SimpleNamespace(tok=load_tokenizer(str(app.MODEL_DIR)), max_len=1024, head_max_len=256)
        project = project_store.create_project("ทดสอบ", "การเลือกตั้งเดียวกัน", "2569", "ไทย")
        base = {"title":"เดินทาง", "content":"เพิ่มรถเมล์", "category":"เดินทาง", "source_kind":"party_campaign"}
        rows = [{**base, "party":party} for party in ("พรรค A", "  พรรค   A  ", "พรรค B", "")]
        rows.append({**base, "party":"พรรค B", "source_kind":"bma_tracker"})
        ids = project_store.save_policies(project["id"], rows)
        client = TestClient(app.app)  # No lifespan: these tests must not load the checkpoint.
        url = f"/api/projects/{project['id']}/compare"
        with patch.object(app.runtime, "agent", agent), patch.object(app.runtime, "predict", return_value={"answers":{"vote":{"choice":"B", "probabilities":{"A":0.3,"B":0.7}}}}) as predict:
            for b in (ids[1], ids[3], ids[4]):
                with self.subTest(policy_b=b):
                    response = client.post(url, json={"policy_a_id":ids[0], "policy_b_id":b, "criterion":"การเดินทาง"})
                    self.assertEqual(response.status_code, 422)
            predict.assert_not_called()
            self.assertEqual(project_store.summary(project["id"])["decisions"], [])
            response = client.post(url, json={"policy_a_id":ids[0], "policy_b_id":ids[2], "criterion":"การเดินทาง"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["winner_id"], ids[2])
            predict.assert_called_once()
            state = predict.call_args.args[0]["state"]
            self.assertEqual(state["policy_A"]["party"], "พรรค A")
            self.assertEqual(state["policy_B"]["party"], "พรรค B")
            self.assertEqual(len(project_store.summary(project["id"])["decisions"]), 1)
        client.close()

    def test_thai_project_excerpts_fit_actual_checkpoint_token_budget(self):
        import app
        from decision_core import load_tokenizer, to_internal, tokenize_question, tokenize_state
        agent = SimpleNamespace(tok=load_tokenizer(str(app.MODEL_DIR)), max_len=1024, head_max_len=256)
        items = scrapers.mock_data()[:2]
        contents = [item["content"] * 10 for item in items]
        state = {"election":"การเลือกตั้งสมมติ", "situation":"คนทำงานที่ใช้รถเมล์ในช่วงเร่งด่วน"}
        for side, item, content in zip(("A", "B"), items, contents):
            state[f"policy_{side}"] = {"title":item["title"], "party":item["party"], "category":item["category"], "source_excerpt":content[:240]}
        request = {"state":state,"questions":{"vote":{"type":"choice","instructions":"นโยบายใดช่วยคนเดินทางด้วยรถเมล์ทุกวันได้มากกว่า?","criteria":{"A":None,"B":None}}}}
        fitted, cuts = app._fit_project_request(request, contents, agent)
        q = tokenize_question(agent.tok, to_internal(fitted["questions"]["vote"]))
        total = len(tokenize_state(agent.tok, fitted["state"])) + len(q["head"]) + sum(map(len,q["opts"])) + 1
        self.assertLessEqual(total, 1024)
        self.assertEqual(cuts, {"A":True,"B":True})
        for side, item in zip(("A", "B"), items):
            self.assertEqual(fitted["state"][f"policy_{side}"]["party"], item["party"])
            self.assertTrue(fitted["state"][f"policy_{side}"]["source_excerpt"])


class TemplateTests(unittest.TestCase):
    def test_bhumjaithai_reads_only_the_policy_array_without_executing_scripts(self):
        policy = '{ID:11,post_author:a,post_date:b,post_date_gmt:c,post_content:"<p>เพิ่มรถเมล์ [ชุมชน]</p>",post_title:"เดินทาง",acf:{images:[]}}'
        news = policy.replace('ID:11', 'ID:99').replace('เดินทาง', 'ข่าวพรรค')
        page = '<script>window.__NUXT__={data:[{policies:{posts:['+policy+']},news:{posts:['+news+']}}]};</script>'
        with patch.object(scrapers, "fetch", return_value=("https://www.bhumjaithai.com/policy", "text/html", page)):
            records = scrapers._bhumjaithai_policies("https://www.bhumjaithai.com/policy")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["party"], "พรรคภูมิใจไทย")
        self.assertEqual(records[0]["content"], "เพิ่มรถเมล์ [ชุมชน]")
        self.assertEqual(records[0]["source_meta"]["source_policy_id"], "11")

    def test_democrat_api_excludes_news_and_preserves_policy_scope(self):
        categories = [{"id":15,"slug":"all-policies","name":"นโยบายพรรคทั้งหมด","count":2},
                      {"id":9,"slug":"income-policies","name":"เสาที่ 1 : รายได้","count":2},
                      {"id":3,"slug":"bangkok-policy","name":"นโยบาย กทม.","count":1}]
        post = {"id":1,"date":"2026-01-01","title":{"rendered":"ค่าเดินทาง"},"content":{"rendered":"<p>ลดค่าโดยสาร</p>"},"link":"https://www.democrat.or.th/transport/","categories":[15,9]}
        news = {**post, "id":99, "categories":[2]}
        with patch.object(scrapers, "fetch", side_effect=[("", "application/json", json.dumps(categories)), ("", "application/json", json.dumps([post,news]))]):
            records = scrapers._democrat_policies("https://www.democrat.or.th/policies/")
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]["category"],"เสาที่ 1 : รายได้")
        self.assertEqual(records[0]["source_meta"]["scope"],"national")
        bkk = {**post, "categories":[3]}
        with patch.object(scrapers, "fetch", side_effect=[("", "application/json", json.dumps(categories)), ("", "application/json", json.dumps([bkk]))]):
            records = scrapers._democrat_policies("https://www.democrat.or.th/category/policy/bangkok-policy/",True)
        self.assertEqual(records[0]["source_kind"],"candidate_campaign")
        self.assertEqual(records[0]["source_meta"]["scope"],"bangkok")

    def test_unicode_public_url_is_encoded_without_changing_existing_escapes(self):
        self.assertEqual(scrapers._public_url("https://8.8.8.8/นโยบาย?q=ไทย"),"https://8.8.8.8/%E0%B8%99%E0%B9%82%E0%B8%A2%E0%B8%9A%E0%B8%B2%E0%B8%A2?q=%E0%B9%84%E0%B8%97%E0%B8%A2")
        self.assertEqual(scrapers._public_url("https://8.8.8.8/%E0%B8%99?q=1&x=2"),"https://8.8.8.8/%E0%B8%99?q=1&x=2")

    def test_mock_template_has_thai_policy_records_and_provenance(self):
        data = scrapers.scrape("mock")
        self.assertEqual(len(data["policies"]), 10)
        self.assertTrue(all(item["source_kind"] == "mock" and item["source_url"].startswith("mock:") for item in data["policies"]))
        self.assertTrue(all(item["title"] and item["content"] and item["category"] for item in data["policies"]))
        parties = {item["party"] for item in data["policies"]}
        self.assertEqual(len(parties), 2)
        categories = [{item["category"] for item in data["policies"] if item["party"] == party} for party in parties]
        self.assertEqual(categories[0], categories[1])
        self.assertEqual(len(categories[0]), 5)

    def test_bangkok_campaign_flight_data_parser(self):
        page = '$R[1]={id:16,slug:"a-01",title:"Baby Box ของขวัญแรกเกิด",summary:"สนับสนุนครอบครัว",tags:[],contentBlocks:[],category:"เลี้ยงครอบครัวง่าย"}'
        with patch.object(scrapers, "fetch", return_value=("https://bkk2569.peoplesparty.or.th/policy/", "text/html", page)):
            result = scrapers._bkk_election_policies("https://bkk2569.peoplesparty.or.th/policy/")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["title"], "Baby Box ของขวัญแรกเกิด")
        self.assertEqual(result[0]["category"], "เลี้ยงครอบครัวง่าย")
        self.assertEqual(result[0]["source_meta"]["slug"], "a-01")

    def test_refuses_local_network_urls(self):
        for url in ("http://localhost/admin", "http://127.0.0.1/", "http://192.168.1.2/"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                scrapers._public_url(url)


if __name__ == "__main__":
    unittest.main(verbosity=2)
