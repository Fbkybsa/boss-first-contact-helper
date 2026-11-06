"""冒烟测试：不联网、不访问账号，直接对本地服务发请求，验证核心链路。

覆盖：建库 → 采集入库 → 去重/再次投递开新批次 → 状态机（前进/拒绝/人工保护）
→ 待确认事件 → 统计口径 → 筛选/排序 → 人工修正 → CSV 导出。

运行：python tests/smoke.py
"""
import json
import os
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
_TEST_DIR = tempfile.TemporaryDirectory(prefix="boss-smoke-", dir=os.path.join(ROOT, "tests"))
TEST_ROOT = _TEST_DIR.name
os.environ["TRACKER_DB"] = os.path.join(TEST_ROOT, "smoke.db")
os.environ["TRACKER_SAMPLE_DIR"] = os.path.join(TEST_ROOT, "samples")
os.environ["TRACKER_SETTINGS"] = os.path.join(TEST_ROOT, "private-settings.json")
os.environ["TRACKER_RESUME_DIR"] = os.path.join(TEST_ROOT, "private")

from http.server import ThreadingHTTPServer  # noqa: E402

from server import db, normalize  # noqa: E402
from server.app import Handler  # noqa: E402


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


PORT = free_port()
httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
server_thread.start()
BASE = f"http://127.0.0.1:{PORT}"

db.init_db()


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def get_raw(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as resp:
        return resp.status, resp.read().decode("utf-8")


def get_bytes(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as resp:
        return resp.status, resp.headers.get_content_type(), resp.read()


def check(name, cond, detail=""):
    if not cond:
        raise AssertionError(f"FAIL: {name}  {detail}")
    print(f"  ok - {name}")


P1 = {
    "page_type": "smoke_chat_list", "captured_at": "2026-09-12 10:00:00",
    "items": [
        {"job_key": "j-1001", "title": "Python开发工程师", "company_name": "示例科技",
         "company_size": "500-999人", "industry": "互联网", "city": "北京",
         "salary_raw": "20-35K·16薪", "url": "https://www.zhipin.com/job_detail/j-1001.html",
         "stage_text": "已沟通", "last_message_time_text": "3小时前",
         "hr": {"name": "测试HR乙", "title": "招聘经理", "activity_text": "今日活跃"}},
        {"job_key": "j-1002", "title": "后端开发工程师", "company_name": "虚构公司乙",
         "company_size": "1000-9999人", "industry": "互联网", "city": "上海",
         "salary_raw": "15-25K·14薪", "stage_text": "已投递", "viewed_text": "已查看",
         "applied_time_text": "2天前",
         "last_message_time_text": "昨天 14:30", "last_reply_time_text": "昨天 15:10",
         "hr": {"name": "测试HR丙", "activity_text": "本周活跃"}},
    ],
}

print("== 1. 健康检查 ==")
code, body = call("GET", "/api/health")
check("health 200", code == 200 and body["ok"])
code, home = get_raw("/")
check("管理页包含时间范围切换", code == 200 and 'id="f-period"' in home)
code, minimal_settings = get_raw("/first-contact-settings.html")
check("首次接触独立设置页可访问", code == 200 and 'id="message"' in minimal_settings and 'id="resume"' in minimal_settings)
code, sample = call("POST", "/api/sample", {
    "page_url": "https://www.zhipin.com/web/geek/chat",
    "title": "沟通列表/BOSS直聘",
    "captured_at": "2026-09-14 13:00:00",
    "html": "<!doctype html><html><body>sample</body></html>",
})
check("扩展可直接保存本地 HTML 样本", code == 200 and os.path.isfile(sample["path"]))
check("样本文件名已清理非法字符", "/" not in sample["name"] and "\\" not in sample["name"])
parsed_clock, confidence = normalize.parse_time_text("11:52", "2026-09-15 12:02:06")
check("沟通列表时分锚定采集日期", parsed_clock == "2026-09-15 11:52:00" and confidence == "推算")

print("== 2. 首次采集（2条新建）==")
code, r = call("POST", "/api/ingest", P1)
check("ingest ok", code == 200 and r["status"] == "ok", str(r))
check("read=2 created=2", r["read"] == 2 and r["created"] == 2, str(r))
check("j-1002 记一次阶段变化", r["stage_changes"] == 1, str(r))

code, data = call("GET", "/api/applications")
rows = {(x["company_name"], x["attempt"]): x for x in data["items"]}
check("列表共2条", data["total"] == 2)
j1, j2 = rows[("示例科技", 1)], rows[("虚构公司乙", 1)]
check("j-1002 已投递/已查看/曾投递", j2["stage"] == "已投递" and j2["viewed"] == "已查看" and j2["ever_applied"] == 1)
check("j-1002 投递时间由'2天前'换算", j2["applied_at"] == "2026-09-10", j2["applied_at"])
check("j-1002 薪酬解析 15-25K·14薪", j2["salary_min_k"] == 15 and j2["salary_max_k"] == 25 and j2["salary_months"] == 14)
check("j-1002 回复耗时≈0.67小时", j2["reply_latency_hours"] == 0.67, str(j2["reply_latency_hours"]))
check("j-1001 已沟通即计为投递", j1["stage"] == "已沟通" and
      j1["viewed"] == "未知" and j1["ever_applied"] == 1)
check("j-1001 消息时间'3小时前'锚定采集时刻", j1["last_message_at"] == "2026-09-12 07:00:00", j1["last_message_at"])
check("HR活跃度保留原文", j2["hr_activity"] == "本周活跃")
check("投递时间精度=日期", j2["applied_at_precision"] == "日期")

print("== 3. 状态变化：不合适 → 已拒绝；已查看 ==")
code, r = call("POST", "/api/ingest", {
    "page_type": "smoke_2", "captured_at": "2026-09-12 10:30:00",
    "items": [{"job_key": "j-1001", "company_name": "示例科技", "title": "Python开发工程师",
               "stage_text": "不合适", "viewed_text": "已查看"}]})
check("不合适→已拒绝(确定证据)", r["stage_changes"] == 1, str(r))
code, data = call("GET", "/api/applications?company_size=")
j1 = [x for x in data["items"] if x["company_name"] == "示例科技"][0]
check("j-1001 阶段=已拒绝 查看=已查看", j1["stage"] == "已拒绝" and j1["viewed"] == "已查看")

print("== 4. 无职位ID：指纹去重 + 未映射文案→待确认 ==")
FP = {"page_type": "smoke_fp", "captured_at": "2026-09-12 10:40:00",
      "items": [{"company_name": "指纹科技", "title": "数据分析师", "city": "上海",
                 "salary_raw": "1-3万", "stage_text": "已沟通"}]}
call("POST", "/api/ingest", FP)
code, r = call("POST", "/api/ingest", {
    "page_type": "smoke_fp2", "captured_at": "2026-09-12 10:41:00",
    "items": [{"company_name": "指纹科技", "title": "数据分析师", "city": "上海",
               "salary_raw": "1-3万", "stage_text": "某个未映射的状态文案"}]})
check("重复采集复用记录", r["created"] == 0 and r["updated"] == 1, str(r))
check("未映射文案→待确认", r["pending"] == 1, str(r))
code, r_repeat = call("POST", "/api/ingest", {
    "page_type": "smoke_fp2", "captured_at": "2026-09-12 10:42:00",
    "items": [{"company_name": "指纹科技", "title": "数据分析师", "city": "上海",
               "salary_raw": "1-3万", "stage_text": "某个未映射的状态文案"}]})
check("相同待确认文案不重复建事件", r_repeat["pending"] == 0, str(r_repeat))
code, data = call("GET", "/api/pending")
check("/api/pending 返回待确认事件", len(data["items"]) >= 1)
code, data = call("GET", "/api/applications?q=" + urllib.request.quote("指纹科技"))
check("万单位薪酬折算 1-3万→10-30K",
      data["total"] == 1 and data["items"][0]["salary_max_k"] == 30)

print("== 5. 已关闭记录再次投递 → 新批次 ==")
code, r = call("POST", "/api/ingest", {
    "page_type": "smoke_reapply", "captured_at": "2026-09-12 11:30:00",
    "items": [{"job_key": "j-1001", "company_name": "示例科技", "title": "Python开发工程师",
               "stage_text": "已投递", "applied_time_text": "1天前"}]})
check("再次投递开新记录", r["created"] == 1, str(r))
code, data = call("GET", "/api/applications")
check("列表共4条", data["total"] == 4, str(data["total"]))
application_times = [item["applied_at"] for item in data["items"]]
check("默认按投递起点倒序", application_times == sorted(application_times, reverse=True),
      str(application_times))

print("== 6. 人工修正 + 保护 ==")
j2_id = [x for x in data["items"] if x["company_name"] == "虚构公司乙"][0]["id"]
code, detail = call("PATCH", f"/api/applications/{j2_id}",
                    {"stage": "约面试", "note": "HR约了下周三下午面试"})
check("PATCH 约面试", detail["application"]["stage"] == "约面试")
check("人工修正自动加锁", detail["application"]["manual_locked"] == 1)
check("曾获面试标记 ever_interview", detail["application"]["ever_interview"] == 1)
check("事件写入时间线", len(detail["events"]) >= 3)

print("== 7. 人工保护：页面旧数据不覆盖 ==")
code, r = call("POST", "/api/ingest", {
    "page_type": "smoke_protect", "captured_at": "2026-09-12 12:00:00",
    "items": [{"job_key": "j-1002", "company_name": "虚构公司乙", "title": "后端开发工程师",
               "stage_text": "不合适"}]})
check("保护生效无变化", r["stage_changes"] == 0 and r["pending"] == 0, str(r))
code, detail = call("GET", f"/api/applications/{j2_id}")
check("阶段仍为约面试", detail["application"]["stage"] == "约面试")

print("== 8. 统计口径 ==")
code, s = call("GET", "/api/stats")
check("总数=4", s["total"] == 4)
check("投递总数=4（已沟通即计入）", s["applied_total"] == 4, str(s["applied_total"]))
check("面试转化率=25%（1/4，多轮只计一次）", s["interview_conversion"] == 25.0)
check("回复率=25%（1/4）", s["reply_rate"] == 25.0)
check("分布四态各1", s["distribution"]["已沟通"] == 1 and s["distribution"]["已投递"] == 1
      and s["distribution"]["约面试"] == 1 and s["distribution"]["已拒绝"] == 1)
check("近8周趋势结构", isinstance(s["weekly"], list) and len(s["weekly"]) == 8)
check("有最近同步记录", s["last_sync"] is not None)
code, scoped = call("GET", "/api/stats?date_from=2026-09-10&date_to=2026-09-10")
check("按投递日期统计指定日", scoped["applied_total"] == 1, str(scoped["applied_total"]))
check("指定日投递的被查看率=100%", scoped["viewed_rate"] == 100.0)
check("时段事件与投递批次分开统计", "period_activity" in scoped)

print("== 9. 筛选 ==")
code, data = call("GET", "/api/applications?stage=" + urllib.request.quote("已投递"))
check("按阶段筛选=1", data["total"] == 1)
code, data = call("GET", "/api/applications?viewed=" + urllib.request.quote("已查看"))
check("按查看筛选=2", data["total"] == 2, str(data["total"]))
code, data = call("GET", "/api/applications?salary_min_k=20")
check("薪酬筛选（上限≥20K）=4（35K×2、25K、30K 均命中）", data["total"] == 4, str(data["total"]))

print("== 10. 导出 ==")
code, text = get_raw("/api/export.csv")
check("CSV 200 且含表头", code == 200 and "招聘阶段" in text)
check("CSV 含数据（BOM+中文）", text.startswith("\ufeff") and "虚构公司乙" in text)

print("== 10.1 同步请求只领取一次 ==")
code, request = call("POST", "/api/sync/request")
code, claim = call("POST", "/api/sync/claim")
code, claim_again = call("POST", "/api/sync/claim")
check("同步请求可领取", claim["want"] and claim["request_id"] == request["request_id"])
check("已领取请求不会重复执行", not claim_again["want"])

print("== 11. 仅浏览职位详情：不产生投递记录 ==")
code, r = call("POST", "/api/ingest", {
    "page_type": "职位详情", "captured_at": "2026-09-12 13:00:00", "application": False,
    "items": [{"job_key": "j-9001", "title": "AI产品经理", "company_name": "虚构公司甲",
               "company_size": "1000-9999人", "industry": "计算机软件", "city": "深圳",
               "salary_raw": "10-14K", "url": "https://www.zhipin.com/job_detail/j-9001.html",
               "hr": {"name": "测试HR甲", "title": "招聘经理", "activity_text": "在线"}}]})
check("详情页浏览入库ok", r["status"] == "ok", str(r))
code, data = call("GET", "/api/applications")
check("仅浏览不建投递记录（仍4条）", data["total"] == 4, str(data["total"]))
code, r = call("POST", "/api/ingest", {
    "page_type": "沟通列表", "captured_at": "2026-09-12 13:05:00",
    "items": [{"job_key": "j-9001", "stage_text": "已沟通"}]})
check("后续真正沟通时才建档（复用已入库职位）", r["created"] == 1, str(r))
code, data = call("GET", "/api/applications?q=" + urllib.request.quote("虚构公司甲"))
check("新记录关联职位字段完整", data["total"] == 1 and data["items"][0]["salary_raw"] == "10-14K")
conn = db.connect()
observation_count = conn.execute("SELECT COUNT(*) FROM raw_observation").fetchone()[0]
conn.close()
check("结构化原始观测已保存且可去重", observation_count > 0)

print("== 12. 沟通列表与当前会话关联 ==")
code, chat_list = call("POST", "/api/ingest", {
    "page_type": "沟通列表", "captured_at": "2026-09-15 12:02:06",
    "items": [{"company_name": "会话科技", "last_message_time_text": "11:52",
               "hr": {"name": "测试HR丁", "title": "招聘专员"}}],
})
code, conversation = call("POST", "/api/ingest", {
    "page_type": "聊天会话", "captured_at": "2026-09-15 12:03:00",
    "items": [{"company_name": "会话科技", "title": "AI产品经理", "salary_raw": "20-30K",
               "last_reply_time_text": "11:59", "stage_text": "已招到",
               "hr": {"name": "测试HR丁", "title": "招聘专员"}}],
})
check("列表先建沟通记录", chat_list["created"] == 1, str(chat_list))
check("打开会话补全同一记录而非重复建档", conversation["created"] == 0, str(conversation))
code, linked = call("GET", "/api/applications?q=" + urllib.request.quote("会话科技"))
check("会话补全岗位并识别已结束", linked["total"] == 1 and
      linked["items"][0]["title"] == "AI产品经理" and linked["items"][0]["stage"] == "已结束")
code, chat_stats = call("GET", "/api/stats?date_from=2026-09-15&date_to=2026-09-15")
check("已沟通计入投递统计", chat_stats["period_activity"]["conversations"] == 1 and
      chat_stats["applied_total"] == 1 and chat_stats["period_activity"]["unclassified"] == 0)

print("== 13. 图片与文字配置 ==")
code, private_settings = call("PATCH", "/api/settings", {"advantage_message": "测试用个人优势占位文本。"})
check("只返回图片与文字配置", code == 200 and set(private_settings) == {"advantage_message", "resume"})
code, invalid_settings = call("PATCH", "/api/settings", {"unknown_option": "not-supported"})
check("拒绝发布版以外的配置字段", code == 400)
code, missing_endpoint = call("POST", "/api/match", {"job": {}})
check("未验证接口不对外提供", code == 404)
one_pixel_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
code, upload = call("POST", "/api/settings/resume", {
    "filename": "我的简历.png", "data_url": "data:image/png;base64," + one_pixel_png,
})
check("简历图片上传到本地私有目录", code == 200 and upload["resume"]["exists"])
code, mime, image = get_bytes("/api/resume")
check("扩展可读取已配置图片", code == 200 and mime == "image/png" and image.startswith(b"\x89PNG"))

print("== 14. 求职进展历史页 ==")
code, history = call("POST", "/api/ingest", {
    "page_type": "求职进展-面试", "captured_at": "2026-09-20 11:29:45",
    "items": [{"job_key": "j-history-interview", "title": "AI CRM产品经理",
               "company_name": "历史科技", "stage_text": "面试",
               "interview_time_text": "2026.09.18 10:00",
               "record_source": "BOSS求职进展-面试"}],
})
code, historical = call("GET", "/api/applications?q=" + urllib.request.quote("历史科技"))
history_app = historical["items"][0]
check("面试页补全阶段、时间和来源", history["created"] == 1 and
      history_app["stage"] == "约面试" and history_app["interview_at"] == "2026-09-18 10:00:00" and
      history_app["source"] == "BOSS求职进展-面试")
call("POST", "/api/ingest", {
    "page_type": "求职进展-已投递", "captured_at": "2026-09-20 11:29:38",
    "summary": {"reported_total": "42"}, "items": [],
})
code, history_stats = call("GET", "/api/stats")
check("平台累计投递数与逐条覆盖率分开统计",
      history_stats["history_coverage"]["platform_applied_total"] == 42 and
      history_stats["history_coverage"]["tracked_applied_total"] >= 1)
code, before_interest = call("GET", "/api/applications")
call("POST", "/api/ingest", {
    "page_type": "求职进展-感兴趣", "captured_at": "2026-09-20 11:29:55",
    "application": False,
    "items": [{"job_key": "j-history-interest", "title": "硬件产品经理",
               "company_name": "收藏科技"}],
})
code, after_interest = call("GET", "/api/applications")
check("感兴趣页不污染投递统计", before_interest["total"] == after_interest["total"])

print("== 15. 沟通成功岗位快照 ==")
contact_payload = {
    "event_id": "boss-contact:smoke-1",
    "source": "boss_stay_on_page",
    "captured_at": "2026-09-21T10:00:00+08:00",
    "action": {
        "button_text": "立即沟通",
        "success_dialog": "已向BOSS发送消息",
        "stay_button_text": "留在此页",
        "stay_button_clicked": True,
    },
    "job": {
        "job_key": "job-contact-1", "title": "AI产品经理", "company_name": "虚构公司甲",
        "company_size": "1000-9999人", "industry": "计算机软件",
        "financing_stage": "不需要融资", "city": "深圳",
        "address": "深圳示例区测试路1号", "experience": "3-5年",
        "education": "本科", "job_tags": ["B端产品", "Agent"],
        "salary_raw": "20-35K·16薪", "salary_capture_status": "readable",
        "url": "https://www.zhipin.com/job_detail/job-contact-1.html?securityId=secret",
        "jd_text": "虚构岗位职责文本，仅用于自动化测试。",
        "hr": {"name": "测试HR甲", "title": "招聘经理", "activity_text": "在线",
               "activity_captured_at": "2026-09-21T10:00:00+08:00"},
    },
    "capture": {"status": "complete", "missing_fields": [], "warnings": []},
}
code, contact = call("POST", "/api/contact-snapshots", contact_payload)
snapshot = contact["snapshot"]
check("成功弹窗保存完整岗位快照", code == 200 and contact["ok"] and
      snapshot["job"]["salary_raw"] == "20-35K·16薪" and
      snapshot["job"]["salary_min_k"] == 20 and snapshot["job"]["salary_max_k"] == 35 and
      snapshot["job"]["salary_months"] == 16 and snapshot["job"]["address"].startswith("深圳"))
code, duplicate_contact = call("POST", "/api/contact-snapshots", contact_payload)
check("相同事件ID重复提交保持幂等", code == 200 and duplicate_contact["duplicate"] is True and
      duplicate_contact["snapshot"]["record_id"] == snapshot["record_id"])

code, recent_contacts = call("GET", "/api/contact-snapshots?limit=1")
check("最新快照查询返回岗位、HR和沟通时间", code == 200 and recent_contacts["total"] == 1 and
      recent_contacts["items"][0]["job"]["company_name"] == "虚构公司甲" and
      recent_contacts["items"][0]["job"]["hr"]["activity_text"] == "在线")
conn = db.connect()
contact_app = conn.execute(
    "SELECT a.stage, a.applied_at, j.address, j.experience, j.education, "
    "j.financing_stage, j.job_tags_json, j.salary_capture_status "
    "FROM application a JOIN job j ON j.id = a.job_id WHERE j.job_key = 'job-contact-1'"
).fetchone()
conn.close()
check("沟通事件保留已沟通阶段并写入投递起点",
      contact_app["stage"] == "已沟通" and
      str(contact_app["applied_at"]).startswith("2026-09-21T10:00:00") and
      contact_app["address"].startswith("深圳") and contact_app["salary_capture_status"] == "readable")

obfuscated_payload = json.loads(json.dumps(contact_payload, ensure_ascii=False))
obfuscated_payload["event_id"] = "boss-contact:smoke-2"
obfuscated_payload["captured_at"] = "2026-09-21T10:01:00+08:00"
obfuscated_payload["job"]["job_key"] = "job-contact-2"
obfuscated_payload["job"]["salary_raw"] = ""
obfuscated_payload["job"]["salary_dom_raw"] = "\ue031\ue030-\ue031\ue034K"
obfuscated_payload["job"]["salary_codepoints"] = ["客户端提供的值不会被信任"]
obfuscated_payload["job"]["salary_font_family"] = "boss-salary-font"
obfuscated_payload["job"]["salary_capture_status"] = "font_obfuscated"
code, obfuscated = call("POST", "/api/contact-snapshots", obfuscated_payload)
check("字体混淆薪资不生成虚假数字", code == 200 and
      obfuscated["snapshot"]["job"]["salary_capture_status"] == "font_obfuscated" and
      obfuscated["snapshot"]["job"]["salary_min_k"] is None and
      obfuscated["snapshot"]["job"]["salary_max_k"] is None)
check("字体混淆薪资保留原始证据并由服务端重建码点", code == 200 and
      obfuscated["snapshot"]["job"]["salary_dom_raw"] == "\ue031\ue030-\ue031\ue034K" and
      obfuscated["snapshot"]["job"]["salary_codepoints"] ==
      ["U+E031", "U+E030", "U+002D", "U+E031", "U+E034", "U+004B"] and
      obfuscated["snapshot"]["job"]["salary_font_family"] == "boss-salary-font")

decoded_payload = json.loads(json.dumps(contact_payload, ensure_ascii=False))
decoded_payload["event_id"] = "boss-contact:smoke-3"
decoded_payload["captured_at"] = "2026-09-21T10:01:30+08:00"
decoded_payload["job"]["job_key"] = "job-contact-3"
decoded_payload["job"]["salary_raw"] = ""
decoded_payload["job"]["salary_dom_raw"] = "\ue032\ue036-\ue034\ue031K·\ue032\ue035薪"
decoded_payload["job"]["salary_font_family"] = "kanzhun-mix, kanzhun-Regular"
decoded_payload["job"]["salary_capture_status"] = "font_obfuscated"
code, decoded_salary = call("POST", "/api/contact-snapshots", decoded_payload)
decoded_job = decoded_salary["snapshot"]["job"]
check("确认的码点偏移规则解码薪资并保留原始证据", code == 200 and
      decoded_job["salary_raw"] == "15-30K·14薪" and
      decoded_job["salary_min_k"] == 15 and decoded_job["salary_max_k"] == 30 and
      decoded_job["salary_months"] == 14 and
      decoded_job["salary_capture_status"] == "font_decoded" and
      decoded_job["salary_decode_method"] == "pua_codepoint_minus_e031" and
      decoded_job["salary_dom_raw"] == "\ue032\ue036-\ue034\ue031K·\ue032\ue035薪")

failed_payload = {
    "event_id": "boss-contact:smoke-failed", "captured_at": "2026-09-21T10:02:00+08:00",
    "source": "boss_stay_on_page",
    "action": {"success_dialog": "已向BOSS发送消息", "stay_button_text": "留在本页",
               "stay_button_clicked": True},
    "job": {"job_key": "job-contact-failed", "company_name": "缺字段公司"},
    "capture": {"status": "failed", "missing_fields": ["title", "jd_text"], "warnings": []},
}
code, failed_contact = call("POST", "/api/contact-snapshots", failed_payload)
conn = db.connect()
failed_job = conn.execute("SELECT id FROM job WHERE job_key = 'job-contact-failed'").fetchone()
conn.close()
check("缺少标题或JD只保存失败事件", code == 200 and
      failed_contact["snapshot"]["capture"]["status"] == "failed" and failed_job is None)

httpd.shutdown()
httpd.server_close()
server_thread.join(timeout=5)
_TEST_DIR.cleanup()
print("\nSMOKE PASS - 核心链路全部通过")
