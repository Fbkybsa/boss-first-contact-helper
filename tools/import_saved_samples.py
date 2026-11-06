"""Import saved BOSS HTML samples using the same selector configuration as the extension."""
import datetime
import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "docs" / "samples"
CONFIG = ROOT / "extension" / "selectors.json"
sys.path.insert(0, str(ROOT))

from server import db, ingest  # noqa: E402


def _matches(node, condition):
    if isinstance(condition, str):
        return node.select_one(condition) is not None
    target = node.select_one(condition.get("selector", "")) if condition else None
    return bool(target and (not condition.get("regex") or
                            re.search(condition["regex"], target.get_text())))


def _extract(spec, item, page_url):
    if spec.get("when") and item.select_one(spec["when"]) is None:
        return None
    if spec.get("unless") and item.select_one(spec["unless"]) is not None:
        return None
    if spec.get("when_any") and not any(_matches(item, c) for c in spec["when_any"]):
        return None
    if spec.get("unless_any") and any(_matches(item, c) for c in spec["unless_any"]):
        return None
    if "value" in spec:
        value = spec["value"]
    elif spec.get("from") == "url":
        value = page_url
    else:
        nodes = item.select(spec["selector"]) if spec.get("selector") else [item]
        target = nodes[-1] if spec.get("pick") == "last" and nodes else (nodes[0] if nodes else None)
        if target is None:
            return None
        value = target.get(spec["attr"]) if spec.get("attr") not in (None, "text") else target.get_text()
    if value is None:
        return None
    value = str(value).strip()
    if spec.get("regex"):
        match = re.search(spec["regex"], value)
        if not match:
            return None
        value = match.group(1) if match.groups() else match.group(0)
    value = value.strip()
    return urljoin("https://www.zhipin.com/", value) if spec.get("absolute_url") else value


def _page_matches(soup, condition):
    if not condition:
        return True
    node = soup.select_one(condition.get("selector", ""))
    if node is None:
        return False
    value = node.get(condition["attr"]) if condition.get("attr") not in (None, "text") else node.get_text()
    return bool(value is not None and (not condition.get("regex") or
                                      re.search(condition["regex"], str(value).strip())))


def _captured_at(name):
    match = re.match(r"(\d{14})", name)
    if not match:
        return db.now()
    return datetime.datetime.strptime(match.group(1), "%Y%m%d%H%M%S").isoformat(sep=" ")


def _set_nested(target, path, value):
    parts = path.split(".")
    current = target
    for part in parts[:-1]:
        current = current.setdefault(part, {})
    current[parts[-1]] = value


def _selected_rules(config, filename):
    for rule in config.get("pages", []):
        hints = rule.get("sample_hints") or [rule.get("sample_hint", "")]
        if any(hint and hint in filename for hint in hints):
            yield rule


def _page_url(rule):
    if rule["page_type"] in ("沟通列表", "聊天会话"):
        return "https://www.zhipin.com/web/geek/chat"
    return "https://www.zhipin.com/web/geek/job"


def main(arguments):
    names = arguments or [path.name for path in sorted(SAMPLES.glob("*.html"))]
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    conn = db.connect()
    db.init_db(conn)
    imported = records = errors = 0
    try:
        for name in names:
            path = Path(name)
            if not path.is_absolute():
                path = SAMPLES / path.name
            if not path.exists():
                print(f"SKIP missing: {path}")
                errors += 1
                continue
            soup = BeautifulSoup(path.read_bytes(), "html.parser")
            for rule in _selected_rules(config, path.name):
                if not _page_matches(soup, rule.get("page_when")):
                    continue
                items = []
                page_url = _page_url(rule)
                summary = {}
                for field, spec in rule.get("summary_fields", {}).items():
                    value = _extract(spec, soup, page_url)
                    if value:
                        _set_nested(summary, field, value)
                for node in soup.select(rule["item_selector"]):
                    item = {}
                    for field, spec in rule.get("fields", {}).items():
                        value = _extract(spec, node, page_url)
                        if value:
                            _set_nested(item, field, value)
                    if item.get("job_key") or item.get("title") or item.get("company_name"):
                        items.append(item)
                if not items and not summary:
                    continue
                result = ingest.ingest_payload(conn, {
                    "page_type": rule["page_type"],
                    "captured_at": _captured_at(path.name),
                    "page_url": page_url,
                    "application": rule.get("application", True),
                    "summary": summary,
                    "items": items,
                })
                imported += 1
                records += result["read"]
                errors += len(result["errors"])
                print(f"{path.name}: {rule['page_type']} {result['read']} records")
    finally:
        conn.close()
    print(f"Imported {records} records from {imported} page rules; errors={errors}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
