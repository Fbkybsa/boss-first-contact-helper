"""采集数据入库：清洗、去重、状态机应用与事件记录。

输入为采集组件 POST 的批次：
{page_type, captured_at, items: [{job_key, title, company_name, ..., stage_text,
  viewed_text, applied_time_text, interview_time_text, last_message_time_text, last_reply_time_text,
  hr: {name, title, activity_text}}]}
"""
import hashlib
import json
from urllib.parse import urlsplit, urlunsplit

try:
    from . import db, normalize, statemachine
except ImportError:
    import db, normalize, statemachine

# ---------------------------------------------------------------------------
# 页面原文 → 阶段/查看状态的映射。
# !!! 待第一阶段字段核实后按页面真实文案调整。
# !!! 未匹配的原文不会丢：会生成"待确认变更"，等人工在管理页采纳。
# ---------------------------------------------------------------------------
STAGE_MAP = {
    "已沟通": "已沟通", "继续沟通": "已沟通", "等待沟通": "已沟通",
    "已投递": "已投递", "简历已投递": "已投递", "投递成功": "已投递",
    "约面试": "约面试", "面试邀请": "约面试", "面试": "约面试",
    "已面试": "已面试", "面试完成": "已面试",
    "已发Offer": "已获Offer", "已发offer": "已获Offer", "Offer": "已获Offer",
    "不合适": "已拒绝", "不合适此职位": "已拒绝", "很遗憾": "已拒绝",
    "已撤回": "已撤回",
    "已结束": "已结束", "已招到": "已结束",
    "不匹配": "已拒绝", "不完全匹配": "已拒绝",
}
VIEWED_MAP = {"已查看": "已查看", "未查看": "未查看"}


def _resolve_stage(text):
    direct = STAGE_MAP.get(text)
    if direct:
        return direct
    if "附件简历" in text and "已发送给Boss" in text:
        return "已投递"
    return None


def ingest_payload(conn, payload):
    """处理一个采集批次，返回汇总（不抛异常：单条失败只记入 errors）。"""
    started = db.now()
    page = payload.get("page_type") or payload.get("source") or "unknown"
    captured = payload.get("captured_at") or started
    page_url = str(payload.get("page_url") or "").strip()
    res = {"page_type": page, "read": 0, "created": 0, "updated": 0,
           "stage_changes": 0, "pending": 0, "observations": 0, "errors": []}
    _record_source_counter(conn, page, payload.get("summary"), captured, page_url)
    # application=False 的页面（如职位详情）只更新职位/HR信息，不产生投递记录
    allow_application = payload.get("application", True)
    for item_index, item in enumerate(payload.get("items") or []):
        if not isinstance(item, dict):
            continue
        res["read"] += 1
        savepoint = f"ingest_item_{item_index}"
        conn.execute(f"SAVEPOINT {savepoint}")
        try:
            observed = _record_observation(
                conn, page, page_url, item, captured
            )
            if not observed:
                conn.execute(f"RELEASE {savepoint}")
                res["updated"] += 1
                continue
            created, changed, pending = _ingest_item(conn, item, captured, allow_application)
            conn.execute(f"RELEASE {savepoint}")
            res["observations"] += observed
            res["created" if created else "updated"] += 1
            res["stage_changes"] += changed
            res["pending"] += pending
        except Exception as exc:  # 单条失败不影响批次内其它记录
            conn.execute(f"ROLLBACK TO {savepoint}")
            conn.execute(f"RELEASE {savepoint}")
            res["errors"].append({"job_key": item.get("job_key"), "error": str(exc)})
    conn.commit()
    status = "ok" if not res["errors"] else "partial"
    log_sync_run(conn, source=page, status=status, counts=res, started_at=started)
    res["status"] = status
    return res


def _record_source_counter(conn, source, summary, captured, page_url):
    if not isinstance(summary, dict):
        return
    try:
        total = int(summary.get("reported_total"))
    except (TypeError, ValueError):
        return
    if total < 0:
        return
    conn.execute(
        "INSERT INTO source_counter (source, total, captured_at, page_url, updated_at) "
        "VALUES (?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET "
        "total = excluded.total, captured_at = excluded.captured_at, "
        "page_url = excluded.page_url, updated_at = excluded.updated_at "
        "WHERE excluded.captured_at >= source_counter.captured_at",
        (source, total, captured, _clean_url(page_url) or None, db.now()),
    )


def log_sync_run(conn, source, status, message="", counts=None, started_at=None):
    finished = db.now()
    counts = counts or {}
    conn.execute(
        "INSERT INTO sync_run (source, status, message, records_read, records_updated,"
        " stage_changes, pending, started_at, finished_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (source, status, message, counts.get("read", 0),
         counts.get("created", 0) + counts.get("updated", 0),
         counts.get("stage_changes", 0), counts.get("pending", 0),
         started_at or finished, finished))
    conn.commit()


# ---------------------------------------------------------------------------


def _fingerprint(item):
    """平台职位标识缺失时：优先按公司+HR关联会话，否则按职位字段去重。"""
    hr = item.get("hr") or {}
    company = str(item.get("company_name") or "").strip()
    hr_identity = str(hr.get("hr_key") or hr.get("name") or "").strip()
    if company and hr_identity:
        # 沟通列表不提供职位ID/职位名；公司+HR可让列表与当前会话稳定关联。
        basis = f"conversation|{company}|{hr_identity}"
    else:
        basis = "|".join(str(item.get(k) or "") for k in
                         ("company_name", "title", "city", "salary_raw"))
    return "fp:" + hashlib.md5(basis.encode("utf-8")).hexdigest()[:16]


def _record_observation(conn, source, page_url, item, captured):
    """保存一次结构化观测；相同来源和内容重复出现时只保留一份。"""
    observation = dict(item)
    if observation.get("url"):
        observation["url"] = _clean_url(observation["url"])
    page_url = _clean_url(page_url)
    canonical = json.dumps(observation, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    basis = f"{source}\n{page_url}\n{canonical}"
    observation_key = hashlib.sha256(basis.encode("utf-8")).hexdigest()
    job_key = str(item.get("job_key") or "").strip() or _fingerprint(item)
    cur = conn.execute(
        "INSERT OR IGNORE INTO raw_observation "
        "(observation_key, source, page_url, job_key, payload_json, captured_at, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (observation_key, source, page_url or None, job_key, canonical, captured, db.now()),
    )
    return 1 if cur.rowcount else 0


def _clean_url(value):
    """去掉只用于跟踪或会话的查询参数，保留稳定页面地址。"""
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        parts = urlsplit(text)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    except ValueError:
        return text


def _time_precision(value):
    text = str(value or "")
    if len(text) >= 19:
        return "秒"
    if len(text) >= 16:
        return "分钟"
    return "日期" if len(text) >= 10 else None


def _ingest_item(conn, item, captured, allow_application=True):
    now = db.now()
    job_key = str(item.get("job_key") or "").strip() or _fingerprint(item)
    job_id = _upsert_job(conn, item, job_key, now)
    hr_id = _upsert_hr(conn, item, captured)

    if not allow_application:
        # 仅浏览（职位详情等）：职位/HR 信息照常入库；
        # 若该职位已有未关闭的投递记录则顺带关联HR，但绝不新建投递记录
        latest = conn.execute(
            "SELECT id, stage FROM application WHERE job_id = ? ORDER BY attempt DESC LIMIT 1",
            (job_id,)).fetchone()
        if latest and latest["stage"] not in statemachine.CLOSED_STAGES and hr_id:
            conn.execute("UPDATE application SET hr_id = COALESCE(?, hr_id) WHERE id = ?",
                         (hr_id, latest["id"]))
        return False, 0, 0

    app_id, created = _find_or_create_application(conn, job_id, hr_id, now)
    changed = pending = 0
    touched = created

    # 沟通时间：观测值只前进（解析值更晚才覆盖，空值不覆盖）
    for text_field, col in (("last_message_time_text", "last_message_at"),
                            ("last_reply_time_text", "last_reply_at")):
        parsed, _conf = normalize.parse_time_text(item.get(text_field), anchor=captured)
        if not parsed:
            continue
        cur = conn.execute(f"SELECT {col} FROM application WHERE id = ?", (app_id,)).fetchone()[0]
        if not cur or parsed > cur:
            conn.execute(f"UPDATE application SET {col} = ? WHERE id = ?", (parsed, app_id))
            touched = True

    row = dict(conn.execute("SELECT * FROM application WHERE id = ?", (app_id,)).fetchone())

    record_source = str(item.get("record_source") or "").strip()
    if record_source and not row.get("source"):
        conn.execute("UPDATE application SET source = ? WHERE id = ?", (record_source, app_id))
        row["source"] = record_source
        touched = True

    # 可观测回复耗时（最近一次观测；多轮中位数需消息级采集，见 README 后续项）
    if row["last_message_at"] and row["last_reply_at"]:
        latency = normalize.hours_between(row["last_message_at"], row["last_reply_at"])
        if latency is not None and latency >= 0:
            conn.execute("UPDATE application SET reply_latency_hours = ? WHERE id = ?",
                         (round(latency, 2), app_id))

    # 业务口径：首次建立沟通就是投递起点。页面给出更明确的投递时间时优先采用；
    # 否则新记录以本次采集时间作为首次投递时间。
    applied_parsed, _conf = normalize.parse_time_text(item.get("applied_time_text"), anchor=captured)
    if applied_parsed and not row["applied_at"]:
        conn.execute(
            "UPDATE application SET applied_at = ?, applied_at_source = '页面', "
            "applied_at_precision = ? WHERE id = ?",
            (applied_parsed, _time_precision(applied_parsed), app_id),
        )
        touched = True
    elif created and not row["applied_at"]:
        source = "沟通成功事件" if item.get("contact_event") else "首次沟通"
        conn.execute(
            "UPDATE application SET applied_at = ?, applied_at_source = ?, "
            "applied_at_precision = ? WHERE id = ?",
            (captured, source, _time_precision(captured), app_id),
        )
        touched = True

    interview_parsed, _conf = normalize.parse_time_text(
        item.get("interview_time_text"), anchor=captured
    )
    if interview_parsed and not row["interview_at"]:
        conn.execute("UPDATE application SET interview_at = ? WHERE id = ?",
                     (interview_parsed, app_id))
        touched = True

    stage_text = str(item.get("stage_text") or "").strip()
    if stage_text:
        stage = _resolve_stage(stage_text)
        if stage is None:
            pending += _add_event(conn, app_id, "stage", row["stage"], None,
                                  f"页面原文: {stage_text}", "待确认",
                                  applied=0, occurred_at=captured)
        else:
            action, new_stage, reason = statemachine.evaluate_stage(
                row["stage"], stage, confidence="确定", manual_locked=bool(row["manual_locked"]))
            if action == "apply":
                _set_stage(conn, app_id, new_stage, occurred_at=captured)
                _add_event(conn, app_id, "stage", row["stage"], new_stage,
                           f"页面: {stage_text}", "确定", applied=1, occurred_at=captured)
                changed += 1
                touched = True
            elif action == "pending":
                pending += _add_event(conn, app_id, "stage", row["stage"], new_stage,
                                      f"页面: {stage_text}（{reason}）", "待确认",
                                      applied=0, occurred_at=captured)

    viewed_text = str(item.get("viewed_text") or "").strip()
    if viewed_text:
        observed = VIEWED_MAP.get(viewed_text)
        if observed is None:
            pending += _add_event(conn, app_id, "viewed", row["viewed"], None,
                                  f"页面原文: {viewed_text}", "待确认",
                                  applied=0, occurred_at=captured)
        else:
            action, new_viewed, reason = statemachine.evaluate_viewed(
                row["viewed"], observed, manual_locked=bool(row["manual_locked"]))
            if action == "apply":
                conn.execute(
                    "UPDATE application SET viewed = ?, last_change_at = ?, updated_at = ? WHERE id = ?",
                    (new_viewed, captured, now, app_id))
                _add_event(conn, app_id, "viewed", row["viewed"], new_viewed,
                           f"页面: {viewed_text}", "确定", applied=1, occurred_at=captured)
                touched = True
            elif action == "pending":
                pending += _add_event(conn, app_id, "viewed", row["viewed"], new_viewed,
                                      f"页面: {viewed_text}（{reason}）", "待确认",
                                      applied=0, occurred_at=captured)

    if touched and not created:
        conn.execute("UPDATE application SET updated_at = ? WHERE id = ?", (now, app_id))
    return created, changed, pending


def _upsert_job(conn, item, job_key, now):
    fields = {}
    for key in ("title", "company_name", "company_size", "industry", "financing_stage",
                "city", "address", "experience", "education", "url", "jd_text",
                "salary_capture_status"):
        value = str(item.get(key) or "").strip()
        if value:
            fields[key] = _clean_url(value) if key == "url" else value
    tags = item.get("job_tags")
    if isinstance(tags, list):
        clean_tags = list(dict.fromkeys(str(tag).strip() for tag in tags if str(tag).strip()))
        fields["job_tags_json"] = json.dumps(clean_tags, ensure_ascii=False)
    elif str(item.get("job_tags_json") or "").strip():
        fields["job_tags_json"] = str(item["job_tags_json"]).strip()
    salary = normalize.parse_salary(item.get("salary_raw"))
    if salary:
        fields.update(salary)
    elif str(item.get("salary_capture_status") or "").strip() in ("font_obfuscated", "missing"):
        fields.update({
            "salary_raw": None, "salary_min_k": None,
            "salary_max_k": None, "salary_months": None,
        })

    row = conn.execute("SELECT id FROM job WHERE job_key = ?", (job_key,)).fetchone()
    if row:
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE job SET {sets}, last_seen_at = ? WHERE id = ?",
                         (*fields.values(), now, row["id"]))
        else:
            conn.execute("UPDATE job SET last_seen_at = ? WHERE id = ?", (now, row["id"]))
        return row["id"]
    if fields:
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        cur = conn.execute(
            f"INSERT INTO job (job_key, {cols}, first_seen_at, last_seen_at) VALUES (?, {marks}, ?, ?)",
            (job_key, *fields.values(), now, now))
    else:
        cur = conn.execute(
            "INSERT INTO job (job_key, first_seen_at, last_seen_at) VALUES (?,?,?)",
            (job_key, now, now))
    return cur.lastrowid


def _upsert_hr(conn, item, captured):
    h = item.get("hr") or {}
    name = str(h.get("name") or "").strip()
    title = str(h.get("title") or "").strip()
    activity = str(h.get("activity_text") or "").strip()
    hr_key = str(h.get("hr_key") or "").strip()
    if not hr_key and name:
        hr_key = f"fp:{str(item.get('company_name') or '').strip()}#{name}"
    if not hr_key:
        return None

    row = conn.execute("SELECT id FROM hr WHERE hr_key = ?", (hr_key,)).fetchone()
    if row:
        sets, params = ["last_seen_at = ?"], [db.now()]
        if name:
            sets.append("name = ?"); params.append(name)
        if title:
            sets.append("title = ?"); params.append(title)
        if activity:
            sets.append("activity_raw = ?"); params.append(activity)
            sets.append("activity_captured_at = ?"); params.append(captured)
        conn.execute(f"UPDATE hr SET {', '.join(sets)} WHERE id = ?", (*params, row["id"]))
        return row["id"]
    cur = conn.execute(
        "INSERT INTO hr (hr_key, name, title, activity_raw, activity_captured_at, last_seen_at)"
        " VALUES (?,?,?,?,?,?)",
        (hr_key, name or None, title or None, activity or None,
         captured if activity else None, db.now()))
    return cur.lastrowid


def _find_or_create_application(conn, job_id, hr_id, now):
    """同一职位存在未关闭记录则复用；上一条已关闭（被拒/撤回/结束/入职）视为再次投递，开新批次。"""
    latest = conn.execute(
        "SELECT id, attempt, stage FROM application WHERE job_id = ? ORDER BY attempt DESC LIMIT 1",
        (job_id,)).fetchone()
    if latest:
        if latest["stage"] not in statemachine.CLOSED_STAGES:
            if hr_id:
                conn.execute("UPDATE application SET hr_id = COALESCE(?, hr_id) WHERE id = ?",
                             (hr_id, latest["id"]))
            return latest["id"], False
        attempt = latest["attempt"] + 1
    else:
        attempt = 1
    cur = conn.execute(
        "INSERT INTO application "
        "(job_id, hr_id, attempt, ever_applied, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        (job_id, hr_id, attempt, 1, now, now))
    return cur.lastrowid, True


def _set_stage(conn, app_id, new_stage, occurred_at):
    now = db.now()
    conn.execute("UPDATE application SET stage = ?, last_change_at = ?, updated_at = ? WHERE id = ?",
                 (new_stage, occurred_at or now, now, app_id))
    idx = statemachine.stage_index(new_stage)
    if idx is not None and idx >= 0:
        conn.execute("UPDATE application SET ever_applied = 1 WHERE id = ?", (app_id,))
    if idx is not None and idx >= 2:
        conn.execute("UPDATE application SET ever_interview = 1 WHERE id = ?", (app_id,))


def _add_event(conn, app_id, field, old_value, new_value, evidence, confidence, applied, occurred_at):
    if not applied:
        duplicate = conn.execute(
            "SELECT 1 FROM status_event WHERE application_id = ? AND field = ? "
            "AND COALESCE(new_value, '') = COALESCE(?, '') AND evidence = ? AND applied = 0 "
            "LIMIT 1",
            (app_id, field, new_value, evidence),
        ).fetchone()
        if duplicate:
            return 0
    conn.execute(
        "INSERT INTO status_event (application_id, field, old_value, new_value, evidence,"
        " confidence, applied, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (app_id, field, old_value, new_value, evidence, confidence, applied,
         occurred_at or db.now(), db.now()))
    return 1
