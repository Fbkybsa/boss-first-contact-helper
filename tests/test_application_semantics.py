"""“已沟通即投递”的数据库迁移与统计单元测试。"""
import os
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import db, stats  # noqa: E402


class ApplicationSemanticsTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix="application-semantics-", dir=ROOT / "tests"
        )
        self.previous_db = os.environ.get("TRACKER_DB")
        os.environ["TRACKER_DB"] = str(pathlib.Path(self.temp_dir.name) / "tracker.db")
        db.init_db()

    def tearDown(self):
        if self.previous_db is None:
            os.environ.pop("TRACKER_DB", None)
        else:
            os.environ["TRACKER_DB"] = self.previous_db
        self.temp_dir.cleanup()

    def test_legacy_contact_is_backfilled_as_application_start(self):
        conn = db.connect()
        job_id = conn.execute(
            "INSERT INTO job (job_key, title, first_seen_at, last_seen_at) VALUES (?,?,?,?)",
            ("legacy-contact", "产品经理", "2026-10-21 09:00:00", "2026-10-21 09:00:00"),
        ).lastrowid
        conn.execute(
            "INSERT INTO application "
            "(job_id, attempt, stage, ever_applied, applied_at, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (job_id, 1, "已沟通", 0, None, "2026-10-21 09:00:05", "2026-10-21 09:00:05"),
        )
        conn.execute(
            "INSERT INTO contact_event "
            "(event_id, job_id, success_dialog_text, contacted_at, capture_status, "
            "snapshot_json, source, created_at) VALUES (?,?,?,?,?,?,?,?)",
            ("boss-contact:legacy", job_id, "已向BOSS发送消息", "2026-10-21 09:00:00",
             "complete", "{}", "test", "2026-10-21 09:00:05"),
        )
        conn.commit()

        db.init_db(conn)
        application = conn.execute(
            "SELECT stage, ever_applied, applied_at, applied_at_source FROM application"
        ).fetchone()
        summary = stats.get_stats(
            conn, date_from="2026-10-21", date_to="2026-10-21"
        )
        conn.close()

        self.assertEqual("已沟通", application["stage"])
        self.assertEqual(1, application["ever_applied"])
        self.assertEqual("2026-10-21 09:00:00", application["applied_at"])
        self.assertEqual("沟通成功事件", application["applied_at_source"])
        self.assertEqual(1, summary["applied_total"])


if __name__ == "__main__":
    unittest.main()
