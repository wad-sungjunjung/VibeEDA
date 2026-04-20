"""에이전트/MCP 공용 마트 조회 도구.

Snowflake 세션을 직접 쏘며, 노트북에 셀을 남기지 않는다.
- get_mart_schema: 컬럼명/타입/description
- preview_mart: 상위 N행 샘플
- profile_mart: 행수 + 컬럼별 NULL·카디널리티
"""
from typing import Any

from . import snowflake_session


def _ctx() -> tuple[Any, str, str]:
    if not snowflake_session.is_connected():
        raise RuntimeError(
            "Snowflake 미연결: 왼쪽 사이드바 '연결 관리'에서 Snowflake에 먼저 연결해야 마트 도구를 사용할 수 있습니다. "
            "사용자에게 연결 후 다시 요청해달라고 ask_user로 안내하세요."
        )
    conn = snowflake_session.get_connection()
    status = snowflake_session.get_status()
    database = status.get("database") or "WAD_DW_PROD"
    schema = status.get("schema") or "MART"
    return conn, database, schema


def _resolve_table(cur, database: str, schema: str, mart_key: str) -> str:
    """mart_key(소문자 가능)를 실제 테이블명으로 변환. 없으면 예외."""
    cur.execute(
        f"""
        SELECT table_name FROM {database}.information_schema.tables
        WHERE table_schema = %s AND LOWER(table_name) = LOWER(%s)
        LIMIT 1
        """,
        (schema.upper(), mart_key),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(f"마트 '{mart_key}' 를 찾을 수 없습니다.")
    return row[0]


def get_mart_schema(mart_key: str) -> dict:
    """마트의 컬럼 스키마 반환."""
    conn, database, schema = _ctx()
    cur = conn.cursor()
    table = _resolve_table(cur, database, schema, mart_key)

    cur.execute(
        f"""
        SELECT column_name, data_type, comment, is_nullable
        FROM {database}.information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
        """,
        (schema.upper(), table),
    )
    rows = cur.fetchall()

    cur.execute(
        f"""
        SELECT comment FROM {database}.information_schema.tables
        WHERE table_schema = %s AND table_name = %s
        """,
        (schema.upper(), table),
    )
    tbl_comment_row = cur.fetchone()

    return {
        "mart_key": table.lower(),
        "full_name": f"{database}.{schema}.{table}",
        "description": (tbl_comment_row[0] if tbl_comment_row else "") or "",
        "columns": [
            {"name": c, "type": t, "description": (d or ""), "nullable": (n == "YES")}
            for (c, t, d, n) in rows
        ],
    }


def preview_mart(mart_key: str, limit: int = 5) -> dict:
    """상위 N행 샘플 반환 (노트북 셀 생성 없음)."""
    limit = max(1, min(int(limit or 5), 50))
    conn, database, schema = _ctx()
    cur = conn.cursor()
    table = _resolve_table(cur, database, schema, mart_key)

    cur.execute(f'SELECT * FROM {database}.{schema}.{table} LIMIT {limit}')
    cols = [c[0] for c in cur.description]
    rows = [[_serialize(v) for v in row] for row in cur.fetchall()]

    return {
        "mart_key": table.lower(),
        "columns": cols,
        "rows": rows,
        "row_count": len(rows),
        "limit": limit,
    }


def profile_mart(mart_key: str, sample_size: int = 100000) -> dict:
    """행수 + 컬럼별 NULL 비율, 카디널리티, 수치형 min/max/avg."""
    conn, database, schema = _ctx()
    cur = conn.cursor()
    table = _resolve_table(cur, database, schema, mart_key)
    full = f"{database}.{schema}.{table}"

    cur.execute(
        f"""
        SELECT column_name, data_type
        FROM {database}.information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
        """,
        (schema.upper(), table),
    )
    col_meta = cur.fetchall()

    cur.execute(f"SELECT COUNT(*) FROM {full}")
    total = cur.fetchone()[0] or 0

    # 표본 추출 (대용량 대비)
    sample_cte = (
        f"(SELECT * FROM {full} SAMPLE ({sample_size} ROWS))"
        if total > sample_size
        else full
    )

    col_profiles: list[dict] = []
    for col, dtype in col_meta:
        dtype_upper = dtype.upper()
        is_numeric = any(k in dtype_upper for k in ("NUMBER", "INT", "FLOAT", "DECIMAL", "DOUBLE"))
        parts = [
            f"COUNT(*) AS total",
            f'SUM(CASE WHEN "{col}" IS NULL THEN 1 ELSE 0 END) AS nulls',
            f'COUNT(DISTINCT "{col}") AS distinct_count',
        ]
        if is_numeric:
            parts += [
                f'MIN("{col}") AS min_v',
                f'MAX("{col}") AS max_v',
                f'AVG("{col}") AS avg_v',
            ]
        try:
            cur.execute(f"SELECT {', '.join(parts)} FROM {sample_cte}")
            row = cur.fetchone()
        except Exception as e:
            col_profiles.append({"name": col, "type": dtype, "error": str(e)})
            continue

        total_s, nulls, distinct = row[0], row[1], row[2]
        entry = {
            "name": col,
            "type": dtype,
            "null_ratio": (nulls / total_s) if total_s else 0.0,
            "distinct_count": distinct,
        }
        if is_numeric and len(row) >= 6:
            entry.update({"min": _serialize(row[3]), "max": _serialize(row[4]), "avg": _serialize(row[5])})
        col_profiles.append(entry)

    return {
        "mart_key": table.lower(),
        "row_count": total,
        "sampled": total > sample_size,
        "sample_size": min(total, sample_size),
        "columns": col_profiles,
    }


def _serialize(v: Any) -> Any:
    """JSON 직렬화 안전한 값으로 변환."""
    import datetime
    import decimal

    if v is None:
        return None
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    return v
