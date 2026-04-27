import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Literal, Optional, AsyncGenerator

import anthropic

from .naming import to_snake_case
from . import mart_tools
from . import agent_skills
from . import category_cache
from . import file_profile_cache
from . import agent_budget
from . import agent_classifier
from . import agent_methods
from .code_style import SQL_STYLE_GUIDE, PYTHON_RULES, MARKDOWN_RULES

logger = logging.getLogger(__name__)

# ─── Bottleneck guards ───────────────────────────────────────────────────────
# 모델 stream 단일 이벤트 도착 간격 상한. 모델/네트워크가 stall 한 경우 자동 종료.
STREAM_EVENT_WATCHDOG_SEC = 90
# stream 종료 후 final_message 회수 타임아웃 (보통 0~수초)
STREAM_FINAL_MESSAGE_SEC = 30
# AsyncAnthropic 자체 read timeout (Anthropic SDK 디폴트 600s 명시)
SDK_READ_TIMEOUT_SEC = 600
SDK_CONNECT_TIMEOUT_SEC = 10
# 자동 실행되는 Python/SQL 셀의 커널 실행 타임아웃.
# 모델링/장기 학습 작업은 시간 단위가 걸릴 수 있으므로 기본값을 넉넉히 잡고,
# 환경변수로 override 가능. 0 또는 음수면 timeout 미적용 (무한 대기).
import os as _os

def _env_int(name: str, default: int) -> int:
    raw = _os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default

# Python: 모델링/대용량 처리 대비 30분 기본
PYTHON_EXEC_TIMEOUT_SEC = _env_int("AGENT_PYTHON_EXEC_TIMEOUT_SEC", 1800)
# SQL: Snowflake 쿼리 5분 기본 (warehouse 지연 포함)
SQL_EXEC_TIMEOUT_SEC = _env_int("AGENT_SQL_EXEC_TIMEOUT_SEC", 300)
# 장기 실행 임계: 이 시간을 넘기면 사용자에게 "아직 실행 중" 신호 발사
LONG_EXEC_HEARTBEAT_THRESHOLDS_SEC = (30, 120, 300, 900)
# 완료 후 "X초 걸렸어요" 알림을 띄우는 최소 임계
LONG_EXEC_NOTIFY_MIN_SEC = 30


# ─── 메모 새니타이저 ──────────────────────────────────────────────────────────
# 에이전트가 프롬프트를 어겨 `**관찰**`, `**비교 기준**` 같은 볼드 라벨을 넣는 경우가 잦아,
# 서버에서 일괄 제거해 평문만 남긴다. 메모는 셀 단위의 짧은 인사이트이므로 강조 마커 불필요.
_MEMO_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_MEMO_BOLD_UNDERSCORE_RE = re.compile(r"__(.+?)__", re.DOTALL)
_MEMO_HEADER_RE = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_MEMO_LABEL_RE = re.compile(
    r"^(\s*[-*]\s*)(관찰|분석|인사이트|결론|해석|요약|다음 행동|다음 단계|비교 기준|발견|이상치|가설)(\s*[:：]\s*)",
    re.MULTILINE,
)


def _sanitize_memo(memo: str) -> str:
    if not memo:
        return memo
    s = _MEMO_BOLD_RE.sub(r"\1", memo)
    s = _MEMO_BOLD_UNDERSCORE_RE.sub(r"\1", s)
    s = _MEMO_HEADER_RE.sub("", s)
    # "- **관찰:** ..." 같은 라벨 머리말을 평문으로 (이미 볼드는 제거됨)
    s = _MEMO_LABEL_RE.sub(r"\1", s)
    return s


# ─── SQL whitelist 검증 ───────────────────────────────────────────────────────

_TABLE_REF_RE = re.compile(
    r"\b(?:from|join)\s+([a-zA-Z_][\w.]*)", re.IGNORECASE
)


def _extract_referenced_tables(sql: str) -> set[str]:
    """SQL 문자열에서 from/join 뒤의 테이블 참조를 추출해 소문자 단일 이름으로 반환.
    - 스키마/DB 경로가 포함돼 있으면 마지막 토큰만 취함
    - CTE 이름은 WITH 블록에서 정의된 것들과 겹치면 별도 판단 필요 (여기선 간단히 제외)
    """
    refs: set[str] = set()
    for m in _TABLE_REF_RE.finditer(sql):
        full = m.group(1)
        bare = full.rsplit(".", 1)[-1].lower()
        refs.add(bare)
    # CTE 정의: `with foo as (`, `), bar as (` 패턴에서 이름 추출
    cte_names: set[str] = set()
    for m in re.finditer(r"(?:with|,)\s+([a-zA-Z_]\w*)\s+as\s*\(", sql, re.IGNORECASE):
        cte_names.add(m.group(1).lower())
    return refs - cte_names


def _whitelist_violation(sql: str, selected_marts: list[str]) -> Optional[str]:
    """SQL이 선택 밖의 테이블을 참조하면 위반 테이블명 반환. 통과하면 None."""
    if not selected_marts:
        return None   # 선택 없음 = 체크 생략 (초기 상태)
    allowed = {m.lower() for m in selected_marts}
    refs = _extract_referenced_tables(sql)
    for r in refs:
        if r not in allowed:
            return r
    return None


# ─── Notebook state ──────────────────────────────────────────────────────────

@dataclass
class CellState:
    id: str
    name: str
    type: Literal["sql", "python", "markdown"]
    code: str
    executed: bool = False
    output: Optional[dict] = None
    memo: str = ""


# 병렬 실행이 안전한 읽기 전용 tool 집합 — 같은 턴에 이 tool 만 호출된 경우 asyncio.gather 로 병렬 실행.
# 쓰기/상태 변경 tool 이 하나라도 섞이면 전체를 순차 실행 (순서 의존성 보존).
PARALLEL_SAFE_TOOLS: set[str] = {
    "read_notebook_context",
    "read_cell_output",
    "get_mart_schema",
    "preview_mart",
    "profile_mart",
    "get_category_values",
    "query_data",
    "list_available_marts",
    "analyze_output",
}


@dataclass
class NotebookState:
    cells: list[CellState] = field(default_factory=list)
    selected_marts: list[str] = field(default_factory=list)
    mart_metadata: list[dict] = field(default_factory=list)
    analysis_theme: str = ""
    analysis_description: str = ""
    notebook_id: str = ""
    skill_ctx: dict = field(default_factory=dict)
    # 에이전트가 셀을 만들거나 수정할 때, 해당 셀의 vibe chat history 에 기록할 원 사용자 메시지.
    user_message_latest: str = ""
    # 이번 턴에 에이전트가 스트리밍한 내레이션 텍스트 — 셀 chat history 에 "이 셀이 왜 만들어졌는지"를 기록.
    # create_cell/update_cell_code 호출 직전 단계에 run loop 가 전체 텍스트로 세팅한다.
    current_turn_narration: str = ""
    # `check_chart_quality` 가 호출된 셀 id 모음 (차트 퀄리티 강제 가드용).
    chart_quality_checked: set = field(default_factory=set)
    # Explore-before-query 가드: 세션 내에서 이미 탐색(profile/preview/query_data/get_category_values)한 마트 키 모음.
    # 이 목록에 없는 마트를 참조하는 SQL 셀 생성 시 거부된다.
    explored_marts: set = field(default_factory=set)
    # 분석 todo 리스트 — Claude Code 스타일 투명한 진행 상황 트래커
    todos: list = field(default_factory=list)
    # 복잡도 분류 결과 + 예산 상태. run_agent_stream 진입 직후 세팅.
    budget: Optional[agent_budget.BudgetState] = None
    # Phase 0 라우팅 결과 — select_methods 호출 후 채워짐. L1 은 자동으로 ['analyze'].
    methods: list = field(default_factory=list)
    method_rationale: str = ""
    expected_artifacts: list = field(default_factory=list)
    # Phase 3 종합 정리 상태
    findings: list = field(default_factory=list)        # rate_findings 결과
    synthesis_done: bool = False                          # synthesize_report 호출 여부
    consistency_checked: bool = False                     # self_consistency_check 1회 한정


# ─── Tool definitions ────────────────────────────────────────────────────────

from . import agent_tools
from . import agent_synthesis
from . import agent_ml
from . import agent_causal
from . import agent_predict
from . import agent_learnings

TOOLS = agent_tools.claude_tools(
    agent_skills.SKILL_TOOLS_CLAUDE,
    method_tools=[
        agent_methods.SELECT_METHODS_TOOL_CLAUDE,
        *agent_synthesis.SYNTHESIS_TOOLS_CLAUDE,
        *agent_ml.ML_TOOLS_CLAUDE,
        *agent_causal.CAUSAL_TOOLS_CLAUDE,
        *agent_predict.PREDICT_TOOLS_CLAUDE,
    ],
)


# ─── Output formatting for Claude ────────────────────────────────────────────

def _format_output_for_claude(output: dict) -> str:
    """Convert cell output to a readable text summary for the LLM."""
    if not output:
        return "(출력 없음)"

    otype = output.get("type", "")

    if otype == "table":
        cols = [c["name"] for c in output.get("columns", [])]
        rows = output.get("rows", [])
        row_count = output.get("rowCount", len(rows))
        truncated = output.get("truncated", False)
        header = " | ".join(cols)
        sep = "-" * len(header)
        sample_rows = rows[:10]
        body = "\n".join(" | ".join(str(v) for v in row) for row in sample_rows)
        note = f"\n(전체 {row_count}행, 상위 {len(sample_rows)}행 표시{'·truncated' if truncated else ''})" if row_count > len(sample_rows) else f"\n(전체 {row_count}행)"
        return f"[테이블 결과]\n{header}\n{sep}\n{body}{note}"

    if otype == "chart":
        meta = output.get("chartMeta") or {}
        title = meta.get("title") or "(제목 없음)"
        x_title = meta.get("x_title") or ""
        y_title = meta.get("y_title") or ""
        traces = meta.get("traces") or []
        trace_lines = []
        for i, tr in enumerate(traces[:10]):
            parts = [f"#{i + 1}", tr.get("type") or "?", tr.get("name") or ""]
            if tr.get("n_points") is not None:
                parts.append(f"n={tr['n_points']}")
            trace_lines.append(" ".join(p for p in parts if p))
        trace_block = "\n".join(trace_lines) if trace_lines else "(trace 정보 없음)"
        img_note = "\n첨부: 렌더링된 차트 PNG가 함께 전달됨 — 이미지를 보고 의도에 부합하는지 검증하세요." if output.get("imagePngBase64") else ""
        return (
            f"[차트 생성됨]\n"
            f"제목: {title}\n"
            f"x축: {x_title} / y축: {y_title}\n"
            f"Traces ({len(traces)}):\n{trace_block}"
            f"{img_note}"
        )

    if otype == "stdout":
        content = output.get("content", "")
        return f"[출력]\n{content}" if content.strip() else "(출력 없음)"

    if otype == "error":
        return f"[오류]\n{output.get('message', '')}"

    return str(output)


# ─── JSON 안전 변환 (Decimal/NaN/datetime/numpy → 기본 타입) ───────────────────
# tool_result 가 Claude 의 json.dumps / Gemini 의 from_function_response 둘 다에 들어가는데,
# Snowflake Decimal · pandas/numpy 스칼라 · datetime 이 직렬화 실패의 흔한 원인.
# `_execute_tool` 의 모든 반환 결과를 이 함수로 한 번 통과시켜 두 경로가 동일하게 안전.
def _make_json_safe(obj):
    import datetime as _dt
    import math as _math
    from decimal import Decimal as _Dec
    if obj is None or isinstance(obj, (str, bool, int)):
        return obj
    if isinstance(obj, float):
        if _math.isnan(obj) or _math.isinf(obj):
            return None
        return obj
    if isinstance(obj, _Dec):
        try:
            f = float(obj)
            if _math.isnan(f) or _math.isinf(f):
                return None
            return f
        except Exception:
            return str(obj)
    if isinstance(obj, (_dt.datetime, _dt.date, _dt.time)):
        return obj.isoformat()
    if isinstance(obj, (bytes, bytearray)):
        return obj.decode("utf-8", errors="replace")
    if isinstance(obj, dict):
        return {str(k): _make_json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_make_json_safe(v) for v in obj]
    if isinstance(obj, set):
        return [_make_json_safe(v) for v in obj]
    # numpy/pandas 스칼라 (.item() 으로 파이썬 native 추출)
    item = getattr(obj, "item", None)
    if callable(item):
        try:
            return _make_json_safe(item())
        except Exception:
            pass
    # 마지막 폴백 — 문자열화
    return str(obj)


# ─── Cell chat-entry narration helper ─────────────────────────────────────────
# 에이전트가 셀을 생성/수정할 때 셀별 chat_history 에 남길 한 줄짜리 user_msg 를 만든다.
# 우선순위: (1) 이번 턴 내레이션 → (2) 원 사용자 요청 → (3) 짧은 기본 문구.
_CELL_NARRATION_MAX_LEN = 400


def _build_cell_chat_narration(state: "NotebookState", created: bool) -> str:
    narration = (getattr(state, "current_turn_narration", "") or "").strip()
    if narration:
        # 한 셀이 여러 turn 에 걸쳐 생성되지 않도록, 지나치게 긴 문단은 앞부분만 사용.
        if len(narration) > _CELL_NARRATION_MAX_LEN:
            narration = narration[:_CELL_NARRATION_MAX_LEN].rstrip() + "…"
        return narration
    original_request = (getattr(state, "user_message_latest", "") or "").strip()
    action = "에이전트가 이 셀을 생성했습니다." if created else "에이전트가 이 셀을 수정했습니다."
    if original_request:
        return f"{action} (요청: {original_request})"
    return action


# ─── Tool execution ───────────────────────────────────────────────────────────

async def _execute_tool(name: str, inp: dict, state: NotebookState) -> tuple[dict, list[dict]]:
    """Public wrapper — sanitizes JSON-incompatible types in the result dict.

    Snowflake Decimal · pandas/numpy 스칼라 · datetime 등이 tool_result 에 섞이면
    Claude 의 `json.dumps` 또는 Gemini 의 `Part.from_function_response` 가 직렬화 실패
    ("Object of type Decimal is not JSON serializable") 한다.
    실제 핸들러는 `_execute_tool_impl` 가 담당하고, 본 wrapper 가 결과를 보정한다.
    SSE 이벤트(events)는 별도 경로(agent.py 의 _json_default)에서 처리되므로 손대지 않는다.
    """
    result, events = await _execute_tool_impl(name, inp, state)
    if isinstance(result, dict):
        result = _make_json_safe(result)
    return result, events


async def _execute_tool_impl(name: str, inp: dict, state: NotebookState) -> tuple[dict, list[dict]]:
    """Returns (tool_result_dict, list_of_sse_events)."""

    # ─── Phase 0 pre-guard — L2/L3 는 첫 도구로 select_methods 강제 ────────
    # L1 은 진입 시 자동으로 methods=['analyze'] 가 세팅됨 (run_agent_stream 참조).
    # methods 가 비어있고 호출 도구가 select_methods 가 아니면 거부.
    if (
        state.budget is not None
        and state.budget.tier in ("L2", "L3")
        and not state.methods
        and name not in agent_methods.PHASE0_TOOL_NAMES
    ):
        return {
            "success": False,
            "error": "method_routing_required",
            "message": (
                "이 분석을 시작하기 전에 먼저 `select_methods` 를 호출해 "
                "어떤 분석 메서드(explore / analyze / predict / causal / ml / ab_test / benchmark) "
                "조합으로 진행할지 선언해야 합니다. "
                "primary 1개 (필수) + secondary 0~2개 + 짧은 rationale 을 함께 제출하세요."
            ),
        }, []

    # ─── select_methods 핸들러 (Phase 0) ──────────────────────────────────
    if name == "select_methods":
        primary = (inp.get("primary") or "").strip().lower()
        secondary_raw = inp.get("secondary") or []
        if not isinstance(secondary_raw, list):
            secondary_raw = []
        # primary + secondary 합쳐 정규화 — 중복·미지의 키 제거
        all_methods = agent_methods.normalize_methods([primary] + list(secondary_raw))
        if primary and primary not in all_methods:
            return {
                "success": False,
                "error": "invalid_primary_method",
                "message": f"primary='{primary}' 는 미지의 메서드입니다. 허용: {agent_methods.ALL_METHODS}",
            }, []
        rationale = (inp.get("rationale") or "").strip()
        if not rationale:
            return {
                "success": False,
                "error": "rationale_required",
                "message": "`rationale` (1문장 한국어 사유) 가 필수입니다.",
            }, []
        artifacts = inp.get("expected_artifacts") or []
        if not isinstance(artifacts, list):
            artifacts = []

        state.methods = all_methods
        state.method_rationale = rationale
        state.expected_artifacts = [str(a) for a in artifacts if a]

        return (
            {
                "success": True,
                "primary": all_methods[0] if all_methods else "",
                "all_methods": all_methods,
                "rationale": rationale,
                "expected_artifacts": state.expected_artifacts,
                "instruction": (
                    "메서드 선택 완료. 이제 일반 분석 흐름으로 진행하세요 "
                    "(create_plan / profile_mart / 등). "
                    "선택된 메서드의 추가 가이드라인은 시스템 프롬프트에 자동 주입되었습니다."
                ),
            },
            [{
                "type": "methods_selected",
                "methods": all_methods,
                "rationale": rationale,
                "expected_artifacts": state.expected_artifacts,
            }],
        )

    # ─── ML 메서드별 도구 (S4) — 'ml' 메서드 미선택 시 거부 ────────────────
    if name in agent_ml.ML_TOOL_NAMES:
        if "ml" not in (state.methods or []):
            return {
                "success": False,
                "error": "method_not_selected",
                "message": (
                    f"`{name}` 은 'ml' 메서드 전용입니다. 현재 선택된 메서드: {state.methods}. "
                    "ml 작업이 필요하면 select_methods 를 다시 호출해 'ml' 을 추가하세요."
                ),
            }, []
        return agent_ml.handle_ml_tool(name, inp, state)

    # ─── Causal/AB 메서드별 도구 (S5) ─────────────────────────────────────
    if name in agent_causal.CAUSAL_TOOL_NAMES:
        allowed_methods = {"causal", "ab_test"}
        if not (set(state.methods or []) & allowed_methods):
            return {
                "success": False,
                "error": "method_not_selected",
                "message": (
                    f"`{name}` 은 'causal' 또는 'ab_test' 메서드 전용입니다. "
                    f"현재 선택: {state.methods}. select_methods 를 다시 호출해 메서드를 추가하세요."
                ),
            }, []
        return agent_causal.handle_causal_tool(name, inp, state)

    # ─── Predict 메서드별 도구 (S6) ───────────────────────────────────────
    if name in agent_predict.PREDICT_TOOL_NAMES:
        if "predict" not in (state.methods or []):
            return {
                "success": False,
                "error": "method_not_selected",
                "message": (
                    f"`{name}` 은 'predict' 메서드 전용입니다. 현재 선택: {state.methods}. "
                    "select_methods 를 다시 호출해 'predict' 를 추가하세요."
                ),
            }, []
        return agent_predict.handle_predict_tool(name, inp, state)

    # ─── Phase 3: rate_findings ───────────────────────────────────────────
    if name == "rate_findings":
        findings_in = inp.get("findings") or []
        if not isinstance(findings_in, list) or not findings_in:
            return {
                "success": False,
                "error": "findings_required",
                "message": "최소 1개 이상의 finding 이 필요합니다.",
            }, []
        cells_by_id = {
            c.id: {"name": c.name, "type": c.type, "output": c.output}
            for c in state.cells
        }
        cells_name_by_id = {c.id: c.name for c in state.cells}
        normalized: list[dict] = []
        all_warnings: list[str] = []
        for f in findings_in:
            if not isinstance(f, dict):
                continue
            norm, warns = agent_synthesis.apply_finding_rules(
                f, methods=state.methods, cells_by_id=cells_by_id,
            )
            # UUID 대신 셀 이름을 함께 돌려줘서 synthesize_report 인용 시 이름을 쓰도록 유도
            norm["evidence_cell_names"] = [
                cells_name_by_id[cid]
                for cid in (norm.get("evidence_cell_ids") or [])
                if cid in cells_name_by_id
            ]
            normalized.append(norm)
            all_warnings.extend(warns)
        state.findings = normalized
        return (
            {
                "success": True,
                "count": len(normalized),
                "findings": normalized,
                "downgrades_applied": all_warnings,
                "instruction": (
                    "Findings 등급 기록 완료. 이제 self_consistency_check (L3 만) → synthesize_report 순서로 진행. "
                    "synthesize_report body_markdown 에서 셀 인용 시 evidence_cell_names 의 이름을 [cell_name] 형태로 사용하세요. UUID는 절대 포함하지 마세요."
                    if (state.budget and state.budget.tier == "L3")
                    else "Findings 등급 기록 완료. 이제 synthesize_report 로 마무리하세요. "
                    "synthesize_report body_markdown 에서 셀 인용 시 evidence_cell_names 의 이름을 [cell_name] 형태로 사용하세요. UUID는 절대 포함하지 마세요."
                ),
            },
            [],
        )

    # ─── Phase 3: self_consistency_check (세션당 1회) ─────────────────────
    if name == "self_consistency_check":
        if state.consistency_checked:
            return {
                "success": False,
                "error": "already_checked",
                "message": (
                    "self_consistency_check 는 세션당 1회만 호출 가능합니다. "
                    "이미 호출했으니 곧바로 synthesize_report 로 마무리하세요."
                ),
            }, []
        state.consistency_checked = True
        issues = inp.get("issues") or []
        if not isinstance(issues, list):
            issues = []
        summary = (inp.get("summary") or "").strip()
        # 간단 검증 — 빈 issues + summary 만 있으면 OK
        return (
            {
                "success": True,
                "issues_count": len(issues),
                "issues": issues,
                "summary": summary,
                "instruction": (
                    "이슈가 있으면 update_cell_code 또는 write_cell_memo 로 1~2턴 안에 보강하고, "
                    "그 다음 synthesize_report 로 마무리. 이슈가 없으면 바로 synthesize_report."
                ),
            },
            [],
        )

    # ─── Phase 3: synthesize_report (세션 종료 마커) ──────────────────────
    if name == "synthesize_report":
        # Sequential gate: L3 는 self_consistency_check 1회 호출 필수.
        # 모델이 한 턴에 rate_findings + synthesize_report 를 같이 부르면 종료 가드가 우회되는 것을 방지.
        if (
            state.budget is not None
            and state.budget.tier == "L3"
            and not state.consistency_checked
        ):
            return {
                "success": False,
                "error": "consistency_check_required",
                "message": (
                    "L3 세션은 `synthesize_report` 호출 전에 `self_consistency_check` 를 1회 호출해야 합니다 "
                    "(이슈 없으면 `issues=[]`, `summary='all consistent'` 로). "
                    "그 후 다시 synthesize_report 를 호출하세요."
                ),
            }, []
        # rate_findings 도 sequential — findings 가 비어있으면 거부 (L2/L3 공통)
        if (
            state.budget is not None
            and state.budget.tier in ("L2", "L3")
            and not state.findings
        ):
            return {
                "success": False,
                "error": "findings_required_first",
                "message": (
                    "synthesize_report 전에 `rate_findings` 로 핵심 결론 3~7개에 confidence 를 매겨야 합니다."
                ),
            }, []
        audience = (inp.get("audience") or "").strip().lower()
        if audience not in ("exec", "ds", "pm"):
            return {
                "success": False,
                "error": "invalid_audience",
                "message": "audience 는 'exec' / 'ds' / 'pm' 중 하나여야 합니다.",
            }, []
        title = (inp.get("title") or "").strip()
        if not title:
            return {"success": False, "error": "title_required"}, []
        body = (inp.get("body_markdown") or "").strip()
        if not body:
            return {"success": False, "error": "body_required"}, []
        # UUID 형태 인용([xxxxxxxx-xxxx-...])이 body에 포함됐으면 제거
        import re as _re
        body = _re.sub(r'\s*\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]', '', body)
        next_steps = inp.get("next_steps") or []
        if not isinstance(next_steps, list):
            next_steps = []

        # 청자 라벨 + 다음 단계 부록 → Markdown 셀로
        audience_label = {"exec": "임원 보고", "ds": "DS 리포트", "pm": "PM 의사결정"}[audience]
        body_full = f"# {title}\n\n_({audience_label})_\n\n{body}"
        if next_steps:
            body_full += "\n\n## 다음 단계\n" + "\n".join(f"- {s}" for s in next_steps if str(s).strip())

        cell_id = str(uuid.uuid4())
        synthesis_cell_name = f"summary_{audience}"
        # 이름 충돌 방지
        existing_names = {c.name for c in state.cells}
        if synthesis_cell_name in existing_names:
            i = 2
            while f"{synthesis_cell_name}_{i}" in existing_names:
                i += 1
            synthesis_cell_name = f"{synthesis_cell_name}_{i}"

        new_cell = CellState(
            id=cell_id, name=synthesis_cell_name, type="markdown", code=body_full,
        )
        new_cell.executed = True
        state.cells.append(new_cell)

        # 영속화
        if state.notebook_id:
            try:
                from . import notebook_store as _ns
                _ns.create_cell(
                    nb_id=state.notebook_id,
                    cell_type="markdown",
                    name=synthesis_cell_name,
                    code=body_full,
                    memo="",
                    cell_id=cell_id,
                    after_id=None,
                    agent_generated=True,
                )
            except Exception as e:
                logger.warning("synthesize_report persist failed: %s", e)

        state.synthesis_done = True

        # learnings 누적 — high-confidence findings 만 노트북별 .md 에 append
        try:
            import datetime as _dt
            ts = _dt.datetime.now().strftime("%Y-%m-%d")
            agent_learnings.append_findings(
                state.notebook_id,
                state.findings,
                session_summary=title,
                timestamp_iso=ts,
            )
        except Exception as e:
            logger.warning("learnings persist failed: %s", e)

        return (
            {
                "success": True,
                "cell_id": cell_id,
                "audience": audience,
                "title": title,
                "instruction": (
                    "최종 요약 셀이 추가되었습니다. 이번 세션을 마무리하세요 — "
                    "더 이상 도구를 호출하지 말고 짧은 마무리 텍스트만 출력하세요."
                ),
            },
            [{
                "type": "cell_created",
                "cell_id": cell_id,
                "cell_type": "markdown",
                "cell_name": synthesis_cell_name,
                "code": body_full,
                "after_cell_id": None,
            }],
        )

    # 스킬 프레임워크 pre-guard — 플랜 강제 등 거부 규칙
    guard_err = agent_skills.check_pre_guard(name, inp, state)
    if guard_err is not None:
        return guard_err, []

    # 스킬 신규 tool 라우팅 (create_plan / update_plan / request_marts)
    if name in agent_skills.SKILL_TOOL_NAMES:
        return agent_skills.handle_skill_tool(name, inp, state, CellState)

    if name == "read_notebook_context":
        return {
            "cells": [
                {
                    "id": c.id,
                    "name": c.name,
                    "type": c.type,
                    "code": c.code,
                    "executed": c.executed,
                    "output_summary": _format_output_for_claude(c.output) if c.output else None,
                }
                for c in state.cells
            ],
            "selected_marts": state.selected_marts,
            "analysis_theme": state.analysis_theme,
        }, []

    if name == "create_cell":
        # 메모 미작성 가드: 직전 실행 셀(sql/python, 정상 출력)에 memo가 비어 있으면 거부.
        # 에이전트가 '다음 셀'을 만들기 전에 반드시 인사이트를 기록하도록 강제한다.
        if state.cells:
            prev = state.cells[-1]
            prev_output_type = (prev.output or {}).get("type") if prev.output else None
            if (
                prev.type in ("sql", "python")
                and prev.executed
                and prev_output_type not in ("error", None)
                and not (prev.memo or "").strip()
            ):
                return {
                    "success": False,
                    "error": "memo_required_before_next_cell",
                    "message": (
                        f"직전 셀 `{prev.name}` (id={prev.id})의 메모가 비어 있습니다. "
                        "다음 셀을 만들기 전에 반드시 `write_cell_memo`를 호출해 "
                        "(1) 직전 출력에서 얻은 핵심 수치·인사이트·이상치, "
                        "(2) 이를 근거로 다음 셀을 만드는 이유 — 를 2~5줄로 기록하세요. "
                        "메모 작성 후 다시 `create_cell`을 호출하면 됩니다."
                    ),
                    "require_memo_for_cell_id": prev.id,
                }, []

        cell_id = str(uuid.uuid4())
        cell_type = inp["cell_type"]
        raw_name = inp.get("name") or f"cell_{len(state.cells) + 1}"
        name_val = to_snake_case(raw_name, fallback=f"cell_{len(state.cells) + 1}")
        code = inp.get("code", "")
        after_id = inp.get("after_cell_id")

        # SQL 셀 whitelist 검증: 선택 밖 마트 참조 차단
        if cell_type == "sql":
            viol = _whitelist_violation(code, state.selected_marts)
            if viol:
                return {
                    "success": False,
                    "error": "mart_not_selected_in_sql",
                    "message": (
                        f"작성한 SQL이 '{viol}' 테이블을 참조하는데, 이 마트는 "
                        f"'사용 마트'에 포함되어 있지 않습니다. 선택된 마트는 "
                        f"[{', '.join(state.selected_marts)}] 뿐입니다. "
                        "ask_user를 호출해 사용자에게 상단 헤더의 '사용 마트'에서 "
                        "해당 마트 추가를 요청하거나, 선택된 마트만으로 쿼리를 다시 작성하세요."
                    ),
                }, []

        new_cell = CellState(id=cell_id, name=name_val, type=cell_type, code=code)
        if after_id:
            idx = next((i for i, c in enumerate(state.cells) if c.id == after_id), -1)
            state.cells.insert(idx + 1, new_cell)
        else:
            state.cells.append(new_cell)

        # 에이전트가 만든 셀도 vibe chat history 에 남겨, 셀별 대화 이력에서 조회 가능하게 함.
        # user_msg = 이번 턴 내레이션 (셀이 왜 만들어졌는지). 비어있으면 짧은 기본 문구로 폴백.
        agent_user_msg = _build_cell_chat_narration(state, created=True)
        if state.notebook_id:
            try:
                from . import notebook_store as _ns
                _ns.add_chat_entry(
                    state.notebook_id,
                    cell_id,
                    user_msg=agent_user_msg,
                    assistant_reply="코드가 업데이트되었습니다. 아래 버튼으로 이 시점 코드를 확인하거나 되돌릴 수 있습니다.",
                    code_snapshot="",
                    code_result=code,
                    agent_created=True,
                )
            except Exception:
                pass

        events: list[dict] = [{
            "type": "cell_created",
            "cell_id": cell_id,
            "cell_type": cell_type,
            "cell_name": name_val,
            "code": code,
            "after_cell_id": after_id,
            "agent_chat_entry": {
                "user": agent_user_msg,
                "assistant": "코드가 업데이트되었습니다. 아래 버튼으로 이 시점 코드를 확인하거나 되돌릴 수 있습니다.",
                "agent_created": True,
            },
        }]

        # NOTE: SQL/Python 자동 실행은 호출부(run_agent_stream)에서 처리한다.
        # 이 함수에서 같이 처리하면 cell_created 이벤트가 자동 실행 종료까지 batch 되어,
        # 프론트가 'Python 코드 작성 중' 상태에서 수십 초 멈춘 것처럼 보인다.
        return {"cell_id": cell_id, "success": True, "cell_type": cell_type}, events

    if name == "update_cell_code":
        cell = next((c for c in state.cells if c.id == inp["cell_id"]), None)
        if not cell:
            return {"success": False, "error": "Cell not found"}, []
        new_code = inp["code"]
        if cell.type == "sql":
            viol = _whitelist_violation(new_code, state.selected_marts)
            if viol:
                return {
                    "success": False,
                    "error": "mart_not_selected_in_sql",
                    "message": (
                        f"수정한 SQL이 '{viol}' 테이블을 참조하는데, 이 마트는 "
                        f"'사용 마트'에 포함되어 있지 않습니다. 선택된 마트는 "
                        f"[{', '.join(state.selected_marts)}] 뿐입니다. "
                        "ask_user로 마트 추가 요청하거나, 선택된 마트만으로 다시 작성하세요."
                    ),
                }, []
        old_code = cell.code
        cell.code = new_code
        # 에이전트 수정도 vibe chat history 에 기록 (이전 코드 스냅샷 포함)
        agent_update_msg = _build_cell_chat_narration(state, created=False)
        if state.notebook_id:
            try:
                from . import notebook_store as _ns
                _ns.add_chat_entry(
                    state.notebook_id,
                    cell.id,
                    user_msg=agent_update_msg,
                    assistant_reply="코드가 업데이트되었습니다. 아래 버튼으로 이 시점 코드를 확인하거나 되돌릴 수 있습니다.",
                    code_snapshot=old_code,
                    code_result=new_code,
                    agent_created=True,
                )
            except Exception:
                pass
        events: list[dict] = [{
            "type": "cell_code_updated",
            "cell_id": cell.id,
            "code": cell.code,
            "agent_chat_entry": {
                "user": agent_update_msg,
                "assistant": "코드가 업데이트되었습니다. 아래 버튼으로 이 시점 코드를 확인하거나 되돌릴 수 있습니다.",
                "agent_created": True,
                "code_snapshot": old_code,
            },
        }]

        # NOTE: 코드 변경 후 자동 재실행은 호출부(run_agent_stream)에서 처리.
        # cell_code_updated 이벤트를 즉시 전달해 프론트 상태가 stale 되지 않게 한다.
        return {"success": True, "cell_id": cell.id, "cell_type": cell.type}, events

    if name == "execute_cell":
        cell = next((c for c in state.cells if c.id == inp["cell_id"]), None)
        if not cell:
            return {"success": False, "error": "Cell not found"}, []

        try:
            from ..services.kernel import run_sql, run_python
            loop = asyncio.get_event_loop()

            # 커널 실행은 thread executor 위에서 돌고, 사용자 코드/Plotly→PNG 가 hang 하면
            # 이벤트 루프와 에이전트 전체가 멈춘다. asyncio.wait_for 로 상한을 둔다.
            # 주의: run_in_executor 의 thread 자체는 cancel 되지 않으므로 백그라운드에서
            # 계속 돌 수 있다 — 그러나 에이전트 흐름은 즉시 복귀해 사용자에게 피드백 가능.
            # timeout <= 0 이면 무한 대기 (모델링 등 장기 작업용 escape hatch).
            async def _await_exec(future, timeout_sec: int):
                if timeout_sec and timeout_sec > 0:
                    return await asyncio.wait_for(future, timeout=timeout_sec)
                return await future

            if cell.type == "sql":
                try:
                    output = await _await_exec(
                        loop.run_in_executor(
                            None, run_sql, state.notebook_id, cell.name, cell.code
                        ),
                        SQL_EXEC_TIMEOUT_SEC,
                    )
                except asyncio.TimeoutError:
                    logger.error(
                        "SQL exec timeout after %ss (cell=%s)", SQL_EXEC_TIMEOUT_SEC, cell.name
                    )
                    output = {
                        "type": "error",
                        "message": (
                            f"SQL 실행이 {SQL_EXEC_TIMEOUT_SEC}초를 넘겨 자동 중단했어요. "
                            "Snowflake 쿼리 응답이 늦거나 결과가 너무 큰지 확인해주세요. "
                            "WHERE/LIMIT 으로 범위를 좁혀 다시 시도하면 됩니다."
                        ),
                    }
            elif cell.type == "python":
                try:
                    output = await _await_exec(
                        loop.run_in_executor(
                            None, run_python, state.notebook_id, cell.name, cell.code
                        ),
                        PYTHON_EXEC_TIMEOUT_SEC,
                    )
                except asyncio.TimeoutError:
                    logger.error(
                        "Python exec timeout after %ss (cell=%s)", PYTHON_EXEC_TIMEOUT_SEC, cell.name
                    )
                    output = {
                        "type": "error",
                        "message": (
                            f"Python 셀 실행이 {PYTHON_EXEC_TIMEOUT_SEC}초를 넘겨 자동 중단했어요. "
                            "장시간 작업이 필요하면 환경변수 AGENT_PYTHON_EXEC_TIMEOUT_SEC 로 상한을 늘리거나 "
                            "0 으로 끄세요(무한). 데이터 처리량이 과도하거나 차트 PNG 렌더가 멈춘 경우라면 "
                            "데이터 크기/포인트 수를 줄여 다시 시도해주세요."
                        ),
                    }
            else:
                output = {"type": "stdout", "content": ""}

        except Exception as e:
            output = {"type": "error", "message": str(e)}

        cell.executed = True
        cell.output = output

        if state.notebook_id:
            try:
                from . import notebook_store as _ns
                _ns.update_cell(state.notebook_id, cell.id, output=output)
            except Exception:
                pass

        output_summary = _format_output_for_claude(output)
        result_payload: dict = {
            "cell_id": cell.id,
            "executed": True,
            "output_summary": output_summary,
        }
        if isinstance(output, dict) and output.get("imagePngBase64"):
            result_payload["image_png_base64"] = output["imagePngBase64"]
        return (
            result_payload,
            [{"type": "cell_executed", "cell_id": cell.id, "output": output}],
        )

    if name == "read_cell_output":
        cell = next((c for c in state.cells if c.id == inp["cell_id"]), None)
        if not cell:
            return {"error": "Cell not found"}, []
        if not cell.executed:
            return {"error": "Cell has not been executed"}, []
        return {"cell_id": cell.id, "output_summary": _format_output_for_claude(cell.output)}, []

    if name == "get_category_values":
        mart_key = (inp.get("mart_key") or "").strip()
        col = (inp.get("column") or "").strip()
        selected_lc = {m.lower() for m in state.selected_marts}
        if state.selected_marts and mart_key.lower() not in selected_lc:
            return {
                "error": "mart_not_selected",
                "message": f"'{mart_key}' 는 선택된 마트가 아닙니다. 현재 선택: [{', '.join(state.selected_marts)}]",
            }, []
        if not col:
            return {"error": "column_required"}, []
        # D: on-demand — 패턴 제약 없이 모든 컬럼 허용 (캐시는 동일 엔진 사용)
        import asyncio as _asyncio
        loop = _asyncio.get_event_loop()
        try:
            # is_category_column 체크를 우회하기 위해 _query_distinct 를 호출 + 수동 캐시 저장
            def _fetch():
                key = (mart_key.lower(), col.lower())
                with category_cache._lock:
                    entry = category_cache._cache.get(key)
                if entry and category_cache._fresh(entry):
                    return entry.get("values")
                try:
                    vals = category_cache._query_distinct(mart_key, col)
                except category_cache._QueryFailed as exc:
                    raise RuntimeError(str(exc))
                import time as _t
                with category_cache._lock:
                    category_cache._cache[key] = {"values": vals, "fetched_at": _t.time()}
                category_cache._flush_to_disk()
                return vals
            vals = await loop.run_in_executor(None, _fetch)
        except Exception as e:
            return {"error": str(e)}, []
        if vals is None:
            return {
                "mart_key": mart_key,
                "column": col,
                "too_many": True,
                "message": f"`{col}` 는 distinct 값이 100개를 초과합니다 — 카테고리성 컬럼이 아님. `profile_mart` 로 분포 파악을 고려하세요.",
            }, []
        return {
            "mart_key": mart_key,
            "column": col,
            "count": len(vals),
            "values": vals,
        }, []

    if name in ("get_mart_schema", "preview_mart", "profile_mart"):
        mart_key = inp.get("mart_key", "")
        # 노트북 SQL 셀 DataFrame 를 마트 도구로 조회하려는 시도 차단 — 명확한 가이드 반환
        executed_sql_cell_names = {c.name for c in state.cells if c.type == "sql" and c.executed}
        if mart_key in executed_sql_cell_names:
            cell = next((c for c in state.cells if c.name == mart_key), None)
            return {
                "error": "cell_dataframe_not_mart",
                "message": (
                    f"'{mart_key}'는 Snowflake 마트가 아니라 노트북의 SQL 셀 실행 결과 DataFrame입니다. "
                    f"profile_mart/preview_mart/get_mart_schema 를 사용할 수 없습니다. "
                    f"대신 다음 방법을 사용하세요:\n"
                    f"1. analyze_output(cell_id='{cell.id if cell else mart_key}') — 통계 요약 조회\n"
                    f"2. read_cell_output(cell_id='{cell.id if cell else mart_key}') — 출력 직접 확인\n"
                    f"3. Python 셀에서 변수명 `{mart_key}` 을 직접 사용 (예: `df = {mart_key}`)"
                ),
            }, []
        # 선택된 마트 whitelist 체크.
        selected_lc = {m.lower() for m in state.selected_marts}
        if state.selected_marts and mart_key.lower() not in selected_lc:
            return {
                "error": "mart_not_selected",
                "message": (
                    f"'{mart_key}'는 현재 '사용 마트'에 포함되어 있지 않습니다. "
                    f"선택된 마트는 [{', '.join(state.selected_marts)}] 뿐입니다. "
                    "이 마트가 필요하면 ask_user를 호출해 사용자에게 "
                    "상단 헤더의 '사용 마트'에서 해당 마트 추가를 요청하세요."
                ),
            }, []
        # 이벤트 루프 블로킹 방지: Snowflake 동기 드라이버 호출은 executor에서 실행
        import asyncio as _asyncio
        loop = _asyncio.get_event_loop()
        try:
            if name == "get_mart_schema":
                result = await loop.run_in_executor(None, mart_tools.get_mart_schema, mart_key)
                state.explored_marts.add(mart_key.lower())
                return result, []
            if name == "preview_mart":
                limit = inp.get("limit", 5)
                result = await loop.run_in_executor(None, mart_tools.preview_mart, mart_key, limit)
                state.explored_marts.add(mart_key.lower())
                return result, []
            result = await loop.run_in_executor(None, mart_tools.profile_mart, mart_key)
            state.explored_marts.add(mart_key.lower())
            return result, []
        except Exception as e:
            return {"error": str(e)}, []

    if name == "query_data":
        sql = (inp.get("sql") or "").strip()
        purpose = (inp.get("purpose") or "").strip()
        if not sql:
            return {"error": "sql_required", "message": "`sql` 이 비어 있습니다."}, []
        if not purpose:
            return {
                "error": "purpose_required",
                "message": "`purpose` 한 줄로 이 쿼리를 실행하는 이유를 적어주세요 (로깅용).",
            }, []
        low = sql.lower().lstrip()
        # SELECT/WITH 외의 statement 차단 (DML/DDL 금지)
        if not (low.startswith("select") or low.startswith("with")):
            return {
                "error": "select_only",
                "message": "`query_data` 는 SELECT(또는 WITH ... SELECT) 전용입니다. DML/DDL 금지.",
            }, []
        # 세미콜론으로 쪼개서 복수 statement 차단
        statements = [s.strip() for s in sql.rstrip(";").split(";") if s.strip()]
        if len(statements) > 1:
            return {
                "error": "single_statement_only",
                "message": "한 번에 하나의 SELECT 문만 허용합니다.",
            }, []
        viol = _whitelist_violation(sql, state.selected_marts)
        if viol:
            return {
                "success": False,
                "error": "mart_not_selected_in_sql",
                "message": (
                    f"'{viol}' 테이블을 참조하는데 '사용 마트'에 포함되어 있지 않습니다. "
                    f"선택된 마트는 [{', '.join(state.selected_marts)}] 뿐입니다."
                ),
            }, []
        # explored_marts 에 참조 테이블 등록 — query_data 도 탐색으로 카운트
        for ref in _extract_referenced_tables(sql):
            state.explored_marts.add(ref)

        import asyncio as _asyncio
        from .snowflake_session import get_connection, is_connected
        if not is_connected():
            return {
                "error": "snowflake_not_connected",
                "message": "Snowflake 미연결. 왼쪽 사이드바에서 연결 후 재시도.",
            }, []

        def _run():
            conn = get_connection()
            cur = conn.cursor()
            cur.execute(sql)
            cols = [c[0] for c in (cur.description or [])]
            rows_raw = cur.fetchmany(100)
            # 직렬화
            import datetime as _dt
            from decimal import Decimal as _D
            def _s(v):
                if v is None:
                    return None
                if isinstance(v, _D):
                    return float(v)
                if isinstance(v, (_dt.date, _dt.datetime, _dt.time)):
                    return v.isoformat()
                if isinstance(v, (bytes, bytearray)):
                    return v.hex()
                return v
            rows = [[_s(v) for v in row] for row in rows_raw]
            return cols, rows

        loop = _asyncio.get_event_loop()
        try:
            cols, rows = await loop.run_in_executor(None, _run)
        except Exception as e:
            return {"error": "query_failed", "message": str(e)}, []

        return {
            "success": True,
            "purpose": purpose,
            "columns": cols,
            "rows": rows,
            "row_count": len(rows),
            "truncated": len(rows) >= 100,
            "note": "query_data 는 셀을 남기지 않습니다. 결과가 분석에 의미 있으면 create_cell 로 정식 셀 작성.",
        }, []

    if name == "analyze_output":
        cell = next((c for c in state.cells if c.id == inp.get("cell_id")), None)
        if not cell:
            return {"success": False, "error": "cell_not_found"}, []
        if not cell.executed:
            return {"success": False, "error": "not_executed", "message": "셀이 아직 실행되지 않았습니다."}, []
        out = cell.output or {}
        if out.get("type") != "table":
            return {
                "success": False,
                "error": "not_a_table",
                "message": f"이 셀의 출력은 {out.get('type', 'unknown')} 타입입니다. analyze_output 은 테이블 결과에만 동작.",
            }, []

        # 커널 namespace 에서 실제 DataFrame 가져오기
        try:
            from .kernel import get_namespace
            ns = get_namespace(state.notebook_id)
            df = ns.get(cell.name)
            if df is None or not hasattr(df, "columns"):
                return {
                    "success": False,
                    "error": "dataframe_missing",
                    "message": f"커널에서 `{cell.name}` DataFrame 을 찾을 수 없습니다. 셀을 재실행 후 재시도.",
                }, []
        except Exception as e:
            return {"success": False, "error": "kernel_error", "message": str(e)}, []

        try:
            import pandas as _pd
            import numpy as _np
        except Exception as e:
            return {"success": False, "error": "pandas_missing", "message": str(e)}, []

        focus = (inp.get("focus_column") or "").strip() or None
        top_n = min(max(int(inp.get("top_n") or 5), 1), 20)

        try:
            row_count = len(df)
            col_types: dict[str, str] = {str(c): str(df[c].dtype) for c in df.columns}
            numeric_cols = [c for c in df.columns if _pd.api.types.is_numeric_dtype(df[c])]
            if focus:
                numeric_cols = [c for c in numeric_cols if str(c).lower() == focus.lower()]

            # describe (수치형 중심)
            describe_data: dict = {}
            if numeric_cols:
                desc = df[numeric_cols].describe().round(4)
                describe_data = {
                    str(c): {stat: (None if _pd.isna(desc.at[stat, c]) else float(desc.at[stat, c]))
                             for stat in desc.index}
                    for c in numeric_cols
                }

            # NULL 요약
            null_summary: dict = {}
            for c in df.columns:
                nulls = int(df[c].isna().sum())
                if nulls:
                    null_summary[str(c)] = {
                        "count": nulls,
                        "ratio": round(nulls / row_count, 4) if row_count else 0.0,
                    }

            # 카디널리티
            cardinality: dict = {}
            for c in df.columns:
                try:
                    cardinality[str(c)] = int(df[c].nunique(dropna=True))
                except Exception:
                    continue

            # Top / Bottom / 이상치 (IQR)
            top_bottom: dict = {}
            outliers: dict = {}
            for c in numeric_cols[:10]:  # 너무 많은 컬럼 방지
                try:
                    s = df[c].dropna()
                    if s.empty:
                        continue
                    # top/bottom: 해당 값과 id-like(첫 비수치 컬럼) 함께 반환
                    idcol = None
                    for oc in df.columns:
                        if oc == c:
                            continue
                        if df[oc].dtype == object or _pd.api.types.is_string_dtype(df[oc]):
                            idcol = oc
                            break
                    sub = df[[c] + ([idcol] if idcol else [])].dropna(subset=[c])
                    top_rows = sub.nlargest(top_n, c).values.tolist()
                    bot_rows = sub.nsmallest(top_n, c).values.tolist()
                    # 값 직렬화
                    def _ser(v):
                        if v is None:
                            return None
                        if hasattr(v, "item"):
                            try:
                                return v.item()
                            except Exception:
                                return str(v)
                        return v
                    top_bottom[str(c)] = {
                        "id_column": str(idcol) if idcol else None,
                        "top": [[_ser(x) for x in r] for r in top_rows],
                        "bottom": [[_ser(x) for x in r] for r in bot_rows],
                    }
                    # IQR 기반 이상치 개수
                    q1, q3 = s.quantile(0.25), s.quantile(0.75)
                    iqr = q3 - q1
                    if iqr > 0:
                        low_b = q1 - 1.5 * iqr
                        high_b = q3 + 1.5 * iqr
                        n_out = int(((s < low_b) | (s > high_b)).sum())
                        if n_out:
                            outliers[str(c)] = {
                                "count": n_out,
                                "ratio": round(n_out / len(s), 4),
                                "iqr_low": float(low_b),
                                "iqr_high": float(high_b),
                            }
                except Exception:
                    continue

            # 카테고리형 top-k value_counts
            categorical_top: dict = {}
            for c in df.columns:
                if c in numeric_cols:
                    continue
                try:
                    vc = df[c].value_counts(dropna=False).head(5)
                    categorical_top[str(c)] = [
                        {"value": (None if _pd.isna(k) else str(k)), "count": int(v)}
                        for k, v in vc.items()
                    ]
                except Exception:
                    continue

            return {
                "success": True,
                "cell_name": cell.name,
                "row_count": row_count,
                "column_types": col_types,
                "describe": describe_data,
                "null_summary": null_summary,
                "cardinality": cardinality,
                "top_bottom": top_bottom,
                "outliers": outliers,
                "categorical_top": categorical_top,
                "hint": (
                    "이 통계 결과를 바탕으로 `write_cell_memo` 에 관찰·이상 신호·다음 행동을 기록하세요. "
                    "outliers 가 비어있지 않으면 이상치 원인을 다음 셀에서 파고들지, 제외할지 결정."
                ),
            }, []
        except Exception as e:
            return {"success": False, "error": "analysis_failed", "message": str(e)}, []

    if name == "list_available_marts":
        # Snowflake 의 전체 마트 카탈로그 (키 + description) 만 반환.
        # 스키마/컬럼은 선택된 마트에 대해서만 노출된다.
        from .snowflake_session import is_connected, get_connection, get_status
        if not is_connected():
            return {
                "error": "snowflake_not_connected",
                "message": "Snowflake 미연결 — 카탈로그 조회 불가. ask_user 로 연결 요청.",
            }, []
        filter_kw = (inp.get("filter_keyword") or "").strip().lower()
        import asyncio as _asyncio
        loop = _asyncio.get_event_loop()

        def _fetch():
            conn = get_connection()
            status = get_status()
            database = status.get("database") or "WAD_DW_PROD"
            schema = status.get("schema") or "MART"
            cur = conn.cursor()
            cur.execute(f"""
                SELECT table_name, comment
                FROM {database}.information_schema.tables
                WHERE table_schema = '{schema.upper()}'
                  AND table_type = 'BASE TABLE'
                ORDER BY table_name
            """)
            return cur.fetchall()

        try:
            rows = await loop.run_in_executor(None, _fetch)
        except Exception as e:
            return {"error": "catalog_query_failed", "message": str(e)}, []

        selected_lc = {m.lower() for m in state.selected_marts}
        marts = []
        for tbl, comment in rows:
            k = tbl.lower()
            desc = (comment or "").strip()
            if filter_kw and filter_kw not in k and filter_kw not in desc.lower():
                continue
            marts.append({
                "key": k,
                "description": desc or tbl,
                "selected": k in selected_lc,
            })
        total = len(marts)
        # 너무 많으면 상위 50개만 (필터 사용 유도)
        truncated = total > 50
        return {
            "success": True,
            "total": total,
            "truncated": truncated,
            "filter_keyword": filter_kw or None,
            "marts": marts[:50],
            "hint": (
                "현재 선택 안 된 마트 중 관련성이 높아 보이는 것이 있으면 `request_marts` 로 사용자에게 추가 요청. "
                "선택된 마트는 `selected: true` 표시. 절대 직접 SQL 조회 시도하지 말 것."
            ),
        }, []

    if name == "todo_write":
        todos_in = inp.get("todos") or []
        if not isinstance(todos_in, list):
            return {"success": False, "error": "invalid_todos"}, []
        normalized = []
        in_progress_count = 0
        for t in todos_in:
            if not isinstance(t, dict):
                continue
            content = (t.get("content") or "").strip()
            status_val = (t.get("status") or "pending").strip().lower()
            if status_val not in ("pending", "in_progress", "completed"):
                status_val = "pending"
            if not content:
                continue
            if status_val == "in_progress":
                in_progress_count += 1
            normalized.append({
                "content": content,
                "status": status_val,
                "active_form": (t.get("active_form") or content).strip(),
            })
        if in_progress_count > 1:
            return {
                "success": False,
                "error": "multiple_in_progress",
                "message": "한 번에 하나의 todo 만 `in_progress` 일 수 있습니다. 나머지를 `pending` 또는 `completed` 로 바꾸세요.",
            }, []
        state.todos = normalized
        total = len(normalized)
        completed = sum(1 for t in normalized if t["status"] == "completed")
        return (
            {
                "success": True,
                "total": total,
                "completed": completed,
                "in_progress": in_progress_count,
                "todos": normalized,
            },
            [{"type": "todos_updated", "todos": normalized}],
        )

    if name == "write_cell_memo":
        cell = next((c for c in state.cells if c.id == inp["cell_id"]), None)
        if not cell:
            return {"success": False, "error": "Cell not found"}, []
        memo = _sanitize_memo(inp.get("memo", ""))
        cell.memo = memo
        # 영속화: 노트북에 즉시 반영
        if state.notebook_id:
            try:
                from . import notebook_store
                notebook_store.update_cell(state.notebook_id, cell.id, memo=memo)
            except Exception:
                pass
        return (
            {"success": True, "cell_id": cell.id},
            [{"type": "cell_memo_updated", "cell_id": cell.id, "memo": memo}],
        )

    if name == "check_chart_quality":
        cell_id = inp.get("cell_id", "")
        passed = bool(inp.get("passed", False))
        if passed and cell_id:
            state.chart_quality_checked.add(cell_id)
        issues = inp.get("issues") or []
        summary = (inp.get("summary") or "").strip()
        if passed:
            instruction = (
                "차트 퀄리티 통과. 이제 같은 셀에 대해 `write_cell_memo`를 호출해 인사이트를 기록한 뒤 "
                "다음 단계로 진행하세요. 같은 셀에 대해 이 도구를 다시 호출하지 마세요."
            )
        else:
            instruction = (
                "차트 퀄리티 미달. 즉시 `update_cell_code`로 동일 셀(cell_id)을 수정해 재렌더하세요. "
                "수정 후 다시 `check_chart_quality`를 호출해 재판정하세요. 새 셀을 만들지 마세요."
            )
        return (
            {"success": True, "cell_id": cell_id, "passed": passed, "issues": issues, "instruction": instruction},
            [{"type": "chart_quality", "cell_id": cell_id, "passed": passed, "summary": summary, "issues": issues}],
        )

    if name == "create_sheet_cell":
        from . import sheet_snapshot
        from . import notebook_store as _ns

        patches = inp.get("patches") or []
        raw_name = inp.get("name") or f"sheet_{len(state.cells) + 1}"
        name_val = to_snake_case(raw_name, fallback=f"sheet_{len(state.cells) + 1}")
        after_id = inp.get("after_cell_id")
        code, skipped = sheet_snapshot.build_snapshot(patches)

        cell_id = str(uuid.uuid4())
        new_cell = CellState(id=cell_id, name=name_val, type="sheet", code=code)
        # sheet 셀은 실행 불가 → 생성 즉시 executed=True 로 표시
        new_cell.executed = True
        if after_id:
            idx = next((i for i, c in enumerate(state.cells) if c.id == after_id), -1)
            state.cells.insert(idx + 1, new_cell)
        else:
            state.cells.append(new_cell)

        # 파일에도 반영 — 에이전트 스트림이 끊겨도 노트북에 남도록
        if state.notebook_id:
            try:
                _ns.create_cell(
                    nb_id=state.notebook_id,
                    cell_type="sheet",
                    name=name_val,
                    code=code,
                    memo="",
                    cell_id=cell_id,
                    after_id=after_id,
                    agent_generated=True,
                )
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning("create_sheet_cell persist failed: %s", e)

        events: list[dict] = [{
            "type": "cell_created",
            "cell_id": cell_id,
            "cell_type": "sheet",
            "cell_name": name_val,
            "code": code,
            "after_cell_id": after_id,
        }]
        return {
            "success": True,
            "cell_id": cell_id,
            "applied_patches": len(patches) - len(skipped),
            "skipped_ranges": skipped,
        }, events

    if name == "update_sheet_cell":
        from . import sheet_snapshot
        cell = next((c for c in state.cells if c.id == inp.get("cell_id")), None)
        if not cell:
            return {"success": False, "error": "Cell not found"}, []
        if cell.type != "sheet":
            return {"success": False, "error": f"Cell is not a sheet (type={cell.type})"}, []
        patches = inp.get("patches") or []
        new_code, skipped = sheet_snapshot.patch_existing(cell.code or "", patches)
        cell.code = new_code
        if state.notebook_id:
            try:
                from . import notebook_store as _ns
                _ns.update_cell(state.notebook_id, cell.id, code=new_code)
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning("update_sheet_cell persist failed: %s", e)
        events: list[dict] = [{"type": "cell_code_updated", "cell_id": cell.id, "code": cell.code}]
        return {
            "success": True,
            "cell_id": cell.id,
            "applied_patches": len(patches) - len(skipped),
            "skipped_ranges": skipped,
        }, events

    if name == "ask_user":
        question = inp.get("question", "").strip()
        options = inp.get("options") or []
        return (
            {
                "posted": True,
                "instruction": (
                    "질문이 사용자에게 전달되었습니다. 더 이상 도구를 호출하지 말고, "
                    "사용자 답변을 기다리는 짧은 한국어 안내문만 출력한 뒤 응답을 종료하세요."
                ),
            },
            [{"type": "ask_user", "question": question, "options": options}],
        )

    return {"error": f"Unknown tool: {name}"}, []


# ─── Auto-execute helper (post create/update) ────────────────────────────────

async def _auto_execute_after_create_or_update(
    tool_name: str,
    tool_input: dict,
    result: dict,
    state: NotebookState,
) -> AsyncGenerator[dict, None]:
    """create_cell/update_cell_code 직후 SQL/Python 셀을 자동 실행.

    SSE 이벤트(cell_executed)는 즉시 yield 하고, 모델이 보는 tool_result(`result`)에는
    auto_executed/output_summary/image_png_base64 를 in-place 머지한다.

    장시간 실행(모델링 등 시간 단위 작업)에서는:
      - LONG_EXEC_HEARTBEAT_THRESHOLDS_SEC 임계마다 `exec_heartbeat` 이벤트 발사
        ("아직 실행 중이에요" 신호 — 프론트가 status 라벨에 경과시간 노출)
      - 완료 시 LONG_EXEC_NOTIFY_MIN_SEC 이상 걸린 경우 `exec_completed_notice` 발사
        (사용자에게 "X초만에 완료됐어요" 알림, 모델 응답 흐름과 별개)
    """
    if tool_name not in ("create_cell", "update_cell_code"):
        return
    if not result.get("success"):
        return
    if not state.notebook_id:
        return
    cell_id = result.get("cell_id") or tool_input.get("cell_id")
    if not cell_id:
        return
    cell_type = result.get("cell_type") or tool_input.get("cell_type")
    if not cell_type:
        cell = next((c for c in state.cells if c.id == cell_id), None)
        cell_type = cell.type if cell else None
    if cell_type not in ("sql", "python"):
        return

    cell_obj = next((c for c in state.cells if c.id == cell_id), None)
    cell_name = cell_obj.name if cell_obj else ""

    import time as _time
    start_ts = _time.monotonic()

    exec_task = asyncio.create_task(
        _execute_tool("execute_cell", {"cell_id": cell_id}, state)
    )
    thresholds = list(LONG_EXEC_HEARTBEAT_THRESHOLDS_SEC)
    next_idx = 0
    last_heartbeat_at = 0.0

    try:
        while not exec_task.done():
            now = _time.monotonic() - start_ts
            # 다음 wake-up 시점 결정: 다음 임계, 아니면 마지막 heartbeat + 60초.
            if next_idx < len(thresholds):
                target = thresholds[next_idx]
            else:
                target = last_heartbeat_at + 60.0
            wait_sec = max(0.1, target - now)
            try:
                await asyncio.wait_for(asyncio.shield(exec_task), timeout=wait_sec)
                break  # exec_task 완료
            except asyncio.TimeoutError:
                now = _time.monotonic() - start_ts
                # 이미 지난 임계는 한꺼번에 advance — wait_for 가 정확히 임계에 깨지 않을 수 있음.
                while next_idx < len(thresholds) and now >= thresholds[next_idx]:
                    next_idx += 1
                last_heartbeat_at = now
                elapsed_int = int(now)
                yield {
                    "type": "exec_heartbeat",
                    "cell_id": cell_id,
                    "cell_name": cell_name,
                    "elapsed_sec": elapsed_int,
                    "message": (
                        f"셀 `{cell_name}` 실행이 {elapsed_int}초째 진행 중이에요. "
                        "끝날 때까지 기다린 뒤 이어서 분석할게요."
                    ),
                }
        exec_result, exec_events = await exec_task
    except asyncio.CancelledError:
        exec_task.cancel()
        raise

    elapsed_total = _time.monotonic() - start_ts
    for ev in exec_events:
        yield ev
    result["auto_executed"] = True
    if "output_summary" in exec_result:
        result["output_summary"] = exec_result.get("output_summary")
    if exec_result.get("image_png_base64"):
        result["image_png_base64"] = exec_result["image_png_base64"]

    # 장기 실행이었다면 완료 알림 — 사용자가 자리 비웠다 돌아와서 확인할 수 있게.
    if elapsed_total >= LONG_EXEC_NOTIFY_MIN_SEC:
        yield {
            "type": "exec_completed_notice",
            "cell_id": cell_id,
            "cell_name": cell_name,
            "elapsed_sec": int(elapsed_total),
            "message": (
                f"셀 `{cell_name}` 이 {int(elapsed_total)}초만에 실행 완료됐어요. "
                "이어서 결과를 분석할게요."
            ),
        }
        # 모델 tool_result 에도 실행 시간을 알려, 응답에서 "X초 걸렸어요" 같은 멘트를 자연스럽게 포함하도록.
        result["elapsed_sec"] = int(elapsed_total)


# ─── System prompt ────────────────────────────────────────────────────────────

def _build_cell_dataframes_block(cell_based: list[str], state: NotebookState) -> str:
    """선택된 데이터 소스 중 Snowflake 마트가 아닌 노트북 SQL 셀 DataFrame 목록을 프롬프트 블록으로 반환."""
    if not cell_based:
        return ""
    lines = []
    for name in cell_based:
        cell = next((c for c in state.cells if c.name == name), None)
        if cell:
            # output 이 있으면 컬럼명, 없으면 SQL 코드로 SELECT 컬럼 힌트 제공
            col_hint = ""
            if cell.output:
                cols = cell.output.get("columns") or []
                if cols:
                    col_names = [c.get("name", str(c)) if isinstance(c, dict) else str(c) for c in cols[:20]]
                    col_hint = f"\n  Columns: {', '.join(col_names)}"
            elif cell.code:
                # SQL 코드 첫 줄에서 SELECT 컬럼 추출 (간단한 힌트용)
                code_preview = cell.code.strip()[:300]
                col_hint = f"\n  SQL: {code_preview.splitlines()[0][:120]}..."
            lines.append(
                f"- `{name}` (cell_id: `{cell.id}`) — 노트북 SQL 셀 실행 결과 DataFrame"
                f"{col_hint}"
            )
        else:
            lines.append(f"- `{name}` — 노트북 SQL 셀 DataFrame")
    block = (
        "\n## 노트북 셀 DataFrame (Python 커널 변수로 바로 사용 가능)\n"
        "아래 DataFrame은 노트북 SQL 셀의 실행 결과로, Python 커널 namespace에 **변수로 이미 적재**되어 있습니다.\n"
        "**⚠️ 이 데이터는 Snowflake 마트가 아닙니다 — `profile_mart`, `preview_mart`, `get_mart_schema`, `list_available_marts` 사용 금지.**\n"
        "올바른 사용법:\n"
        "- `analyze_output(cell_id='...')` 또는 `read_cell_output(cell_id='...')` 로 통계/내용 확인\n"
        "- Python 셀에서 변수명을 직접 사용: `df = <변수명>` 후 pandas/plotly 분석\n"
        "- SQL 셀을 새로 만들 필요 없음 — 이미 실행된 DataFrame을 바로 Python에서 활용하라\n\n"
        + "\n".join(lines) + "\n"
    )
    return block


def _build_system_prompt(state: NotebookState) -> str:
    # 실행된 SQL 셀 이름 집합 — selected_marts 중 이 이름과 겹치면 마트가 아닌 셀 DataFrame
    executed_sql_cell_names = {c.name for c in state.cells if c.type == "sql" and c.executed}
    cell_based = [m for m in state.selected_marts if m in executed_sql_cell_names]
    snowflake_marts = [m for m in state.selected_marts if m not in executed_sql_cell_names]
    marts = ", ".join(snowflake_marts) if snowflake_marts else "없음"
    from . import snowflake_session
    import datetime as _dt
    sf_connected = snowflake_session.is_connected()

    # 오늘 날짜 + 데이터 최신화 경계 (D-1). 한국 표준시 기준.
    try:
        from zoneinfo import ZoneInfo
        now_kst = _dt.datetime.now(ZoneInfo("Asia/Seoul"))
    except Exception:
        now_kst = _dt.datetime.now()
    today_kst = now_kst.date()
    data_cutoff = today_kst - _dt.timedelta(days=1)
    weekday_ko = "월화수목금토일"[today_kst.weekday()]
    date_block = (
        f"\n## 오늘 날짜 & 데이터 최신화\n"
        f"- 오늘: **{today_kst.isoformat()} ({weekday_ko})** (KST)\n"
        f"- 데이터 최신화: **{data_cutoff.isoformat()} 까지** (전일자 D-1 기준). 오늘 날짜({today_kst.isoformat()}) 데이터는 아직 적재되지 않았을 수 있음.\n"
        f"- 사용자가 '최근', '최신', '어제', '이번 주/달' 등 상대 기간을 쓰면 위 날짜 기준으로 해석하라:\n"
        f"  - '어제' = {data_cutoff.isoformat()}\n"
        f"  - '최근 7일' = {(data_cutoff - _dt.timedelta(days=6)).isoformat()} ~ {data_cutoff.isoformat()} (오늘 제외)\n"
        f"  - '최근 30일' = {(data_cutoff - _dt.timedelta(days=29)).isoformat()} ~ {data_cutoff.isoformat()}\n"
        f"  - '이번 달' = {today_kst.replace(day=1).isoformat()} ~ {data_cutoff.isoformat()}\n"
        f"- SQL 작성 시 `CURRENT_DATE` 대신 **위 고정 날짜** 를 리터럴로 쓰는 것을 우선 고려하라 — 재실행 시 결과가 달라지는 것을 방지.\n"
        f"- 기간이 모호하면(예: '최근 매출') 반드시 `ask_user` 로 정확한 범위를 재확인.\n"
    )
    sf_status = "연결됨" if sf_connected else "미연결 — Snowflake 관련 도구(get_mart_schema, preview_mart, profile_mart, SQL 실행) 사용 불가. 필요 시 ask_user로 연결 요청"

    # 선택된 마트의 컬럼 스키마를 프롬프트에 미리 주입 → get_mart_schema 재호출 불필요
    mart_schema_block = ""
    category_lines: list[str] = []
    if state.mart_metadata:
        lines = []
        for m in state.mart_metadata:
            cols = m.get("columns") or []
            col_descs = ", ".join(
                f"{c.get('name', '')}({c.get('type', '')})"
                + (f" — {c['desc']}" if c.get("desc") else "")
                for c in cols
            )
            lines.append(
                f"- [{m.get('key', '')}] {m.get('description', '')}\n  Columns: {col_descs}"
            )
            # 카테고리 컬럼(_status/_type) 의 distinct 값 목록
            mk = m.get("key", "")
            for c in cols:
                cats = c.get("categories")
                if cats:
                    preview = ", ".join(f"'{v}'" for v in cats)
                    category_lines.append(
                        f"- {mk}.{c.get('name', '')} ∈ {{{preview}}}  (총 {len(cats)}개)"
                    )
        mart_schema_block = (
            "\n## 선택된 마트 스키마 (이미 로드됨 — `get_mart_schema` 재호출 불필요)\n"
            + "\n".join(lines) + "\n"
        )
        if category_lines:
            mart_schema_block += (
                "\n### 카테고리 컬럼 허용 값 (status/type — SQL `WHERE` 작성 시 정확한 값 사용)\n"
                + "\n".join(category_lines) + "\n"
                + "- 위 목록에 없는 값을 WHERE 에 쓰면 결과가 비게 되니 주의. "
                "목록에 없고 필요해 보이면 `ask_user` 로 확인.\n"
            )

    # 루트 폴더에 드롭된 로컬 데이터 파일 (CSV/Parquet 등) 프로파일
    local_files_block = file_profile_cache.format_for_prompt()

    # 이전 세션의 누적 발견 (learnings.md) — 같은 노트북에서 재발견 방지
    learnings_block = agent_learnings.load_for_prompt(state.notebook_id)

    # ─── Phase 0 라우팅 블록 ────────────────────────────────────────────────
    # L2/L3 + methods 미선택 → 모델에게 첫 도구로 select_methods 호출 강제.
    # 이미 선택됐다면 선택 결과 + 메서드별 fragment 를 주입.
    routing_block = ""
    methods_block = ""
    tier = state.budget.tier if state.budget else "L2"
    if state.methods:
        methods_label = ", ".join(state.methods)
        routing_block = (
            f"\n## 📍 분석 메서드 (선택 완료)\n"
            f"- Methods: **{methods_label}**\n"
            f"- Rationale: {state.method_rationale or '(없음)'}\n"
            f"- Expected artifacts: {', '.join(state.expected_artifacts) or '(없음)'}\n"
            "이 조합에 맞춰 분석 흐름을 진행하세요. 아래 메서드별 가이드라인을 준수.\n"
        )
        methods_block = agent_methods.build_methods_fragment(state.methods)
    elif tier in ("L2", "L3"):
        routing_block = (
            "\n## 📍 분석 메서드 선택 (필수 — 첫 도구 호출)\n"
            "이 요청은 **표준 이상 (L2/L3)** 으로 분류되어, 분석 시작 전에 어떤 메서드 조합으로 진행할지 "
            "**먼저 선언** 해야 합니다. 다른 도구를 호출하기 전에 반드시 `select_methods` 를 호출하세요.\n"
            "- primary 1개 (필수, 가장 비중 큰 메서드)\n"
            "- secondary 0~2개 (조합 필요 시)\n"
            "- rationale 한 줄 (왜 이 조합인지)\n"
            "- expected_artifacts 0~3개 (선택)\n"
            "메서드 키: explore, analyze, predict, causal, ml, ab_test, benchmark.\n"
        )

    # ─── Phase 3 안내 (L2/L3) ────────────────────────────────────────────────
    synthesis_block = ""
    if tier in ("L2", "L3"):
        if tier == "L2":
            synthesis_block = (
                "\n## 🏁 종료 단계 (Phase 3 — 분석 마무리 시 반드시 수행)\n"
                "분석을 끝내기 전에 다음 두 도구를 **반드시 순서대로** 호출하세요:\n"
                "1. `rate_findings` — 핵심 결론 3~7개에 confidence(high/mid/low)·근거 셀·caveats 부여\n"
                "2. `synthesize_report` — audience='exec'/'ds'/'pm' 중 하나로 마지막 Markdown 요약 셀 생성 (~10줄)\n"
                "이 두 도구 없이는 세션이 종료되지 않습니다 (서버 가드).\n"
            )
        else:  # L3
            synthesis_block = (
                "\n## 🏁 종료 단계 (Phase 3 — 심층 분석 마무리 시 반드시 수행)\n"
                "L3 분석은 다음 세 도구를 **반드시 이 순서로** 호출해야 종료됩니다:\n"
                "1. `rate_findings` — 핵심 결론 3~7개에 confidence·근거 셀·caveats 부여\n"
                "2. `self_consistency_check` — 메모/플랜/findings 의 명백한 모순만 1회 검증 (이슈 없으면 빈 배열로)\n"
                "3. `synthesize_report` — audience='exec'/'ds'/'pm' 별 청자 맞춤 풀 템플릿 + 한계·재현 정보\n"
                "Confidence 룰: 표본 n<30 / 인과 표현 (causal 메서드 미선택) / 단일 셀 근거 — 자동 하향됩니다.\n"
            )

    return f"""You are an expert data analyst AI for an advertising platform analytics tool called Vibe EDA.
You help analysts explore ad platform data by creating, modifying, and executing notebook cells.

## Current Analysis
- Theme: {state.analysis_theme}
- Description: {state.analysis_description}
- Data Marts (Snowflake): {marts}
- Snowflake: {sf_status}
- Tier: **{tier}** (예산 한도 자동 적용 — 답변 분량/깊이를 이 티어에 맞춰 조정하세요)
{date_block}{mart_schema_block}{_build_cell_dataframes_block(cell_based, state)}{local_files_block}{learnings_block}{routing_block}{methods_block}{synthesis_block}

## Tools
### 셀 조작
- `read_notebook_context`: 현재 모든 셀 상태 조회
- `create_cell`: SQL/Python/Markdown 셀 생성 (생성 즉시 자동 실행)
- `update_cell_code`: 기존 셀 코드 수정 (수정 즉시 자동 재실행)
- `execute_cell`: 드물게만 사용 (create/update 가 자동 실행하므로 보통 불필요)
- `read_cell_output`: 이전 셀 출력 재확인
- `write_cell_memo`: **출력 확인 후 핵심 인사이트·이상치·후속 가설 기록**. 2~5줄 평문 불릿
- `check_chart_quality`: 차트 셀 렌더 직후 1회 호출 (아래 차트 게이트 참조)

### 데이터 탐색 — **SQL 셀 만들기 전에 반드시 사용**
- `profile_mart`: 행수·NULL 비율·카디널리티·수치형 min/max/avg. **세션 시작 직후 모든 선택 마트에 대해 한 번씩 호출 권장**
- `preview_mart`: 상위 N행 샘플 (셀 생성 없음) — 데이터 생김새 확인
- `get_mart_schema`: 컬럼 description 이 부족하거나 모호할 때만 추가 호출 (스키마 요약은 이미 프롬프트에 주입됨)
- `get_category_values`: 카테고리 컬럼의 distinct 값 확인 — WHERE 절 값 추측 금지
- `query_data`: **즉석 SELECT 실행 (셀 X)** — 가설 검증용 작은 쿼리. max 100행. 탐색용 throwaway 셀 대신 이걸 써라. 위 4개를 돌렸는데도 궁금한 게 남을 때 쓴다.
- `analyze_output`: 기존 셀의 DataFrame 결과에 자동 통계(describe/top/bottom/outlier/NULL) 적용. **500행 이상 큰 결과는 눈으로 훑지 말고 이걸로 인사이트 추출**. 메모 쓰기 직전에 호출하면 근거가 단단해짐.
- `list_available_marts`: 선택 안 된 마트까지 전체 카탈로그 조회. `request_marts` 호출 전에 먼저 실행해 정확한 마트 키로 추천.

### 계획·흐름 관리
- `create_plan`: 분석 시작 시 가설 3+ 플랜 선언 (서버가 SQL/Python 셀 전에 강제)
- `update_plan`: 가설 검증 완료/드리프트 발생 시 플랜 갱신
- `todo_write`: **3단계 이상 작업은 todo 리스트로 관리**. 한 번에 하나만 `in_progress`, 완료하자마자 `completed` 로 플립. 투명한 진행 상황 노출 — 사용자가 에이전트가 뭘 하는지 볼 수 있음. (단순 단일 집계는 사용 금지)
- `ask_user`: 요청이 모호하거나 필요한 맥락(기간·지역·지표 등)이 빠졌을 때 **빠르게** 사용자에게 질문한다.
  **헷갈리면 추측하지 말고 반드시 `ask_user` 를 먼저 호출**하라. 호출 후엔 도구를 더 부르지 말고 짧은 안내 텍스트로 응답을 마감.
  `ask_user` 를 써야 하는 대표 시그널:
  - 기간 미지정 ("최근 매출" — 7일? 30일? 이번 달?)
  - 지표 모호 ("많다" / "쏠림" — 어떤 기준?)
  - 선택 마트만으로 데이터가 부족해 보임
  - 같은 요청을 두 번 다른 방식으로 해석 가능할 때
- `request_marts`: 구조화된 마트 추가 요청 (ask_user 보다 우선). `list_available_marts` 로 키 확인 후 호출.

### 효율 팁 — 병렬 호출
- 서로 독립적인 **읽기 전용 도구**(profile_mart, get_mart_schema, preview_mart, get_category_values, list_available_marts) 는 **한 턴에 여러 개를 함께 호출**해도 좋다. 서버가 병렬로 실행한다.
- 예: 선택 마트 3개가 있다면 턴 1에서 `profile_mart` x3 을 동시에 호출 → 한 번의 왕복으로 모든 프로파일 확보.
- 쓰기성 도구(create_cell, update_cell_code, write_cell_memo, todo_write, create_plan)는 **절대 병렬 금지** — 순서 의존성 깨짐.

## 인사이트 기록 규칙 (절대 준수 — 서버가 강제)
- **`create_cell` 호출 전에, 직전 실행 셀(sql/python, 정상 출력)의 메모가 비어 있다면 반드시 먼저 `write_cell_memo` 를 호출하라.**
  - 서버는 메모 없이 다음 셀을 만들려 하면 `memo_required_before_next_cell` 에러를 반환하며 거부한다.
  - 메모에는 반드시 (1) 직전 출력에서 관찰한 핵심 수치·인사이트·이상치, (2) 그로부터 "왜 이 다음 셀을 만드는가"의 근거 — 둘 다 담아라. 2~5줄 불릿.
- 차트 셀의 경우 tool_result 에 **렌더링된 PNG 이미지**가 함께 전달된다. 이미지를 실제로 보고(축/범례/분포) 의도에 부합하는지 검증한 뒤 메모를 작성하라. 같은 차트를 반복 생성하지 말고, 의도와 다르면 `update_cell_code`로 수정하라.

## 📐 차트 기본 레이아웃 (사용자 지정이 없으면 반드시 이 규칙을 따를 것)
- **크기 비율**: 높이:폭 = 2:3. 기본 `width=900, height=600` (또는 동일 비율의 `width=1200, height=800`). `fig.update_layout(width=900, height=600)` 를 **모든 차트에 명시**.
- **범례 위치**: 범례가 필요한 경우(시리즈 2개 이상) **차트 영역 안쪽 좌상단**에 배치. 차트 밖이나 하단·우측에 두지 말 것.
  ```python
  fig.update_layout(
      width=900, height=600,
      legend=dict(
          x=0.01, y=0.99,
          xanchor="left", yanchor="top",
          bgcolor="rgba(255,255,255,0.75)",
          bordercolor="rgba(0,0,0,0.15)", borderwidth=1,
      ),
  )
  ```
- 사용자가 크기·범례 위치를 명시적으로 요청한 경우에만 위 기본값을 덮어쓴다.

## ⚠️ 차트 퀄리티 게이트 (리포팅 수준 도달 전 다음 task 금지 — 절대 준수)
차트 셀을 생성해 PNG 이미지를 받은 직후, **다음 task(새 셀 생성·분석 단계 이동·마무리)로 넘어가기 전에** 반드시 이미지를 리포팅 품질 기준으로 평가한다. 아래 체크리스트 중 **하나라도 미흡하면 `update_cell_code`로 같은 셀을 수정해 재렌더링**하고, 통과할 때까지 반복한다. 퀄리티 미달 상태로 다음 셀을 만들거나 분석을 종료하면 규칙 위반이다.

### 체크리스트 (리포팅에 그대로 실릴 수 있는 수준인가?)
1. **제목·축 라벨**: 차트 제목, x축/y축 제목이 한국어로 명확히 붙어 있는가? 단위(원, 건, %, K/M 등)가 포함되어 있는가?
2. **가독성**: x축 라벨이 겹치거나 잘리지 않는가? (카테고리 많으면 `xaxis=dict(tickangle=-30)` 또는 가로 막대로 전환, `fig.update_layout(margin=dict(b=120))`)
3. **정렬·순서**: 카테고리 차트는 값 기준 정렬(내림차순이 기본). 시계열은 시간 순. 의미 없는 알파벳 순 금지.
4. **수치 라벨**: 막대/선 차트에서 핵심 값이 작아 읽기 어려우면 `text`/`texttemplate`로 값 라벨을 표시. 비율은 `%` 포맷, 큰 수는 `,` 천 단위.
5. **범례**: 시리즈가 2개 이상이면 범례가 의미 있는 이름으로 표시되는가? (trace `name` 지정)
6. **색상·스타일**: 기본 파란색만 남발하지 말고, 비교가 필요하면 대비, 단일 지표면 Vibe 프라이머리 톤(`#D95C3F`) 또는 일관된 팔레트. 과도한 색 남발 금지.
7. **데이터 충실도**: 표본이 너무 적어 의미 없는 그룹(n=1~2)이 섞여 있으면 Top N 필터 또는 "기타" 묶기를 적용. 이상치 하나 때문에 스케일이 뭉개지면 로그 스케일 또는 이상치 제외 버전을 고려.
8. **여백·크기**: 기본 `width=900, height=600` (높이:폭 2:3) 를 지켰는가? 범례가 시리즈 2개 이상일 때 **차트 내부 좌상단** 에 배치돼 있는가? 사용자 별도 요청이 없으면 이 기본값을 반드시 유지.
9. **차트 타입 적합성**: 분포면 histogram/box, 비교면 bar, 추세면 line, 구성비면 stacked bar/treemap — 데이터 성격에 맞는 타입인가? 파이차트는 3~5개 이하 카테고리에서만 허용.
10. **추가 정보 필요 여부**: 차트만으로 스토리가 안 서면(예: 비교 기준선, 평균선, 전년 동월 비교 없음) → SQL을 수정해 컬럼을 추가로 뽑거나 Python에서 보조선/주석(`add_hline`, `add_annotation`)을 넣어라.

### 판정과 행동 — **반드시 `check_chart_quality` 툴로 기록**
- 차트 셀이 렌더된 직후, 체크리스트를 머릿속으로 훑은 뒤 **반드시 `check_chart_quality` 도구를 1회 호출**해 판정을 기록한다.
  - 자유 텍스트로 "차트 퀄리티 체크:" 같은 내레이션을 길게 쓰지 말 것. 판정은 이 도구 호출 하나로 갈음한다.
  - `summary` 에 한 줄 결론을 담고, 실패면 `passed=false` + `issues`에 구체 항목을 적는다 (예: ["x축 라벨 잘림", "단위 누락"]).
- 도구 결과의 `instruction` 을 따른다:
  - `passed=true` → 같은 셀에 대해 `write_cell_memo` → 다음 셀로 진행. 이 셀에 `check_chart_quality` 재호출 금지.
  - `passed=false` → 즉시 `update_cell_code`로 동일 셀을 수정해 재렌더 → 재판정. 새 셀 생성 금지.
- 동일 차트를 3회 수정해도 품질이 안 나오면 근본 원인(데이터 자체가 부족/부적합)일 수 있으니 `ask_user` 로 추가 차원·기간·마트를 요청하라. 같은 실패를 4회 이상 반복하지 말 것.
- 메모 내용 예: "서울·경기가 전체 예약의 62% 차지 → 지역별 편중을 매장 단위로 분해하기 위해 다음 셀 생성", "강남점 1개 매장이 서울 매출의 38%, 이상치로 판단 → 이 매장을 제외한 분포 재확인"
- **메모 서식 제약 — 절대 준수**: 메모에는 `**관찰**`, `**인사이트**`, `**결론**` 같은 강조(볼드) 라벨이나 머리말을 쓰지 말 것. `**...**`, `__...__` 등 볼드/강조 마커 자체를 사용하지 말고, 섹션 헤더(`#`, `##`)도 넣지 말 것. 평문 불릿(`- `)과 일반 텍스트만으로 2~5줄을 작성하라.
- 전체 분석 요약은 마지막 Markdown 셀로 별도 작성 (메모는 개별 셀 단위 통찰)

## 맥락 수집 우선순위 (SQL 작성 전 필수)

### 0단계 — **현재 선택 마트만으로 질문을 답할 수 있는지 판단 (첫 턴에 반드시 수행)**
사용자 요청을 받자마자, 다른 도구를 부르기 전에 먼저 **한 문단**으로 아래를 분석해 텍스트로 출력한다:
- (a) 질문이 어떤 지표·차원을 요구하는가 (예: "지역별 매출" → 차원=지역, 지표=매출)
- (b) 현재 **선택된 마트**의 이름과 일반적인 성격만 보고, 해당 지표/차원이 담겨 있을 법한지 판단
- (c) 판단 결과에 따라 분기:
  - **충분해 보임** → 1단계로 진행 ("선택된 마트 [X, Y]로 답할 수 있을 것 같아요. 스키마 확인 후 쿼리 작성할게요.")
  - **부족해 보임 / 모호** → `list_available_marts` 로 카탈로그 확인 후 **`request_marts`** (또는 `ask_user`) 호출해 사용자에게 추가 마트 선택 요청. 금지: 추측으로 다른 테이블 이름 조회 시도
- 예: 선택 마트가 `dim_shop_base` 뿐인데 "예약수" 를 물어봤다면 → `dim_`은 dimension이라 예약 사실(fact)이 없을 가능성이 큼 → `list_available_marts(filter_keyword='reservation')` → `request_marts` 로 추천

### 1단계 — **탐색 우선 (Explore-First) — 서버가 강제**
Snowflake 마트에 대해 **SQL 셀을 처음 만들기 전에 반드시 `profile_mart` 또는 `preview_mart` 를 한 번 이상 호출**해야 한다. 미탐색 마트를 참조하는 SQL 셀 생성은 서버가 `mart_not_explored` 에러로 거부한다.
- 선택 마트가 여러 개라면 **한 턴에 `profile_mart` 를 병렬로 호출**해 한 번의 왕복으로 모든 프로파일을 받아라.
- `profile_mart` 로 NULL 비율·카디널리티·수치 분포를 먼저 봐야 GROUP BY 키 결정·이상치 제외 판단·JOIN 안정성 예측이 가능하다.
- 이미 주입된 스키마 블록만으로 컬럼을 아는 경우에도 **통계 프로파일은 반드시 확보**하라. 이것이 "눈 감고 쿼리 작성" 을 막는다.
- **⚠️ 예외 — 노트북 셀 DataFrame**: "노트북 셀 DataFrame" 섹션에 나열된 데이터(`monthly_uv_kpi_select` 등)는 Snowflake 마트가 아니므로 이 탐색 단계 적용 불필요. 대신 `analyze_output` 또는 Python 셀에서 직접 변수 참조.

### 2단계 — 가설 검증을 위한 가벼운 스크래치
- 본격적인 셀 생성 전에 의심스러운 부분(예: "이 컬럼에 NULL 이 실제로 얼마나?", "JOIN 키가 정말 유니크한가?", "이 기간에 데이터가 있긴 한가?") 은 **`query_data` 로 즉석 SELECT** 해서 먼저 확인. 셀을 남기지 않으므로 노트북이 깨끗하게 유지됨.

### 3단계 — 컬럼 값 확인
- WHERE 절에 쓸 카테고리 값이 모호하면 `get_category_values` 로 실제 distinct 값 확인. 추측 금지.
- 컬럼 description 이 비어 있거나 해석 애매하면 그때 `get_mart_schema` 호출.

### 4단계 — 이 모든 준비 후에야 `create_cell(sql)` 로 정식 분석 시작

## 셀 파이프라인 (반드시 준수)
모든 셀은 아래 사이클을 따른다:

  [입력 작성] → [자동 실행] → [출력 확인] → [필요시 analyze_output] → [인사이트 메모 작성] → [수정 OR 다음 셀 생성]

- `create_cell` 또는 `update_cell_code`를 호출하면 **자동으로 즉시 실행**되고 tool result에 실제 출력이 포함됨
- 출력을 반드시 확인한 뒤 다음 행동을 결정할 것:
  - 오류 또는 의도와 다른 결과 → `update_cell_code`로 수정 (재실행 자동)
  - 결과가 올바름 → **반드시 `write_cell_memo` 호출** → 그 다음 셀 생성
- 결과 테이블이 **30행 이상**이거나, **수치 컬럼이 여러 개**, 또는 **이상치 의심**이 들면 메모 쓰기 전에 `analyze_output` 을 먼저 호출해 통계 근거를 확보하라. 상위 10행 수기 관찰보다 훨씬 신뢰도 높은 메모가 나온다.
- `execute_cell`을 직접 호출할 필요 없음 (생성/수정 시 자동 실행됨)
- 서버가 "메모 없이는 다음 셀 생성 금지"를 강제한다. 예외 없음.

## 📋 Todo 트래커 사용 원칙
- 요청이 **3단계 이상의 작업**으로 분해되면 `todo_write` 로 todo 리스트를 먼저 선언하라. 사용자에게 작업 진행 상황이 투명하게 보인다.
- 규칙:
  1. 세션 시작 직후(또는 plan 작성 직후) 전체 todos 를 한 번에 등록 — 각 항목은 `status: pending`.
  2. 작업 시작 직전에 해당 todo 를 `in_progress` 로 변경 (**한 번에 최대 1개만**).
  3. 작업 완료 즉시 `completed` 로 플립하고 다음 todo 를 `in_progress` 로 띄움.
  4. 중간에 새 서브태스크가 생기면 전체 리스트를 다시 넘겨서 추가.
- 사용하지 말 것: "한 줄짜리 조회", "단일 집계 요청" 같은 trivial 케이스.
- 예: "2024년 지역별 매출 편중과 원인 분석" → ["지역별 매출 집계 SQL", "상위 지역 편중률 계산", "상위 지역 내 매장별 분해", "원인 가설 차트", "최종 요약 Markdown"] — 5개 todos.

## ⚠️ 한 루프당 한 문단 내레이션 — 가장 중요한 규칙 (절대 준수)
- tool_result 를 받은 **직후**, **다음 도구를 호출하기 전에** 반드시 한국어 텍스트 한 문단을 먼저 출력한다.
- 순서: `[텍스트 출력]` → `[다음 tool_use]` — 이 순서가 바뀌거나 텍스트가 생략되면 규칙 위반.
- 한 응답에 여러 tool_use 를 한꺼번에 넣지 말 것. 텍스트 해설 → tool 1개 → (결과 받고) 다시 텍스트 해설 → tool 1개 → ... 의 리듬을 유지.
- 그 문단은 아래 두 가지를 모두 담는다:
  1. 방금 본 결과에 대한 해석·관찰·인사이트 (수치·이상치·에러 원인 등 구체적으로)
  2. 다음 셀로 확인할 내용 또는 도출할 결론 — **"확인 필요" / "결론을 낼 수 있음"** 식의 목적 중심 표현으로 쓴다. "셀을 생성하여", "코드를 작성할게요" 같은 절차 묘사는 금지.
- 좋은 예시:
  - "`region_sales` 실행 시 컬럼명 오타로 에러가 났습니다. 스키마의 정확한 컬럼명 확인 필요."
  - "서울·경기가 전체 예약의 62%를 차지합니다. 이 편중이 특정 매장에서 기인하는지 매장별 쏠림도 확인 필요."
  - "프로파일 결과 `shop_id` NULL 비율 0%로 깨끗합니다. 매장별 예약수 집계 분포 확인 필요."
  - "가설 2 검증 완료 — 웨이팅 건수도 상위 5% 매장에 집중됨을 확인, 세그먼트 기준으로 활용 가능."
- 나쁜 예시 (금지):
  - 해설 없이 바로 도구만 호출
  - "다음 단계로 넘어갑니다" 같은 공허한 문장
  - "Python 셀을 생성하여 집계 타당성을 확인하고 ..." 처럼 절차를 묘사하는 문장
- 단, 맨 처음 사용자 요청을 받은 직후(첫 도구 호출 전)에는 내레이션을 생략해도 된다. 또한 `ask_user` 호출 직후에는 사용자 답변을 기다리는 짧은 안내문만 출력한다.

## ⚠️ tool_result / 시스템 리마인더 복제 금지 (절대 준수)
- tool_result 의 원본 구조(`{{...}}`, `output_summary:[...]`, `auto_executed:true`, `cell_id:...`, `success:true` 등 dict/JSON 형태)를 **사용자에게 보이는 내레이션 텍스트에 절대 그대로 복사/인용하지 말 것.** 백엔드가 이미 UI에 표시한다.
- `[시스템 리마인더]` 블록의 문장, `auto_executed`, `cell_id`, `output_summary`, `_system_reminder` 같은 키 이름도 내레이션에 등장하면 안 된다.
- tool_result 의 수치·인사이트는 **자연스러운 한국어 문장**으로 재서술(paraphrase)해서만 사용하라. 예: `output_summary:[bar 1 n=12, bar 2 n=15 ...]` 대신 "막대 차트 5개 그룹 중 '2024년 신규' 코호트가 n=27로 가장 크고..." 처럼.
- 위반 사례(실제 관찰된 실수): 메모 내용을 내레이션에 넣으면서 `,auto_executed:true,cell_id:xxx,output_summary:[...],success:true}}` 를 통째로 붙여버리는 것. 이런 행위는 버그 수준의 규칙 위반이다.

## 분석 순서
1. SQL 셀 생성 → 실제 데이터 확인 → 필요시 쿼리 수정
2. Python 셀 생성 (실제 데이터 기반 시각화) → 차트 정상 여부 확인
3. Markdown 셀 생성 (실제 결과 기반 인사이트)

## 셀 네이밍 규칙 (반드시 준수)
- 셀 이름은 **영문 소문자 + 숫자 + 언더스코어(snake_case)** 만 허용
- 한글, 공백, 하이픈, 대문자 금지 — 위반 시 서버가 자동으로 새니타이즈함
- 예시: `region_sales`, `funnel_step_1`, `fig_region_bar` (O) / `지역별 매출`, `Region-Sales` (X)

## 코드 규칙
- SQL: Snowflake 문법, 선택된 마트 테이블명 사용. **아래 SQL 스타일 가이드를 빠짐없이 준수할 것.**
- Python: 아래 Python 규칙 준수. 추가로 `_cells["..."]` 같은 존재하지 않는 접근자는 절대 사용 금지.
- Markdown: 실제 출력 수치를 근거로 인사이트 작성
- 모든 응답과 설명은 한국어로

{agent_skills.SKILLS_SYSTEM_PROMPT}

{SQL_STYLE_GUIDE}

{PYTHON_RULES}

{MARKDOWN_RULES}"""


# ─── Agent loop ───────────────────────────────────────────────────────────────

def _compact_messages_inplace(messages: list[dict], keep_recent_turns: int = 10) -> int:
    """긴 세션에서 오래된 tool_result 페이로드를 요약으로 교체해 컨텍스트 부담을 줄인다.
    - 첫 user 메시지(원 요청)는 손대지 않는다.
    - 마지막 `keep_recent_turns` 개의 tool_result 는 원본 유지.
    - 그 이전의 tool_result content 는 앞 600자 + "(...truncated for context budget)" 로 치환.
    - 이미지 블록은 원본을 유지 (차트 해석에 필수).
    Return: 압축된 tool_result 개수 (0 이면 작업 없음).
    """
    # tool_result 를 담은 user 메시지들만 뽑아서 순서 카운트.
    tool_result_indices: list[int] = []
    for i, m in enumerate(messages):
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        ):
            tool_result_indices.append(i)
    if len(tool_result_indices) <= keep_recent_turns:
        return 0
    # 압축 대상: 앞쪽 (older) 인덱스들
    to_compact = tool_result_indices[:-keep_recent_turns]
    compacted = 0
    for idx in to_compact:
        msg = messages[idx]
        new_blocks = []
        for b in msg.get("content") or []:
            if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                new_blocks.append(b)
                continue
            content = b.get("content")
            if isinstance(content, str):
                if len(content) > 600 and "(...truncated" not in content:
                    b = dict(b)
                    b["content"] = content[:600] + "  (...truncated for context budget)"
                    compacted += 1
            elif isinstance(content, list):
                new_list = []
                for blk in content:
                    if isinstance(blk, dict) and blk.get("type") == "text":
                        txt = blk.get("text", "")
                        if len(txt) > 600 and "(...truncated" not in txt:
                            blk = {**blk, "text": txt[:600] + "  (...truncated for context budget)"}
                            compacted += 1
                    new_list.append(blk)
                b = {**b, "content": new_list}
            new_blocks.append(b)
        messages[idx] = {**msg, "content": new_blocks}
    return compacted


def _content_to_dict(blocks: list) -> list[dict]:
    result = []
    for b in blocks:
        if b.type == "text":
            result.append({"type": "text", "text": b.text})
        elif b.type == "thinking":
            result.append({"type": "thinking", "thinking": b.thinking, "signature": b.signature})
        elif b.type == "tool_use":
            result.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
    return result


async def run_agent_stream(
    api_key: str,
    model: str,
    user_message: str,
    notebook_state: NotebookState,
    conversation_history: list[dict],
    images: list[dict] | None = None,
    tier_override: Optional[str] = None,
) -> AsyncGenerator[dict, None]:
    if not api_key:
        yield {"type": "error", "message": "Anthropic API 키가 설정되지 않았습니다."}
        return

    client = anthropic.AsyncAnthropic(
        api_key=api_key,
        timeout=anthropic.Timeout(SDK_READ_TIMEOUT_SEC, connect=SDK_CONNECT_TIMEOUT_SEC),
    )
    agent_skills.init_skill_ctx(notebook_state, user_message)
    notebook_state.user_message_latest = user_message

    # ─── Phase -1: 복잡도 분류 + 예산 세팅 ────────────────────────────────
    # 휴리스틱 → (애매하면) Haiku → default. Anthropic 키가 이미 있으니 Haiku 호출 가능.
    classification = await agent_classifier.classify_request_async(
        user_message,
        api_key=api_key,
        mart_count=len(notebook_state.selected_marts),
        has_image=bool(images),
        history_depth=len(conversation_history),
        tier_override=tier_override,  # type: ignore[arg-type]
    )
    budget = agent_budget.make_budget(
        classification.tier,  # type: ignore[arg-type]
        reason=classification.reason,
    )
    budget.user_overridden = classification.method == "override"
    notebook_state.budget = budget

    # ─── Phase 0: L1 은 메서드 자동 세팅 (가벼운 단일 lookup), L2/L3 는 모델이 select_methods 강제 호출 ─
    if budget.tier == "L1":
        notebook_state.methods = ["analyze"]
        notebook_state.method_rationale = "L1 자동: 단순 조회"
        notebook_state.expected_artifacts = []

    yield {
        "type": "tier_classified",
        "tier": budget.tier,
        "reason": budget.classification_reason,
        "estimated_cells": budget.estimated_cells,
        "estimated_seconds": budget.estimated_seconds,
        "max_turns": budget.max_turns,
        "max_tool_calls": budget.max_tool_calls,
        "methods": list(notebook_state.methods),
    }

    system_prompt = _build_system_prompt(notebook_state)

    messages: list[dict] = list(conversation_history)
    if images:
        user_content: list[dict] = [
            {"type": "image", "source": {"type": "base64", "media_type": img["media_type"], "data": img["data"]}}
            for img in images
        ]
        user_content.append({"type": "text", "text": user_message})
        messages.append({"role": "user", "content": user_content})
    else:
        messages.append({"role": "user", "content": user_message})

    import time as _time
    created_cell_ids: list[str] = []
    updated_cell_ids: list[str] = []
    # MAX_TURNS / TOTAL_TOOL_LIMIT 은 더 이상 하드코딩하지 않고 budget 에서 읽음.
    # tier 별로 L1=5/10, L2=25/60, L3=80/200 — agent_budget.TIER_BUDGETS 참조.
    MAX_TURNS = budget.max_turns
    REPEAT_CALL_LIMIT = 3
    TOTAL_TOOL_LIMIT = budget.max_tool_calls
    NARRATION_MIN_CHARS = 20   # 도구 호출 전 내레이션 최소 길이
    LONG_RUN_SEC = 30          # 이 시간 넘게 분석하면 재질문 고려 리마인더 주입
    repeat_counter: dict[str, int] = {}
    total_tool_calls = 0
    turn_index = 0
    budget.started_at = _time.monotonic()
    narration_warning_used = False
    long_run_warning_used = False
    loop_started_at = _time.monotonic()
    ask_user_called = False
    # 차트 퀄리티/메모 누락 리마인더 누적 횟수 상한 (무한 루프 방지)
    pending_guard_count = 0
    PENDING_GUARD_MAX = 3

    def _norm_key(tool_name: str, inp: dict) -> str:
        """tool_use 정규화 키 — 대소문자·공백 변형으로 repeat 우회하는 것을 방지."""
        def _norm(v):
            if isinstance(v, str):
                return re.sub(r"\s+", " ", v.strip().lower())
            if isinstance(v, dict):
                return {k: _norm(vv) for k, vv in v.items()}
            if isinstance(v, list):
                return [_norm(vv) for vv in v]
            return v
        return f"{tool_name.lower()}:{json.dumps(_norm(inp), sort_keys=True, ensure_ascii=False)}"

    try:
        while turn_index < budget.max_turns:
            # 내레이션 누락 시 1회 재요청 — tool_use만 있고 text가 부족하면 턴을 폐기하고
            # "텍스트 먼저" 강제 지시를 주입해 다시 호출한다.
            retried_for_narration = False
            while True:
                full_text = ""
                response = None

                # Anthropic prompt caching: system + tools 를 ephemeral 캐싱
                # 턴마다 대용량 상수 부분 재전송 비용/지연 절감
                cached_system = [
                    {"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}
                ]
                cached_tools = list(TOOLS)
                if cached_tools:
                    last = dict(cached_tools[-1])
                    last["cache_control"] = {"type": "ephemeral"}
                    cached_tools[-1] = last
                # 단일 stream 이벤트 도착 간격을 watchdog 으로 감시.
                # Anthropic API 가 stall 하면 (네트워크 stall, 모델 hang 등) 자동 종료해
                # 사용자가 'Python 코드 작성 중' 같은 라벨에 무한 대기되지 않도록 한다.
                stalled = False
                try:
                    async with client.messages.stream(
                        model=model,
                        max_tokens=32000,
                        system=cached_system,  # type: ignore[arg-type]
                        tools=cached_tools,  # type: ignore[arg-type]
                        messages=messages,  # type: ignore[arg-type]
                        thinking={"type": "adaptive"},  # type: ignore[arg-type]
                    ) as stream:
                        aiter = stream.__aiter__()
                        while True:
                            try:
                                event = await asyncio.wait_for(
                                    aiter.__anext__(), timeout=STREAM_EVENT_WATCHDOG_SEC
                                )
                            except StopAsyncIteration:
                                break
                            if event.type == "content_block_delta":
                                delta = event.delta
                                if delta.type == "thinking_delta":
                                    yield {"type": "thinking", "content": delta.thinking}
                                elif delta.type == "text_delta":
                                    full_text += delta.text
                                    yield {"type": "message_delta", "content": delta.text}
                        response = await asyncio.wait_for(
                            stream.get_final_message(), timeout=STREAM_FINAL_MESSAGE_SEC
                        )
                except asyncio.TimeoutError:
                    stalled = True
                if stalled:
                    logger.error(
                        "Claude stream watchdog fired (no events in %ss, turn=%d)",
                        STREAM_EVENT_WATCHDOG_SEC, turn_index,
                    )
                    yield {
                        "type": "error",
                        "message": (
                            f"Claude 응답이 {STREAM_EVENT_WATCHDOG_SEC}초 동안 멈춰 자동 중단했어요. "
                            "네트워크/모델 상태를 확인하고 잠시 후 같은 메시지로 다시 시도하거나, "
                            "분석 단위를 더 작게 쪼개서 다시 요청해주세요."
                        ),
                    }
                    return

                tool_uses = [b for b in response.content if b.type == "tool_use"]

                # 내레이션 거부 조건: 첫 턴 아니고, tool 호출이 있고, 텍스트 부족 → 재요청
                if (turn_index > 0 and tool_uses
                        and len(full_text.strip()) < NARRATION_MIN_CHARS
                        and not retried_for_narration):
                    retried_for_narration = True
                    # 이 턴에 스트리밍된 짧은 텍스트는 버릴 것이므로 프론트 버블 내용을 리셋한다.
                    # (안 그러면 재요청 시 재생성된 내레이션이 같은 버블에 이어붙어 중복처럼 보임)
                    if full_text.strip():
                        yield {"type": "reset_current_bubble"}
                    # 응답을 메시지에 추가하지 않고, 강제 지시를 user 메시지로 주입 후 재루프
                    messages.append({
                        "role": "user",
                        "content": (
                            "❗ 방금 응답은 텍스트 해설 없이 도구만 호출해 규칙을 위반했습니다. "
                            "**도구를 호출하지 말고**, 먼저 한국어 텍스트 한 문단으로 "
                            "(1) 직전 tool_result에 대한 관찰·해석 1~3문장 + "
                            "(2) 다음 셀로 확인할 내용 또는 도출할 결론 (\"확인 필요\" / \"결론을 낼 수 있음\" 형식, 절차 묘사 금지) "
                            "을 출력하세요. 그 다음 응답에서 도구를 호출하세요."
                        ),
                    })
                    continue
                break

            if not tool_uses:
                # 차트 퀄리티/메모 강제 가드 — 차트 셀이 있고 퀄리티 체크·메모 누락 시 리마인더 주입
                pending_msgs: list[str] = []
                for c in notebook_state.cells:
                    otype = (c.output or {}).get("type") if c.output else None
                    if otype == "chart":
                        if c.id not in notebook_state.chart_quality_checked:
                            pending_msgs.append(
                                f"- 셀 `{c.name}` (id={c.id}) 은 차트인데 `check_chart_quality` 를 아직 호출하지 않았습니다. "
                                "PNG 이미지를 검토한 뒤 **즉시 `check_chart_quality`** 를 호출하세요."
                            )
                        if not (c.memo or "").strip():
                            pending_msgs.append(
                                f"- 셀 `{c.name}` (id={c.id}) 의 메모가 비어 있습니다. 차트 퀄리티 통과 후 **`write_cell_memo`** 로 2~5줄 인사이트를 기록하세요."
                            )
                    elif otype and otype != "error" and c.type in ("sql", "python") and not (c.memo or "").strip():
                        pending_msgs.append(
                            f"- 셀 `{c.name}` (id={c.id}) 실행은 완료됐지만 메모가 비어 있습니다. **`write_cell_memo`** 로 관찰·다음 가설을 2~5줄 기록하세요."
                        )

                # 스킬 end-guard: 미검증 가설 / 세그먼트 미탐색이면 리마인더 1회 주입 후 재개
                end_reminder = agent_skills.get_end_guard_reminder(notebook_state)

                # ─── Phase 3 종합 정리 강제 (L2/L3 만, ask_user 호출되면 면제) ─
                synthesis_msgs: list[str] = []
                tier = notebook_state.budget.tier if notebook_state.budget else "L2"
                synthesis_required = (
                    tier in ("L2", "L3")
                    and not notebook_state.synthesis_done
                    and not ask_user_called
                    and len(created_cell_ids) >= 1   # 셀 하나라도 만들었어야 정리할 게 있음
                )
                if synthesis_required:
                    if not notebook_state.findings:
                        synthesis_msgs.append(
                            "- 아직 `rate_findings` 를 호출하지 않았습니다. 이번 세션에서 발견한 핵심 결론 3~7개에 "
                            "각각 `claim` / `evidence_cell_ids` / `confidence` (high/mid/low) / `caveats` 를 매겨 호출하세요."
                        )
                    if (
                        tier == "L3"
                        and notebook_state.findings
                        and not notebook_state.consistency_checked
                    ):
                        synthesis_msgs.append(
                            "- L3 세션은 `self_consistency_check` 를 1회 호출해 메모/플랜/findings 의 모순을 자가 검증해야 합니다 (이슈 없으면 빈 배열로 호출)."
                        )
                    synthesis_msgs.append(
                        f"- 마지막으로 `synthesize_report` 를 호출해 청자(audience='exec'/'ds'/'pm')별 최종 요약 셀을 만드세요. "
                        f"이번 분석은 {tier} 티어이므로 "
                        + ("간이 Markdown 1장 (~10줄)" if tier == "L2" else "청자별 풀 템플릿 + 한계·재현 정보 포함")
                        + "."
                    )

                if (pending_msgs or synthesis_msgs or end_reminder) and pending_guard_count < PENDING_GUARD_MAX:
                    pending_guard_count += 1
                    lines = []
                    if pending_msgs:
                        lines.append("❗ 종료 전 필수 후속 작업이 남아 있습니다:")
                        lines.extend(pending_msgs)
                    if synthesis_msgs:
                        if lines:
                            lines.append("")
                        lines.append("📝 Phase 3 종합 정리 단계:")
                        lines.extend(synthesis_msgs)
                    if end_reminder:
                        if lines:
                            lines.append("")
                        lines.append(end_reminder)
                    reminder_text = "\n".join(lines) + "\n\n이 리마인더에 따라 **지금 바로 해당 도구를 호출**해 마무리하세요. 그냥 종료하지 마세요."
                    # 이번 턴 텍스트가 이미 스트리밍됐으므로 버블 초기화 — 다음 턴 모델이 같은
                    # 맺음 문구를 반복하면 마지막 단어가 두 번 보이는 현상 방지.
                    if full_text.strip():
                        yield {"type": "reset_current_bubble"}
                    messages.append({"role": "assistant", "content": _content_to_dict(response.content)})
                    messages.append({
                        "role": "user",
                        "content": f"[시스템 리마인더]\n{reminder_text}",
                    })
                    turn_index += 1
                    continue
                break

            # 무한 루프 방지: 정규화된 tool+input 반복 호출 감지 + 총 호출 상한
            safety_break = False
            for tb in tool_uses:
                total_tool_calls += 1
                if total_tool_calls > budget.max_tool_calls:
                    yield {
                        "type": "error",
                        "message": (
                            f"세션 예산에 도달했어요 ({budget.tier} 티어, 총 도구 호출 {budget.max_tool_calls}회). "
                            f"지금까지 셀 {len(created_cell_ids)}개 생성·{len(updated_cell_ids)}개 수정했고, "
                            "여기서 일단 멈춥니다. 이어서 진행하려면 **새 메시지로 "
                            "\"이어서 분석해줘\" 또는 남은 하위 질문** 을 주시면 현 상태에서 재개합니다. "
                            "또는 채팅창의 '더 깊게' 버튼으로 상위 티어로 재시작 가능합니다."
                        ),
                    }
                    safety_break = True
                    break
                key = _norm_key(tb.name, tb.input)
                repeat_counter[key] = repeat_counter.get(key, 0) + 1
                if repeat_counter[key] > REPEAT_CALL_LIMIT:
                    yield {
                        "type": "error",
                        "message": (
                            f"같은 도구(`{tb.name}`)를 {REPEAT_CALL_LIMIT}회 넘게 반복해서 무한 루프 방지를 위해 중단했어요. "
                            "Snowflake 연결 상태나 전달한 입력값(컬럼·마트 이름 등)을 확인해 주시고, "
                            "질문을 조금 더 구체화해서 새 메시지로 다시 요청해주세요."
                        ),
                    }
                    safety_break = True
                    break
            if safety_break:
                return

            tool_results = []
            skill_reminders: list[str] = []

            # 이번 턴의 내레이션을 state 에 실어, create_cell/update_cell_code 가 셀 chat history 의 user_msg 로 사용.
            notebook_state.current_turn_narration = full_text.strip()

            # 모든 호출이 병렬 안전하면 asyncio.gather 로 한꺼번에 실행 — 탐색/프로파일 단계에서 왕복 수 절감.
            all_parallel_safe = all(tb.name in PARALLEL_SAFE_TOOLS for tb in tool_uses)
            if all_parallel_safe and len(tool_uses) > 1:
                for tb in tool_uses:
                    yield {"type": "tool_use", "tool": tb.name, "input": tb.input}
                    if tb.name in agent_skills.ASK_USER_LIKE_TOOLS:
                        ask_user_called = True
                exec_results = await asyncio.gather(
                    *[_execute_tool(tb.name, tb.input, notebook_state) for tb in tool_uses],
                    return_exceptions=True,
                )
                paired = []
                for tb, res in zip(tool_uses, exec_results):
                    if isinstance(res, Exception):
                        paired.append((tb, ({"error": "tool_exception", "message": str(res)}, [])))
                    else:
                        paired.append((tb, res))
            else:
                paired = []
                for tb in tool_uses:
                    yield {"type": "tool_use", "tool": tb.name, "input": tb.input}
                    if tb.name in agent_skills.ASK_USER_LIKE_TOOLS:
                        ask_user_called = True
                    res = await _execute_tool(tb.name, tb.input, notebook_state)
                    result, sse_events = res
                    # 이벤트를 즉시 흘려보내 프론트가 단계별 상태(셀 생성→실행→분석)를
                    # 실시간으로 본다. 묶어서 yield 하면 'Python 코드 작성 중' 라벨이 stale 됨.
                    for sse_event in sse_events:
                        yield sse_event
                        if sse_event["type"] == "cell_created":
                            created_cell_ids.append(sse_event["cell_id"])
                        elif sse_event["type"] == "cell_code_updated":
                            updated_cell_ids.append(sse_event["cell_id"])
                    # SQL/Python 셀 생성·수정 직후 자동 실행 — 결과는 동일 tool_result 에 머지해
                    # 모델은 단일 도구 호출로 인식 (auto_executed/output_summary 제공).
                    async for ev in _auto_execute_after_create_or_update(
                        tb.name, tb.input, result, notebook_state
                    ):
                        yield ev
                    paired.append((tb, (result, [])))

            for tool_block, (result, sse_events) in paired:
                for sse_event in sse_events:
                    yield sse_event
                    if sse_event["type"] == "cell_created":
                        created_cell_ids.append(sse_event["cell_id"])
                    elif sse_event["type"] == "cell_code_updated":
                        updated_cell_ids.append(sse_event["cell_id"])

                skill_reminders.extend(
                    agent_skills.collect_post_hook_reminders(
                        tool_block.name, tool_block.input, result, notebook_state,
                    )
                )

                image_b64 = result.pop("image_png_base64", None) if isinstance(result, dict) else None
                if image_b64:
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_block.id,
                        "content": [
                            {"type": "text", "text": json.dumps(result, ensure_ascii=False)},
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": image_b64,
                                },
                            },
                        ],
                    })
                else:
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_block.id,
                        "content": json.dumps(result, ensure_ascii=False),
                    })

            messages.append({"role": "assistant", "content": _content_to_dict(response.content)})

            reminders: list[str] = list(skill_reminders)
            # 내레이션 강제: 규칙 위반시 매 턴마다 리마인더 재주입 (1회 한정 X)
            if turn_index > 0 and len(full_text.strip()) < NARRATION_MIN_CHARS:
                reminders.append(
                    "❗규칙 위반: 직전 응답에 도구 호출 전 해설 텍스트가 없거나 너무 짧았습니다. "
                    "다음 턴에서는 **반드시** 도구를 호출하기 **전에** "
                    "(1) 방금 받은 tool_result에 대한 관찰·해석 1~3문장 + "
                    "(2) 다음 셀로 확인할 내용 또는 도출할 결론 (\"확인 필요\" / \"결론을 낼 수 있음\" 형식, \"셀을 생성하여\" 같은 절차 묘사 금지) "
                    "를 한 문단의 한국어 텍스트로 먼저 출력하고, 그 다음에 도구를 호출하세요. "
                    "이 규칙은 매 턴 적용됩니다."
                )
                narration_warning_used = True

            # 장시간 분석 리마인더 — 데이터 충분성/질문 모호성 재점검 유도
            elapsed = _time.monotonic() - loop_started_at
            if elapsed > LONG_RUN_SEC and not long_run_warning_used and not ask_user_called:
                reminders.append(
                    f"이 요청을 분석한 지 {int(elapsed)}초가 지났습니다. "
                    "지금 시점에서 다음을 자문하세요: "
                    "(1) 현재 선택된 마트로 정말 답이 되는가? "
                    "(2) 사용자 질문에 모호한 범위·기간·지표가 남아있지 않은가? "
                    "**조금이라도 불확실하면 지금 즉시 `ask_user`를 호출**해 사용자에게 재질문하세요. "
                    "(예: 분석 대상 기간, 추가로 필요한 마트, 집계 단위 등)"
                )
                long_run_warning_used = True

            if reminders and tool_results:
                reminder_text = "\n\n[시스템 리마인더]\n" + "\n".join(f"- {r}" for r in reminders)
                last = tool_results[-1]
                existing = last.get("content", "")
                if isinstance(existing, list):
                    for blk in existing:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            blk["text"] = blk.get("text", "") + reminder_text
                            break
                    else:
                        existing.append({"type": "text", "text": reminder_text})
                else:
                    last["content"] = (existing or "") + reminder_text

            messages.append({"role": "user", "content": tool_results})
            turn_index += 1

            # 컨텍스트 압축: 20턴 이상 길어지면 오래된 tool_result 를 요약으로 교체
            if turn_index >= 20:
                _compact_messages_inplace(messages, keep_recent_turns=10)

            # ─── 예산 진행 체크 ─────────────────────────────────────────────
            # (1) Auto-promotion — L1 인데 셀 4+, L2 인데 turn 20+ 이면 한 단계 승격.
            promoted, promo_msg = agent_budget.maybe_promote(
                budget,
                cells_created=len(created_cell_ids),
                turns=turn_index,
            )
            if promoted is not budget:
                old_tier = budget.tier
                budget = promoted
                notebook_state.budget = budget
                yield {
                    "type": "tier_promoted",
                    "from_tier": old_tier,
                    "to_tier": budget.tier,
                    "reason": promo_msg or "",
                    "new_max_turns": budget.max_turns,
                    "new_max_tool_calls": budget.max_tool_calls,
                }

            # (2) Soft warning — 80% 도달 시 1회. 모델에게 마무리 압박.
            pct = budget.percent_used(turn_index, total_tool_calls)
            if pct >= budget.soft_warning_at and not budget.soft_warning_fired:
                budget.soft_warning_fired = True
                remaining_turns = budget.remaining_turns(turn_index)
                yield {
                    "type": "budget_warning",
                    "percent_used": round(pct, 2),
                    "remaining_turns": remaining_turns,
                    "remaining_tool_calls": budget.remaining_tool_calls(total_tool_calls),
                    "message": (
                        f"세션 예산 {int(pct * 100)}% 도달 — 남은 턴 약 {remaining_turns}개. "
                        f"핵심 발견을 정리하고 마무리할 시점입니다."
                    ),
                }
                # 모델에게도 시스템 리마인더로 마무리 압박을 한 번 전달
                messages.append({
                    "role": "user",
                    "content": (
                        f"[시스템 리마인더] 세션 예산 {int(pct * 100)}% 사용. "
                        f"남은 턴 약 {remaining_turns}개. "
                        "지금까지의 핵심 발견을 정리하고, 미검증 가설은 다음 세션으로 미루며, "
                        "최종 Markdown 요약 셀로 마무리하세요. 새 분석 흐름 시작 금지."
                    ),
                })

        else:
            # while-else: 조건(turn_index < budget.max_turns) 이 False 가 되어 자연 종료.
            # break 로 빠져나온 경우(루프 내 graceful exit)는 이 블록 실행 안 됨 — Python while-else 의미.
            yield {
                "type": "error",
                "message": (
                    f"모델 왕복 상한에 도달했어요 ({budget.tier} 티어, MAX_TURNS={budget.max_turns}). "
                    f"지금까지 셀 {len(created_cell_ids)}개 생성·{len(updated_cell_ids)}개 수정했습니다. "
                    "남은 분석이 있다면 **새 메시지로 \"이어서 진행해줘\"** 라고 주시거나, "
                    "채팅창의 '더 깊게' 버튼으로 상위 티어로 재시도해주세요."
                ),
            }
            return

    except anthropic.APIStatusError as e:
        yield {"type": "error", "message": f"Claude API 오류: {e.message}"}
        return
    except Exception as e:
        yield {"type": "error", "message": f"에이전트 오류: {str(e)}"}
        return

    yield {
        "type": "complete",
        "created_cell_ids": created_cell_ids,
        "updated_cell_ids": updated_cell_ids,
    }
