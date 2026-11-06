"""用保存的真实消息页检查自动点击会话所依赖的 DOM 结构。"""
from pathlib import Path

from bs4 import BeautifulSoup


root = Path(__file__).resolve().parent.parent
sample = root / "docs" / "samples" / "20260920161807-BOSS直聘.html"
soup = BeautifulSoup(sample.read_text(encoding="utf-8"), "html.parser")

rows = soup.select(
    '.user-list-content ul[role="thead"] > li, '
    '.user-list-content ul[role="group"] > li[role="listitem"]'
)
assert rows, "消息列表选择器未命中"
selected = next((row for row in rows if row.select_one(".friend-content.selected")), None)
assert selected, "当前选中会话未命中"
hr = selected.select_one(".name-box .name-text")
company = selected.select_one(".name-box > span:nth-of-type(2)")
preview = selected.select_one(".last-msg-text")
assert hr and hr.get_text(strip=True), "列表 HR 缺失"
assert company and company.get_text(strip=True), "列表公司缺失"
assert preview and preview.get_text(strip=True), "列表最新消息缺失"

conversation = soup.select_one(".chat-conversation")
assert conversation, "当前会话未命中"
assert conversation.select_one(".top-info-content .name-text").get_text(strip=True) == hr.get_text(strip=True)
assert conversation.select_one(".top-info-content .base-info > span:not(.base-title)").get_text(strip=True) == company.get_text(strip=True)
assert conversation.select_one(".chat-position-content .position-name")
assert conversation.select_one("#chat-input")
assert conversation.select_one('.btn-sendimg input[type="file"]')
assert conversation.select_one(".btn-send")
assert conversation.select_one(".im-list .message-item[data-mid]")

print(f"MESSAGE DOM PASS - {len(rows)} 个列表项，当前会话 {company.get_text(strip=True)} / {hr.get_text(strip=True)}")
