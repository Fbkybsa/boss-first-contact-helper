"""Release boundaries for image/text sending and local job records."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import db, settings  # noqa: E402


class ReleaseScopeTest(unittest.TestCase):
    def test_old_private_fields_are_not_loaded_or_saved(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "tests") as directory:
            path = Path(directory) / "settings.json"
            path.write_text(json.dumps({"advantage_message": "测试文字", "legacy_only": "private"}), encoding="utf-8")
            with patch.dict(os.environ, {"TRACKER_SETTINGS": str(path)}):
                self.assertEqual({"advantage_message", "resume"}, set(settings.load()))
                with self.assertRaises(ValueError):
                    settings.update({"unknown_option": "unsupported"})
                settings.update({"advantage_message": "更新后的测试文字"})
                self.assertEqual({"advantage_message", "resume"}, set(json.loads(path.read_text(encoding="utf-8"))))

    def test_fresh_database_only_contains_released_job_fields(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "tests") as directory:
            with patch.dict(os.environ, {"TRACKER_DB": str(Path(directory) / "test.db")}):
                db.init_db()
                conn = db.connect()
                try:
                    columns = {row["name"] for row in conn.execute("PRAGMA table_info(job)")}
                finally:
                    conn.close()
                self.assertIn("jd_text", columns)
                self.assertFalse(any(name.startswith("match") for name in columns))

    def test_unreleased_modules_are_not_distributed(self):
        for relative in ("server/matcher.py", "tools/dry_run_match.py", "extension/assistant.js"):
            self.assertFalse((ROOT / relative).exists(), relative)


if __name__ == "__main__":
    unittest.main()
