"""notebook_store 핵심 — 경로/설정/폴더 config/파일 I/O + 요청 스코프 캐시."""
from __future__ import annotations

import json
import re
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Optional

_SETTINGS_FILE = Path.home() / ".vibe_eda_settings.json"


def _load_settings() -> dict:
    if _SETTINGS_FILE.exists():
        try:
            return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_settings(data: dict) -> None:
    try:
        _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


_settings = _load_settings()
NOTEBOOKS_DIR = Path(_settings.get("notebooks_dir", str(Path.home() / "vibe-notebooks"))).expanduser().resolve()
VIBE_DIR = NOTEBOOKS_DIR / ".vibe"
CONFIG_FILE = VIBE_DIR / "config.json"


# ── 초기화 ────────────────────────────────────────────────────────────────────

def _ensure_dir() -> None:
    NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
    VIBE_DIR.mkdir(parents=True, exist_ok=True)
    # Windows에서 .vibe 폴더를 숨김 처리
    import sys
    if sys.platform == "win32":
        import subprocess
        subprocess.run(["attrib", "+h", str(VIBE_DIR)], capture_output=True)


def set_notebooks_dir(new_path: str) -> Path:
    """노트북 저장 경로를 변경하고 설정 파일에 저장합니다."""
    global NOTEBOOKS_DIR, VIBE_DIR, CONFIG_FILE
    resolved = Path(new_path).expanduser().resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    NOTEBOOKS_DIR = resolved
    VIBE_DIR = resolved / ".vibe"
    CONFIG_FILE = VIBE_DIR / "config.json"
    VIBE_DIR.mkdir(parents=True, exist_ok=True)
    _save_settings({**_load_settings(), "notebooks_dir": str(resolved)})
    # 경로 변경 시 요청 캐시는 무효화 (다른 디렉터리 컨텐츠 섞이지 않도록)
    cache = _request_cache.get()
    if cache is not None:
        cache.clear()
    return resolved


def _read_config() -> dict:
    # 요청 스코프 안에서는 한 번만 디스크 읽고 같은 dict 객체를 재사용한다.
    # 호출자(_register_file 등)는 cfg 를 mutate 후 _write_config(cfg) 로 영속하는데,
    # 같은 객체를 들고 있으므로 같은 요청 내 후속 _read_config 도 최신 상태를 본다.
    holder = _request_config_cache.get()
    if holder is not None and "data" in holder:
        return holder["data"]
    if CONFIG_FILE.exists():
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    else:
        data = {"folders": []}
    if holder is not None:
        holder["data"] = data
    return data


def _write_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    holder = _request_config_cache.get()
    if holder is not None:
        holder["data"] = cfg


# ── 파일명 관리 ───────────────────────────────────────────────────────────────

def _sanitize_title(title: str) -> str:
    """타이틀을 Windows 유효 파일명으로 변환."""
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title).strip('. ') or 'notebook'
    return sanitized


def _unique_filename(title: str, exclude_id: str | None = None) -> str:
    """title 기반 충돌 없는 파일명(확장자 제외) 반환."""
    base = _sanitize_title(title)
    cfg = _read_config()
    used = set(v for k, v in cfg.get("id_to_file", {}).items() if k != exclude_id)
    if base not in used:
        return base
    n = 1
    while f"{base} {n}" in used:
        n += 1
    return f"{base} {n}"


def _register_file(nb_id: str, fname: str) -> None:
    cfg = _read_config()
    cfg.setdefault("id_to_file", {})[nb_id] = fname
    _write_config(cfg)


def _unregister_file(nb_id: str) -> None:
    cfg = _read_config()
    cfg.setdefault("id_to_file", {}).pop(nb_id, None)
    _write_config(cfg)


# ── 파일 I/O + 요청 스코프 캐시 ──────────────────────────────────────────────

_EXCLUDED_DIR_NAMES = {"reports", "__pycache__"}


def _iter_notebook_paths() -> list[Path]:
    """NOTEBOOKS_DIR 아래 모든 .ipynb 파일 (reports/, hidden, __pycache__ 제외)."""
    results: list[Path] = []
    if not NOTEBOOKS_DIR.exists():
        return results
    for p in NOTEBOOKS_DIR.rglob("*.ipynb"):
        try:
            rel_parts = p.relative_to(NOTEBOOKS_DIR).parts
        except ValueError:
            continue
        parent_parts = rel_parts[:-1]
        if any(part.startswith(".") or part in _EXCLUDED_DIR_NAMES for part in parent_parts):
            continue
        results.append(p)
    return results


def _nb_path(nb_id: str) -> Path:
    cfg = _read_config()
    rel = cfg.get("id_to_file", {}).get(nb_id)
    if rel:
        p = NOTEBOOKS_DIR / f"{rel}.ipynb"
        if p.exists():
            return p
    # Fallback: 재귀 스캔으로 metadata.vibe.id 가 일치하는 파일 찾기
    for p in _iter_notebook_paths():
        try:
            nb = json.loads(p.read_text(encoding="utf-8"))
            if nb.get("metadata", {}).get("vibe", {}).get("id") == nb_id:
                new_rel = str(p.relative_to(NOTEBOOKS_DIR).with_suffix(""))
                cfg = _read_config()
                cfg.setdefault("id_to_file", {})[nb_id] = new_rel
                _write_config(cfg)
                return p
        except Exception:
            continue
    # 하위 호환: 기존 UUID 파일명
    return NOTEBOOKS_DIR / f"{nb_id}.ipynb"


# 요청 스코프 캐시 (FastAPI 미들웨어가 scope를 연다).
# 한 HTTP 요청 내에서 같은 nb_id / config 를 여러 번 읽을 때 파일 I/O 를 반복하지 않도록.
# 쓰기는 cache 에도 반영해 동일 요청 내 후속 read 가 최신 상태를 보게 한다.
_request_cache: ContextVar[Optional[dict]] = ContextVar("nb_request_cache", default=None)
# config (folders/id_to_file 인덱스) 전용 — 한 요청 내 _read_config 호출이
# 셀/노트북/폴더 모듈에 걸쳐 누적될 수 있어 별도로 관리.
_request_config_cache: ContextVar[Optional[dict]] = ContextVar("nb_request_config_cache", default=None)


@contextmanager
def request_cache_scope():
    """한 요청 동안 유지되는 노트북 파일/설정 캐시를 연다. 미들웨어에서 호출."""
    nb_token = _request_cache.set({})
    cfg_token = _request_config_cache.set({})
    try:
        yield
    finally:
        _request_config_cache.reset(cfg_token)
        _request_cache.reset(nb_token)


def _read_nb(nb_id: str) -> dict:
    cache = _request_cache.get()
    if cache is not None and nb_id in cache:
        return cache[nb_id]
    nb = json.loads(_nb_path(nb_id).read_text(encoding="utf-8"))
    if cache is not None:
        cache[nb_id] = nb
    return nb


def _write_nb(nb_id: str, nb: dict) -> None:
    _nb_path(nb_id).write_text(
        json.dumps(nb, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    cache = _request_cache.get()
    if cache is not None:
        cache[nb_id] = nb
