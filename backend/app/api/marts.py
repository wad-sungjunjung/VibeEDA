import logging
from datetime import datetime

from fastapi import APIRouter

logger = logging.getLogger(__name__)

from ..services import snowflake_session

router = APIRouter()


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
        """)
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
        """)
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
