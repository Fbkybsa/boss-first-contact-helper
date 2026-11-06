"""Check release files without printing potentially private matched values."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
POLICY = ROOT / "release-files.txt"
ASSETS = ROOT / "release-assets.json"
TEXT_SUFFIXES = {".py", ".js", ".css", ".html", ".json", ".md", ".sql", ".yaml", ".yml", ".bat", ".txt"}
RULES = (
    ("credential", re.compile(r"(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})")),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("phone", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("personal-path", re.compile(r"[A-Za-z]:[\\/]Users[\\/][^\\/\r\n]+")),
)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SAFE_EMAIL_DOMAINS = {"example.com", "example.invalid", "users.noreply.github.com", "github.com"}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def allowed_paths():
    return {line.strip() for line in POLICY.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")}


def inspect(path, data, allowed, assets, private_terms=()):
    issues = []
    if path not in allowed:
        return ["unapproved-path"]
    if path in assets:
        return [] if hashlib.sha256(data).hexdigest() == assets[path] else ["unreviewed-image"]
    if Path(path).suffix not in TEXT_SUFFIXES and path not in {
        "LICENSE", ".gitignore", ".gitattributes", ".githooks/pre-commit", ".githooks/pre-push"
    }:
        return ["unapproved-file-type"]
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        return ["unexpected-binary"]
    for label, pattern in RULES:
        if pattern.search(content):
            issues.append(label)
    if any(term and term.casefold() in content.casefold() for term in private_terms):
        issues.append("private-term")
    if any(address.rsplit("@", 1)[1].lower() not in SAFE_EMAIL_DOMAINS
           for address in EMAIL.findall(content)):
        issues.append("email-needs-review")
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--staged", action="store_true", help="Check changed index blobs before commit")
    group.add_argument("--worktree", action="store_true", help="Check tracked and non-ignored local files before upload")
    parser.add_argument("--private-term", action="append", default=[], help="Local-only name, company or unique phrase; never saved")
    args = parser.parse_args()
    if args.staged:
        paths = git("diff", "--cached", "--diff-filter=ACMRT", "--name-only", "-z").decode().split("\0")
    elif args.worktree:
        paths = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")
    else:
        paths = git("ls-tree", "-rz", "--name-only", "HEAD").decode().split("\0")
    allowed = allowed_paths()
    assets = json.loads(ASSETS.read_text(encoding="utf-8"))
    failures = []
    checked = 0
    for path in sorted(set(filter(None, paths))):
        if args.worktree:
            candidate = ROOT / path
            if not candidate.is_file():
                continue
            data = candidate.read_bytes()
        else:
            data = git("show", (":" if args.staged else "HEAD:") + path)
        checked += 1
        failures.extend((path, issue) for issue in inspect(path, data, allowed, assets, args.private_term))
    for path, issue in failures:
        print(f"BLOCK {path}: {issue}")
    print(f"PRIVACY {'FAIL' if failures else 'PASS'}: {checked} files, {len(failures)} findings")
    if not args.staged:
        print("Also review screenshots, fixtures, Git history and commit author emails manually.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
