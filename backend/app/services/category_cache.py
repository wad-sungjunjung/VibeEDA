"""Category 컬럼(`*_status`, `*_type`, bare `status`/`type`) 의 distinct 값 캐시.

에이전트/Vibe Chat 이 WHERE 절을 쓸 때 올바른 카테고리 값을 알도록 시스템 프롬프트에 주입한다.

### 동작
- (mart_key_lower, col_name_lower) → list[str] | None 매핑
- distinct count > MAX_DISTINCT (=100) 면 None 으로 캐싱 (카테고리형 아님)
- **파일 영속**: `{notebooks_dir}/.categories_cache.json` 에 저장 → 백엔드 재시작 후에도 유지
- **TTL**: 각 엔트리 마다 `fetched_at` 기록, `_TTL_SECONDS` 지나면 stale 로 간주
- 수동 초기화: `clear_cache()` / `clear_cache(mart_key)`

### 프리워밍
- `prewarm_all_marts()`: 연결된 Snowflake 에서 모든 마트 열람 → `_status/_type` 컬럼 distinct 일괄 조회
- Snowflake 연결 직후 백그라운드 태스크로 호출 권장
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Optional

from . import snowflake_session


logger = logging.getLogger(__name__)

# 카테고리로 취급할 컬럼 이름 패턴
_CATEGORY_COL_RE = re.compile(r"(?i)(?:^|_)(status|type)$")
_MAX_DISTINCT = 100
_TTL_SECONDS = 7 * 24 * 60 * 60   # 7일

# 인메모리 저장소: (mart, col) -> {values: list[str] | None, fetched_at: float}
_cache: dict[tuple[str, str], dict] = {}
_lock = threading.Lock()
_loaded_from_disk = False


def _cache_path() -> Path:
    from . import notebook_store
    return notebook_store.VIBE_DIR / "categories_cache.json"


def _load_from_disk() -> None:
    global _loaded_from_disk
    if _loaded_from_disk:
        return
    path = _cache_path()
    try:
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            with _lock:
                for mart_key, cols in (raw or {}).items():
                    for col, entry in (cols or {}).items():
                        _cache[(mart_key, col)] = {
                            "values": entry.get("values"),
                            "fetched_at": float(entry.get("fetched_at") or 0.0),
                        }
    except Exception as e:
        logger.warning("category cache load failed: %s", e)
    _loaded_from_disk = True


def _flush_to_disk() -> None:
    path = _cache_path()
    try:
        # mart 단위로 그룹핑 저장 (가독성)
        grouped: dict[str, dict[str, dict]] = {}
        with _lock:
            for (mart, col), entry in _cache.items():
                grouped.setdefault(mart, {})[col] = {
                    "values": entry["values"],
                    "fetched_at": entry["fetched_at"],
                }
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(grouped, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except Exception as e:
        logger.warning("category cache flush failed: %s", e)


def is_category_column(col_name: str) -> bool:
    return bool(_CATEGORY_COL_RE.search(col_name or ""))


def clear_cache(mart_key: Optional[str] = None) -> int:
    _load_from_disk()
    with _lock:
        if mart_key is None:
            n = len(_cache)
            _cache.clear()
        else:
            mk = mart_key.lower()
            keys = [k for k in _cache if k[0] == mk]
            for k in keys:
                del _cache[k]
            n = len(keys)
    _flush_to_disk()
    return n


def _fresh(entry: dict) -> bool:
    return (time.time() - entry.get("fetched_at", 0.0)) < _TTL_SECONDS


class _QueryFailed(Exception):
    """쿼리 실패(미연결·예외) — 캐시에 저장하지 않고 다음 요청 때 재시도."""


def _query_distinct(mart_key: str, col: str) -> Optional[list[str]]:
    """Snowflake 에서 distinct 값 조회.
    - 정상 응답 값 ≤ MAX_DISTINCT → list
    - 정상 응답 값 > MAX_DISTINCT → None (too_many — 캐시에 저장 OK)
    - 미연결 or 예외 → _QueryFailed 발생 (상위에서 cache 저장 스킵)"""
    if not snowflake_session.is_connected():
        raise _QueryFailed("snowflake not connected")
    try:
        conn = snowflake_session.get_connection()
        status = snowflake_session.get_status()
        database = status.get("database") or "WAD_DW_PROD"
        schema = status.get("schema") or "MART"
        table = mart_key.upper()
        full = f'{database}.{schema}.{table}'
        cur = conn.cursor()
        cur.execute(
            f'SELECT DISTINCT "{col}" FROM {full} WHERE "{col}" IS NOT NULL LIMIT {_MAX_DISTINCT + 1}'
        )
        rows = cur.fetchall()
    except Exception as e:
        logger.warning("category distinct query failed: %s.%s → %s", mart_key, col, e)
        raise _QueryFailed(str(e))
    if len(rows) > _MAX_DISTINCT:
        return None   # 정상 "too many" — 캐시에 None 저장
    vals: list[str] = []
    for r in rows:
        v = r[0]
        if v is None:
            continue
        s = str(v)
        if s.strip() == "":
            continue
        vals.append(s)
    vals.sort()
    return vals


def get_category_values(mart_key: str, col: str, use_cache: bool = True) -> Optional[list[str]]:
    """캐시 우선 조회. TTL 유효하면 즉시 리턴, 아니면 재쿼리.
    쿼리 실패(미연결·예외) 시에는 캐시를 오염시키지 않고 None 반환."""
    _load_from_disk()
    key = (mart_key.lower(), col.lower())
    if use_cache:
        with _lock:
            entry = _cache.get(key)
        if entry and _fresh(entry):
            return entry["values"]
    try:
        vals = _query_distinct(mart_key, col)
    except _QueryFailed:
        return None   # 캐시에 쓰지 않음 — 다음 요청 시 재시도
    with _lock:
        _cache[key] = {"values": vals, "fetched_at": time.time()}
    _flush_to_disk()
    return vals


def enrich_mart_metadata(mart_metadata: list[dict]) -> list[dict]:
    """각 마트의 카테고리성 컬럼에 `categories` 필드 주입 (캐시 기반, 미스 시 즉시 쿼리)."""
    _load_from_disk()
    out: list[dict] = []
    for m in mart_metadata or []:
        mk = m.get("key") or ""
        new_cols: list[dict] = []
        for c in m.get("columns") or []:
            cname = c.get("name") or ""
            if is_category_column(cname):
                try:
                    vals = get_category_values(mk, cname)
                except Exception as e:
                    logger.warning("enrich category failed: %s.%s → %s", mk, cname, e)
                    vals = None
                if vals:
                    new_c = dict(c)
                    new_c["categories"] = vals
                    new_cols.append(new_c)
                    continue
            new_cols.append(c)
        new_m = dict(m)
        new_m["columns"] = new_cols
        out.append(new_m)
    return out


# ─── 백그라운드 프리워밍 ─────────────────────────────────────────────────────

_prewarm_running = False
_prewarm_lock = threading.Lock()
_prewarm_progress = {"total": 0, "done": 0, "started_at": 0.0, "finished_at": 0.0}


def get_prewarm_progress() -> dict:
    with _prewarm_lock:
        return dict(_prewarm_progress, running=_prewarm_running)


def _list_all_marts() -> list[tuple[str, list[str]]]:
    """연결된 Snowflake 에서 모든 마트와 각 테이블의 카테고리 컬럼 나열."""
    if not snowflake_session.is_connected():
        return []
    conn = snowflake_session.get_connection()
    status = snowflake_session.get_status()
    database = status.get("database") or "WAD_DW_PROD"
    schema = status.get("schema") or "MART"
    cur = conn.cursor()
    try:
        cur.execute(
            f"""
            SELECT table_name, column_name
            FROM {database}.information_schema.columns
            WHERE table_schema = '{schema.upper()}'
              AND (
                LOWER(column_name) LIKE '%\\_status' ESCAPE '\\'
                OR LOWER(column_name) = 'status'
                OR LOWER(column_name) LIKE '%\\_type' ESCAPE '\\'
                OR LOWER(column_name) = 'type'
              )
            ORDER BY table_name, ordinal_position
            """
        )
        rows = cur.fetchall()
    except Exception as e:
        logger.warning("list all marts failed: %s", e)
        return []
    by_table: dict[str, list[str]] = {}
    for tbl, col in rows:
        by_table.setdefault(tbl, []).append(col)
    return list(by_table.items())


def _get_last_altered_map() -> dict[str, float]:
    """마트별 last_altered 시각 epoch 반환 — 스마트 invalidation 용."""
    if not snowflake_session.is_connected():
        return {}
    conn = snowflake_session.get_connection()
    status = snowflake_session.get_status()
    database = status.get("database") or "WAD_DW_PROD"
    schema = status.get("schema") or "MART"
    cur = conn.cursor()
    try:
        cur.execute(
            f"""
            SELECT table_name, DATE_PART('epoch', last_altered)
            FROM {database}.information_schema.tables
            WHERE table_schema = '{schema.upper()}'
              AND table_type = 'BASE TABLE'
            """
        )
        rows = cur.fetchall()
    except Exception as e:
        logger.warning("get last_altered failed: %s", e)
        return {}
    return {r[0].lower(): float(r[1]) for r in rows if r[0] and r[1] is not None}


def invalidate_changed_marts() -> int:
    """Snowflake last_altered 기준으로 캐시보다 최근에 변경된 마트의 엔트리만 무효화.
    반환: 무효화된 엔트리 개수."""
    _load_from_disk()
    altered = _get_last_altered_map()
    if not altered:
        return 0
    removed = 0
    with _lock:
        for key in list(_cache.keys()):
            mart_key, _ = key
            la = altered.get(mart_key)
            if la is None:
                continue
            entry = _cache[key]
            if la > entry.get("fetched_at", 0.0):
                del _cache[key]
                removed += 1
    if removed:
        _flush_to_disk()
        logger.info("invalidated %d cache entries due to last_altered change", removed)
    return removed


def prewarm_all_marts(priority_marts: Optional[list[str]] = None) -> dict:
    """연결된 Snowflake 의 모든 마트에서 카테고리 컬럼 distinct 값을 일괄 조회·저장.
    priority_marts 는 먼저 처리할 마트 키 리스트 (선택된 마트 우선).
    동시 실행 방지: 중복 호출은 즉시 리턴."""
    global _prewarm_running
    with _prewarm_lock:
        if _prewarm_running:
            return {"ok": False, "reason": "already_running"}
        _prewarm_running = True
        _prewarm_progress.update(
            {"total": 0, "done": 0, "started_at": time.time(), "finished_at": 0.0}
        )

    try:
        _load_from_disk()
        # 변경 감지 → 캐시 파기 → 재쿼리 대상 자연스레 증가
        try:
            invalidate_changed_marts()
        except Exception as e:
            logger.warning("invalidate_changed_marts failed: %s", e)
        all_marts = _list_all_marts()  # [(table, [col...])]
        if priority_marts:
            prio_set = {m.lower() for m in priority_marts}
            all_marts.sort(key=lambda t: (0 if t[0].lower() in prio_set else 1, t[0]))

        total_cols = sum(len(cols) for _, cols in all_marts)
        with _prewarm_lock:
            _prewarm_progress["total"] = total_cols

        done = 0
        fetched = 0
        skipped_fresh = 0
        for mart_key, cols in all_marts:
            for col in cols:
                key = (mart_key.lower(), col.lower())
                with _lock:
                    entry = _cache.get(key)
                if entry and _fresh(entry):
                    skipped_fresh += 1
                else:
                    try:
                        vals = _query_distinct(mart_key, col)
                    except _QueryFailed:
                        # 쿼리 실패 → 캐시에 쓰지 않고 다음 주기에 재시도
                        done += 1
                        continue
                    with _lock:
                        _cache[key] = {"values": vals, "fetched_at": time.time()}
                    fetched += 1
                done += 1
                with _prewarm_lock:
                    _prewarm_progress["done"] = done
        _flush_to_disk()
        return {
            "ok": True,
            "marts_scanned": len(all_marts),
            "columns_total": total_cols,
            "fetched": fetched,
            "skipped_fresh": skipped_fresh,
        }
    finally:
        with _prewarm_lock:
            _prewarm_running = False
            _prewarm_progress["finished_at"] = time.time()
