"""BOSS直聘投递追踪 - 本地服务（Python 3.9+ 标准库，无第三方依赖）。

启动：python server/app.py  →  http://127.0.0.1:8787
只绑定 127.0.0.1，数据不出本机；管理页与 API 同源，无需跨域配置
（仍输出宽松 CORS 头以兼容扩展等本机调用方）。
"""
import csv
import io
import json
import os
import pathlib
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

try:
    from . import db, ingest, normalize, settings, statemachine, stats
except ImportError:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import db, ingest, normalize, settings, statemachine, stats

HOST = "127.0.0.1"
PORT = int(os.environ.get("TRACKER_PORT", "8787"))
WEB_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web"))

_manual_requests = []          # {id, requested_at}；由扩展原子领取，避免重复执行
_manual_lock = threading.Lock()

SORTABLE = {
    "applied_at": "COALESCE(NULLIF(a.applied_at, ''), a.created_at)",
    "updated_at": "a.updated_at",
    "created_at": "a.created_at",
    "last_change_at": "a.last_change_at",
    "salary_max_k": "j.salary_max_k",
    "company_name": "j.company_name",
}

CSV_COLUMNS = [
    ("记录ID", "id"), ("公司", "company_name"), ("岗位", "title"), ("城市", "city"),
    ("行业", "industry"), ("公司规模", "company_size"), ("薪酬原文", "salary_raw"),
    ("薪酬下限(K)", "salary_min_k"), ("薪酬上限(K)", "salary_max_k"), ("发薪月数", "salary_months"),
    ("招聘阶段", "stage"), ("查看状态", "viewed"), ("投递批次", "attempt"),
    ("投递时间", "applied_at"), ("投递时间来源", "applied_at_source"),
    ("投递时间精度", "applied_at_precision"),
    ("最近状态变化", "last_change_at"), ("最近消息", "last_message_at"), ("最近回复", "last_reply_at"),
    ("回复耗时(小时)", "reply_latency_hours"), ("面试时间", "interview_at"),
    ("HR", "hr_name"), ("HR活跃度", "hr_activity"), ("备注", "note"), ("职位链接", "url"),
    ("发送状态", "send_status"), ("记录来源", "source"),
]


class _HttpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "BossTracker/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静模式：常规访问不刷控制台
        pass

    # ---- 基础收发 ----------------------------------------------------------
    def _send(self, code, body, content_type="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        if length > 25 * 1024 * 1024:
            raise _HttpError(413, "请求过大，页面样本需小于 25 MB")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PATCH(self):
        self._route("PATCH")

    # ---- 路由 --------------------------------------------------------------
    def _route(self, method):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        conn = None
        try:
            conn = db.connect()
            if method == "GET":
                if path == "/api/health":
                    return self._send(200, {"ok": True, "db": str(db._db_path())})
                if path == "/api/applications":
                    return self._send(200, _query_applications(conn, qs))
                if path == "/api/contact-snapshots":
                    return self._send(200, _query_contact_snapshots(conn, qs))
                m = re.fullmatch(r"/api/applications/(\d+)", path)
                if m:
                    return self._send(200, _application_detail(conn, int(m.group(1))))
                if path == "/api/stats":
                    return self._send(200, stats.get_stats(
                        conn,
                        int(qs.get("stale_days", 7)),
                        date_from=qs.get("date_from"),
                        date_to=qs.get("date_to"),
                    ))
                if path == "/api/meta":
                    return self._send(200, _meta(conn))
                if path == "/api/settings":
                    return self._send(200, settings.public())
                if path == "/api/resume":
                    resume = settings.resume_file()
                    if not resume:
                        raise _HttpError(404, "尚未配置简历图片")
                    resume_path, mime, _name = resume
                    return self._send(200, resume_path.read_bytes(), content_type=mime)
                if path == "/api/pending":
                    return self._send(200, _pending_events(conn))
                if path == "/api/export.csv":
                    body = _export_csv(conn, qs)
                    return self._send(200, body, content_type="text/csv; charset=utf-8")
                if path == "/api/sync/want":
                    with _manual_lock:
                        _purge_sync_requests()
                        want = bool(_manual_requests)
                    return self._send(200, {"want": want})
                if path.startswith("/api/"):
                    return self._send(404, {"error": "not found"})
                return self._static(path)

            if method == "POST":
                if path == "/api/ingest":
                    return self._send(200, ingest.ingest_payload(conn, self._json_body()))
                if path == "/api/applications/record":
                    return self._send(200, _record_application(conn, self._json_body()))
                if path == "/api/contact-snapshots":
                    return self._send(200, _record_contact_snapshot(conn, self._json_body()))
                if path == "/api/settings/resume":
                    p = self._json_body()
                    try:
                        resume = settings.save_resume(p.get("data_url", ""), p.get("filename", ""))
                    except ValueError as exc:
                        raise _HttpError(400, str(exc)) from exc
                    return self._send(200, {"ok": True, "resume": resume})
                if path == "/api/sample":
                    return self._send(200, _save_sample(self._json_body()))
                if path == "/api/sync/request":
                    request_id = uuid.uuid4().hex
                    with _manual_lock:
                        _purge_sync_requests()
                        _manual_requests.append({"id": request_id, "requested_at": time.time()})
                    return self._send(200, {"ok": True,
                        "request_id": request_id,
                        "message": "已请求同步：浏览器扩展将在约1分钟内采集当前打开的BOSS直聘页面"})
                if path == "/api/sync/claim":
                    with _manual_lock:
                        _purge_sync_requests()
                        request = _manual_requests.pop(0) if _manual_requests else None
                    return self._send(200, {
                        "want": bool(request),
                        "request_id": request["id"] if request else None,
                    })
                if path == "/api/sync/report":
                    p = self._json_body()
                    ingest.log_sync_run(conn, source=p.get("source", "extension"),
                                        status=p.get("status", "paused"),
                                        message=p.get("message", ""))
                    return self._send(200, {"ok": True})
                return self._send(404, {"error": "not found"})

            if method == "PATCH":
                if path == "/api/settings":
                    try:
                        return self._send(200, settings.update(self._json_body()))
                    except ValueError as exc:
                        raise _HttpError(400, str(exc)) from exc
                m = re.fullmatch(r"/api/applications/(\d+)", path)
                if m:
                    return self._send(200, _patch_application(conn, int(m.group(1)), self._json_body()))
                return self._send(404, {"error": "not found"})
        except _HttpError as e:
            return self._send(e.code, {"error": e.message})
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self._send(500, {"error": str(e)})
        finally:
            if conn:
                conn.close()

    def _static(self, path):
        if path in ("/", "/index.html"):
            path = "/index.html"
        fname = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not fname.startswith(WEB_DIR) or not os.path.isfile(fname):
            return self._send(404, {"error": "not found"})
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8"}.get(os.path.splitext(fname)[1], "application/octet-stream")
        with open(fname, "rb") as f:
            return self._send(200, f.read(), content_type=ctype)


# ---- API 实现 ---------------------------------------------------------------


def _purge_sync_requests():
    cutoff = time.time() - 90
    _manual_requests[:] = [r for r in _manual_requests if r["requested_at"] >= cutoff]


def _save_sample(body):
    page_url = str(body.get("page_url") or "").strip()
    html = str(body.get("html") or "")
    title = str(body.get("title") or "页面").strip()
    captured = str(body.get("captured_at") or db.now())
    if not page_url.startswith("https://www.zhipin.com/"):
        raise _HttpError(400, "只允许保存 BOSS 直聘页面样本")
    if not html or "<html" not in html[:1000].lower():
        raise _HttpError(400, "页面 HTML 为空或格式不正确")

    sample_dir = pathlib.Path(os.environ.get("TRACKER_SAMPLE_DIR") or (
        pathlib.Path(__file__).resolve().parent.parent / "docs" / "samples"
    ))
    sample_dir.mkdir(parents=True, exist_ok=True)
    stamp = re.sub(r"\D", "", captured)[:14] or time.strftime("%Y%m%d%H%M%S")
    safe_title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip(" ._")[:70] or "页面"
    candidate = sample_dir / f"{stamp}-{safe_title}.html"
    suffix = 2
    while candidate.exists():
        candidate = sample_dir / f"{stamp}-{safe_title}-{suffix}.html"
        suffix += 1
    candidate.write_text(html, encoding="utf-8")
    return {"ok": True, "name": candidate.name, "path": str(candidate), "bytes": candidate.stat().st_size}


def _job_payload(body):
    source = body.get("job") if isinstance(body.get("job"), dict) else body
    job = {}
    for key in ("job_key", "title", "company_name", "company_size", "industry",
                "financing_stage", "city", "address", "experience", "education",
                "salary_raw", "salary_capture_status", "url", "jd_text"):
        value = str(source.get(key) or "").strip()
        if value:
            job[key] = value
    tags = source.get("job_tags")
    if isinstance(tags, list):
        job["job_tags"] = list(dict.fromkeys(
            str(tag).strip() for tag in tags if str(tag).strip()
        ))[:50]
    if not job.get("job_key"):
        match = re.search(r"/job_detail/([^.?/]+)\.html", job.get("url", ""))
        if match:
            job["job_key"] = match.group(1)
    if not job.get("job_key"):
        raise _HttpError(400, "当前岗位缺少稳定职位标识，请重新打开职位详情")
    hr = source.get("hr")
    if isinstance(hr, dict):
        job["hr"] = {k: str(v or "").strip() for k, v in hr.items() if v}
    return job


def _record_application(conn, body):
    status = str(body.get("workflow_status") or "").strip()
    allowed = {
        "confirmed", "image_sent", "greeting_sent", "complete",
        "image_failed", "greeting_failed",
    }
    if status not in allowed:
        raise _HttpError(400, "非法发送状态")
    job = _job_payload(body)
    captured = str(body.get("captured_at") or db.now())
    item = dict(job)
    item["stage_text"] = "已投递" if status == "complete" else "已沟通"
    if status == "complete":
        item["applied_time_text"] = captured
        item["last_message_time_text"] = captured
    result = ingest.ingest_payload(conn, {
        "page_type": "辅助投递",
        "page_url": job.get("url", ""),
        "captured_at": captured,
        "application": True,
        "items": [item],
    })
    row = conn.execute(
        "SELECT a.* FROM application a JOIN job j ON j.id = a.job_id "
        "WHERE j.job_key = ? ORDER BY a.attempt DESC LIMIT 1",
        (job["job_key"],),
    ).fetchone()
    if not row:
        raise _HttpError(500, "投递记录写入失败")
    row = dict(row)
    error = str(body.get("error") or "").strip()[:1000] or None
    if row.get("send_status") != "complete" or status == "complete":
        conn.execute(
            "UPDATE application SET source = '辅助投递', send_status = ?, send_error = ?, "
            "updated_at = ? WHERE id = ?",
            (status, error, db.now(), row["id"]),
        )
        if row.get("send_status") != status:
            conn.execute(
                "INSERT INTO status_event (application_id, field, old_value, new_value, evidence, "
                "confidence, applied, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (row["id"], "send_status", row.get("send_status"), status,
                 error or "辅助投递流程", "确定", 1, captured, db.now()),
            )
        conn.commit()
    return {"ok": True, "workflow_status": status, "ingest": result,
            "record": _application_detail(conn, row["id"])}


_CONTACT_STAY_LABELS = {
    "留在当前页", "留在本页", "留在当前页面", "继续留在当前页", "留在此页",
}
_CONTACT_JOB_FIELDS = (
    "job_key", "title", "company_name", "company_size", "industry",
    "financing_stage", "city", "address", "experience", "education",
    "salary_raw", "salary_dom_raw", "salary_font_family", "url", "jd_text",
)


def _compact_text(value):
    return re.sub(r"\s+", "", str(value or "")).strip()


def _short_text(value, limit=500):
    return str(value or "").strip()[:limit]


def _json_string_list(value, limit=50):
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(
        _short_text(item, 200) for item in value if _short_text(item, 200)
    ))[:limit]


def _unicode_codepoints(value):
    return [f"U+{ord(character):04X}" for character in str(value or "")]


_SALARY_DECODE_METHOD = "pua_codepoint_minus_e031"


def _decode_pua_salary(value):
    """按用户确认的 BOSS 字体规则解码；遇到其他私用区码点时拒绝猜测。"""
    decoded = []
    found = False
    for character in str(value or ""):
        codepoint = ord(character)
        if 0xE000 <= codepoint <= 0xF8FF:
            found = True
            if not 0xE031 <= codepoint <= 0xE03A:
                return None
            decoded.append(str(codepoint - 0xE031))
        else:
            decoded.append(character)
    return "".join(decoded) if found else None


def _derive_snapshot_salary(snapshot):
    """为保留了原始字符的历史快照计算派生薪资，不修改数据库原文。"""
    job = snapshot.get("job") if isinstance(snapshot.get("job"), dict) else None
    if not job:
        return snapshot
    dom_salary = str(job.get("salary_dom_raw") or "")
    decoded = _decode_pua_salary(dom_salary)
    if decoded is None:
        return snapshot
    parsed = normalize.parse_salary(decoded) or {}
    job["salary_raw"] = decoded
    job["salary_min_k"] = parsed.get("salary_min_k")
    job["salary_max_k"] = parsed.get("salary_max_k")
    job["salary_months"] = parsed.get("salary_months")
    job["salary_capture_status"] = "font_decoded"
    job["salary_decode_method"] = _SALARY_DECODE_METHOD
    capture = snapshot.get("capture") if isinstance(snapshot.get("capture"), dict) else {}
    warnings = [warning for warning in _json_string_list(capture.get("warnings"))
                if warning not in ("salary_font_obfuscated", "salary_font_decoded")]
    warnings.append("salary_font_decoded")
    capture["warnings"] = warnings
    snapshot["capture"] = capture
    return snapshot


def _contact_event_response(row, duplicate=False):
    snapshot = _derive_snapshot_salary(json.loads(row["snapshot_json"]))
    snapshot["record_id"] = row["id"]
    snapshot["duplicate"] = duplicate
    return snapshot


def _record_contact_snapshot(conn, body):
    if not isinstance(body, dict):
        raise _HttpError(400, "岗位快照格式不正确")
    event_id = _short_text(body.get("event_id"), 200)
    if not re.fullmatch(r"boss-contact:[0-9A-Za-z:_-]+", event_id):
        raise _HttpError(400, "无效的岗位快照事件标识")
    existing = conn.execute(
        "SELECT * FROM contact_event WHERE event_id = ?", (event_id,)
    ).fetchone()
    if existing:
        return {"ok": True, "duplicate": True,
                "snapshot": _contact_event_response(existing, duplicate=True)}

    action_in = body.get("action") if isinstance(body.get("action"), dict) else {}
    dialog_text = _short_text(action_in.get("success_dialog"), 100)
    stay_text = _short_text(action_in.get("stay_button_text"), 100)
    if _compact_text(dialog_text) != "已向BOSS发送消息":
        raise _HttpError(400, "缺少平台沟通成功证据")
    if _compact_text(stay_text) not in _CONTACT_STAY_LABELS:
        raise _HttpError(400, "留页按钮文案不受支持")

    captured = _short_text(body.get("captured_at") or db.now(), 64)
    source = _short_text(body.get("source") or "boss_stay_on_page", 100)
    job_in = body.get("job") if isinstance(body.get("job"), dict) else {}
    job = {}
    for key in _CONTACT_JOB_FIELDS:
        limit = 100000 if key == "jd_text" else 2000
        value = _short_text(job_in.get(key), limit)
        if value:
            job[key] = value
    if not job.get("job_key"):
        match = re.search(r"/job_detail/([^.?/]+)\.html", job.get("url", ""))
        if match:
            job["job_key"] = match.group(1)
    job["job_tags"] = _json_string_list(job_in.get("job_tags"))

    raw_salary = job.get("salary_raw", "")
    dom_salary = job.get("salary_dom_raw", "")
    requested_salary_status = _short_text(job_in.get("salary_capture_status"), 40)
    if not dom_salary and re.search(r"[\uE000-\uF8FF]", raw_salary):
        dom_salary = raw_salary
    salary_decode_method = None
    if re.search(r"[\uE000-\uF8FF]", raw_salary) or re.search(r"[\uE000-\uF8FF]", dom_salary):
        decoded_salary = _decode_pua_salary(dom_salary or raw_salary)
        if decoded_salary is not None:
            raw_salary = decoded_salary
            salary_status = "font_decoded"
            salary_decode_method = _SALARY_DECODE_METHOD
        else:
            raw_salary = ""
            job.pop("salary_raw", None)
            salary_status = "font_obfuscated"
    elif raw_salary:
        salary_status = "readable"
    elif requested_salary_status == "font_obfuscated":
        salary_status = "font_obfuscated"
    else:
        salary_status = "missing"
    job["salary_raw"] = raw_salary
    job["salary_dom_raw"] = dom_salary
    job["salary_codepoints"] = _unicode_codepoints(dom_salary)
    job["salary_capture_status"] = salary_status
    job["salary_decode_method"] = salary_decode_method
    parsed_salary = normalize.parse_salary(raw_salary)
    job["salary_min_k"] = parsed_salary.get("salary_min_k") if parsed_salary else None
    job["salary_max_k"] = parsed_salary.get("salary_max_k") if parsed_salary else None
    job["salary_months"] = parsed_salary.get("salary_months") if parsed_salary else None

    hr_in = job_in.get("hr") if isinstance(job_in.get("hr"), dict) else {}
    hr = {}
    for source_key, target_key in (
        ("hr_key", "hr_key"), ("name", "name"), ("title", "title"),
        ("activity_text", "activity_text"),
    ):
        value = _short_text(hr_in.get(source_key), 500)
        if value:
            hr[target_key] = value
    if hr.get("activity_text"):
        hr["activity_captured_at"] = _short_text(
            hr_in.get("activity_captured_at") or captured, 64
        )
    job["hr"] = hr

    required = [key for key in ("job_key", "title", "jd_text") if not job.get(key)]
    capture_in = body.get("capture") if isinstance(body.get("capture"), dict) else {}
    missing = list(dict.fromkeys(
        required + _json_string_list(capture_in.get("missing_fields"))
    ))
    warnings = [warning for warning in _json_string_list(capture_in.get("warnings"))
                if warning not in ("salary_font_obfuscated", "salary_font_decoded")]
    if salary_status == "font_obfuscated":
        warnings.append("salary_font_obfuscated")
    elif salary_status == "font_decoded":
        warnings.append("salary_font_decoded")
    capture_status = "failed" if required else "complete"
    action = {
        "button_text": _short_text(action_in.get("button_text"), 100),
        "success_dialog": dialog_text,
        "stay_button_text": stay_text,
        "stay_button_clicked": bool(action_in.get("stay_button_clicked")),
    }
    snapshot = {
        "event_id": event_id,
        "source": source,
        "captured_at": captured,
        "action": action,
        "job": job,
        "capture": {
            "status": capture_status,
            "missing_fields": missing,
            "warnings": warnings,
        },
    }
    snapshot_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))

    job_id = hr_id = None
    ingest_result = None
    if not required:
        item = dict(job)
        item["stage_text"] = "已沟通"
        item["last_message_time_text"] = captured
        item["record_source"] = "沟通岗位快照"
        item["contact_event"] = {
            "event_id": event_id,
            "success_dialog_text": dialog_text,
            "stay_button_clicked": action["stay_button_clicked"],
        }
        ingest_result = ingest.ingest_payload(conn, {
            "page_type": "沟通岗位快照",
            "page_url": job.get("url", ""),
            "captured_at": captured,
            "application": True,
            "items": [item],
        })
        if ingest_result.get("errors"):
            raise _HttpError(500, "岗位快照写入失败")
        job_row = conn.execute(
            "SELECT id FROM job WHERE job_key = ?", (job["job_key"],)
        ).fetchone()
        job_id = job_row["id"] if job_row else None
        if job_id:
            app_row = conn.execute(
                "SELECT hr_id FROM application WHERE job_id = ? ORDER BY attempt DESC LIMIT 1",
                (job_id,),
            ).fetchone()
            hr_id = app_row["hr_id"] if app_row else None

    conn.execute(
        "INSERT OR IGNORE INTO contact_event "
        "(event_id, job_id, hr_id, action_label, success_dialog_text, contacted_at, "
        "stay_button_text, stay_button_clicked, capture_status, missing_fields_json, "
        "warnings_json, snapshot_json, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (event_id, job_id, hr_id, action["button_text"] or None, dialog_text, captured,
         stay_text, 1 if action["stay_button_clicked"] else 0, capture_status,
         json.dumps(missing, ensure_ascii=False), json.dumps(warnings, ensure_ascii=False),
         snapshot_json, source, db.now()),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM contact_event WHERE event_id = ?", (event_id,)).fetchone()
    return {"ok": True, "duplicate": False, "ingest": ingest_result,
            "snapshot": _contact_event_response(row)}


def _query_contact_snapshots(conn, qs):
    try:
        limit = int(qs.get("limit", 20))
    except (TypeError, ValueError):
        raise _HttpError(400, "limit 必须是整数")
    limit = max(1, min(limit, 100))
    rows = conn.execute(
        "SELECT * FROM contact_event ORDER BY contacted_at DESC, id DESC LIMIT ?", (limit,)
    ).fetchall()
    total = conn.execute("SELECT COUNT(*) FROM contact_event").fetchone()[0]
    return {"total": total, "items": [_contact_event_response(row) for row in rows]}


def _build_filters(qs):
    where, params = ["1=1"], []
    if qs.get("q"):
        like = f"%{qs['q']}%"
        where.append("(j.company_name LIKE ? OR j.title LIKE ? OR j.industry LIKE ? OR a.note LIKE ?)")
        params += [like] * 4
    for key, col in (("stage", "a.stage"), ("viewed", "a.viewed"),
                     ("industry", "j.industry"), ("company_size", "j.company_size")):
        if qs.get(key):
            where.append(f"{col} = ?")
            params.append(qs[key])
    if qs.get("date_from"):
        where.append("date(COALESCE(NULLIF(a.applied_at, ''), a.created_at)) >= date(?)")
        params.append(qs["date_from"])
    if qs.get("date_to"):
        where.append("date(COALESCE(NULLIF(a.applied_at, ''), a.created_at)) <= date(?)")
        params.append(qs["date_to"])
    if qs.get("salary_min_k"):
        where.append("j.salary_max_k >= ?")
        params.append(float(qs["salary_min_k"]))
    return " AND ".join(where), params


_BASE_FROM = ("FROM application a JOIN job j ON j.id = a.job_id "
              "LEFT JOIN hr h ON h.id = a.hr_id")
_SELECT_COLS = ("a.*, j.title, j.company_name, j.company_size, j.industry, j.city,"
               " j.salary_raw, j.salary_min_k, j.salary_max_k, j.salary_months, j.url, j.job_key,"
               " j.jd_text,"
               " h.name AS hr_name, h.title AS hr_title, h.activity_raw AS hr_activity")


def _query_applications(conn, qs):
    where_sql, params = _build_filters(qs)
    total = conn.execute(f"SELECT COUNT(*) {_BASE_FROM} WHERE {where_sql}", params).fetchone()[0]
    sort_col = SORTABLE.get(qs.get("sort"), SORTABLE["applied_at"])
    order = "ASC" if str(qs.get("order", "desc")).lower() == "asc" else "DESC"
    limit = min(int(qs.get("limit") or 500), 100000)
    offset = int(qs.get("offset") or 0)
    sql = (f"SELECT {_SELECT_COLS} {_BASE_FROM} WHERE {where_sql} "
           f"ORDER BY ({sort_col} IS NULL), {sort_col} {order}, a.id DESC LIMIT ? OFFSET ?")
    rows = [dict(r) for r in conn.execute(sql, (*params, limit, offset))]
    return {"items": rows, "total": total}


def _application_detail(conn, app_id):
    row = conn.execute(f"SELECT {_SELECT_COLS} {_BASE_FROM} WHERE a.id = ?", (app_id,)).fetchone()
    if not row:
        raise _HttpError(404, "记录不存在")
    events = [dict(r) for r in conn.execute(
        "SELECT * FROM status_event WHERE application_id = ? ORDER BY id DESC", (app_id,))]
    return {"application": dict(row), "events": events}


def _pending_events(conn):
    rows = [dict(r) for r in conn.execute(
        f"SELECT e.*, j.company_name, j.title FROM status_event e "
        f"JOIN application a ON a.id = e.application_id JOIN job j ON j.id = a.job_id "
        f"WHERE e.applied = 0 ORDER BY e.id DESC LIMIT 200")]
    return {"items": rows}


def _patch_application(conn, app_id, body):
    row = conn.execute("SELECT * FROM application WHERE id = ?", (app_id,)).fetchone()
    if not row:
        raise _HttpError(404, "记录不存在")
    row = dict(row)
    now = db.now()
    updates, events = {}, []

    if body.get("stage") is not None:
        if body["stage"] not in statemachine.ALL_STAGES:
            raise _HttpError(400, f"非法阶段: {body['stage']}")
        if body["stage"] != row["stage"]:
            updates["stage"] = body["stage"]
            updates["last_change_at"] = now
            events.append(("stage", row["stage"], body["stage"], "人工修正"))
            idx = statemachine.stage_index(body["stage"])
            if idx is not None and idx >= 0:
                updates["ever_applied"] = 1
            if idx is not None and idx >= 2:
                updates["ever_interview"] = 1

    if body.get("viewed") is not None:
        if body["viewed"] not in statemachine.VIEWED_OPTIONS:
            raise _HttpError(400, f"非法查看状态: {body['viewed']}")
        if body["viewed"] != row["viewed"]:
            updates["viewed"] = body["viewed"]
            updates["last_change_at"] = now
            events.append(("viewed", row["viewed"], body["viewed"], "人工修正"))

    if "applied_at" in body:
        v = str(body.get("applied_at") or "").strip()
        if v != (row["applied_at"] or ""):
            updates["applied_at"] = v or None
            updates["applied_at_source"] = "人工" if v else None
            updates["applied_at_precision"] = (
                "秒" if len(v) >= 19 else "分钟" if len(v) >= 16 else "日期" if len(v) >= 10 else None
            )
            events.append(("applied_at", row["applied_at"], v or "（清空）", "人工补录"))

    if "interview_at" in body:
        updates["interview_at"] = str(body.get("interview_at") or "").strip() or None
    if "note" in body:
        updates["note"] = body.get("note")

    if "manual_locked" in body:
        updates["manual_locked"] = 1 if body["manual_locked"] else 0
    elif "stage" in updates or "viewed" in updates:
        updates["manual_locked"] = 1  # 人工修正默认加锁，防被页面旧数据覆盖

    if updates:
        updates["updated_at"] = now
        sets = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(f"UPDATE application SET {sets} WHERE id = ?", (*updates.values(), app_id))
        for field, old, new, evidence in events:
            conn.execute(
                "INSERT INTO status_event (application_id, field, old_value, new_value, evidence,"
                " confidence, applied, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (app_id, field, old, new, evidence, "确定", 1, now, now))
        conn.commit()
    return _application_detail(conn, app_id)


def _meta(conn):
    industries = [r[0] for r in conn.execute(
        "SELECT DISTINCT industry FROM job WHERE industry IS NOT NULL AND industry != '' ORDER BY industry")]
    sizes = [r[0] for r in conn.execute(
        "SELECT DISTINCT company_size FROM job WHERE company_size IS NOT NULL AND company_size != '' ORDER BY company_size")]
    return {"stages": statemachine.ALL_STAGES, "viewed": statemachine.VIEWED_OPTIONS,
            "industries": industries, "company_sizes": sizes}


def _export_csv(conn, qs):
    rows = _query_applications(conn, {**qs, "limit": "100000"})["items"]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([h for h, _ in CSV_COLUMNS])
    for r in rows:
        writer.writerow(["" if r.get(k) is None else r.get(k) for _, k in CSV_COLUMNS])
    return b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")  # BOM 便于 Excel 直接打开


def main():
    db.init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[boss-tracker] 服务已启动: http://{HOST}:{PORT}  （Ctrl+C 退出）")
    print(f"[boss-tracker] 数据库: {db._db_path()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
