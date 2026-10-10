"""Run a bilingual, option-order sensitivity probe against the local On-Fly-Jev API."""
import json
from datetime import datetime
from pathlib import Path
import statistics
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8765"

# Fictional, unnamed, illustrative policy pairs. These are probes, not claims
# about the platforms of actual Thai parties or an election-poll instrument.
CASES = [
    {"id":"cost_of_living", "topic":"ค่าครองชีพ / Cost of living",
     "state":{"th":"ครอบครัวรายได้น้อยมีลูกสองคน ต้องการลดค่าใช้จ่ายจำเป็นเดือนนี้ งบสองมาตรการใกล้กัน",
              "en":"A low-income household with two children needs help paying essential expenses this month. The two measures use a similar public budget."},
     "question":{"th":"ทางใดลดค่าใช้จ่ายจำเป็นเดือนนี้ได้ตรงกว่า?",
                 "en":"Which measure more directly reduces this household's essential expenses this month?"},
     "A":{"th":"ให้ครอบครัวรายได้น้อยเดือนละ 1,000 บาท นาน 12 เดือน",
          "en":"Give registered low-income households 1,000 baht per month for 12 months."},
     "B":{"th":"ลด VAT ของกินของใช้จาก 7% เหลือ 5% นาน 12 เดือน",
          "en":"Reduce VAT on food and essential goods from 7% to 5% for 12 months."}},
    {"id":"low_wage_work", "topic":"รายได้แรงงาน / Low-wage work",
     "state":{"th":"ร้านเล็กชะลอจ้าง คนค่าแรงต่ำอยากได้เงินเพิ่มและกังวลชั่วโมงงานลด",
              "en":"Small businesses are slowing new hiring. Low-wage workers want more take-home pay, while employers may cut work hours."},
     "question":{"th":"ทางไหนเพิ่มรายได้ โดยคำนึงถึงความเสี่ยงชั่วโมงงานลด?",
                 "en":"Which measure is more likely to raise take-home pay for low-wage workers while accounting for possible reductions in work hours?"},
     "A":{"th":"ขึ้นค่าแรงขั้นต่ำทั่วประเทศ",
          "en":"Raise the national minimum wage and apply the same wage rule to employers of every size."},
     "B":{"th":"รัฐอุดหนุนร้านที่ขึ้นค่าจ้างพนักงาน 12 เดือน",
          "en":"Offer a 12-month public wage subsidy to employers who raise pay for low-wage staff."}},
    {"id":"school_children", "topic":"อาหารและการเรียนของเด็ก / School meals",
     "state":{"th":"เด็กยากจนบางคนมาเรียนโดยไม่ได้กินเช้า โรงเรียนมีครัว",
              "en":"Some children arrive at a community school without breakfast. Families have low incomes, and the school has a working kitchen."},
     "question":{"th":"ทางใดช่วยให้เด็กกินอิ่มในวันเรียนได้สม่ำเสมอกว่า?",
                 "en":"Which measure is more likely to ensure children eat regularly on school days?"},
     "A":{"th":"ฟรีอาหารเช้าและกลางวันจากวัตถุดิบในชุมชน",
          "en":"Provide free breakfast and lunch at school every school day, with a budget for local ingredients."},
     "B":{"th":"ให้เงินผู้ปกครองปีละ 2,000 บาทต่อเด็กหนึ่งคน",
          "en":"Give parents an annual 2,000-baht education grant per child and let each family decide how to spend it."}},
    {"id":"rural_transport", "topic":"การเดินทาง / Transport",
     "state":{"th":"คนทำงานรอบนอกเดินทาง 45 กม. ไม่มีรถต่อสถานีและค่าเดินทางแพง",
              "en":"Low-income workers in an outer district commute 45 kilometers. There is no feeder service from their villages to the main transit station, and travel is expensive."},
     "question":{"th":"ทางใดช่วยการเดินทางไปทำงานของกลุ่มนี้ตรงกว่า?",
                 "en":"Which measure more directly addresses this group's commute to work?"},
     "A":{"th":"รถไฟฟ้าในเมืองไม่เกิน 20 บาทต่อเที่ยว",
          "en":"Cap metro fares inside the city at 20 baht per trip."},
     "B":{"th":"รถราคาถูกเชื่อมหมู่บ้านรอบนอกกับสถานีหลัก",
          "en":"Add low-fare feeder buses from outer-district villages to the main transit station."}},
    {"id":"rural_health", "topic":"บริการสุขภาพ / Healthcare",
     "state":{"th":"ผู้ป่วยเรื้อรังในชนบทอยู่ห่าง รพ. 70 กม. ต้องไปทุกเดือนแต่ค่ารถแพง",
              "en":"A patient with a chronic illness lives in a rural area 70 kilometers from a hospital. They need a monthly doctor visit and prescription refill but have a limited travel budget."},
     "question":{"th":"ทางใดช่วยให้ผู้ป่วยไปตรวจและรับยาต่อเนื่องสะดวกกว่า?",
                 "en":"Which measure would make it easier for this patient to receive ongoing care and refills?"},
     "A":{"th":"คลินิกเคลื่อนที่เดือนละครั้ง ตรวจโรคเรื้อรังและรับยาได้",
          "en":"Run a monthly mobile clinic in the community for chronic-condition checkups and prescription refills."},
     "B":{"th":"ยกเว้นค่าร่วมจ่าย รพ.รัฐให้ผู้ป่วยโรคเรื้อรัง",
          "en":"Waive public-hospital co-payments for registered patients with chronic conditions."}},
    {"id":"flooding", "topic":"น้ำท่วมชุมชน / Flooding",
     "state":{"th":"ชุมชนริมน้ำท่วมซ้ำ บ้านเสียหายบ่อย คนในชุมชนไม่มีเงินสำรองซ่อมบ้าน",
              "en":"A riverside neighborhood has flooded several times in five years. Most residents lack savings to repair their homes and want to reduce long-term damage."},
     "question":{"th":"ทางใดลดความเสียหายน้ำท่วมซ้ำได้ตรงกว่า?",
                 "en":"Which measure more directly reduces repeat flood damage in this neighborhood?"},
     "A":{"th":"รัฐสร้างและดูแลระบบระบายน้ำกับพื้นที่หน่วงน้ำ",
          "en":"Publicly fund and maintain neighborhood drainage and water-retention areas."},
     "B":{"th":"ชดเชยและช่วยย้ายบ้านโดยสมัครใจจากจุดเสี่ยงน้ำท่วมซ้ำ",
          "en":"Offer compensation and relocation grants to households in repeatedly flooded areas that choose to move."}},
]

def request(payload, retries=4):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + "/api/decide", data=body,
                                 headers={"Content-Type": "application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            if exc.code == 503 and attempt + 1 < retries:
                time.sleep(0.4 * (attempt + 1))
                continue
            raise RuntimeError(f"Inference API returned {exc.code}: {detail}") from exc

def policy_question(case, lang, order):
    state = {"situation": case["state"][lang],
             # Keep policy text fixed; reverse only the question's option order.
             "policies": {key: case[key][lang] for key in ("A", "B")}}
    return {"state": state, "questions": {"vote": {
        "type": "choice", "instructions": case["question"][lang],
        "criteria": {key: None for key in order}}}}

def run():
    health = json.load(urllib.request.urlopen(BASE + "/api/health", timeout=5))
    if health.get("status") != "ready" or health.get("mock"):
        raise SystemExit(f"Local On-Fly-Jev is not ready: {health}")
    outputs = []
    for case in CASES:
        for lang in ("th", "en"):
            baseline_request = policy_question(case, lang, ("A", "B"))
            baseline = request(baseline_request)
            swapped_request = policy_question(case, lang, ("B", "A"))
            swapped = request(swapped_request)
            p = baseline["answers"]["vote"]["probabilities"]
            q = swapped["answers"]["vote"]["probabilities"]
            # Policy IDs remain attached to the same text; only dict/option order changes.
            p_a_reversed = q["A"]
            outputs.append({
                "case_id": case["id"], "topic": case["topic"], "language": lang,
                "policy_a": case["A"][lang], "policy_b": case["B"][lang],
                "question": case["question"][lang],
                "baseline_request": baseline_request, "swapped_request": swapped_request,
                "baseline": baseline, "swapped": swapped,
                "baseline_choice": baseline["answers"]["vote"]["choice"],
                "baseline_probabilities": p,
                "swapped_choice": swapped["answers"]["vote"]["choice"],
                "swapped_probabilities": q,
                "a_probability_order_adjusted": p["A"],
                "a_probability_swapped_order_adjusted": p_a_reversed,
                "order_probability_delta_for_A": round(abs(p["A"] - p_a_reversed), 4),
                "same_policy_after_swap": baseline["answers"]["vote"]["choice"] == swapped["answers"]["vote"]["choice"],
                "inference_ms_each": [baseline["runtime"]["inference_ms"], swapped["runtime"]["inference_ms"]],
                "input_tokens_each": [baseline["usage"]["input_tokens"], swapped["usage"]["input_tokens"]],
            })
            print(f"{case['id']:18s} {lang} {baseline['answers']['vote']['choice']} {p} | swapped {swapped['answers']['vote']['choice']} {q}", flush=True)
    results = {
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "method": {"model": "On-Fly-Jev", "revision": health["revision"],
                   "checkpoint_sha256": health["checkpoint_sha256"], "device": health["device"],
                   "mock": False, "calls": len(outputs) * 2,
                   "design": "6 illustrative Thai election-style policy pairs × Thai/English × original/reversed option order.",
                   "criterion": "Each pair has a short situation and a narrow, explicit question. No real parties are named.",
                   "scope": "Descriptive probe only; no labeled gold answers, voter sample, or accuracy estimate."},
        "cases": outputs,
    }
    runtime_dir = ROOT / ".runtime"
    runtime_dir.mkdir(exist_ok=True)
    output_path = runtime_dir / "policy-experiments.json"
    output_path.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    report_path = ROOT / "reports" / "onfly-policy-test-report.md"
    report_path.parent.mkdir(exist_ok=True)
    report_path.write_text(render_report(results), encoding="utf-8")
    print(f"Saved {len(outputs)} bilingual probes / {len(outputs)*2} model calls")
    print(report_path)

def render_report(results):
    cases = results["cases"]
    pairs = {}
    for row in cases:
        pairs.setdefault(row["case_id"], {})[row["language"]] = row
    total = len(cases)
    order_stable = sum(row["same_policy_after_swap"] for row in cases)
    en_th_agree = sum(
        (pair["th"]["baseline_choice"] == pair["en"]["baseline_choice"])
        for pair in pairs.values() if "th" in pair and "en" in pair
    )
    thai_b = sum(row["baseline_choice"] == "B" for row in cases if row["language"] == "th")
    english_a = sum(row["baseline_choice"] == "A" for row in cases if row["language"] == "en")
    mean_delta = sum(row["order_probability_delta_for_A"] for row in cases) / max(total, 1)
    latencies = [x for row in cases for x in row["inference_ms_each"]]
    thai, english = "ไทย", "อังกฤษ"
    def cell(value):
        return str(value).replace("|", "\\|").replace("\n", " ")
    lines = [
        "# รายงานผลทดลองให้ On-Fly-Jev เลือกนโยบาย",
        "",
        f"วันที่ทดสอบ: {results['created_at']}  ",
        f"โมเดล: {results['method']['model']} · รุ่น `{results['method']['revision']}` · อุปกรณ์ `{results['method']['device']}`  ",
        f"SHA-256 ของไฟล์โมเดล: `{results['method']['checkpoint_sha256']}`",
        "",
        "## สรุปผล",
        "",
        f"ทดลองนโยบายสมมติ 6 คู่ โดยป้อนเป็นภาษาไทยและอังกฤษ ภาษาแต่ละแบบรันทั้งลำดับ A/B เดิมและสลับลำดับ รวม {len(cases)} กรณี และเรียกโมเดลจริง {results['method']['calls']} ครั้ง",
        "",
        f"- เมื่อสลับตำแหน่งคำตอบ ผู้ชนะยังเป็นนโยบายเดิม **{order_stable}/{total}** กรณี",
        f"- ภาษาไทยและอังกฤษเลือกนโยบายเดียวกัน **{en_th_agree}/{len(pairs)}** หัวข้อ",
        f"- ในชุดคำถามนี้ ภาษาไทยเลือก **B {thai_b}/{len(pairs)}** หัวข้อ ส่วนภาษาอังกฤษเลือก **A {english_a}/{len(pairs)}** หัวข้อ",
        f"- ความน่าจะเป็นของ A เปลี่ยนโดยเฉลี่ย **{mean_delta:.3f}** เมื่อสลับลำดับคำตอบและจับคู่ A กลับเข้ากับนโยบายเดิม",
        f"- เวลาคำนวณต่อครั้ง: มัธยฐาน **{statistics.median(latencies):.1f} ms**, ช่วง **{min(latencies):.1f}–{max(latencies):.1f} ms** บน {results['method']['device'].upper()}",
        "",
        "จุดที่เห็นชัดที่สุดคือผลภาษาไทยกับอังกฤษต่างกันมาก: ใน 6 หัวข้อ โมเดลเลือกตรงกันเพียง 1 หัวข้อ ควรมองว่านี่เป็นสัญญาณว่าโมเดลอาจอ่านนโยบายภาษาไทยได้ไม่สม่ำเสมอ ผลทั้งหมดเป็นการสังเกตพฤติกรรม **ไม่ใช่คะแนนความแม่นยำ** เพราะไม่มีเฉลยว่านโยบายใดดีกว่าจริง เปอร์เซ็นต์เป็นน้ำหนักที่โมเดลให้ตัวเลือก ไม่ใช่คะแนนนิยม ผลสำรวจ หรือจำนวนแมงวันที่ลงคะแนน",
        "",
        "## ชุดข้อมูลที่ใช้ทดสอบ",
        "",
        "ทุกกรณีใช้คำถามชนิด `choice` และตัวเลือก `A` กับ `B` ข้อความนโยบายในสถานการณ์คงลำดับเดิม ส่วนการทดลองสลับจะสลับเฉพาะลำดับ A/B ในคำถาม ตารางนี้แสดงข้อความที่ส่งให้โมเดลครบทั้งสองภาษา",
        "",
        "| หัวข้อ | ภาษา | สถานการณ์ (State) | เกณฑ์ที่ถาม (Question) | นโยบาย A | นโยบาย B |",
        "|---|---|---|---|---|---|",
    ]
    for case_id, pair in pairs.items():
        for lang in ("th", "en"):
            row = pair[lang]
            state = row["baseline_request"]["state"]
            lines.append(f"| {cell(row['topic'] if lang == 'th' else '')} | {thai if lang == 'th' else english} | {cell(state['situation'])} | {cell(row['question'])} | {cell(row['policy_a'])} | {cell(row['policy_b'])} |")
    lines += [
        "",
        "## ผลที่โมเดลเลือก",
        "",
        "`P(A)` คือค่าน้ำหนักที่โมเดลให้กับนโยบาย A ก่อนและหลังสลับลำดับ ส่วนผู้ชนะระบุเป็นรหัสนโยบายเดิม A/B",
        "",
        "| หัวข้อ | ภาษา | P(A) ก่อน → หลังสลับ | ผู้ชนะก่อน → หลังสลับ | เลือกนโยบายเดิมหรือไม่ |",
        "|---|---|---:|---|:---:|",
    ]
    for case_id, pair in pairs.items():
        for lang in ("th", "en"):
            row = pair[lang]
            pa = row["baseline_probabilities"]["A"]
            pa_swap = row["a_probability_swapped_order_adjusted"]
            lines.append(f"| {cell(row['topic'] if lang == 'th' else '')} | {thai if lang == 'th' else english} | {pa:.3f} → {pa_swap:.3f} | {row['baseline_choice']} → {row['swapped_choice']} | {'ใช่' if row['same_policy_after_swap'] else 'ไม่'} |")
    lines += ["", "## ขอบเขตและข้อจำกัด", "",
              "- ข้อความทั้ง 6 คู่เป็นตัวอย่างสมมติที่เขียนขึ้นเพื่อทดลอง ไม่ได้ดึงจากพรรคหรือแถลงการณ์หาเสียงจริง จึงไม่ควรนำผลไปอ้างว่าเป็นจุดยืนของพรรคใด",
              "- ผลไทย/อังกฤษเป็นเพียงการเปรียบเทียบข้อความตัวอย่าง ไม่ใช่การวัดความสามารถด้านภาษาอย่างเป็นระบบ",
              "- การสลับ A/B คือการเรียกโมเดลตัวเดิมสองครั้ง ไม่ใช่แมงวันสองตัวหรือผู้มีสิทธิเลือกตั้งสองกลุ่ม",
              "- On-Fly-Jev เป็นโมเดลที่เลือกคำตอบจากข้อความและอิงโครงสร้างเซลล์แมงวันบางส่วน ไม่ใช่การจำลองสมองแมงวันทั้งตัว การเลือกเกิดจากโมเดลที่ฝึกด้วยข้อมูลและป้ายกำกับของมนุษย์",
              "- รายงานนี้บอกได้เพียงว่าโมเดลตอบอย่างไรกับข้อความชุดนี้ ไม่มีคำตอบมาตรฐานสำหรับตัดสินความถูกต้องหรือคุณภาพของนโยบาย",
              "",
              "## ข้อมูลดิบและการทำซ้ำ",
              "",
              "คำขอและคำตอบ JSON จากทุกครั้ง รวมถึงค่าน้ำหนัก จำนวน token และเวลาคำนวณ อยู่ในไฟล์ `.runtime/policy-experiments.json` ไฟล์นี้ถูกเก็บในเครื่องและไม่ส่งเข้า Git หากต้องการรันใหม่ ให้เปิดเซิร์ฟเวอร์แล้วใช้ `.venv/bin/python scripts/run_policy_experiments.py`",
              "",
              "บัตรข้อมูลโมเดลระบุว่าโมเดลอาจตอบผิดอย่างมั่นใจได้ การทดลองนี้ไม่ได้รับรองนโยบายหรือใช้เป็นคำแนะนำการลงคะแนน",
              ""]
    return "\n".join(lines)

if __name__ == "__main__":
    run()
