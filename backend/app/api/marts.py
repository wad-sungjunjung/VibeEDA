import logging
import re
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)

from ..services import snowflake_session

router = APIRouter()


_IDENT_RE = re.compile(r"^[A-Za-z0-9_$]+$")


def _safe_ident(s: str) -> str:
    """SQL identifier 검증 — account_usage 검색 결과를 information_schema 로 다시 질의할 때 사용.
    영숫자/언더스코어/달러 외 문자가 있으면 거부 (인젝션 방지)."""
    if not s or not _IDENT_RE.match(s):
        raise HTTPException(status_code=400, detail=f"Invalid identifier: {s!r}")
    return s


@router.get("/marts")
def list_marts():
    if not snowflake_session.is_connected():
        return []

    try:
        conn = snowflake_session.get_connection()
        status = snowflake_session.get_status()
        database = status.get("database", "WAD_DW_PROD")
        schema = status.get("schema", "MART")

        cur = conn.cursor()

        cur.execute(f"""
            SELECT table_name, comment
            FROM {database}.information_schema.tables
            WHERE table_schema = '{schema.upper()}'
              AND table_type = 'BASE TABLE'
            ORDER BY table_name
        """, timeout=10)
        tables = cur.fetchall()

        if not tables:
            return []

        table_names = [t[0] for t in tables]
        table_comments = {t[0]: t[1] or "" for t in tables}

        in_clause = ", ".join(f"'{t}'" for t in table_names)
        cur.execute(f"""
            SELECT table_name, column_name, data_type, comment
            FROM {database}.information_schema.columns
            WHERE table_schema = '{schema.upper()}'
              AND table_name IN ({in_clause})
            ORDER BY table_name, ordinal_position
        """, timeout=10)
        col_rows = cur.fetchall()

        columns_by_table: dict[str, list[dict]] = {t: [] for t in table_names}
        for tbl, col, dtype, cdesc in col_rows:
            columns_by_table.setdefault(tbl, []).append({
                "name": col,
                "type": dtype,
                "desc": cdesc or col,
            })

        now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        result = []
        for tbl, comment in table_comments.items():
            words = [w.lower() for w in tbl.split("_") if w]
            result.append({
                "key": tbl.lower(),
                "description": comment or tbl,
                "keywords": words,
                "columns": columns_by_table.get(tbl, []),
                "rules": [],
                "recommendationScore": 0,
                "updatedAt": now,
            })
        return result

    except Exception as e:
        logger.error("Failed to fetch marts from Snowflake: %s", e)
        return []


@router.get("/marts/search")
def search_marts(
    q: str = Query(..., min_length=2, max_length=64, description="테이블명 부분 일치 (대소문자 무시)"),
    limit: int = Query(20, ge=1, le=50),
):
    """히든룰 — MART 스키마 외 영역까지 확장 검색.

    SNOWFLAKE.ACCOUNT_USAGE.TABLES 에서 TABLE_NAME ILIKE %q% 매칭.
    account_usage 는 45분~3시간 지연이 있지만 마트 메타 검색에는 문제 없음.
    실패 시 information_schema 폴백 (현재 세션 DB 한정)."""
    if not snowflake_session.is_connected():
        raise HTTPException(status_code=400, detail="Snowflake 에 연결되어 있지 않습니다.")
    pattern = f"%{q}%"
    try:
        conn = snowflake_session.get_connection()
        cur = conn.cursor()
        try:
            cur.execute(
                """
                SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, COMMENT
                FROM SNOWFLAKE.ACCOUNT_USAGE.TABLES
                WHERE DELETED IS NULL
                  AND TABLE_NAME ILIKE %s
                  AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
                ORDER BY LAST_ALTERED DESC NULLS LAST
                LIMIT %s
                """,
                (pattern, limit),
                timeout=15,
            )
            rows = cur.fetchall()
        except Exception as e:
            # account_usage 권한 없거나 비활성 — 현재 세션 DB 의 information_schema 로 폴백
            logger.warning("account_usage 검색 실패, information_schema 폴백: %s", e)
            status = snowflake_session.get_status()
            database = status.get("database") or "WAD_DW_PROD"
            cur.execute(
                f"""
                SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, COMMENT
                FROM {_safe_ident(database)}.INFORMATION_SCHEMA.TABLES
                WHERE TABLE_NAME ILIKE %s
                  AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
                ORDER BY TABLE_NAME
                LIMIT %s
                """,
                (pattern, limit),
                timeout=10,
            )
            rows = cur.fetchall()

        results = []
        for cat, sch, tbl, ttype, comment in rows:
            results.append({
                "database": cat,
                "schema": sch,
                "table_name": tbl,
                "table_type": ttype,
                "comment": comment or "",
                # UI 표시용 — DB.SCHEMA.TABLE 가 같으면 중복 추가 방지
                "fqn": f"{cat}.{sch}.{tbl}".lower(),
            })
        return {"ok": True, "results": results}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("search_marts failed: %s", e)
        return {"ok": False, "message": str(e), "results": []}


@router.get("/marts/columns")
def get_mart_columns(
    database: str = Query(...),
    schema: str = Query(...),
    table: str = Query(...),
):
    """검색 결과로 발견한 테이블의 컬럼 메타 조회.
    extras 추가 직전에 호출되며, MartMeta 로 변환할 수 있는 형태를 반환."""
    if not snowflake_session.is_connected():
        raise HTTPException(status_code=400, detail="Snowflake 에 연결되어 있지 않습니다.")
    db = _safe_ident(database)
    sch = _safe_ident(schema).upper()
    tbl = _safe_ident(table).upper()
    try:
        conn = snowflake_session.get_connection()
        cur = conn.cursor()
        # 테이블 메타 (COMMENT) 와 컬럼 목록 함께 조회
        cur.execute(
            f"""
            SELECT TABLE_NAME, COMMENT
            FROM {db}.INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
            """,
            (sch, tbl),
            timeout=10,
        )
        meta = cur.fetchone()
        if not meta:
            raise HTTPException(status_code=404, detail=f"{db}.{sch}.{tbl} not found")
        tbl_comment = meta[1] or ""

        cur.execute(
            f"""
            SELECT COLUMN_NAME, DATA_TYPE, COMMENT
            FROM {db}.INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
            ORDER BY ORDINAL_POSITION
            """,
            (sch, tbl),
            timeout=10,
        )
        cols = [
            {"name": c, "type": t, "desc": (cmt or c)}
            for c, t, cmt in cur.fetchall()
        ]

        # MART 스키마 외부 테이블은 FQN 으로 키를 만든다 (마트 풀의 단순 키와 충돌 방지)
        key = f"{db}.{sch}.{tbl}".lower()
        words = [w.lower() for w in re.split(r"[._]", tbl) if w]
        return {
            "ok": True,
            "mart": {
                "key": key,
                "database": db,
                "schema": sch,
                "table_name": tbl,
                "description": tbl_comment or tbl,
                "keywords": words,
                "columns": cols,
                "rules": [],
                "recommendationScore": 0,
                "updatedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                "extra": True,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("get_mart_columns failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
