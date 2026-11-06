"""选择器回归验证：用 docs/samples/ 的真实页面 HTML 验证 selectors.json 的字段配置。

用法：python tests/validate_selectors.py [样本文件名 ...]
不带参数时验证 samples 目录下全部文件；每个样本验证配置里 sample_hint 能匹配其文件名的 page。
需要开发依赖 beautifulsoup4+soupsieve（pip install beautifulsoup4 soupsieve），仅本地验证用，不影响运行时零依赖。

退出码：全部字段提取成功为 0，存在 MISS 为 1（用于阶段性验收）。
"""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "docs" / "samples"
CONFIG = ROOT / "extension" / "selectors.json"

# 样本文件没有真实 URL，用固定样例 URL 验证 from:"url" 类字段的正则提取
FAKE_URL = "https://www.zhipin.com/job_detail/sample-job-001.html?lid=test"


def extract(spec, item, url):
    if spec.get("when") and item.select_one(spec["when"]) is None:
        return None
    if spec.get("unless") and item.select_one(spec["unless"]) is not None:
        return None
    def matches(condition):
        if isinstance(condition, str):
            return item.select_one(condition) is not None
        node = item.select_one(condition.get("selector", ""))
        return bool(node and (not condition.get("regex") or
                              re.search(condition["regex"], node.get_text())))
    if spec.get("when_any") and not any(matches(c) for c in spec["when_any"]):
        return None
    if spec.get("unless_any") and any(matches(c) for c in spec["unless_any"]):
        return None
    if "value" in spec:
        value = spec["value"]
    elif spec.get("from") == "url":
        value = url
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
        m = re.search(spec["regex"], value)
        if not m:
            return None
        value = m.group(1) if m.groups() else m.group(0)
    value = str(value).strip()
    if spec.get("absolute_url"):
        value = urljoin("https://www.zhipin.com/", value)
    return value


def page_condition_matches(soup, condition):
    if not condition:
        return True
    node = soup.select_one(condition.get("selector", ""))
    if node is None:
        return False
    value = node.get(condition["attr"]) if condition.get("attr") not in (None, "text") else node.get_text()
    return bool(value is not None and (not condition.get("regex") or
                                      re.search(condition["regex"], str(value).strip())))


def main(argv):
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    pages = cfg["pages"]
    names = argv or [p.name for p in SAMPLES.glob("*.html")]
    if not names:
        print("docs/samples/ 下没有样本文件")
        return 1

    total_ok = total = 0
    for name in names:
        path = SAMPLES / name
        soup = BeautifulSoup(path.read_bytes(), "html.parser")
        print(f"\n=== 样本: {name} ===")
        matched = False
        for page in pages:
            hints = page.get("sample_hints") or [page.get("sample_hint", "")]
            if not any(hint and hint in name for hint in hints):
                continue
            matched = True
            if not page_condition_matches(soup, page.get("page_when")):
                print(f"  [{page['page_type']}] page_when 未匹配")
                total += 1
                continue
            for field, spec in page.get("summary_fields", {}).items():
                value = extract(spec, soup, FAKE_URL)
                required = spec.get("required", True)
                if required:
                    total += 1
                    total_ok += bool(value)
                mark = "OK " if value else "OPT" if not required else "MISS"
                print(f"  [{mark}] summary.{field:10s} = {ascii(value) if value else repr(value)}")
            item = soup.select_one(page["item_selector"])
            if item is None:
                print(f"  [{page['page_type']}] item_selector 未找到: {page['item_selector']}")
                total += 1
                continue
            print(f"  [{page['page_type']}] item={page['item_selector']}")
            for field, spec in page["fields"].items():
                v = extract(spec, item, FAKE_URL)
                required = spec.get("required", True)
                if required:
                    total += 1
                    total_ok += bool(v)
                mark = "OK " if v else "OPT" if not required else "MISS"
                display = ascii(v[:180] + ("..." if len(v) > 180 else "")) if isinstance(v, str) else repr(v)
                print(f"    [{mark}] {field:18s} = {display}")
        if not matched:
            print("  （没有匹配的 page 配置，检查 sample_hint）")
    print(f"\n合计: {total_ok}/{total} 字段提取成功")
    return 0 if total_ok == total else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
