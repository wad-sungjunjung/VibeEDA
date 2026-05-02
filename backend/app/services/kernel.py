import ast
import concurrent.futures
import logging
import os
import traceback
from collections import OrderedDict
from typing import Any

logger = logging.getLogger(__name__)

# Plotly→PNG 렌더(kaleido)는 Windows 에서 chromium 서브프로세스 spawn 으로 종종 hang 한다.
# 차트 JSON은 정상 반환되어 UI에는 그려지므로, PNG 가 늦으면 포기하고 None 으로 폴백한다.
# (LLM 이 차트를 이미지로 보지 못할 뿐, 사용자 노트북 흐름은 막히지 않음)
KALEIDO_RENDER_TIMEOUT_SEC = 30

# kaleido(Chromium 번들 ~157MB) 옵션화 — 기본 on, env 로 끄면 PNG 렌더 자체 skip.
# 끄면 차트는 UI 에서 정상이지만 LLM 은 차트를 이미지로 못 봄(메타데이터 텍스트로만 인지).
# 1차 효과: 셀 실행마다 chromium 서브프로세스 spawn 비용 제거 (CPU/메모리 spike 해소).
KALEIDO_ENABLED = os.environ.get("VIBE_ENABLE_KALEIDO", "1").lower() not in ("0", "false", "off", "no")

# 노트북별 namespace 는 셀 간 변수 공유(SQL→Python)를 위해 프로세스 메모리에 유지된다.
# 무제한이면 사용자가 노트북을 자주 열고 닫을수록 RSS 가 단조 증가 → OOM.
# LRU 로 가장 최근에 사용한 N 개만 유지. 환경변수로 튜닝 가능.
KERNEL_NAMESPACE_MAX = int(os.environ.get("VIBE_KERNEL_NS_MAX", "20"))

# 추가 RSS 가드 — 개수 LRU 로 막지 못하는 거대한 DataFrame 누적 케이스 차단.
# 프로세스 RSS(MB) 가 임계치를 넘으면 가장 오래된 namespace 부터 evict.
# 0 이면 비활성. 기본 2048MB.
KERNEL_RSS_MB_LIMIT = int(os.environ.get("VIBE_KERNEL_RSS_MB", "2048"))

_namespaces: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


def _process_rss_mb() -> float | None:
    """현재 프로세스 RSS 를 MB 로 반환. psutil 없거나 실패하면 None."""
    try:
        import psutil  # requirements.txt 에 명시
        return psutil.Process().memory_info().rss / (1024 * 1024)
    except Exception:
        return None


def _enforce_rss_cap() -> None:
    """RSS 가 임계치 초과면 가장 오래된 namespace 부터 evict (최소 1개는 남김).
    호출 주기: get_namespace 진입 시 + 이후 LRU 캡 처리 후.
    """
    if KERNEL_RSS_MB_LIMIT <= 0:
        return
    rss = _process_rss_mb()
    if rss is None:
        return
    while rss > KERNEL_RSS_MB_LIMIT and len(_namespaces) > 1:
        evicted_id, _ = _namespaces.popitem(last=False)
        logger.warning(
            "kernel namespace RSS evict: notebook=%s (rss=%.0fMB > cap=%dMB)",
            evicted_id, rss, KERNEL_RSS_MB_LIMIT,
        )
        # 다음 측정 — 메모리는 즉시 반환 안 될 수도 있어 보수적으로 한 번만 재측정.
        rss2 = _process_rss_mb()
        if rss2 is None or rss2 >= rss:
            break
        rss = rss2


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
    if notebook_id in _namespaces:
        # LRU: 사용 시 끝으로 이동
        _namespaces.move_to_end(notebook_id)
        # 기존 namespace 사용도 RSS 체크 — 거대한 DataFrame 갱신으로 임계치 넘을 수 있음
        _enforce_rss_cap()
        return _namespaces[notebook_id]
    _namespaces[notebook_id] = {}
    # 캡 초과 시 가장 오래된 namespace 제거 — 해당 노트북의 셀 변수는 잃지만,
    # 다음 실행 시 자동 재생성된다 (SQL 셀은 캐시에서, Python 셀은 코드 재실행).
    while len(_namespaces) > KERNEL_NAMESPACE_MAX:
        evicted_id, _ = _namespaces.popitem(last=False)
        logger.info(
            "kernel namespace LRU evict: notebook=%s (cap=%d)",
            evicted_id, KERNEL_NAMESPACE_MAX,
        )
    _enforce_rss_cap()
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
    """Plotly Figure를 저해상도 PNG로 렌더링하여 base64 문자열 반환. 실패 시 None.
    기본 비율은 2:3(height:width). fig.layout 에 명시된 width/height 가 있으면 존중.
    LLM tool_result 로 보낼 이미지라 크기는 작게 유지.

    kaleido 가 hang 하는 알려진 케이스(특히 Windows 의 chromium 재사용 실패)에서
    셀 실행 전체가 막히지 않도록 KALEIDO_RENDER_TIMEOUT_SEC 안에 못 끝내면 None 반환.
    VIBE_ENABLE_KALEIDO=0 이면 즉시 None — chromium spawn 자체를 skip.
    """
    if not KALEIDO_ENABLED:
        return None
    try:
        layout = getattr(fig, "layout", None)
        w = getattr(layout, "width", None) if layout is not None else None
        h = getattr(layout, "height", None) if layout is not None else None
        # 명시값이 있으면 비율 유지하며 width 600 기준으로 축소
        if w and h:
            scale_factor = 600 / float(w)
            width = 600
            height = max(int(float(h) * scale_factor), 1)
        else:
            width, height = 600, 400  # 2:3

        # 데몬 스레드에서 fig.to_image 실행 → timeout 시 미완료 스레드는 abandon.
        # ThreadPoolExecutor 의 worker 는 daemon=True 라 프로세스 종료 시 같이 죽음.
        ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            future = ex.submit(
                fig.to_image, format="png", width=width, height=height, scale=1
            )
            try:
                img_bytes = future.result(timeout=KALEIDO_RENDER_TIMEOUT_SEC)
            except concurrent.futures.TimeoutError:
                logger.warning(
                    "kaleido PNG render timed out after %ss — falling back to no PNG",
                    KALEIDO_RENDER_TIMEOUT_SEC,
                )
                return None
        finally:
            # wait=False: hang 한 worker 스레드 기다리지 않고 즉시 풀 정리.
            ex.shutdown(wait=False)
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
            import math as _math
            import datetime as _dt2

            def _safe_py(v):
                if v is None:
                    return None
                cls = v.__class__.__name__
                if cls == "NaTType":
                    return None
                if isinstance(v, float) and (_math.isnan(v) or _math.isinf(v)):
                    return None
                if isinstance(v, (_dt2.datetime, _dt2.date, _dt2.time)):
                    return v.isoformat()
                if isinstance(v, (bytes, bytearray)):
                    return v.decode("utf-8", errors="replace")
                return v

            df = var
            rows = df.head(500).values.tolist()
            columns = [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]
            return {
                "type": "table",
                "columns": columns,
                "rows": [[_safe_py(v) for v in row] for row in rows],
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
        # Jupyter 호환: 마지막 문이 표현식이면 그 값을 cell_name 으로 바인딩해
        # 테이블/차트 렌더러가 자동으로 픽업하도록 한다.
        last_expr_value: Any = None
        has_last_expr = False
        try:
            tree = ast.parse(translated, mode="exec")
        except SyntaxError:
            tree = None
        if tree is not None and tree.body and isinstance(tree.body[-1], ast.Expr):
            last = tree.body[-1]
            body = tree.body[:-1]
            exec(compile(ast.Module(body=body, type_ignores=[]), "<cell>", "exec"), exec_ns)  # noqa: S102
            last_expr_value = eval(compile(ast.Expression(body=last.value), "<cell>", "eval"), exec_ns)  # noqa: S307
            has_last_expr = True
        else:
            exec(translated, exec_ns)  # noqa: S102
        touched_keys: set[str] = set()
        for k, v in exec_ns.items():
            if k in ("print", "__builtins__"):
                continue
            if k not in pre_snapshot or pre_snapshot[k] != id(v):
                touched_keys.add(k)
            ns[k] = v
        if has_last_expr and last_expr_value is not None:
            ns[cell_name] = last_expr_value
            touched_keys.add(cell_name)
        stdout = "".join(output_lines)
        return _to_cell_output(ns, cell_name, stdout, touched_keys)
    except Exception:
        return {"type": "error", "message": traceback.format_exc()}


_CONN_ERROR_PATTERNS = (
    "authentication token", "expired", "session no longer exists",
    "session is no longer", "connection is closed", "not connected",
    "connection reset", "connection aborted", "broken pipe",
    "ssl", "eof occurred", "operationalerror", "networkerror",
    "could not connect", "timeout", "network is unreachable",
)


def _looks_like_connection_error(err: BaseException) -> bool:
    msg = (str(err) or "").lower()
    name = type(err).__name__.lower()
    if any(k in name for k in ("operational", "interface", "network", "connection")):
        return True
    return any(p in msg for p in _CONN_ERROR_PATTERNS)


def _execute_sql_once(sql: str):
    """단일 시도 — 연결을 새로 받아 SQL 실행 후 raw DataFrame 반환."""
    from .snowflake_session import get_connection
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(sql)
        return cur.fetch_pandas_all()
    except Exception as exc:
        # pyarrow 미설치(슬림 install)면 fetch_pandas_all 이 ImportError 로 실패.
        # 그 외에도 결과 포맷이 ARROW 가 아니면 동일 경로. JSON 폴백으로 결과는 동일.
        # 큰 결과셋(>100k rows)에서는 ~2-3 배 느릴 수 있음 — 가속하려면 requirements-arrow.txt 설치.
        if isinstance(exc, ImportError) and "pyarrow" in str(exc).lower():
            logger.info("pyarrow 미설치 — JSON 폴백으로 SQL 결과를 가져옵니다 (가속하려면 pip install -r backend/requirements-arrow.txt)")
        else:
            logger.debug("fetch_pandas_all 실패 → JSON 폴백: %s", exc)
        import pandas as _pd
        cur2 = conn.cursor()
        try:
            cur2.execute("ALTER SESSION SET PYTHON_CONNECTOR_QUERY_RESULT_FORMAT = 'JSON'")
        except Exception:
            pass
        cur2.execute(sql)
        rows_raw = cur2.fetchall()
        cols = [d[0] for d in (cur2.description or [])]
        return _pd.DataFrame(rows_raw, columns=cols)


def run_sql(notebook_id: str, cell_name: str, sql: str) -> dict:
    from .snowflake_session import try_silent_reconnect

    ns = get_namespace(notebook_id)

    try:
        import math
        from decimal import Decimal
        import datetime as _dt

        # 1차 시도. 실패가 연결 문제로 보이면 1회 조용히 재접속 후 재시도.
        try:
            raw_df = _execute_sql_once(sql)
        except Exception as first_err:
            if not _looks_like_connection_error(first_err):
                raise
            if not try_silent_reconnect():
                return {
                    "type": "error",
                    "message": (
                        "Snowflake 연결이 끊어졌고 자동 재접속에도 실패했습니다.\n"
                        "왼쪽 사이드바 '연결 관리'에서 다시 로그인해주세요.\n"
                        f"(원인: {first_err})"
                    ),
                }
            try:
                raw_df = _execute_sql_once(sql)
            except Exception as second_err:
                return {
                    "type": "error",
                    "message": (
                        "Snowflake 자동 재접속은 성공했지만 재시도 SQL도 실패했습니다.\n"
                        "쿼리 또는 연결 상태를 확인해주세요.\n"
                        f"(원인: {second_err})"
                    ),
                }
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
