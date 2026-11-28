"""Local image and message settings for first contact."""
import base64
import json
import os
import pathlib
import re
import tempfile


_ROOT = pathlib.Path(__file__).resolve().parent.parent
_DEFAULT_SETTINGS = _ROOT / "db" / "private-settings.json"
_DEFAULT_RESUME_DIR = _ROOT / "db" / "private"

MAX_RESUMES = 9
MAX_RESUME_BYTES = 8 * 1024 * 1024
MAX_TOTAL_RESUME_BYTES = 40 * 1024 * 1024
_RESUME_FILE = re.compile(r"resume(?:-\d+)?\.[A-Za-z0-9]+$")

DEFAULTS = {"advantage_message": "", "advantage_messages": [], "resume": {}, "resumes": []}


def _settings_path() -> pathlib.Path:
    return pathlib.Path(os.environ.get("TRACKER_SETTINGS") or _DEFAULT_SETTINGS)


def _resume_dir() -> pathlib.Path:
    return pathlib.Path(os.environ.get("TRACKER_RESUME_DIR") or _DEFAULT_RESUME_DIR)


def load() -> dict:
    data = {}
    path = _settings_path()
    if path.is_file():
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                data = value
        except (OSError, ValueError):
            data = {}
    return {key: data.get(key, value) for key, value in DEFAULTS.items()}


def configured_messages(cfg):
    raw = cfg.get("advantage_messages")
    if raw is None or raw == []:
        legacy = str(cfg.get("advantage_message") or "").strip()
        return [legacy] if legacy else []
    return validate_messages(raw)


def validate_messages(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 3:
        raise ValueError("话术必须为 1 到 3 段文字")
    if any(not isinstance(text, str) or not text.strip() or len(text.strip()) > 300 for text in raw):
        raise ValueError("每段话术不能为空且最多 300 字符")
    return [text.strip() for text in raw]


def update_messages(cfg, values):
    if "advantage_messages" in values:
        texts = validate_messages(values["advantage_messages"])
    elif "advantage_message" in values:
        first = str(values.get("advantage_message") or "").strip()
        if len(first) > 300:
            raise ValueError("个人优势话术最多 300 字")
        texts = ([first] if first else []) + configured_messages(cfg)[1:]
    else:
        texts = configured_messages(cfg)
    cfg["advantage_messages"] = texts
    cfg["advantage_message"] = texts[0] if texts else ""


def configured_resumes(cfg):
    raw = cfg.get("resumes")
    if isinstance(raw, list):
        items = [item for item in raw if isinstance(item, dict) and item.get("path")]
        if items:
            return items
    legacy = cfg.get("resume")
    if isinstance(legacy, dict) and legacy.get("path"):
        return [legacy]
    return []


def public() -> dict:
    cfg = load()
    resumes = []
    for item in configured_resumes(cfg):
        path = pathlib.Path(str(item.get("path") or ""))
        exists = bool(path.is_file())
        resumes.append({
            "exists": exists,
            "name": item.get("name", "") if exists else "",
            "mime": item.get("mime", "") if exists else "",
            "size": path.stat().st_size if exists else 0,
        })
    resume = resumes[0] if resumes else {"exists": False, "name": "", "mime": "", "size": 0}
    return {
        "advantage_message": (configured_messages(cfg) or [""])[0],
        "advantage_messages": configured_messages(cfg),
        "resume": dict(resume),
        "resumes": resumes,
    }


def update(values: dict) -> dict:
    if set(values) - {"advantage_message", "advantage_messages"}:
        raise ValueError("设置仅支持个人优势话术")
    cfg = load()
    update_messages(cfg, values)
    _write(cfg)
    return public()


def _decode_image(entry):
    if not isinstance(entry, dict):
        raise ValueError("图片数据无效")
    data_url = str(entry.get("data_url") or "")
    match = re.fullmatch(r"data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)", data_url)
    if not match:
        raise ValueError("只支持 JPG、PNG 或 WebP 图片")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except ValueError as exc:
        raise ValueError("图片数据无效") from exc
    if not raw or len(raw) > MAX_RESUME_BYTES:
        raise ValueError("每张简历图片需小于 8 MB")
    return match.group(1), raw, str(entry.get("filename") or "")


def _write_resume_items(items) -> list:
    if not items:
        raise ValueError("请至少保留一张简历图片")
    if len(items) > MAX_RESUMES:
        raise ValueError(f"最多保留 {MAX_RESUMES} 张简历图片")
    if sum(len(raw) for _mime, raw, _name in items) > MAX_TOTAL_RESUME_BYTES:
        raise ValueError("简历图片总大小需小于 40 MB")

    directory = _resume_dir()
    directory.mkdir(parents=True, exist_ok=True)
    records = []
    for index, (mime, raw, filename) in enumerate(items, 1):
        suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime]
        target = directory / f"resume-{index:02d}{suffix}"
        _atomic_bytes(target, raw)
        records.append({
            "path": str(target.resolve()),
            "name": _safe_filename(filename, suffix),
            "mime": mime,
        })
    target_paths = {pathlib.Path(item["path"]) for item in records}
    for old in directory.iterdir():
        if old.is_file() and _RESUME_FILE.fullmatch(old.name) and old.resolve() not in target_paths:
            old.unlink()

    cfg = load()
    cfg["resumes"] = records
    cfg["resume"] = dict(records[0])
    _write(cfg)
    return public()["resumes"]


def save_resumes(files) -> list:
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_RESUMES:
        raise ValueError(f"请一次上传 1 到 {MAX_RESUMES} 张简历图片")
    return _write_resume_items([_decode_image(item) for item in files])


def append_resumes(files) -> list:
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_RESUMES:
        raise ValueError(f"请一次添加 1 到 {MAX_RESUMES} 张简历图片")
    existing = []
    for path, mime, name in resume_files():
        try:
            existing.append((mime, path.read_bytes(), name))
        except OSError as exc:
            raise ValueError("读取现有简历图片失败，请清空后重新选择") from exc
    if len(existing) + len(files) > MAX_RESUMES:
        raise ValueError(f"最多保留 {MAX_RESUMES} 张简历图片，当前已有 {len(existing)} 张")
    return _write_resume_items(existing + [_decode_image(item) for item in files])


def clear_resumes() -> list:
    directory = _resume_dir()
    if directory.is_dir():
        for old in directory.iterdir():
            if old.is_file() and _RESUME_FILE.fullmatch(old.name):
                old.unlink()
    cfg = load()
    cfg["resumes"] = []
    cfg["resume"] = {}
    _write(cfg)
    return []


def save_resume(data_url: str, filename: str) -> dict:
    save_resumes([{"data_url": data_url, "filename": filename}])
    return public()["resume"]


def resume_files():
    files = []
    for item in configured_resumes(load()):
        path = pathlib.Path(str(item.get("path") or ""))
        if path.is_file():
            files.append((path, item.get("mime") or "application/octet-stream",
                          item.get("name") or path.name))
    return files


def resume_file():
    files = resume_files()
    return files[0] if files else None


def _safe_filename(name: str, suffix: str) -> str:
    stem = pathlib.Path(str(name or "resume")).stem
    stem = re.sub(r'[^\w\-\u4e00-\u9fff]+', "_", stem, flags=re.UNICODE).strip("_.")[:80]
    return (stem or "resume") + suffix


def _write(data: dict) -> None:
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    _atomic_bytes(path, content)


def _atomic_bytes(path: pathlib.Path, content: bytes) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
