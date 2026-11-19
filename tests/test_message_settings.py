"""Ordered-message settings use temporary fixtures, never personal configuration."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from server import settings


class MessageSettingsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "tests")
        self.path = Path(self.temp.name) / "settings.json"
        self.env = patch.dict(os.environ, {"TRACKER_SETTINGS": str(self.path)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_legacy_text_is_first_and_new_order_survives_reload(self):
        self.path.write_text(json.dumps({"advantage_message": "旧测试文字"}), encoding="utf-8")
        self.assertEqual(["旧测试文字"], settings.public()["advantage_messages"])
        settings.update({"advantage_messages": [" 甲 ", "乙", "丙"]})
        self.assertEqual(["甲", "乙", "丙"], settings.public()["advantage_messages"])
        self.assertEqual("甲", settings.public()["advantage_message"])
        settings.update({"advantage_message": "改后的第一段"})
        self.assertEqual(["改后的第一段", "乙", "丙"], settings.public()["advantage_messages"])
        settings.update({"advantage_messages": ["只保留一段"]})
        self.assertEqual(["只保留一段"], settings.public()["advantage_messages"])

    def test_invalid_array_does_not_overwrite_saved_configuration(self):
        settings.update({"advantage_messages": ["测试原文"]})
        original = self.path.read_bytes()
        for value in ([], ["甲"] * 4, [" "], [1], ["甲" * 301], "错误类型", None):
            with self.assertRaises(ValueError):
                settings.update({"advantage_messages": value})
            self.assertEqual(original, self.path.read_bytes())
        settings.update({"advantage_messages": ["甲" * 300, "甲" * 300, "甲" * 300]})
        self.assertEqual(3, len(settings.public()["advantage_messages"]))


if __name__ == "__main__":
    unittest.main()
