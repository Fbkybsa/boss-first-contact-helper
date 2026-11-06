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

DEFAULTS = {"advantage_message": "", "resume": {}}


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


def public() -> dict:
    cfg = load()
    resume = dict(cfg.get("resume") or {})
    path = resume.get("path")
    exists = bool(path and pathlib.Path(path).is_file())
    return {
        "advantage_message": cfg.get("advantage_message", ""),
        "resume": {
            "exists": exists,
            "name": resume.get("name", "") if exists else "",
            "mime": resume.get("mime", "") if exists else "",
            "size": pathlib.Path(path).stat().st_size if exists else 0,
        },
    }


def update(values: dict) -> dict:
    if set(values) - {"advantage_message"}:
        raise ValueError("设置仅支持个人优势话术")
    cfg = load()
    if "advantage_message" in values:
        cfg["advantage_message"] = str(values.get("advantage_message") or "").strip()
    if len(cfg["advantage_message"]) > 300:
        raise ValueError("个人优势话术最多 300 字")
    _write(cfg)
    return public()


def save_resume(data_url: str, filename: str) -> dict:
    match = re.fullmatch(r"data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)", data_url or "")
    if not match:
        raise ValueError("只支持 JPG、PNG 或 WebP 图片")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except ValueError as exc:
        raise ValueError("图片数据无效") from exc
    if not raw or len(raw) > 8 * 1024 * 1024:
        raise ValueError("简历图片需小于 8 MB")

    mime = match.group(1)
    suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime]
    directory = _resume_dir()
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ("resume" + suffix)
    for old in directory.glob("resume.*"):
        if old != target and old.is_file():
            old.unlink()
    _atomic_bytes(target, raw)

    cfg = load()
    cfg["resume"] = {
        "path": str(target.resolve()),
        "name": _safe_filename(filename, suffix),
        "mime": mime,
    }
    _write(cfg)
    return public()["resume"]


def resume_file():
    cfg = load()
    resume = cfg.get("resume") or {}
    path = pathlib.Path(str(resume.get("path") or ""))
    if not path.is_file():
        return None
    return path, resume.get("mime") or "application/octet-stream", resume.get("name") or path.name


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
