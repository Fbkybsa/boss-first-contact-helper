"""字段清洗：薪酬解析、相对时间换算。

原则：保留原文；解析失败不阻塞流程、宁缺毋猜；
相对时间必须用采集时刻(anchor)锚定，换算结果标注置信度。
"""
import datetime as _dt
import re

_DATETIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
    "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y/%m/%d",
    "%Y.%m.%d %H:%M:%S", "%Y.%m.%d %H:%M", "%Y.%m.%d",
)

_SALARY_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*[-–~—]\s*(\d+(?:\.\d+)?)\s*([Kk]|万|W)?\s*(?:[·•xX×]\s*(\d+)\s*薪)?"
)


def parse_salary(raw):
    """'20-35K·16薪' → dict(salary_raw/salary_min_k/salary_max_k/salary_months)。

    单位为千元/月；'元/天'等无法可靠折算的只保留原文、数值留空。
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    out = {"salary_raw": text, "salary_min_k": None, "salary_max_k": None, "salary_months": None}
    m = _SALARY_RE.search(text)
    if not m:
        return out
    lo, hi, unit, months = m.groups()
    if unit in ("K", "k"):
        factor = 1.0
    elif unit in ("万", "W"):
        factor = 10.0
    else:
        return out  # 如 "300-500元/天"、"面议"，不折算
    out["salary_min_k"] = round(float(lo) * factor, 1)
    out["salary_max_k"] = round(float(hi) * factor, 1)
    out["salary_months"] = int(months) if months else None
    return out


def _to_dt(value):
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value
    text = str(value).strip().replace("T", " ")
    for fmt in _DATETIME_FORMATS:
        try:
            return _dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _fmt(dt):
    return dt.replace(microsecond=0).isoformat(sep=" ")


def parse_time_text(text, anchor=None):
    """相对时间 → 绝对时间。返回 (值或None, 置信度)。

    值可能精确到秒，也可能只到日期（"3天前"只知日期）。
    anchor 为采集时刻；anchor 本身失效时退回当前时间。
    """
    base = _to_dt(anchor) or _dt.datetime.now()
    if text is None:
        return (None, None)
    s = str(text).strip()
    if not s:
        return (None, None)
    D = _dt.timedelta

    # 绝对时间
    if re.fullmatch(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}([ ]\d{1,2}:\d{2}(:\d{2})?)?", s):
        dt = _to_dt(s)
        return (_fmt(dt), "确定") if dt else (None, None)

    # "9月12日" / "9月12日 14:30"
    m = re.fullmatch(r"(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?", s)
    if m:
        try:
            dt = _dt.datetime(base.year, int(m[1]), int(m[2]), int(m[3] or 0), int(m[4] or 0))
        except ValueError:
            return (None, None)
        if dt > base + D(days=2):  # 出现"未来"日期视为跨年
            dt = dt.replace(year=base.year - 1)
        return (_fmt(dt), "推算")

    # 沟通列表当天记录只显示 "14:30"
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", s)
    if m:
        try:
            dt = _dt.datetime.combine(base.date(), _dt.time(int(m[1]), int(m[2])))
        except ValueError:
            return (None, None)
        return (_fmt(dt), "推算")

    if s in ("刚刚", "刚才", "现在", "在线", "当前在线"):
        return (_fmt(base), "推算")
    m = re.fullmatch(r"(\d+)秒(?:钟)?前", s)
    if m:
        return (_fmt(base - D(seconds=int(m[1]))), "推算")
    m = re.fullmatch(r"(\d+)分钟前", s)
    if m:
        return (_fmt(base - D(minutes=int(m[1]))), "推算")
    m = re.fullmatch(r"(\d+)小时前", s)
    if m:
        return (_fmt(base - D(hours=int(m[1]))), "推算")

    m = re.fullmatch(r"(今天|今日)(?:\s*(\d{1,2}):(\d{2}))?", s)
    if m:
        if m[2]:
            return (_fmt(_dt.datetime.combine(base.date(), _dt.time(int(m[2]), int(m[3])))), "推算")
        return (base.date().isoformat(), "推算")
    m = re.fullmatch(r"(昨天|昨日)(?:\s*(\d{1,2}):(\d{2}))?", s)
    if m:
        d = base.date() - D(days=1)
        if m[2]:
            return (_fmt(_dt.datetime.combine(d, _dt.time(int(m[2]), int(m[3])))), "推算")
        return (d.isoformat(), "推算")
    m = re.fullmatch(r"前天(?:\s*(\d{1,2}):(\d{2}))?", s)
    if m:
        d = base.date() - D(days=2)
        if m[1]:
            return (_fmt(_dt.datetime.combine(d, _dt.time(int(m[1]), int(m[2])))), "推算")
        return (d.isoformat(), "推算")

    m = re.fullmatch(r"(\d+)天前", s)
    if m:
        return ((base.date() - D(days=int(m[1]))).isoformat(), "推算")
    m = re.fullmatch(r"(\d+)周前", s)
    if m:
        return ((base.date() - D(weeks=int(m[1]))).isoformat(), "推算")
    m = re.fullmatch(r"(\d+)个月前", s)
    if m:
        return ((base.date() - D(days=30 * int(m[1]))).isoformat(), "推算")

    # HR 活跃度描述 → 日期级下界（"今日活跃"=今天之内在线过）
    if s in ("今日活跃", "刚刚活跃", "今日在线"):
        return (base.date().isoformat(), "推算")
    if s == "本周活跃":
        return ((base - D(days=6)).date().isoformat(), "推算")
    if s == "本月活跃":
        return ((base - D(days=29)).date().isoformat(), "推算")
    m = re.fullmatch(r"(\d+)日内活跃", s)
    if m:
        return ((base - D(days=int(m[1]) - 1)).date().isoformat(), "推算")

    return (None, None)


def hours_between(start, end):
    """两个 'YYYY-MM-DD[ HH:MM[:SS]]' 之间的小时数；解析失败返回 None。"""
    a, b = _to_dt(start), _to_dt(end)
    if not a or not b:
        return None
    return (b - a).total_seconds() / 3600.0
