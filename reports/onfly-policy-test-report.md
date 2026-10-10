# รายงานผลทดลองให้ On-Fly-Jev เลือกนโยบาย

วันที่ทดสอบ: 2026-10-10T15:34:48+07:00  
โมเดล: On-Fly-Jev · รุ่น `e11d5a2a328b34aab7956ae4891b6b34b98425b5` · อุปกรณ์ `cpu`  
SHA-256 ของไฟล์โมเดล: `9e83bb449d9d4e98b8e035c8d518b0a9d6302413532bebcb5ce10982a1a43e2b`

## สรุปผล

ทดลองนโยบายสมมติ 6 คู่ โดยป้อนเป็นภาษาไทยและอังกฤษ ภาษาแต่ละแบบรันทั้งลำดับ A/B เดิมและสลับลำดับ รวม 12 กรณี และเรียกโมเดลจริง 24 ครั้ง

- เมื่อสลับตำแหน่งคำตอบ ผู้ชนะยังเป็นนโยบายเดิม **12/12** กรณี
- ภาษาไทยและอังกฤษเลือกนโยบายเดียวกัน **1/6** หัวข้อ
- ในชุดคำถามนี้ ภาษาไทยเลือก **B 6/6** หัวข้อ ส่วนภาษาอังกฤษเลือก **A 5/6** หัวข้อ
- ความน่าจะเป็นของ A เปลี่ยนโดยเฉลี่ย **0.135** เมื่อสลับลำดับคำตอบและจับคู่ A กลับเข้ากับนโยบายเดิม
- เวลาคำนวณต่อครั้ง: มัธยฐาน **53.4 ms**, ช่วง **30.2–111.7 ms** บน CPU

จุดที่เห็นชัดที่สุดคือผลภาษาไทยกับอังกฤษต่างกันมาก: ใน 6 หัวข้อ โมเดลเลือกตรงกันเพียง 1 หัวข้อ ควรมองว่านี่เป็นสัญญาณว่าโมเดลอาจอ่านนโยบายภาษาไทยได้ไม่สม่ำเสมอ ผลทั้งหมดเป็นการสังเกตพฤติกรรม **ไม่ใช่คะแนนความแม่นยำ** เพราะไม่มีเฉลยว่านโยบายใดดีกว่าจริง เปอร์เซ็นต์เป็นน้ำหนักที่โมเดลให้ตัวเลือก ไม่ใช่คะแนนนิยม ผลสำรวจ หรือจำนวนแมงวันที่ลงคะแนน

## ชุดข้อมูลที่ใช้ทดสอบ

ทุกกรณีใช้คำถามชนิด `choice` และตัวเลือก `A` กับ `B` ข้อความนโยบายในสถานการณ์คงลำดับเดิม ส่วนการทดลองสลับจะสลับเฉพาะลำดับ A/B ในคำถาม ตารางนี้แสดงข้อความที่ส่งให้โมเดลครบทั้งสองภาษา

| หัวข้อ | ภาษา | สถานการณ์ (State) | เกณฑ์ที่ถาม (Question) | นโยบาย A | นโยบาย B |
|---|---|---|---|---|---|
| ค่าครองชีพ / Cost of living | ไทย | ครอบครัวรายได้น้อยมีลูกสองคน ต้องการลดค่าใช้จ่ายจำเป็นเดือนนี้ งบสองมาตรการใกล้กัน | ทางใดลดค่าใช้จ่ายจำเป็นเดือนนี้ได้ตรงกว่า? | ให้ครอบครัวรายได้น้อยเดือนละ 1,000 บาท นาน 12 เดือน | ลด VAT ของกินของใช้จาก 7% เหลือ 5% นาน 12 เดือน |
|  | อังกฤษ | A low-income household with two children needs help paying essential expenses this month. The two measures use a similar public budget. | Which measure more directly reduces this household's essential expenses this month? | Give registered low-income households 1,000 baht per month for 12 months. | Reduce VAT on food and essential goods from 7% to 5% for 12 months. |
| รายได้แรงงาน / Low-wage work | ไทย | ร้านเล็กชะลอจ้าง คนค่าแรงต่ำอยากได้เงินเพิ่มและกังวลชั่วโมงงานลด | ทางไหนเพิ่มรายได้ โดยคำนึงถึงความเสี่ยงชั่วโมงงานลด? | ขึ้นค่าแรงขั้นต่ำทั่วประเทศ | รัฐอุดหนุนร้านที่ขึ้นค่าจ้างพนักงาน 12 เดือน |
|  | อังกฤษ | Small businesses are slowing new hiring. Low-wage workers want more take-home pay, while employers may cut work hours. | Which measure is more likely to raise take-home pay for low-wage workers while accounting for possible reductions in work hours? | Raise the national minimum wage and apply the same wage rule to employers of every size. | Offer a 12-month public wage subsidy to employers who raise pay for low-wage staff. |
| อาหารและการเรียนของเด็ก / School meals | ไทย | เด็กยากจนบางคนมาเรียนโดยไม่ได้กินเช้า โรงเรียนมีครัว | ทางใดช่วยให้เด็กกินอิ่มในวันเรียนได้สม่ำเสมอกว่า? | ฟรีอาหารเช้าและกลางวันจากวัตถุดิบในชุมชน | ให้เงินผู้ปกครองปีละ 2,000 บาทต่อเด็กหนึ่งคน |
|  | อังกฤษ | Some children arrive at a community school without breakfast. Families have low incomes, and the school has a working kitchen. | Which measure is more likely to ensure children eat regularly on school days? | Provide free breakfast and lunch at school every school day, with a budget for local ingredients. | Give parents an annual 2,000-baht education grant per child and let each family decide how to spend it. |
| การเดินทาง / Transport | ไทย | คนทำงานรอบนอกเดินทาง 45 กม. ไม่มีรถต่อสถานีและค่าเดินทางแพง | ทางใดช่วยการเดินทางไปทำงานของกลุ่มนี้ตรงกว่า? | รถไฟฟ้าในเมืองไม่เกิน 20 บาทต่อเที่ยว | รถราคาถูกเชื่อมหมู่บ้านรอบนอกกับสถานีหลัก |
|  | อังกฤษ | Low-income workers in an outer district commute 45 kilometers. There is no feeder service from their villages to the main transit station, and travel is expensive. | Which measure more directly addresses this group's commute to work? | Cap metro fares inside the city at 20 baht per trip. | Add low-fare feeder buses from outer-district villages to the main transit station. |
| บริการสุขภาพ / Healthcare | ไทย | ผู้ป่วยเรื้อรังในชนบทอยู่ห่าง รพ. 70 กม. ต้องไปทุกเดือนแต่ค่ารถแพง | ทางใดช่วยให้ผู้ป่วยไปตรวจและรับยาต่อเนื่องสะดวกกว่า? | คลินิกเคลื่อนที่เดือนละครั้ง ตรวจโรคเรื้อรังและรับยาได้ | ยกเว้นค่าร่วมจ่าย รพ.รัฐให้ผู้ป่วยโรคเรื้อรัง |
|  | อังกฤษ | A patient with a chronic illness lives in a rural area 70 kilometers from a hospital. They need a monthly doctor visit and prescription refill but have a limited travel budget. | Which measure would make it easier for this patient to receive ongoing care and refills? | Run a monthly mobile clinic in the community for chronic-condition checkups and prescription refills. | Waive public-hospital co-payments for registered patients with chronic conditions. |
| น้ำท่วมชุมชน / Flooding | ไทย | ชุมชนริมน้ำท่วมซ้ำ บ้านเสียหายบ่อย คนในชุมชนไม่มีเงินสำรองซ่อมบ้าน | ทางใดลดความเสียหายน้ำท่วมซ้ำได้ตรงกว่า? | รัฐสร้างและดูแลระบบระบายน้ำกับพื้นที่หน่วงน้ำ | ชดเชยและช่วยย้ายบ้านโดยสมัครใจจากจุดเสี่ยงน้ำท่วมซ้ำ |
|  | อังกฤษ | A riverside neighborhood has flooded several times in five years. Most residents lack savings to repair their homes and want to reduce long-term damage. | Which measure more directly reduces repeat flood damage in this neighborhood? | Publicly fund and maintain neighborhood drainage and water-retention areas. | Offer compensation and relocation grants to households in repeatedly flooded areas that choose to move. |

## ผลที่โมเดลเลือก

`P(A)` คือค่าน้ำหนักที่โมเดลให้กับนโยบาย A ก่อนและหลังสลับลำดับ ส่วนผู้ชนะระบุเป็นรหัสนโยบายเดิม A/B

| หัวข้อ | ภาษา | P(A) ก่อน → หลังสลับ | ผู้ชนะก่อน → หลังสลับ | เลือกนโยบายเดิมหรือไม่ |
|---|---|---:|---|:---:|
| ค่าครองชีพ / Cost of living | ไทย | 0.267 → 0.119 | B → B | ใช่ |
|  | อังกฤษ | 0.390 → 0.228 | B → B | ใช่ |
| รายได้แรงงาน / Low-wage work | ไทย | 0.471 → 0.170 | B → B | ใช่ |
|  | อังกฤษ | 0.636 → 0.676 | A → A | ใช่ |
| อาหารและการเรียนของเด็ก / School meals | ไทย | 0.409 → 0.213 | B → B | ใช่ |
|  | อังกฤษ | 0.960 → 0.965 | A → A | ใช่ |
| การเดินทาง / Transport | ไทย | 0.280 → 0.150 | B → B | ใช่ |
|  | อังกฤษ | 0.978 → 0.963 | A → A | ใช่ |
| บริการสุขภาพ / Healthcare | ไทย | 0.499 → 0.155 | B → B | ใช่ |
|  | อังกฤษ | 0.907 → 0.928 | A → A | ใช่ |
| น้ำท่วมชุมชน / Flooding | ไทย | 0.428 → 0.290 | B → B | ใช่ |
|  | อังกฤษ | 0.908 → 0.785 | A → A | ใช่ |

## ขอบเขตและข้อจำกัด

- ข้อความทั้ง 6 คู่เป็นตัวอย่างสมมติที่เขียนขึ้นเพื่อทดลอง ไม่ได้ดึงจากพรรคหรือแถลงการณ์หาเสียงจริง จึงไม่ควรนำผลไปอ้างว่าเป็นจุดยืนของพรรคใด
- ผลไทย/อังกฤษเป็นเพียงการเปรียบเทียบข้อความตัวอย่าง ไม่ใช่การวัดความสามารถด้านภาษาอย่างเป็นระบบ
- การสลับ A/B คือการเรียกโมเดลตัวเดิมสองครั้ง ไม่ใช่แมงวันสองตัวหรือผู้มีสิทธิเลือกตั้งสองกลุ่ม
- On-Fly-Jev เป็นโมเดลที่เลือกคำตอบจากข้อความและอิงโครงสร้างเซลล์แมงวันบางส่วน ไม่ใช่การจำลองสมองแมงวันทั้งตัว การเลือกเกิดจากโมเดลที่ฝึกด้วยข้อมูลและป้ายกำกับของมนุษย์
- รายงานนี้บอกได้เพียงว่าโมเดลตอบอย่างไรกับข้อความชุดนี้ ไม่มีคำตอบมาตรฐานสำหรับตัดสินความถูกต้องหรือคุณภาพของนโยบาย

## ข้อมูลดิบและการทำซ้ำ

คำขอและคำตอบ JSON จากทุกครั้ง รวมถึงค่าน้ำหนัก จำนวน token และเวลาคำนวณ อยู่ในไฟล์ `.runtime/policy-experiments.json` ไฟล์นี้ถูกเก็บในเครื่องและไม่ส่งเข้า Git หากต้องการรันใหม่ ให้เปิดเซิร์ฟเวอร์แล้วใช้ `.venv/bin/python scripts/run_policy_experiments.py`

บัตรข้อมูลโมเดลระบุว่าโมเดลอาจตอบผิดอย่างมั่นใจได้ การทดลองนี้ไม่ได้รับรองนโยบายหรือใช้เป็นคำแนะนำการลงคะแนน
