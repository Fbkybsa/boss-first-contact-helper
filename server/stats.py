"""求职进展统计。

口径（与方案一致）：
- 投递总数   = 已建立沟通的求职记录数；平台原始阶段“已沟通”就是投递起点
- 面试转化率 = 曾到达"约面试"及以上的记录数 ÷ 投递总数
  （同一投递多轮面试只计一次；后续被拒绝也保留曾获得面试的事实）
- 回复率     = 收到HR回复的记录数 ÷ 投递总数
- 每周趋势   = 按真实投递时间汇总，无投递时间的记录不计入
- 待跟进     = 未关闭且超过 N 天无状态变化的记录数
"""
import datetime

try:
    from . import statemachine
except ImportError:
    import statemachine


def _date_scope(date_from, date_to, column):
    where, params = [], []
    if date_from:
        datetime.date.fromisoformat(date_from)
        where.append(f"date({column}) >= date(?)")
        params.append(date_from)
    if date_to:
        datetime.date.fromisoformat(date_to)
        where.append(f"date({column}) <= date(?)")
        params.append(date_to)
    return (" AND ".join(where) or "1=1"), params


def get_stats(conn, stale_days=7, date_from=None, date_to=None):
    def one(sql, params=()):
        return conn.execute(sql, params).fetchone()[0]

    application_time = "COALESCE(NULLIF(applied_at, ''), created_at)"
    cohort_where, cohort_params = _date_scope(date_from, date_to, application_time)
    event_where, event_params = _date_scope(date_from, date_to, "occurred_at")
    reply_where, reply_params = _date_scope(date_from, date_to, "last_reply_at")
    activity_time = (
        "CASE WHEN last_reply_at IS NULL THEN last_message_at "
        "WHEN last_message_at IS NULL THEN last_reply_at "
        "WHEN last_reply_at > last_message_at THEN last_reply_at ELSE last_message_at END"
    )
    activity_where, activity_params = _date_scope(date_from, date_to, activity_time)

    total = one(f"SELECT COUNT(*) FROM application WHERE {cohort_where}", cohort_params)
    applied_total = total
    interview_total = one(
        f"SELECT COUNT(*) FROM application WHERE ever_interview = 1 AND {cohort_where}",
        cohort_params,
    )
    viewed_total = one(
        f"SELECT COUNT(*) FROM application WHERE viewed = '已查看' "
        f"AND {cohort_where}",
        cohort_params,
    )

    distribution = {s: 0 for s in statemachine.ALL_STAGES}
    for r in conn.execute(
            f"SELECT stage, COUNT(*) AS c FROM application WHERE {cohort_where} GROUP BY stage",
            cohort_params):
        distribution[r["stage"]] = r["c"]

    chat_total = one(
        f"SELECT COUNT(*) FROM application WHERE "
        f"(last_message_at IS NOT NULL OR last_reply_at IS NOT NULL) AND {cohort_where}",
        cohort_params,
    )
    replied_total = one(
        f"SELECT COUNT(*) FROM application WHERE last_reply_at IS NOT NULL AND {cohort_where}",
        cohort_params,
    )

    period_activity = {
        "conversations": one(
            f"SELECT COUNT(*) FROM application WHERE {activity_time} IS NOT NULL "
            f"AND {activity_where}",
            activity_params,
        ),
        "unclassified": one(
            f"SELECT COUNT(*) FROM application WHERE ever_applied = 0 "
            f"AND {activity_time} IS NOT NULL AND {activity_where}",
            activity_params,
        ),
        "viewed": one(
            f"SELECT COUNT(DISTINCT application_id) FROM status_event WHERE applied = 1 "
            f"AND field = 'viewed' AND new_value = '已查看' AND {event_where}",
            event_params,
        ),
        "replied": one(
            f"SELECT COUNT(*) FROM application WHERE last_reply_at IS NOT NULL AND {reply_where}",
            reply_params,
        ),
        "interview": one(
            f"SELECT COUNT(DISTINCT application_id) FROM status_event WHERE applied = 1 "
            f"AND field = 'stage' AND new_value IN ('约面试','已面试','已获Offer','已入职') "
            f"AND {event_where}",
            event_params,
        ),
        "rejected": one(
            f"SELECT COUNT(DISTINCT application_id) FROM status_event WHERE applied = 1 "
            f"AND field = 'stage' AND new_value = '已拒绝' AND {event_where}",
            event_params,
        ),
    }
    unknown_applied_time = one(
        "SELECT COUNT(*) FROM application WHERE ever_applied = 1 "
        "AND (applied_at IS NULL OR applied_at = '')"
    )
    all_applied_total = one("SELECT COUNT(*) FROM application")
    counter_rows = conn.execute(
        "SELECT source, total, captured_at FROM source_counter ORDER BY source"
    ).fetchall()
    platform_counts = {row["source"]: {"total": row["total"], "captured_at": row["captured_at"]}
                       for row in counter_rows}
    platform_applied = platform_counts.get("求职进展-已投递", {}).get("total")
    history_coverage = None
    if platform_applied is not None:
        history_coverage = {
            "platform_applied_total": platform_applied,
            "tracked_applied_total": all_applied_total,
            "remaining": max(0, platform_applied - all_applied_total),
            "percent": round(min(all_applied_total, platform_applied) * 100.0 / platform_applied, 1)
                       if platform_applied else 100.0,
        }

    closed_ph = ",".join("?" for _ in statemachine.CLOSED_STAGES)
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=stale_days)).strftime("%Y-%m-%d %H:%M:%S")
    stale_count = one(
        f"SELECT COUNT(*) FROM application WHERE stage NOT IN ({closed_ph})"
        " AND COALESCE(NULLIF(last_change_at, ''), created_at) < ?",
        (*statemachine.CLOSED_STAGES, cutoff))

    last = conn.execute(
        "SELECT * FROM sync_run WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1").fetchone()

    return {
        "total": total,
        "applied_total": applied_total,
        "viewed_total": viewed_total,
        "viewed_rate": round(viewed_total * 100.0 / applied_total, 1) if applied_total else 0.0,
        "interview_total": interview_total,
        "interview_conversion": round(interview_total * 100.0 / applied_total, 1) if applied_total else 0.0,
        "chat_total": chat_total,
        "replied_total": replied_total,
        "reply_rate": round(replied_total * 100.0 / applied_total, 1) if applied_total else 0.0,
        "period_activity": period_activity,
        "scope": {
            "date_from": date_from,
            "date_to": date_to,
            "unknown_applied_time": unknown_applied_time,
        },
        "platform_counts": platform_counts,
        "history_coverage": history_coverage,
        "distribution": distribution,
        "weekly": _weekly_trend(conn),
        "stale_days": stale_days,
        "stale_count": stale_count,
        "last_sync": dict(last) if last else None,
    }


def _weekly_trend(conn, weeks=8):
    """近 N 周按真实投递时间汇总，周以周一为起点。"""
    today = datetime.date.today()
    monday = today - datetime.timedelta(days=today.weekday())
    buckets = []
    for i in range(weeks - 1, -1, -1):
        start = monday - datetime.timedelta(weeks=i)
        iso = start.isocalendar()
        buckets.append({"week": f"{iso[0]}W{iso[1]:02d}", "start": start.isoformat(), "applied": 0})

    counts = {}
    for r in conn.execute(
            "SELECT COALESCE(NULLIF(applied_at, ''), created_at) AS applied_at FROM application"):
        try:
            d = datetime.date.fromisoformat(str(r["applied_at"])[:10])
        except ValueError:
            continue
        wk = d - datetime.timedelta(days=d.weekday())
        counts[wk] = counts.get(wk, 0) + 1
    for b in buckets:
        b["applied"] = counts.get(datetime.date.fromisoformat(b["start"]), 0)
    return buckets
