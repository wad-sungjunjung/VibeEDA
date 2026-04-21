"""루트 폴더에 드롭된 로컬 데이터 파일(CSV/TSV/Parquet/Excel) 스키마·카테고리 캐시.

에이전트/Vibe chat 이 `pd.read_csv(...)` 같은 코드를 생성할 때, 파일의 컬럼·샘플값·
카테고리 컬럼 값을 이미 알고 있도록 시스템 프롬프트에 주입한다.

### 동작
- 파일 경로·mtime 을 키로 프로파일 저장 → mtime 변경 감지 시 재프로파일
- 대용량 파일은 `nrows=_SAMPLE_ROWS` 만 읽어 샘플링
- 파일 영속: `{notebooks_dir}/.files_profile_cache.json`
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


_SUPPORTED_EXTS = {".csv", ".tsv", ".parquet", ".xlsx", ".xls"}
_SAMPLE_ROWS = 10_000
_MAX_CATEGORIES = 100
_MAX_BYTES = 200 * 1024 * 1024   # 200MB 초과 파일은 프로파일링 스킵

# path(str) -> {"mtime": float, "size": int, "columns": [...], "row_sample_count": int, "error": str?}
_cache: dict[str, dict] = {}
_lock = threading.Lock()
_loaded_from_disk = False


def _cache_path() -> Path:
    from . import notebook_store
    return notebook_store.NOTEBOOKS_DIR / ".files_profile_cache.json"


def _load_from_disk() -> None:
    global _loaded_from_disk
    if _loaded_from_disk:
        return
    path = _cache_path()
    try:
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            with _lock:
                _cache.update(raw or {})
    except Exception as e:
        logger.warning("file profile cache load failed: %s", e)
    _loaded_from_disk = True


def _flush_to_disk() -> None:
    path = _cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        with _lock:
            snapshot = dict(_cache)
        tmp.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except Exception as e:
        logger.warning("file profile cache flush failed: %s", e)


def _read_df(path: Path) -> Optional[Any]:
    """파일 확장자에 맞춰 pandas 로 읽기. 큰 파일은 nrows 제한."""
    import pandas as pd
    ext = path.suffix.lower()
    try:
        if ext == ".csv":
            return pd.read_csv(path, nrows=_SAMPLE_ROWS, low_memory=False)
        if ext == ".tsv":
            return pd.read_csv(path, sep="\t", nrows=_SAMPLE_ROWS, low_memory=False)
        if ext == ".parquet":
            # parquet 은 nrows 지원 X — 전체 로드 (사이즈 가드로 보호)
            return pd.read_parquet(path)
        if ext in (".xlsx", ".xls"):
            return pd.read_excel(path, nrows=_SAMPLE_ROWS)
    except Exception as e:
        raise RuntimeError(f"read failed: {e}")
    return None


def _profile_columns(df) -> list[dict]:
    """DataFrame 의 각 컬럼 요약: type, null_ratio, distinct_count, (카테고리면) values."""
    out: list[dict] = []
    total = len(df)
    for col in df.columns:
        try:
            s = df[col]
            null_ratio = float(s.isna().mean()) if total > 0 else 0.0
            distinct = int(s.nunique(dropna=True))
            entry: dict[str, Any] = {
                "name": str(col),
                "dtype": str(s.dtype),
                "null_ratio": round(null_ratio, 3),
                "distinct_count": distinct,
            }
            # 카테고리형이면 distinct 값 수집
            if 1 < distinct <= _MAX_CATEGORIES and s.dtype == object:
                vals = sorted(str(v) for v in s.dropna().unique()[:_MAX_CATEGORIES])
                entry["categories"] = vals
            # 수치형 min/max
            try:
                import pandas as pd
                if pd.api.types.is_numeric_dtype(s):
                    entry["min"] = float(s.min()) if distinct else None
                    entry["max"] = float(s.max()) if distinct else None
            except Exception:
                pass
            out.append(entry)
        except Exception as e:
            out.append({"name": str(col), "error": str(e)})
    return out


def profile_file(path: Path | str, force: bool = False) -> dict:
    """파일 프로파일링. mtime 기반 캐시 사용. force=True 면 재프로파일."""
    _load_from_disk()
    p = Path(path).expanduser().resolve()
    key = str(p)
    if p.suffix.lower() not in _SUPPORTED_EXTS:
        return {"path": key, "error": "unsupported_extension"}
    if not p.exists() or not p.is_file():
        return {"path": key, "error": "not_found"}
    stat = p.stat()
    if stat.st_size > _MAX_BYTES:
        # 캐시에 skip 기록
        entry = {"path": key, "mtime": stat.st_mtime, "size": stat.st_size, "error": "file_too_large"}
        with _lock:
            _cache[key] = entry
        _flush_to_disk()
        return entry

    if not force:
        with _lock:
            cached = _cache.get(key)
        if cached and cached.get("mtime") == stat.st_mtime and cached.get("size") == stat.st_size and "error" not in cached:
            return cached

    try:
        df = _read_df(p)
    except Exception as e:
        entry = {"path": key, "mtime": stat.st_mtime, "size": stat.st_size, "error": str(e)}
        with _lock:
            _cache[key] = entry
        _flush_to_disk()
        return entry

    if df is None:
        return {"path": key, "error": "unsupported_format"}

    columns = _profile_columns(df)
    entry = {
        "path": key,
        "name": p.name,
        "mtime": stat.st_mtime,
        "size": stat.st_size,
        "row_sample_count": int(len(df)),
        "columns": columns,
    }
    with _lock:
        _cache[key] = entry
    _flush_to_disk()
    return entry


def get_cached(path: Path | str) -> Optional[dict]:
    _load_from_disk()
    with _lock:
        return _cache.get(str(Path(path).expanduser().resolve()))


def clear_cache(path: Optional[str] = None) -> int:
    _load_from_disk()
    with _lock:
        if path is None:
            n = len(_cache)
            _cache.clear()
        else:
            key = str(Path(path).expanduser().resolve())
            n = 1 if _cache.pop(key, None) else 0
    _flush_to_disk()
    return n


def scan_and_profile_root() -> dict:
    """루트 하위의 모든 지원 확장자 파일을 순회하며 프로파일링 (lazy — 이미 최신이면 스킵).
    반환: 통계 {scanned, cached, fetched, errors}."""
    from . import notebook_store
    root = notebook_store.NOTEBOOKS_DIR
    if not root.exists():
        return {"scanned": 0}
    scanned = 0
    fetched = 0
    cached = 0
    errors = 0
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in _SUPPORTED_EXTS:
            continue
        # 숨김/제외 디렉터리 스킵
        parts = p.relative_to(root).parts
        if any(x.startswith(".") or x in ("reports", "__pycache__") for x in parts[:-1]):
            continue
        scanned += 1
        stat = p.stat()
        key = str(p.resolve())
        with _lock:
            prev = _cache.get(key)
        if prev and prev.get("mtime") == stat.st_mtime and prev.get("size") == stat.st_size:
            cached += 1
            continue
        res = profile_file(p)
        if "error" in res:
            errors += 1
        else:
            fetched += 1
    return {"scanned": scanned, "cached": cached, "fetched": fetched, "errors": errors}


def get_all_profiled() -> list[dict]:
    """현재 캐시에 있는 모든 프로파일 반환 (에이전트 시스템 프롬프트 주입용)."""
    _load_from_disk()
    with _lock:
        return [dict(v) for v in _cache.values() if "columns" in v]


def format_for_prompt(max_files: int = 20, max_cols_per_file: int = 30) -> str:
    """시스템 프롬프트에 삽입할 텍스트 블록 생성."""
    profiles = get_all_profiled()
    if not profiles:
        return ""
    lines = ["\n## 📂 로컬 데이터 파일 (루트 폴더 — `pd.read_csv(path)` 로 접근)"]
    for p in profiles[:max_files]:
        path = p.get("path", "")
        name = p.get("name") or Path(path).name
        row_cnt = p.get("row_sample_count", "?")
        size_mb = (p.get("size", 0) or 0) / (1024 * 1024)
        lines.append(f"- **{name}** — `{path}`  ({row_cnt}행 샘플, {size_mb:.1f}MB)")
        cols = (p.get("columns") or [])[:max_cols_per_file]
        for c in cols:
            desc = f"    - {c.get('name')} ({c.get('dtype')})"
            if c.get("null_ratio", 0) > 0.05:
                desc += f" null={c['null_ratio']}"
            if c.get("distinct_count") is not None:
                desc += f" distinct={c['distinct_count']}"
            if c.get("categories"):
                preview = ", ".join(f"'{v}'" for v in c["categories"][:10])
                if len(c["categories"]) > 10:
                    preview += f", …(+{len(c['categories']) - 10})"
                desc += f" ∈ {{{preview}}}"
            lines.append(desc)
    if len(profiles) > max_files:
        lines.append(f"- ... 외 {len(profiles) - max_files}개 파일")
    lines.append("- 사용법: `import pandas as pd; df = pd.read_csv('절대경로')` — 경로는 위 path 그대로 사용.")
    return "\n".join(lines) + "\n"
