"""SQLite 连接与初始化。数据库文件位置可用环境变量 TRACKER_DB 覆盖（测试用）。"""
import datetime
import os
import pathlib
import sqlite3

_ROOT = pathlib.Path(__file__).resolve().parent.parent
_DEFAULT_DB = _ROOT / "db" / "tracker.db"
_SCHEMA = _ROOT / "db" / "schema.sql"

DB_PATH = _DEFAULT_DB


def _db_path() -> pathlib.Path:
    return pathlib.Path(os.environ.get("TRACKER_DB") or _DEFAULT_DB)


def connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection | None = None) -> None:
    own = conn is None
    conn = conn or connect()
    conn.executescript(_SCHEMA.read_text(encoding="utf-8"))
    _migrate(conn)
    conn.commit()
    if own:
        conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """对既有数据库做只增不删的轻量迁移。"""
    app_columns = {row["name"] for row in conn.execute("PRAGMA table_info(application)")}
    if "applied_at_precision" not in app_columns:
        conn.execute("ALTER TABLE application ADD COLUMN applied_at_precision TEXT")
    if "resume_exchange_at" not in app_columns:
        conn.execute("ALTER TABLE application ADD COLUMN resume_exchange_at TEXT")
    for name in ("source", "send_status", "send_error"):
        if name not in app_columns:
            conn.execute(f"ALTER TABLE application ADD COLUMN {name} TEXT")
    job_columns = {row["name"] for row in conn.execute("PRAGMA table_info(job)")}
    for name, column_type in (
        ("jd_text", "TEXT"),
        ("financing_stage", "TEXT"), ("address", "TEXT"),
        ("experience", "TEXT"), ("education", "TEXT"),
        ("job_tags_json", "TEXT"), ("salary_capture_status", "TEXT"),
    ):
        if name not in job_columns:
            conn.execute(f"ALTER TABLE job ADD COLUMN {name} {column_type}")
    conn.execute(
        "UPDATE application SET applied_at_precision = CASE "
        "WHEN length(applied_at) >= 19 THEN '秒' "
        "WHEN length(applied_at) >= 16 THEN '分钟' "
        "WHEN length(applied_at) >= 10 THEN '日期' END "
        "WHERE applied_at IS NOT NULL AND applied_at_precision IS NULL"
    )
    _repair_legacy_resume_events(conn)
    _migrate_application_start_semantics(conn)


def _migrate_application_start_semantics(conn: sqlite3.Connection) -> None:
    """“已沟通”即投递起点：回填旧记录并保留平台原始阶段。"""
    conn.execute("UPDATE application SET ever_applied = 1")
    conn.execute(
        "UPDATE application SET applied_at = COALESCE("
        "(SELECT MIN(c.contacted_at) FROM contact_event c WHERE c.job_id = application.job_id), "
        "created_at), "
        "applied_at_source = CASE WHEN EXISTS ("
        "SELECT 1 FROM contact_event c WHERE c.job_id = application.job_id"
        ") THEN '沟通成功事件' ELSE '首次记录' END "
        "WHERE applied_at IS NULL OR applied_at = ''"
    )
    conn.execute(
        "UPDATE application SET applied_at_precision = CASE "
        "WHEN length(applied_at) >= 19 THEN '秒' "
        "WHEN length(applied_at) >= 16 THEN '分钟' "
        "WHEN length(applied_at) >= 10 THEN '日期' END "
        "WHERE applied_at IS NOT NULL AND applied_at_precision IS NULL"
    )


def _repair_legacy_resume_events(conn: sqlite3.Connection) -> None:
    """旧版本曾把附件消息误当成已投递；保留时间候选并纠正阶段依据。"""
    legacy = (
        "field = 'stage' AND applied = 1 "
        "AND evidence LIKE '%附件简历%已发送%'"
    )
    conn.execute(
        f"UPDATE application SET resume_exchange_at = COALESCE(resume_exchange_at, applied_at) "
        f"WHERE EXISTS (SELECT 1 FROM status_event e WHERE e.application_id = application.id AND {legacy})"
    )
    confirmed = (
        "EXISTS (SELECT 1 FROM status_event e WHERE e.application_id = application.id "
        "AND e.field = 'stage' AND e.applied = 1 "
        "AND e.new_value IN ('已投递','约面试','已面试','已获Offer','已入职') "
        "AND NOT (e.evidence LIKE '%附件简历%已发送%'))"
    )
    conn.execute(
        f"UPDATE application SET applied_at_source = '简历交换时间推定' "
        f"WHERE applied_at IS NOT NULL AND {confirmed} "
        f"AND EXISTS (SELECT 1 FROM status_event e WHERE e.application_id = application.id AND {legacy})"
    )
    conn.execute(
        f"UPDATE application SET applied_at = NULL, applied_at_source = NULL, "
        f"applied_at_precision = NULL WHERE NOT ({confirmed}) "
        f"AND EXISTS (SELECT 1 FROM status_event e WHERE e.application_id = application.id AND {legacy})"
    )
    conn.execute(
        f"UPDATE application SET stage = CASE WHEN stage = '已投递' THEN '已沟通' ELSE stage END, "
        f"ever_applied = CASE WHEN ever_interview = 1 THEN 1 ELSE 0 END "
        f"WHERE NOT ({confirmed}) "
        f"AND EXISTS (SELECT 1 FROM status_event e WHERE e.application_id = application.id AND {legacy})"
    )
    conn.execute(
        "UPDATE status_event SET field = 'communication', old_value = NULL, new_value = '已沟通', "
        "evidence = '页面：简历附件消息（仅计沟通）' "
        f"WHERE {legacy}"
    )


def now() -> str:
    """本地时间，格式 'YYYY-MM-DD HH:MM:SS'，全程统一使用该格式便于字符串比较。"""
    return datetime.datetime.now().replace(microsecond=0).isoformat(sep=" ")
