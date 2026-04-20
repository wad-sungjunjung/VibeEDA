import traceback
from typing import Any

_namespaces: dict[str, dict[str, Any]] = {}


def _suppress_plotly_show() -> None:
    """Plotly가 새 브라우저 탭을 여는 것을 방지.
    - pio.renderers.default 를 그리지 않는 렌더러로 고정
    - Figure.show / pio.show 를 no-op 로 몽키패치
    프로세스 수명 동안 한 번만 적용한다.
    """
    try:
        import plotly.io as pio
        from plotly.graph_objs import Figure
    except ImportError:
        return
    if getattr(pio, "_vibe_show_suppressed", False):
        return
    try:
        pio.renderers.default = "json"
    except Exception:
        pass
    Figure.show = lambda self, *a, **kw: None  # type: ignore[assignment]
    pio.show = lambda *a, **kw: None  # type: ignore[assignment]
    pio._vibe_show_suppressed = True  # type: ignore[attr-defined]


_suppress_plotly_show()


def _make_vibe_df(df):
    """Wrap a pandas DataFrame so it also has .to_pandas() for Snowpark-style compatibility."""
    try:
        import pandas as pd

        class VibeDf(pd.DataFrame):
            @property
            def _constructor(self):
                return VibeDf

            def to_pandas(self) -> "pd.DataFrame":
                return pd.DataFrame(self)

        return VibeDf(df)
    except Exception:
        return df


def get_namespace(notebook_id: str) -> dict[str, Any]:
    if notebook_id not in _namespaces:
        _namespaces[notebook_id] = {}
    return _namespaces[notebook_id]


def clear_namespace(notebook_id: str) -> None:
    _namespaces.pop(notebook_id, None)


def get_dataframe_summaries(notebook_id: str) -> dict[str, str]:
    """Return {cell_name: info_string} for all DataFrames in namespace."""
    ns = get_namespace(notebook_id)
    result: dict[str, str] = {}
    for name, val in ns.items():
        if name.startswith("_") or not hasattr(val, "columns"):
            continue
        try:
            import io
            buf = io.StringIO()
            val.info(buf=buf, verbose=True, show_counts=True)
            result[name] = buf.getvalue()
        except Exception:
            try:
                cols = ", ".join(f"{c}({val[c].dtype})" for c in val.columns)
                result[name] = f"shape={val.shape}, columns=[{cols}]"
            except Exception:
                pass
    return result


def _to_cell_output(ns: dict, cell_name: str, stdout: str) -> dict:
    var = ns.get(cell_name)

    try:
        import json
        import plotly.graph_objs as go
        candidate = var if isinstance(var, go.Figure) else next(
            (v for v in ns.values() if isinstance(v, go.Figure)), None
        )
        if candidate is not None:
            return {"type": "chart", "plotlyJson": json.loads(candidate.to_json())}
    except ImportError:
        pass

    if var is not None and hasattr(var, "columns") and hasattr(var, "values"):
        try:
            df = var
            rows = df.head(500).values.tolist()
            columns = [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]
            return {
                "type": "table",
                "columns": columns,
                "rows": [[None if (hasattr(v, '__class__') and v.__class__.__name__ == 'NaTType') else v for v in row] for row in rows],
                "rowCount": len(df),
                "truncated": len(df) > 500,
            }
        except Exception:
            pass

    if stdout.strip():
        return {"type": "stdout", "content": stdout}

    return {"type": "stdout", "content": ""}


def run_python(notebook_id: str, cell_name: str, code: str) -> dict:
    ns = get_namespace(notebook_id)
    output_lines: list[str] = []

    def _print(*args, **kwargs):
        sep = kwargs.get("sep", " ")
        end = kwargs.get("end", "\n")
        output_lines.append(sep.join(str(a) for a in args) + end)

    exec_ns = {**ns, "print": _print, "__builtins__": __builtins__}
    try:
        exec(code, exec_ns)  # noqa: S102
        for k, v in exec_ns.items():
            if k not in ("print", "__builtins__"):
                ns[k] = v
        stdout = "".join(output_lines)
        return _to_cell_output(ns, cell_name, stdout)
    except Exception:
        return {"type": "error", "message": traceback.format_exc()}


def run_sql(notebook_id: str, cell_name: str, sql: str) -> dict:
    from .snowflake_session import get_connection

    ns = get_namespace(notebook_id)

    try:
        import math
        from decimal import Decimal
        import datetime as _dt
        conn = get_connection()
        # 세션 ARROW 포맷은 connect()의 session_parameters로 이미 설정됨.
        # fetch_pandas_all 실패 시에만 새 커서로 JSON 결과 + fetchall 폴백.
        try:
            cur = conn.cursor()
            cur.execute(sql)
            raw_df = cur.fetch_pandas_all()
        except Exception:
            import pandas as _pd
            cur2 = conn.cursor()
            try:
                cur2.execute("ALTER SESSION SET PYTHON_CONNECTOR_QUERY_RESULT_FORMAT = 'JSON'")
            except Exception:
                pass
            cur2.execute(sql)
            rows_raw = cur2.fetchall()
            cols = [d[0] for d in (cur2.description or [])]
            raw_df = _pd.DataFrame(rows_raw, columns=cols)
        df = _make_vibe_df(raw_df)
        ns[cell_name] = df

        def _safe(v):
            if v is None:
                return None
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                return None
            if isinstance(v, Decimal):
                f = float(v)
                return None if math.isnan(f) or math.isinf(f) else f
            if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
                return v.isoformat()
            if isinstance(v, (bytes, bytearray)):
                return v.decode("utf-8", errors="replace")
            return v

        rows = [[_safe(v) for v in row] for row in df.head(500).values.tolist()]
        columns = [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]
        return {
            "type": "table",
            "columns": columns,
            "rows": rows,
            "rowCount": len(df),
            "truncated": len(df) > 500,
        }
    except ValueError as e:
        return {"type": "error", "message": str(e)}
    except Exception:
        return {"type": "error", "message": traceback.format_exc()}
