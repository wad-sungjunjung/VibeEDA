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


def _summarize_figure(fig) -> dict:
    """Figure 메타데이터를 LLM이 읽기 쉬운 dict로 요약."""
    try:
        layout = fig.layout
        title = ""
        try:
            title = (layout.title.text or "") if layout.title else ""
        except Exception:
            pass

        def _axis(ax):
            try:
                t = ax.title.text if ax and ax.title else ""
            except Exception:
                t = ""
            return t or ""

        x_title = _axis(getattr(layout, "xaxis", None))
        y_title = _axis(getattr(layout, "yaxis", None))

        traces = []
        for tr in (fig.data or []):
            info = {
                "type": getattr(tr, "type", "") or "",
                "name": getattr(tr, "name", "") or "",
            }
            try:
                x = getattr(tr, "x", None)
                y = getattr(tr, "y", None)
                if x is not None:
                    info["n_points"] = len(list(x))
                if y is not None:
                    info["y_n"] = len(list(y))
            except Exception:
                pass
            traces.append(info)
        return {"title": title, "x_title": x_title, "y_title": y_title, "traces": traces}
    except Exception:
        return {}


def _render_figure_png_base64(fig) -> str | None:
    """Plotly Figure를 저해상도 PNG로 렌더링하여 base64 문자열 반환. 실패 시 None."""
    try:
        img_bytes = fig.to_image(format="png", width=600, height=400, scale=1)
        import base64
        return base64.b64encode(img_bytes).decode("ascii")
    except Exception:
        return None


def _to_cell_output(
    ns: dict,
    cell_name: str,
    stdout: str,
    touched_keys: set[str] | None = None,
) -> dict:
    var = ns.get(cell_name)

    try:
        import json
        import plotly.graph_objs as go
        # 차트 후보 선택 — 이전 셀에서 만들어진 Figure가 namespace 에 남아
        # 엉뚱한 셀에 '캐싱된 것처럼' 재출력되는 것을 막기 위해,
        # (a) cell_name 변수가 직접 Figure 인 경우, 또는
        # (b) 이번 실행에서 새로 바인딩/변경된 변수 중 마지막 Figure 만 허용한다.
        candidate = None
        if isinstance(var, go.Figure):
            candidate = var
        elif touched_keys:
            for k in reversed(list(touched_keys)):
                v = ns.get(k)
                if isinstance(v, go.Figure):
                    candidate = v
                    break
        if candidate is not None:
            result = {
                "type": "chart",
                "plotlyJson": json.loads(candidate.to_json()),
                "chartMeta": _summarize_figure(candidate),
            }
            png_b64 = _render_figure_png_base64(candidate)
            if png_b64:
                result["imagePngBase64"] = png_b64
            return result
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


import re as _re
import shlex as _shlex

# Jupyter 호환: `!pip install ...`, `%pip install ...`, `!<shell>` 을
# in-process 파이썬 코드로 변환해 실행한다.
_MAGIC_LINE_RE = _re.compile(r"^(?P<indent>\s*)(?P<sigil>[!%])(?P<rest>.+)$")


def _translate_shell_magics(code: str) -> str:
    out_lines: list[str] = []
    needs_subprocess = False
    for line in code.splitlines():
        m = _MAGIC_LINE_RE.match(line)
        if not m:
            out_lines.append(line)
            continue
        indent = m.group("indent")
        rest = m.group("rest").strip()
        # pip install (혹은 %pip install / !pip install)
        lower = rest.lower()
        try:
            tokens = _shlex.split(rest)
        except ValueError:
            tokens = rest.split()
        if lower.startswith("pip "):
            # 예: "pip install xgboost" → subprocess 로 현재 인터프리터에 설치하고
            # 출력은 셀 stdout 으로 흘려 진행/완료를 볼 수 있게 한다.
            args = tokens[1:]  # drop 'pip'
            py_args = ["sys.executable", "'-m'", "'pip'"] + [repr(a) for a in args]
            out_lines.append(
                f"{indent}_r = __import__('subprocess').run("
                f"[{', '.join(py_args)}], capture_output=True, text=True)"
            )
            out_lines.append(f"{indent}print(_r.stdout, end='')")
            out_lines.append(f"{indent}print(_r.stderr, end='')")
            out_lines.append(
                f"{indent}"
                "_ = (_r.returncode == 0) or "
                "(_ for _ in ()).throw(RuntimeError(f'pip install failed (exit {_r.returncode})'))"
            )
            needs_subprocess = True
            continue
        # 기타 `!shell cmd` — subprocess.run 으로 변환, stdout 만 print
        cmd_list = ", ".join(repr(t) for t in tokens)
        out_lines.append(
            f"{indent}print(__import__('subprocess').run([{cmd_list}], "
            f"capture_output=True, text=True).stdout, end='')"
        )
        needs_subprocess = True
    if needs_subprocess:
        out_lines.insert(0, "import sys")
    return "\n".join(out_lines)


def run_python(notebook_id: str, cell_name: str, code: str) -> dict:
    ns = get_namespace(notebook_id)
    output_lines: list[str] = []

    def _print(*args, **kwargs):
        sep = kwargs.get("sep", " ")
        end = kwargs.get("end", "\n")
        output_lines.append(sep.join(str(a) for a in args) + end)

    exec_ns = {**ns, "print": _print, "__builtins__": __builtins__}
    pre_snapshot = {k: id(v) for k, v in ns.items()}
    translated = _translate_shell_magics(code)
    try:
        exec(translated, exec_ns)  # noqa: S102
        touched_keys: set[str] = set()
        for k, v in exec_ns.items():
            if k in ("print", "__builtins__"):
                continue
            if k not in pre_snapshot or pre_snapshot[k] != id(v):
                touched_keys.add(k)
            ns[k] = v
        stdout = "".join(output_lines)
        return _to_cell_output(ns, cell_name, stdout, touched_keys)
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
