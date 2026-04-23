"""Agent Skills — Claude/Gemini 파이프라인 공용 분석가 마인드셋 모듈.

각 스킬은 다음 중 하나 이상을 제공한다:
  1) system prompt fragment (에이전트에게 규칙 주입)
  2) 신규 tool 정의 (Claude JSONSchema + Gemini FunctionDeclaration)
  3) pre-guard: 특정 tool 호출 직전 거부 (서버 강제 규칙)
  4) post-hook: tool 실행 후 리마인더 텍스트 수집
  5) end-guard: 루프 종료 직전 "아직 더 해야 할 일" 재확인

운용 상태는 `NotebookState.skill_ctx` (dict) 에 고정 키로 기록한다:
  plan_cell_id, initial_user_message, error_count_by_cell, sanity_hinted_cells,
  memo_count, end_guard_fired, end_guard_reason

Tier 1  : planning, plan_revision, hypothesis_exhaustion, data_request, output_critic,
          sanity_check, error_recovery
Tier 2  : baseline_comparison, segmentation_exploration
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .claude_agent import NotebookState, CellState


PLAN_MARKER = "<!-- vibe:analysis_plan -->"
PLAN_CELL_NAME = "analysis_plan"

_TRIVIAL_METRIC_WORDS = (
    "count", "sum", "avg", "총합", "총", "개수", "평균", "행수", "rowcount"
)


# ─── Skill runtime state helpers ─────────────────────────────────────────────

def init_skill_ctx(state: "NotebookState", initial_user_message: str) -> None:
    """런 시작 시 1회 호출. 기존 노트북에 이미 플랜 셀이 있으면 그 id를 추적."""
    ctx = state.skill_ctx
    ctx.setdefault("initial_user_message", initial_user_message or "")
    ctx.setdefault("error_count_by_cell", {})
    ctx.setdefault("sanity_hinted_cells", set())
    ctx.setdefault("memo_count", 0)
    ctx.setdefault("end_guard_fired", False)
    if "plan_cell_id" not in ctx:
        ctx["plan_cell_id"] = _detect_existing_plan_cell(state)


def _detect_existing_plan_cell(state: "NotebookState") -> Optional[str]:
    for c in state.cells:
        if c.type == "markdown" and (
            c.name == PLAN_CELL_NAME or PLAN_MARKER in (c.code or "")
        ):
            return c.id
    return None


_DEEP_ANALYSIS_HINTS = (
    "분석", "비교", "원인", "왜", "탐색", "패턴", "변화", "추이", "세그먼트",
    "분포", "요인", "구조", "영향", "why", "explore", "compare",
)


def _is_trivial_request(user_message: str) -> bool:
    """짧고 단일 집계성인 질문은 플랜 강제 스킵. 애매하면 플랜 쪽으로 기운다."""
    m = (user_message or "").strip()
    if not m:
        return True
    low = m.lower()
    # 깊이 분석 힌트가 있으면 길이 무관 비-trivial
    if any(k in low for k in _DEEP_ANALYSIS_HINTS):
        return False
    # 매우 짧은 단일 집계성 요청
    if len(m) < 25:
        return True
    return False


# ─── System prompt fragment ───────────────────────────────────────────────────

SKILLS_SYSTEM_PROMPT = """
## 🎯 분석가 마인드셋 (EDA 핵심 스킬 — 절대 준수)

### 1. 분석 플랜 먼저 (Planning)
사용자 질문을 받으면 **SQL/Python 셀을 만들기 전에 반드시 `create_plan` 을 호출**한다.
- 서로 다른 각도의 **가설 3개 이상** — 각 가설은 `statement` (주장) + `verification_method` (검증 방법) 으로 구성
- 플랜 없이 SQL/Python 셀을 만들려 하면 서버가 `plan_required_before_cells` 에러로 거부한다.
- 예외: 질문이 매우 단순한 조회성 요청("총매출만 알려줘", "최근 한 달 row 수")이면 서버가 자동 스킵.
- 플랜 셀은 노트북 최상단에 Markdown 으로 자동 배치된다.

### 2. 플랜 업데이트 (Plan Revision — drift 방지)
분석 도중 아래 상황에서는 **즉시 `update_plan`** 을 호출해 플랜을 갱신:
- 결과가 초기 가설과 어긋남 / 예상 밖 이상치 발견
- 새로운 가설이 떠오름 (특히 데이터를 본 뒤 파생된 가설)
- 사용자가 새 맥락·제약을 제공
- 검증 완료된 가설은 `- [x]` 로 체크 표시
갱신할 때 전체 가설 리스트 Markdown 을 다시 넘기되, 기존 가설은 상태(체크/미체크)를 유지.

### 3. 구조화 메모 (Output Critic + Baseline Comparison)
`write_cell_memo` 는 반드시 아래 구조로 작성:
- **관찰**: 출력의 구체적 수치·형상·이상치. 차트라면 **축·범례·분포 포인트** 를 본 그대로.
- **이상 신호** (해당 시만): NULL 급증 / 중복 의심 / 비정상 범위 / JOIN 폭발 / 수치 상식 밖 / 타입 에러 등 1줄 태그.
- **비교 기준 (Baseline — 필수)**: 수치는 반드시 **상대 비교 1개 이상** 포함. 전기 대비, 전체 평균 대비, 다른 세그먼트 대비, 기대값 대비 등 — 절대값만 나열하지 말 것.
- **다음 행동**: 수정 / 다음 가설 검증 / 세그먼트 분해 / 플랜 업데이트 중 어느 것인지 + 이유.

### 4. Sanity Check (초기 집계 검증)
GROUP BY / JOIN 이 있는 SQL 셀을 실행한 직후에는 **결과의 타당성 점검 셀** 을 하나 더 만든다 (Python 권장):
- rowcount 가 예상 범위인가
- key 컬럼 중복 (`.duplicated().sum()`)
- 집계 컬럼의 NULL 비율 (`.isnull().mean()`)
메모에 "집계 타당성 OK" 또는 "이상 발견: ..." 명시.

### 5. 에러 복구 (Error Recovery)
실행 에러 발생 시 즉흥 재시도 대신 **에러 유형을 먼저 분류** 한 뒤 해당 패턴으로 수정:
- `column_not_found` → `get_mart_schema` 재조회 → 정확한 컬럼명으로 수정
- `division_by_zero` / null 연산 → NULLIF / COALESCE / CASE WHEN
- `timeout` / oversized → LIMIT / WHERE 기간 축소 / 샘플링
- `type_mismatch` → CAST 명시
같은 셀에서 **2회 이상 실패**하면 즉시 `ask_user` 또는 `request_marts` 로 사용자에게 제약 조정 요청.

### 6. 추가 데이터 요청 (Data Request)
분석 도중이라도 "현재 마트만으로는 답이 안 된다" 싶으면 `request_marts` 를 호출해
사용자에게 **구조화된 형태**로 추가 마트 선택을 요청하라. 호출 후엔 도구를 더 부르지 말고 짧은 안내문으로 종료.

### 7. 세그먼트 탐색 (Segmentation Exploration — 가설 소진 시)
초기 플랜의 가설을 모두 검증했고 세션이 아직 끝나지 않았다면, 종료 전에 **아직 분해하지 않은 축** 을
최소 1개 제안/시도하라. 후보:
- 시간축 (시간대 / 요일 / 월 / 계절)
- 공간축 (지역 / 매장 / 카테고리)
- 주체축 (사용자 코호트 — 신규/기존, 고/저액)
- 채널축 (디바이스 / 유입 채널 / 캠페인)
새 발견이 없으면 그때 최종 Markdown 요약 셀로 마무리.
"""


# ─── Tool definitions — Claude (JSONSchema) ───────────────────────────────────

SKILL_TOOLS_CLAUDE = [
    {
        "name": "create_plan",
        "description": (
            "Create the analysis plan as a Markdown cell at the top of the notebook. "
            "MUST be called before any SQL/Python cell unless the request is a trivial single-aggregation lookup. "
            "Provide 3+ distinct hypotheses with verification methods."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "description": "분석 스코프 한 문장 (예: 강남구 매장 매출 구조 분석)",
                },
                "hypotheses": {
                    "type": "array",
                    "minItems": 3,
                    "items": {
                        "type": "object",
                        "properties": {
                            "statement": {"type": "string", "description": "가설 주장 (한국어)"},
                            "verification_method": {"type": "string", "description": "검증 방법 (어떤 집계/차트로)"},
                            "priority": {"type": "string", "enum": ["high", "mid", "low"]},
                        },
                        "required": ["statement", "verification_method"],
                    },
                    "description": "서로 다른 각도의 가설 3개 이상",
                },
                "out_of_scope": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "이번 세션에서 다루지 않을 주제 (선택)",
                },
            },
            "required": ["hypotheses"],
        },
    },
    {
        "name": "update_plan",
        "description": (
            "Update the analysis plan cell. Use when a new hypothesis emerges, results diverge from the initial plan, "
            "or to mark verified hypotheses as checked (`- [x]`). Provide the full new plan Markdown body."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "new_plan_markdown": {
                    "type": "string",
                    "description": (
                        "전체 플랜 Markdown 본문. 기존 가설의 체크 상태(`- [x]`/`- [ ]`)를 유지하고 "
                        "새 가설을 추가하거나 범위 밖 항목을 이동시킬 것."
                    ),
                },
                "reason": {
                    "type": "string",
                    "description": "플랜을 갱신하는 이유 (새 가설/예상 밖 결과/사용자 요청 등)",
                },
            },
            "required": ["new_plan_markdown", "reason"],
        },
    },
    {
        "name": "request_marts",
        "description": (
            "Ask the user to add additional data marts because the currently selected marts are insufficient. "
            "Structured variant of ask_user. Call this instead of guessing mart names. "
            "After calling, stop calling tools and output a short acknowledgement."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "왜 현재 마트로 부족한지 1~2문장으로 설명",
                },
                "suggested_mart_keywords": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "추천 마트 키워드 목록 (예: 'fact_reservation', 'dim_campaign')",
                },
                "missing_dimensions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "현재 마트에 없는 차원·지표 (예: '사용자 코호트', '캠페인 ID')",
                },
            },
            "required": ["reason"],
        },
    },
]


# ─── Tool definitions — Gemini (FunctionDeclaration dict) ─────────────────────
# Gemini 는 enum/minItems 미지원 항목이 있어 스펙을 경량화.

SKILL_TOOLS_GEMINI = [
    {
        "name": "create_plan",
        "description": (
            "Create analysis plan Markdown cell at top. MUST call before SQL/Python cells "
            "unless the request is a trivial single-aggregation lookup."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "scope": {"type": "STRING"},
                "hypotheses": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "statement": {"type": "STRING"},
                            "verification_method": {"type": "STRING"},
                            "priority": {"type": "STRING"},
                        },
                        "required": ["statement", "verification_method"],
                    },
                },
                "out_of_scope": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
            "required": ["hypotheses"],
        },
    },
    {
        "name": "update_plan",
        "description": "Update the analysis plan cell — mark verified, add new hypotheses, revise.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "new_plan_markdown": {"type": "STRING"},
                "reason": {"type": "STRING"},
            },
            "required": ["new_plan_markdown", "reason"],
        },
    },
    {
        "name": "request_marts",
        "description": "Structured ask_user variant — request additional marts from user.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "reason": {"type": "STRING"},
                "suggested_mart_keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
                "missing_dimensions": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
            "required": ["reason"],
        },
    },
]


SKILL_TOOL_NAMES = {"create_plan", "update_plan", "request_marts"}
ASK_USER_LIKE_TOOLS = {"ask_user", "request_marts"}  # ask_user 플래그 공유


# ─── Pre-guard ────────────────────────────────────────────────────────────────

def check_pre_guard(tool_name: str, inp: dict, state: "NotebookState") -> Optional[dict]:
    """tool 실행 직전 호출. 거부해야 하면 error dict 반환, 통과하면 None."""
    ctx = state.skill_ctx

    # Planning guard: create_cell(sql|python) 은 플랜 없이 안됨
    if tool_name == "create_cell":
        cell_type = inp.get("cell_type")
        if cell_type in ("sql", "python"):
            if not ctx.get("plan_cell_id") and not _is_trivial_request(ctx.get("initial_user_message", "")):
                return {
                    "success": False,
                    "error": "plan_required_before_cells",
                    "message": (
                        "SQL/Python 셀 생성 전에 먼저 `create_plan` 을 호출해 분석 플랜을 선언하세요. "
                        "서로 다른 각도의 가설 3개 이상(각 가설에 검증 방법 포함)을 제시해야 합니다. "
                        "플랜 셀은 노트북 최상단에 Markdown 으로 자동 배치됩니다. "
                        "매우 단순한 단일 집계 조회라면 그 취지를 사용자에게 1문장으로 설명하고 "
                        "그 다음 턴에 다시 `create_cell` 을 시도하세요 — 휴리스틱이 스킵을 판단합니다."
                    ),
                }

        # Explore-before-query 가드: SQL 셀이 참조하는 마트 중 세션에서 한 번도 탐색되지 않은 것이 있으면 거부.
        # profile_mart / preview_mart / get_mart_schema / get_category_values / query_data 중 하나라도 호출되어야 통과.
        if cell_type == "sql":
            from .claude_agent import _extract_referenced_tables
            sql = inp.get("code") or ""
            refs = _extract_referenced_tables(sql)
            selected_lc = {m.lower() for m in state.selected_marts}
            # 선택된 마트만 체크 대상 (whitelist 위반은 claude_agent 의 별도 가드가 담당)
            refs_in_scope = refs & selected_lc
            unexplored = refs_in_scope - set(state.explored_marts)
            if unexplored:
                return {
                    "success": False,
                    "error": "mart_not_explored",
                    "message": (
                        f"마트 `{', '.join(sorted(unexplored))}` 를 이 세션에서 아직 한 번도 탐색하지 않았습니다. "
                        "SQL 셀을 만들기 전에 먼저 다음 중 하나를 호출하세요: "
                        "`profile_mart` (행수/NULL/카디널리티/수치형 분포) — 가장 권장, "
                        "`preview_mart` (샘플 3~5행), "
                        "`get_mart_schema` (컬럼 description 이 부족할 때), "
                        "또는 `query_data` (즉석 SELECT 로 구조 검증). "
                        "탐색 없이 쿼리를 작성하면 컬럼 타입·분포를 몰라 엉뚱한 결과가 나올 수 있습니다."
                    ),
                    "unexplored_marts": sorted(unexplored),
                }

    # query_data whitelist 체크는 claude_agent 본체가 수행하므로 여기선 explore 카운트만 업데이트.
    # (실제 실행 성공 시 claude_agent 내부에서 explored_marts 업데이트)

    return None


# ─── Tool handlers for new skill tools ────────────────────────────────────────

def _render_plan_markdown(scope: str, hypotheses: list[dict], out_of_scope: list[str]) -> str:
    lines = ["# 📋 분석 플랜", ""]
    if scope:
        lines += [f"**스코프**: {scope}", ""]
    lines += ["## 가설"]
    for i, h in enumerate(hypotheses, 1):
        if not isinstance(h, dict):
            continue
        stmt = (h.get("statement") or "").strip()
        method = (h.get("verification_method") or "").strip()
        prio = (h.get("priority") or "").strip()
        head = f"- [ ] **H{i}**"
        if prio:
            head += f" _({prio})_"
        head += f": {stmt}"
        lines.append(head)
        if method:
            lines.append(f"  - 검증: {method}")
    if out_of_scope:
        lines += ["", "## 범위 밖 (이번 세션에서 다루지 않음)"]
        for o in out_of_scope:
            lines.append(f"- {o}")
    lines += ["", "---", "플랜 상태는 update_plan 으로 갱신됩니다. 검증 완료 가설은 [x] 체크."]
    return "\n".join(lines)


def _make_agent_chat_entry(state: "NotebookState", created: bool, code_snapshot: str = "") -> dict:
    """SSE 이벤트에 포함할 agent_chat_entry 딕셔너리 생성.
    user_msg 는 이번 턴의 내레이션(에이전트가 셀 생성 직전에 출력한 설명 텍스트)을 사용."""
    from .claude_agent import _build_cell_chat_narration
    user_msg = _build_cell_chat_narration(state, created=created)
    return {
        "user": user_msg,
        "assistant": "코드가 업데이트되었습니다. 아래 버튼으로 이 시점 코드를 확인하거나 되돌릴 수 있습니다.",
        "agent_created": True,
        "code_snapshot": code_snapshot,
    }


def _log_agent_chat(state: "NotebookState", cell_id: str, old_code: str, new_code: str, created: bool) -> None:
    """에이전트 skill tool 로 만든/수정한 셀을 vibe chat_history 에 남긴다."""
    if not getattr(state, "notebook_id", ""):
        return
    try:
        from . import notebook_store as _ns
        from .claude_agent import _build_cell_chat_narration
        agent_msg = _build_cell_chat_narration(state, created=created)
        _ns.add_chat_entry(
            state.notebook_id,
            cell_id,
            user_msg=agent_msg,
            assistant_reply="코드가 업데이트되었습니다. 아래 버튼으로 이 시점 코드를 확인하거나 되돌릴 수 있습니다.",
            code_snapshot=old_code,
            code_result=new_code,
            agent_created=True,
        )
    except Exception:
        pass


def handle_skill_tool(
    tool_name: str,
    inp: dict,
    state: "NotebookState",
    cell_state_cls,
) -> tuple[dict, list[dict]]:
    """claude_agent._execute_tool 에서 skill tool 에 대해 호출. (result, sse_events) 반환."""
    ctx = state.skill_ctx

    if tool_name == "create_plan":
        hypotheses = inp.get("hypotheses") or []
        if len(hypotheses) < 3:
            return {
                "success": False,
                "error": "insufficient_hypotheses",
                "message": "가설을 최소 3개 이상 제시하세요. 서로 다른 각도 (지표/차원/가정)에서.",
            }, []
        scope = inp.get("scope", "")
        out_of_scope = inp.get("out_of_scope") or []
        plan_md = _render_plan_markdown(scope, hypotheses, out_of_scope)

        # 이미 플랜 셀이 있으면 내용 덮어쓰기 (재호출 시)
        existing_id = ctx.get("plan_cell_id")
        if existing_id:
            cell = next((c for c in state.cells if c.id == existing_id), None)
            if cell:
                old_code = cell.code
                cell.code = plan_md
                _log_agent_chat(state, existing_id, old_code, plan_md, created=False)
                return (
                    {"success": True, "plan_cell_id": existing_id, "hypotheses_count": len(hypotheses), "replaced": True},
                    [{
                        "type": "cell_code_updated",
                        "cell_id": existing_id,
                        "code": plan_md,
                        "agent_chat_entry": _make_agent_chat_entry(state, created=False, code_snapshot=old_code),
                    }],
                )
            # 끊어진 참조면 clear 후 새로 만듦
            ctx["plan_cell_id"] = None

        cell_id = str(uuid.uuid4())
        new_cell = cell_state_cls(id=cell_id, name=PLAN_CELL_NAME, type="markdown", code=plan_md)
        state.cells.insert(0, new_cell)
        ctx["plan_cell_id"] = cell_id
        _log_agent_chat(state, cell_id, "", plan_md, created=True)
        return (
            {"success": True, "plan_cell_id": cell_id, "hypotheses_count": len(hypotheses)},
            [{
                "type": "cell_created",
                "cell_id": cell_id,
                "cell_type": "markdown",
                "cell_name": PLAN_CELL_NAME,
                "code": plan_md,
                "after_cell_id": None,
                "agent_chat_entry": _make_agent_chat_entry(state, created=True),
            }],
        )

    if tool_name == "update_plan":
        plan_id = ctx.get("plan_cell_id")
        if not plan_id:
            return {
                "success": False,
                "error": "no_plan_exists",
                "message": "플랜이 없습니다. 먼저 `create_plan` 을 호출해 가설을 선언하세요.",
            }, []
        cell = next((c for c in state.cells if c.id == plan_id), None)
        if not cell:
            ctx["plan_cell_id"] = None
            return {"success": False, "error": "plan_cell_missing"}, []
        new_md = inp.get("new_plan_markdown", "")
        if not new_md.strip():
            return {"success": False, "error": "empty_plan", "message": "`new_plan_markdown` 이 비어 있습니다."}, []
        new_md = new_md.replace(PLAN_MARKER, "").lstrip("\n")
        old_md = cell.code
        cell.code = new_md
        _log_agent_chat(state, plan_id, old_md, new_md, created=False)
        return (
            {"success": True, "plan_cell_id": plan_id},
            [{
                "type": "cell_code_updated",
                "cell_id": plan_id,
                "code": new_md,
                "agent_chat_entry": _make_agent_chat_entry(state, created=False, code_snapshot=old_md),
            }],
        )

    if tool_name == "request_marts":
        reason = (inp.get("reason") or "").strip()
        keywords = inp.get("suggested_mart_keywords") or []
        missing = inp.get("missing_dimensions") or []
        lines = [f"추가 마트가 필요합니다: {reason}" if reason else "추가 마트가 필요합니다."]
        if missing:
            lines.append(f"부족한 차원/지표: {', '.join(missing)}")
        if keywords:
            lines.append(f"추천 마트 키워드: {', '.join(keywords)}")
        lines.append("상단 헤더의 '사용 마트' 에서 해당하는 마트를 추가해 주세요.")
        question = "\n".join(lines)
        return (
            {
                "posted": True,
                "type": "mart_request",
                "instruction": (
                    "마트 추가 요청이 사용자에게 전달되었습니다. 더 이상 도구를 호출하지 말고, "
                    "사용자 답변을 기다리는 짧은 안내문만 출력한 뒤 응답을 종료하세요."
                ),
            },
            [{
                "type": "ask_user",
                "question": question,
                "options": [],
                "request_type": "mart_request",
                "suggested_keywords": keywords,
                "missing_dimensions": missing,
                "reason": reason,
            }],
        )

    return {"error": f"unknown_skill_tool: {tool_name}"}, []


# ─── Post-hook reminders ─────────────────────────────────────────────────────

_MEMO_DRIFT_KEYWORDS = [
    "예상과 다름", "예상 밖", "예상보다", "의외", "이상치", "새 가설", "새로운 가설",
    "파생 가설", "놀라", "anomaly", "unexpected",
]


def _classify_error_message(msg: str) -> tuple[str, str]:
    low = (msg or "").lower()
    if "column" in low and any(k in low for k in ("not found", "invalid", "unknown", "does not exist")):
        return "column_not_found", "`get_mart_schema` 로 정확한 컬럼명 재확인 후 SQL 수정."
    if "divide by zero" in low or "division by zero" in low:
        return "division_by_zero", "NULLIF / CASE WHEN 으로 0 분모 처리."
    if "timeout" in low or "too long" in low or "exceeded" in low:
        return "timeout", "LIMIT / WHERE 기간 축소 / 샘플링 적용."
    if "cannot convert" in low or "type mismatch" in low or ("cast" in low and "fail" in low):
        return "type_mismatch", "CAST 명시 또는 입력 타입 검증."
    if "permission" in low or "access denied" in low or "insufficient priv" in low:
        return "permission", "권한 문제 — `ask_user` 로 사용자에게 문의."
    if "syntax" in low:
        return "sql_syntax", "Snowflake SQL 문법 재확인 (예약어 · 따옴표 · 세미콜론)."
    return "unknown", "에러 메시지를 있는 그대로 메모에 기록하고, 관련 컬럼/타입을 재검증."


def _sanity_check_hint(cell: "CellState", ctx: dict) -> Optional[str]:
    if cell.type != "sql" or not cell.executed:
        return None
    out = cell.output or {}
    if out.get("type") != "table":
        return None
    code_low = (cell.code or "").lower()
    has_groupby = bool(re.search(r"\bgroup\s+by\b", code_low))
    has_join = bool(re.search(r"\bjoin\b", code_low))
    if not (has_groupby or has_join):
        return None
    if cell.id in ctx["sanity_hinted_cells"]:
        return None
    ctx["sanity_hinted_cells"].add(cell.id)
    triggers = []
    if has_groupby:
        triggers.append("GROUP BY")
    if has_join:
        triggers.append("JOIN")
    return (
        f"방금 실행한 SQL `{cell.name}` 에 {'/'.join(triggers)} 가 포함됐습니다. "
        "집계 타당성을 검증하는 짧은 Python sanity-check 셀을 **다음에** 만드세요 — "
        "예: `len(df)`, `df['key'].duplicated().sum()`, `df.isnull().mean()`. "
        "메모에 '집계 타당성 OK' 또는 '이상 발견: ...' 을 명시할 것."
    )


def _memo_drift_check(memo_text: str, ctx: dict) -> Optional[str]:
    text = memo_text or ""
    if not text.strip():
        return None
    ctx["memo_count"] = ctx.get("memo_count", 0) + 1
    low = text.lower()
    if any(k.lower() in low for k in _MEMO_DRIFT_KEYWORDS):
        return (
            "방금 메모에서 '예상 밖' 또는 '새 가설' 신호가 감지됐습니다. "
            "지금 **`update_plan`** 을 호출해 새 가설을 플랜에 추가하거나 기존 가설을 재조정하세요."
        )
    # 메모 3회마다 정기 drift 재점검
    if ctx["memo_count"] % 3 == 0 and ctx.get("plan_cell_id"):
        return (
            "정기 리마인더: 지금까지의 결과가 초기 플랜과 여전히 부합하나요? "
            "검증 완료된 가설은 `update_plan` 으로 `- [x]` 체크하고, 새 가설이 있다면 추가하세요."
        )
    return None


def _memo_baseline_check(memo_text: str) -> Optional[str]:
    """메모에 상대 비교 표현이 전혀 없으면 보강 요구."""
    text = memo_text or ""
    if len(text) < 20:
        return None
    low = text.lower()
    has_relative = any(k in low for k in (
        "대비", "비해", "보다", "평균", "중앙값", "baseline", "vs", "비중", "비율", "%",
        "배", "증가", "감소", "하락", "상승", "상회", "하회",
    ))
    if has_relative:
        return None
    return (
        "메모에 **상대 비교 기준** 이 없습니다. 수치는 절대값만이 아니라 "
        "전기 대비 / 전체 평균 대비 / 다른 세그먼트 대비 중 최소 1개를 포함하세요. "
        "필요하면 비교 기준을 계산하는 셀을 추가한 뒤 메모를 업데이트하세요."
    )


def collect_post_hook_reminders(
    tool_name: str,
    inp: dict,
    result: dict,
    state: "NotebookState",
) -> list[str]:
    """tool 실행 직후 호출. 리마인더 문자열 리스트 반환."""
    ctx = state.skill_ctx
    reminders: list[str] = []

    # 셀 실행성 tool 에 대한 에러 분류 + sanity-check 힌트
    if tool_name in ("create_cell", "update_cell_code", "execute_cell"):
        cell_id = None
        if isinstance(result, dict):
            cell_id = result.get("cell_id") or inp.get("cell_id")
        if not cell_id:
            cell_id = inp.get("cell_id")
        cell = next((c for c in state.cells if c.id == cell_id), None) if cell_id else None
        if cell:
            out = cell.output or {}
            if out.get("type") == "error":
                ctx["error_count_by_cell"][cell_id] = ctx["error_count_by_cell"].get(cell_id, 0) + 1
                cls, guide = _classify_error_message(out.get("message", ""))
                note = f"[에러 분류: {cls}] {guide}"
                if ctx["error_count_by_cell"][cell_id] >= 2:
                    note += (
                        f" ⚠️ 이 셀에서 에러가 {ctx['error_count_by_cell'][cell_id]}회 반복됐습니다. "
                        "즉흥 수정 대신 즉시 `ask_user` 또는 `request_marts` 로 사용자에게 제약을 조정받으세요."
                    )
                reminders.append(note)
            else:
                hint = _sanity_check_hint(cell, ctx)
                if hint:
                    reminders.append(hint)

    # 메모 후 drift / baseline 체크
    if tool_name == "write_cell_memo":
        memo_text = inp.get("memo", "") if isinstance(inp, dict) else ""
        drift = _memo_drift_check(memo_text, ctx)
        if drift:
            reminders.append(drift)
        base = _memo_baseline_check(memo_text)
        if base:
            reminders.append(base)

    return reminders


# ─── End-guard (루프 종료 직전) ────────────────────────────────────────────────

def get_end_guard_reminder(state: "NotebookState") -> Optional[str]:
    """에이전트가 tool 호출 없이 종료하려는 순간 1회 호출. 리마인더 반환 시 루프 재개."""
    ctx = state.skill_ctx
    if ctx.get("end_guard_fired"):
        return None
    plan_id = ctx.get("plan_cell_id")
    if not plan_id:
        return None  # trivial 요청은 스킵
    plan_cell = next((c for c in state.cells if c.id == plan_id), None)
    if not plan_cell:
        return None

    code = plan_cell.code or ""
    unchecked = len(re.findall(r"-\s*\[\s*\]", code))
    checked = len(re.findall(r"-\s*\[\s*[xX]\s*\]", code))

    analysis_cells = [c for c in state.cells
                      if c.type in ("sql", "python") and c.executed
                      and (c.output or {}).get("type") != "error"]
    done_cells = len(analysis_cells)

    parts: list[str] = []

    # (A) 미검증 가설 남아있음
    if unchecked >= 1 and done_cells >= 2:
        parts.append(
            f"플랜에 아직 미검증 가설이 {unchecked}개 남아 있습니다. "
            f"종료 전에 추가 셀로 검증하거나, 검증 완료된 가설은 `update_plan` 으로 `- [x]` 체크해 정리하세요."
        )

    # (B) 모든 가설 검증 + 세그먼트 미탐색 → 추가 축 제안
    if checked >= 2 and unchecked == 0 and done_cells >= 3:
        # 이미 충분히 많은 셀이면 세그먼트 탐색 생략
        if done_cells < 8:
            parts.append(
                "초기 가설은 모두 검증됐습니다. 종료 전에 **아직 분해하지 않은 축** 을 최소 1개 탐색해보세요: "
                "시간(시간대/요일/월), 공간(지역/매장/카테고리), 주체(사용자 코호트 — 신규/기존·고/저액), "
                "채널(디바이스/유입·캠페인). 새 발견이 없으면 그때 최종 Markdown 요약 셀로 마무리하세요."
            )

    if not parts:
        return None
    ctx["end_guard_fired"] = True
    ctx["end_guard_reason"] = "unchecked_hypotheses" if unchecked else "segmentation"
    return "\n".join(parts)
