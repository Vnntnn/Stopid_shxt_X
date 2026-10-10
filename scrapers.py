"""Small, source-aware importers for mock and public election policy pages."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import ipaddress
import json
import re
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_PAGE_BYTES = 12 * 1024 * 1024
USER_AGENT = "FlyDecisionLab/1.0 (local election-policy research tool)"
MOCK_POLICIES = [
    ("พรรคสมมติ A", "รถเมล์ไฟฟ้าราคาคงที่", "เดินทาง", "ปรับรถเมล์เป็นรถไฟฟ้าและกำหนดค่าโดยสารราคาเดียวตลอดเส้นทาง"),
    ("พรรคสมมติ B", "เพิ่มความถี่รถเมล์ช่วงเร่งด่วน", "เดินทาง", "เพิ่มเที่ยวรถช่วงเช้าและเย็น พร้อมตารางเวลารถที่ตรวจสอบได้"),
    ("พรรคสมมติ A", "ศูนย์เด็กเล็กใกล้บ้าน", "คุณภาพชีวิต", "เพิ่มศูนย์ดูแลเด็กเล็กในชุมชนและขยายเวลาให้บริการสำหรับผู้ปกครองที่ทำงาน"),
    ("พรรคสมมติ B", "เงินช่วยค่าเลี้ยงดูเด็ก", "คุณภาพชีวิต", "ช่วยค่าเลี้ยงดูเด็กแก่ครอบครัวรายได้น้อยเพื่อให้เลือกบริการดูแลเด็กเองได้"),
    ("พรรคสมมติ A", "คลินิกชุมชน 24 ชั่วโมง", "สุขภาพ", "ขยายบริการคลินิกปฐมภูมิและสายด่วนให้คำปรึกษาทางสุขภาพตลอดวัน"),
    ("พรรคสมมติ B", "หน่วยแพทย์เยี่ยมบ้าน", "สุขภาพ", "จัดทีมแพทย์เยี่ยมผู้สูงอายุและผู้ป่วยติดบ้านตามนัดหมายเพื่อลดภาระเดินทาง"),
    ("พรรคสมมติ A", "จัดการขยะต้นทาง", "สิ่งแวดล้อม", "แยกขยะตั้งแต่ต้นทางและเปิดเผยผลการจัดเก็บขยะรายเขต"),
    ("พรรคสมมติ B", "เพิ่มจุดรับขยะรีไซเคิล", "สิ่งแวดล้อม", "เพิ่มจุดรับขยะรีไซเคิลใกล้ชุมชนและให้รางวัลตามปริมาณขยะที่นำมาคืน"),
    ("พรรคสมมติ A", "กองทุนร้านค้ารายย่อย", "เศรษฐกิจ", "ให้สินเชื่อดอกเบี้ยต่ำและคำปรึกษาบัญชีแก่ร้านค้ารายย่อยในพื้นที่"),
    ("พรรคสมมติ B", "ตลาดชุมชนลดค่าเช่า", "เศรษฐกิจ", "จัดพื้นที่ขายสินค้าโดยลดค่าเช่าและเพิ่มช่องทางขายออนไลน์ให้ร้านค้ารายย่อย"),
]


def _public_url(url):
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("กรุณาใช้ URL สาธารณะที่ขึ้นต้นด้วย http:// หรือ https://")
    host = parts.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("ไม่อนุญาตให้นำเข้าจาก URL ภายในเครื่อง")
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            addresses = {ipaddress.ip_address(info[4][0]) for info in socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80))}
        except OSError as exc:
            raise ValueError("ไม่พบโดเมนของ URL นี้") from exc
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError("ไม่อนุญาตให้เข้าถึงที่อยู่เครือข่ายภายใน")
    return urlunsplit((parts.scheme, parts.netloc, quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~"),
                      quote(parts.query, safe="%/?@!$&'()*+,;=:-._~"), ""))


class _SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, accept="text/html,application/json;q=0.9,*/*;q=0.5"):
    url = _public_url(url)
    opener = build_opener(_SafeRedirect())
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    try:
        with opener.open(req, timeout=20) as response:
            body = response.read(MAX_PAGE_BYTES + 1)
            if len(body) > MAX_PAGE_BYTES:
                raise ValueError("หน้าเว็บมีขนาดเกิน 12 MB")
            return response.geturl(), response.headers.get_content_type(), body.decode("utf-8", "replace")
    except HTTPError as exc:
        raise ValueError(f"เว็บต้นทางตอบกลับ HTTP {exc.code}") from exc
    except URLError as exc:
        raise ValueError("เชื่อมต่อเว็บต้นทางไม่ได้: " + str(exc.reason)) from exc


def _decode_js_string(value):
    try:
        return json.loads('"' + value + '"')
    except (ValueError, TypeError):
        return value.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"').replace("\\'", "'")


class _Text(HTMLParser):
    DROP = {"script", "style", "noscript", "svg", "nav", "footer"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.drop = 0
        self.text = []
        self.headings = []
        self.current_heading = None
        self.links = []
        self.current_link = None
        self.tables = []
        self.in_table = False
        self.in_row = False
        self.in_cell = False
        self.row = []
        self.cell = []
        self.title = ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in self.DROP:
            self.drop += 1
            return
        if self.drop:
            return
        if tag == "title": self.in_title = True
        if tag in ("h1", "h2", "h3", "h4"):
            self.current_heading = []
        if tag == "a" and attrs.get("href"):
            self.current_link = [attrs["href"], []]
        if tag == "table": self.in_table = True
        if self.in_table and tag == "tr": self.in_row, self.row = True, []
        if self.in_row and tag in ("td", "th"): self.in_cell, self.cell = True, []
        if tag in ("p", "br", "li", "section", "article", "div"):
            self.text.append(" ")

    def handle_endtag(self, tag):
        if tag in self.DROP:
            self.drop = max(0, self.drop - 1)
            return
        if self.drop: return
        if tag == "title": self.in_title = False
        if tag in ("h1", "h2", "h3", "h4") and self.current_heading is not None:
            value = " ".join(" ".join(self.current_heading).split())
            if value: self.headings.append(value)
            self.current_heading = None
        if tag == "a" and self.current_link:
            self.links.append((self.current_link[0], " ".join(" ".join(self.current_link[1]).split())))
            self.current_link = None
        if tag in ("td", "th") and self.in_cell:
            self.row.append(" ".join(" ".join(self.cell).split()))
            self.cell, self.in_cell = [], False
        if tag == "tr" and self.in_row:
            if any(self.row): self.tables.append(self.row)
            self.row, self.in_row = [], False
        if tag == "table": self.in_table = False
        if tag in ("p", "br", "li", "section", "article", "div"):
            self.text.append(" ")

    def handle_data(self, data):
        if self.drop: return
        value = " ".join(data.split())
        if not value: return
        if self.in_title: self.title += value
        self.text.append(value)
        if self.current_heading is not None: self.current_heading.append(value)
        if self.current_link is not None: self.current_link[1].append(value)
        if self.in_cell: self.cell.append(value)


def _page(url):
    actual, content_type, body = fetch(url)
    parser = _Text(); parser.feed(body)
    return actual, body, parser


def _clean(text):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text


def _policy(title, content, category="", source_kind="party_campaign", source_label="", source_url="", party=""):
    title, content = _clean(title), _clean(content)
    if not title: return None
    return {"title": title[:500], "content": content[:50000], "category": _clean(category)[:300],
            "party": party, "source_kind": source_kind, "source_url": source_url,
            "source_label": source_label, "source_meta": {}}


def mock_data():
    return [_policy(title, text, category, "mock", "สองพรรคสมมติ (mock)", "mock://thai-election-demo", party=party)
            for party, title, category, text in MOCK_POLICIES]


def _ptp_policies(url):
    base = "https://election.ptp.or.th/api/v1"
    _, _, categories_text = fetch(base + "/ddl/policy-main-categories", "application/json")
    categories = json.loads(categories_text).get("data", [])
    listings = []
    for category in categories:
        _, _, body = fetch(base + "/policy-categories/" + str(category["id"]), "application/json")
        data = json.loads(body).get("data", {})
        for item in data.get("policies", []):
            listings.append((item, category.get("name", "")))
    def detail(pair):
        item, category = pair
        try:
            _, _, body = fetch(base + "/policies/" + str(item["id"]), "application/json")
            data = json.loads(body).get("data", {})
            html_parser = _Text(); html_parser.feed(data.get("description", ""))
            desc = _clean(" ".join(html_parser.text))
            content = data.get("short_description") or desc or item.get("policy_name", "")
            result = _policy(data.get("title") or item.get("policy_name"), content, category,
                             source_kind="party_campaign", source_label="นโยบายเลือกตั้ง พรรคเพื่อไทย (เว็บไซต์ทางการ)",
                             source_url=url, party="พรรคเพื่อไทย")
            if result: result["source_meta"] = {"source_policy_id": item["id"]}
            return result
        except (ValueError, KeyError, json.JSONDecodeError):
            return _policy(item.get("policy_name"), item.get("policy_name", ""), category,
                           source_kind="party_campaign", source_label="นโยบายเลือกตั้ง พรรคเพื่อไทย (เว็บไซต์ทางการ)",
                           source_url=url, party="พรรคเพื่อไทย")
    with ThreadPoolExecutor(max_workers=8) as pool:
        return [item for item in pool.map(detail, listings) if item]


def _bangkok_tracker(url):
    all_rows, seen = [], set()
    for page in range(0, 10):
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        query["page"] = [str(page)]
        page_url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), ""))
        actual, _, parser = _page(page_url)
        rows = parser.tables
        header_index = next((i for i, row in enumerate(rows) if any("รหัสนโยบาย" in c for c in row)), None)
        if header_index is None: break
        header = rows[header_index]
        indices = {name: next((i for i, value in enumerate(header) if token in value), None)
                   for name, token in (("code", "รหัส"), ("title", "ชื่อ"), ("category", "มิติ"), ("strategy", "ยุทธศาสตร์"))}
        page_rows = []
        for row in rows[header_index + 1:]:
            if len(row) < len(header): continue
            title = row[indices["title"]] if indices["title"] is not None and indices["title"] < len(row) else ""
            code = row[indices["code"]] if indices["code"] is not None and indices["code"] < len(row) else ""
            if not title or "เลือกมิติ" in title or code in seen: continue
            seen.add(code)
            category = row[indices["category"]] if indices["category"] is not None and indices["category"] < len(row) else ""
            strategy = row[indices["strategy"]] if indices["strategy"] is not None and indices["strategy"] < len(row) else ""
            item = _policy(title, f"{title} หมวดมิติ: {category} ยุทธศาสตร์: {strategy}", category,
                           source_kind="bma_tracker", source_label="ตัวติดตามนโยบาย กทม. (รายการกลยุทธ์/action plan)",
                           source_url=actual)
            if item:
                item["source_meta"] = {"policy_code": code, "strategy": strategy,
                                        "source_note": "รายการนโยบาย/กลยุทธ์ของ กทม. ไม่ใช่บัญชีนโยบายหาเสียงผู้สมัคร"}
                page_rows.append(item)
        # Yii's paginator can return the same page for index 0 and 1; keep
        # checking subsequent indices rather than treating the first duplicate
        # page as end-of-data.
        if not page_rows: continue
        all_rows.extend(page_rows)
    if not all_rows: raise ValueError("อ่านตารางนโยบาย กทม. ไม่พบแถวข้อมูล")
    return all_rows


def _bkk_election_policies(url):
    actual, _, parser = _page(url)
    # The official campaign site's server-rendered route data includes title and summary.
    html_actual, _, body = fetch(actual)
    pattern = re.compile(r'id:(\d+),slug:"((?:\\.|[^"])*)",title:"((?:\\.|[^"])*)",summary:"((?:\\.|[^"])*)",tags:')
    matches = list(pattern.finditer(body))
    records = []
    for position, match in enumerate(matches):
        source_id, slug, title, summary = (_decode_js_string(value) for value in match.groups())
        end = matches[position + 1].start() if position + 1 < len(matches) else len(body)
        tail = body[match.end():end]
        category_match = re.search(r'category:"((?:\\.|[^"])*)"', tail)
        category = _decode_js_string(category_match.group(1)) if category_match else "นโยบายกรุงเทพมหานคร"
        item = _policy(title, summary, category, source_kind="candidate_campaign",
                       source_label="นโยบายเลือกตั้ง กทม. พรรคประชาชน (เว็บไซต์แคมเปญ)",
                       source_url=html_actual, party="พรรคประชาชน")
        if item:
            item["source_meta"] = {"source_policy_id": source_id, "slug": slug,
                                    "source_note": "สรุปนโยบายจากข้อมูลที่เผยแพร่โดยแคมเปญผู้สมัคร"}
            records.append(item)
    if records: return records
    return _generic_campaign(url)


def _pp_national(url):
    actual, _, body = fetch(_public_url(url))
    # The official page server-renders a structured React flight payload with
    # one `type:"File"` object per policy; extract its title, summary and
    # parent category without needing a browser runtime.
    pattern = re.compile(
        r'id:\d+,slug:"((?:\\.|[^"])*)",type:"File",title:"((?:\\.|[^"])*)",'
        r'content:(null|"(?:\\.|[^"])*"),'
        r'parentLevel1:\$R\[\d+\]=\{id:\d+,slug:"((?:\\.|[^"])*)",title:"((?:\\.|[^"])*)"\},'
        r'parentLevel2:\$R\[\d+\]=\{id:\d+,slug:"((?:\\.|[^"])*)",title:"((?:\\.|[^"])*)"\},'
        r'summary:(null|"(?:\\.|[^"])*")'
    )
    records = []
    for match in pattern.finditer(body):
        slug, title, content_raw, _pillar_slug, _pillar, category_slug, category, summary_raw = match.groups()
        summary = _decode_js_string(summary_raw[1:-1]) if summary_raw.startswith('"') else ""
        content = _decode_js_string(content_raw[1:-1]) if content_raw.startswith('"') else ""
        item = _policy(title, summary or content or title, category, "party_campaign",
                       "นโยบายเลือกตั้ง พรรคประชาชน (เว็บไซต์ทางการ)", actual, "พรรคประชาชน")
        if item:
            item["source_meta"] = {"slug": _decode_js_string(slug), "category_slug": _decode_js_string(category_slug)}
            records.append(item)
    if records: return records
    return _generic_campaign(actual)


def _generic_campaign(url):
    actual, _, parser = _page(url)
    title = parser.headings[0] if parser.headings else parser.title
    content = _clean(" ".join(parser.text))
    if not content:
        raise ValueError("หน้านี้ไม่มีข้อความนโยบายที่อ่านได้ ลองใช้ URL หน้าเนื้อหานโยบายโดยตรง")
    item = _policy(title or "นโยบายจากหน้าเว็บ", content[:12000], "ไม่ระบุหมวดหมู่",
                   "candidate_campaign", "ข้อมูลจาก URL นโยบายที่ระบุ", actual)
    return [item] if item else []


def _html_text(html):
    parser = _Text()
    parser.feed(html or "")
    return _clean(" ".join(parser.text))


def _democrat_policies(url, bangkok=False):
    """Read the public WordPress policy categories, excluding party news."""
    api = "https://www.democrat.or.th/wp-json/wp/v2"
    _, _, body = fetch(api + "/categories?per_page=100", "application/json")
    categories = json.loads(body)
    slug = "bangkok-policy" if bangkok else "all-policies"
    category = next((item for item in categories if item["slug"] == slug), None)
    if not category:
        raise ValueError("ไม่พบหมวดนโยบายประชาธิปัตย์จากเว็บไซต์ทางการ")
    names = {item["id"]: _html_text(item["name"]) for item in categories}
    records = []
    seen = set()
    for page in range(1, max(1, (int(category["count"]) + 99) // 100) + 1):
        query = urlencode({"categories":category["id"], "per_page":100, "page":page,
                           "_fields":"id,date,title,content,link,categories"})
        _, _, body = fetch(api + "/posts?" + query, "application/json")
        for post in json.loads(body):
            if category["id"] not in post.get("categories", []):
                continue
            if post["id"] in seen:
                continue
            seen.add(post["id"])
            title = _html_text(post["title"]["rendered"])
            content = _html_text(post["content"]["rendered"])
            # Image-only policies cannot support a text comparison.
            if not content:
                continue
            pillar = next((names[c] for c in post.get("categories", []) if names.get(c, "").startswith("เสาที่")), names[category["id"]])
            item = _policy(title, content, pillar, "candidate_campaign" if bangkok else "party_campaign",
                "นโยบาย กทม. พรรคประชาธิปัตย์ (เว็บไซต์ทางการ)" if bangkok else "นโยบายพรรคประชาธิปัตย์ (เว็บไซต์ทางการ)",
                post["link"], "พรรคประชาธิปัตย์")
            if item:
                item["source_meta"] = {"source_policy_id":post["id"], "published_at":post.get("date", ""),
                                       "scope":"bangkok" if bangkok else "national", "listing_url":url}
                records.append(item)
    if not records:
        raise ValueError("ไม่พบข้อความนโยบายประชาธิปัตย์ที่อ่านได้จากแหล่งนี้")
    return records


def _bhumjaithai_policies(url):
    actual, _, body = fetch(url)
    marker = "policies:{posts:["
    start = body.find(marker)
    if start < 0:
        raise ValueError("ไม่พบรายการนโยบายภูมิใจไทยจากเว็บไซต์ทางการ")
    # Extract just the policy array, including nested fields, without executing JS.
    start += len(marker) - 1
    depth, string, escaped, end = 0, None, False, None
    for position in range(start, len(body)):
        char = body[position]
        if string:
            if escaped: escaped = False
            elif char == "\\": escaped = True
            elif char == string: string = None
        elif char in ('"', "'"): string = char
        elif char == "[": depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                end = position
                break
    if end is None:
        raise ValueError("ข้อมูลนโยบายภูมิใจไทยไม่ครบ กรุณาลองใหม่")
    pattern = re.compile(r'\{ID:(\d+),post_author:[^,]+,post_date:[^,]+,post_date_gmt:[^,]+,'
                         r'post_content:"((?:\\.|[^"])*)",post_title:"((?:\\.|[^"])*)"')
    records, seen = [], set()
    for match in pattern.finditer(body[start:end]):
        source_id, content, title = match.groups()
        if source_id in seen: continue
        seen.add(source_id)
        item = _policy(_decode_js_string(title), _html_text(_decode_js_string(content)), "นโยบายพรรค",
                       "party_campaign", "นโยบายพรรคภูมิใจไทย (เว็บไซต์ทางการ)", actual, "พรรคภูมิใจไทย")
        if item and item["content"]:
            item["source_meta"] = {"source_policy_id":source_id, "scope":"national"}
            records.append(item)
    if not records:
        raise ValueError("ไม่พบข้อความนโยบายภูมิใจไทยที่อ่านได้จากแหล่งนี้")
    return records


def scrape(template, url=""):
    if template == "mock": return {"source_kind": "mock", "source_url": "mock://thai-election-demo", "source_label": "ชุดข้อมูลตัวอย่าง (mock)", "policies": mock_data()}
    if template == "bma_tracker":
        target = url or "https://policy.bangkok.go.th/tracking/frontend/web/index.php?r=apolicies261"
        items = _bangkok_tracker(target)
        return {"source_kind": "bma_tracker", "source_url": target, "source_label": "ตัวติดตามนโยบาย กทม. (รายการกลยุทธ์/action plan)", "policies": items}
    if template == "thai_election":
        target = url or "https://election69.peoplesparty.or.th/policy/"
        host = urlsplit(_public_url(target)).hostname or ""
        path = urlsplit(target).path.rstrip("/")
        if host == "election.ptp.or.th": items = _ptp_policies(target)
        elif host == "bkk2569.peoplesparty.or.th": items = _bkk_election_policies(target)
        elif host == "election69.peoplesparty.or.th": items = _pp_national(target)
        elif host in {"www.democrat.or.th", "democrat.or.th"} and path in {"/policies", "/category/party-policies/all-policies", "/category/policy/bangkok-policy"}:
            items = _democrat_policies(target, "bangkok-policy" in path)
        elif host in {"www.bhumjaithai.com", "bhumjaithai.com"} and path == "/policy": items = _bhumjaithai_policies(target)
        else: items = _generic_campaign(target)
        kind = items[0]["source_kind"] if items else "party_campaign"
        return {"source_kind": kind, "source_url": target, "source_label": items[0].get("source_label", "ข้อมูลจาก URL นโยบายที่ระบุ"), "policies": items}
    if template == "bangkok_candidate":
        target = url or "https://bkk2569.peoplesparty.or.th/policy/"
        host = urlsplit(_public_url(target)).hostname or ""
        if host == "bkk2569.peoplesparty.or.th": items = _bkk_election_policies(target)
        elif host in {"www.democrat.or.th", "democrat.or.th"} and "bangkok-policy" in urlsplit(target).path:
            items = _democrat_policies(target, True)
        else: items = _generic_campaign(target)
        return {"source_kind": "candidate_campaign", "source_url": target, "source_label": items[0].get("source_label", "ข้อมูลจาก URL นโยบายผู้สมัคร"), "policies": items}
    raise ValueError("ไม่รู้จักเทมเพลตข้อมูลนี้")
