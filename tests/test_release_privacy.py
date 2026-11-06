"""Privacy guard regression tests use constructed data only."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("release_privacy", ROOT / "tools/check_release_privacy.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PrivacyGuardTest(unittest.TestCase):
    def test_unapproved_private_files_are_blocked(self):
        for path in ("db/tracker.db", "db/private-settings.json", "docs/samples/page.html", "resume.png", "exports/jobs.csv"):
            self.assertEqual(["unapproved-path"], guard.inspect(path, b"private", {"README.md"}, {}))

    def test_text_secrets_and_custom_private_terms_are_blocked(self):
        cases = (("credential", "ghp_" + "a" * 30), ("phone", "138" + "0" * 8),
                 ("private-term", "fixture confidential-phrase"), ("email-needs-review", "test@" + "mail.invalid"))
        for expected, content in cases:
            self.assertIn(expected, guard.inspect("README.md", content.encode(), {"README.md"}, {}, ["confidential-phrase"]))

    def test_only_the_reviewed_image_bytes_are_allowed(self):
        path = "assets/overview.png"
        data = b"constructed-image-data"
        approved = {path: hashlib.sha256(data).hexdigest()}
        self.assertEqual([], guard.inspect(path, data, {path}, approved))
        self.assertEqual(["unreviewed-image"], guard.inspect(path, b"replaced", {path}, approved))

    def test_public_noreply_address_and_generic_data_are_allowed(self):
        text = "example@users.noreply.github.com fictional JD for tests"
        self.assertEqual([], guard.inspect("README.md", text.encode(), {"README.md"}, {}))


if __name__ == "__main__":
    unittest.main()
