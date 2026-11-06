"""将扩展保存的离线 HTML 样本按 selectors.json 导入本地数据库。

运行：python tools/import_samples.py docs/samples/20260915120206-BOSS直聘.html
开发工具依赖 BeautifulSoup；正式采集和服务运行仍为纯标准库。
"""
import argparse
import datetime
import json
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import db, ingest  # noqa: E402


def _matches(item, condition):
    if isinstance(condition, str):
        return item.select_one(condition) is not None
    node = item.select_one(condition.get("selector", ""))
    return bool(node and (not condition.get("regex") or
                          re.search(condition["regex"], node.get_text())))


def extract(spec, item, page_url):
    if spec.get("when") and item.select_one(spec["when"]) is None:
        return None
    if spec.get("unless") and item.select_one(spec["unless"]) is not None:
        return None
    if spec.get("when_any") and not any(_matches(item, c) for c in spec["when_any"]):
        return None
    if spec.get("unless_any") and any(_matches(item, c) for c in spec["unless_any"]):
        return None
    if spec.get("from") == "url":
        value = page_url
    else:
        nodes = item.select(spec["selector"]) if spec.get("selector") else [item]
        node = nodes[-1] if spec.get("pick") == "last" and nodes else (nodes[0] if nodes else None)
        if node is None:
            return None
        value = node.get(spec["attr"]) if spec.get("attr") not in (None, "text") else node.get_text()
    if value is None:
        return None
    value = str(value).strip()
    if spec.get("regex"):
        match = re.search(spec["regex"], value)
        if not match:
            return None
        value = match.group(1) if match.groups() else match.group(0)
    return value or None


def set_nested(target, path, value):
    current = target
    parts = path.split(".")
    for part in parts[:-1]:
        current = current.setdefault(part, {})
    current[parts[-1]] = value


def captured_at(path):
    match = re.match(r"(\d{14})", path.name)
    if not match:
        return db.now()
    return datetime.datetime.strptime(match.group(1), "%Y%m%d%H%M%S").isoformat(sep=" ")


def infer_url(soup, rules):
    canonical = soup.select_one("link[rel=canonical][href]")
    if canonical:
        return canonical["href"]
    if any(rule.get("page_type") in ("沟通列表", "聊天会话") for rule in rules):
        return "https://www.zhipin.com/web/geek/chat"
    return ""


def import_file(conn, path, config):
    soup = BeautifulSoup(path.read_bytes(), "html.parser")
    rules = [rule for rule in config["pages"]
             if rule.get("sample_hint") and rule["sample_hint"] in path.name]
    if not rules:
        raise ValueError(f"没有与样本文件名匹配的页面规则: {path.name}")
    page_url = infer_url(soup, rules)
    summaries = []
    for rule in rules:
        items = []
        for node in soup.select(rule["item_selector"]):
            item = {}
            for field, spec in rule.get("fields", {}).items():
                value = extract(spec, node, page_url)
                if value is not None:
                    set_nested(item, field, value)
            if item.get("job_key") or item.get("title") or item.get("company_name"):
                items.append(item)
        result = ingest.ingest_payload(conn, {
            "page_type": rule["page_type"],
            "captured_at": captured_at(path),
            "source": "offline_sample",
            "page_url": page_url,
            "application": rule.get("application", True),
            "items": items,
        })
        summaries.append(result)
    return summaries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    config = json.loads((ROOT / "extension" / "selectors.json").read_text(encoding="utf-8"))
    db.init_db()
    conn = db.connect()
    try:
        for path in args.files:
            for result in import_file(conn, path.resolve(), config):
                print(json.dumps({k: result[k] for k in
                                  ("page_type", "read", "created", "updated",
                                   "stage_changes", "pending", "status")},
                                 ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
