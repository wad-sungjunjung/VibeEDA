import asyncio
import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Literal, Optional, AsyncGenerator

import anthropic

from .naming import to_snake_case
from . import mart_tools
from .code_style import SQL_STYLE_GUIDE, PYTHON_RULES


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


@dataclass
class NotebookState:
    cells: list[CellState] = field(default_factory=list)
    selected_marts: list[str] = field(default_factory=list)
    mart_metadata: list[dict] = field(default_factory=list)
    analysis_theme: str = ""
    analysis_description: str = ""
    notebook_id: str = ""


# ─── Tool definitions ────────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "read_notebook_context",
        "description": "Read the current state of all cells in the notebook, including code, execution status, and output summary.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "create_cell",
        "description": "Create a new cell in the notebook with initial code.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_type": {
                    "type": "string",
                    "enum": ["sql", "python", "markdown"],
                    "description": "Type of cell to create",
                },
                "name": {"type": "string", "description": "Cell name (optional)"},
                "code": {"type": "string", "description": "Initial code for the cell"},
                "after_cell_id": {
                    "type": "string",
                    "description": "ID of the cell to insert after (optional, defaults to end)",
                },
            },
            "required": ["cell_type", "code"],
        },
    },
    {
        "name": "update_cell_code",
        "description": "Update the code of an existing cell.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string", "description": "ID of the cell to update"},
                "code": {"type": "string", "description": "New code content"},
            },
            "required": ["cell_id", "code"],
        },
    },
    {
        "name": "execute_cell",
        "description": "Execute a cell against the real Snowflake DB or Python kernel and get its actual output.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string", "description": "ID of the cell to execute"}
            },
            "required": ["cell_id"],
        },
    },
    {
        "name": "read_cell_output",
        "description": "Read the output of an already-executed cell.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string", "description": "ID of the cell"}
            },
            "required": ["cell_id"],
        },
    },
    {
        "name": "get_mart_schema",
        "description": (
            "Get column schema (name, type, description) of a selected mart. "
            "MUST be called before writing SQL against a mart to avoid column-not-found errors."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "mart_key": {"type": "string", "description": "Mart key (table name, e.g. 'mart_revenue')"}
            },
            "required": ["mart_key"],
        },
    },
    {
        "name": "preview_mart",
        "description": (
            "Fetch top N rows from a mart WITHOUT creating a notebook cell. "
            "Use this to sanity-check data shape before writing real analysis cells."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "mart_key": {"type": "string"},
                "limit": {"type": "integer", "default": 5, "description": "Row limit (1~50)"},
            },
            "required": ["mart_key"],
        },
    },
    {
        "name": "profile_mart",
        "description": (
            "Profile a mart: total row count, per-column NULL ratio, distinct count, "
            "and min/max/avg for numeric columns. Samples up to 100k rows for large tables."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"mart_key": {"type": "string"}},
            "required": ["mart_key"],
        },
    },
    {
        "name": "write_cell_memo",
        "description": (
            "Write or update a cell's memo (노트). Use this to record INSIGHTS derived from the cell's output "
            "— key findings, anomalies, numbers worth remembering, next-step hypotheses. "
            "Call after observing a cell's output. Short bullet points preferred (2~5줄)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string"},
                "memo": {"type": "string", "description": "Markdown-friendly insight memo, Korean"},
            },
            "required": ["cell_id", "memo"],
        },
    },
    {
        "name": "ask_user",
        "description": (
            "Ask the user a clarification question when the request is ambiguous or missing "
            "required context (target period, region, metric, etc.). "
            "After calling this tool, respond with a short acknowledgement text and STOP calling tools — "
            "the agent session will end and wait for the user's reply."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question to ask the user"},
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional suggested answer choices",
                },
            },
            "required": ["question"],
        },
    },
]


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


# ─── Tool execution ───────────────────────────────────────────────────────────

async def _execute_tool(name: str, inp: dict, state: NotebookState) -> tuple[dict, list[dict]]:
    """Returns (tool_result_dict, list_of_sse_events)."""

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

        events: list[dict] = [{
            "type": "cell_created",
            "cell_id": cell_id,
            "cell_type": cell_type,
            "cell_name": name_val,
            "code": code,
            "after_cell_id": after_id,
        }]

        # 모든 셀(SQL/Python)은 생성 즉시 자동 실행 — 에이전트가 실제 출력을 보고 다음 단계를 결정
        if cell_type in ("sql", "python") and state.notebook_id:
            exec_result, exec_events = await _execute_tool(
                "execute_cell", {"cell_id": cell_id}, state
            )
            events.extend(exec_events)
            payload = {
                "cell_id": cell_id,
                "success": True,
                "auto_executed": True,
                "output_summary": exec_result.get("output_summary"),
            }
            if exec_result.get("image_png_base64"):
                payload["image_png_base64"] = exec_result["image_png_base64"]
            return payload, events

        return {"cell_id": cell_id, "success": True}, events

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
        cell.code = new_code
        events: list[dict] = [{"type": "cell_code_updated", "cell_id": cell.id, "code": cell.code}]

        # 코드 변경 후 즉시 재실행
        if cell.type in ("sql", "python") and state.notebook_id:
            exec_result, exec_events = await _execute_tool(
                "execute_cell", {"cell_id": cell.id}, state
            )
            events.extend(exec_events)
            payload = {
                "success": True,
                "auto_executed": True,
                "output_summary": exec_result.get("output_summary"),
            }
            if exec_result.get("image_png_base64"):
                payload["image_png_base64"] = exec_result["image_png_base64"]
            return payload, events

        return {"success": True}, events

    if name == "execute_cell":
        cell = next((c for c in state.cells if c.id == inp["cell_id"]), None)
        if not cell:
            return {"success": False, "error": "Cell not found"}, []

        try:
            from ..services.kernel import run_sql, run_python
            loop = asyncio.get_event_loop()

            if cell.type == "sql":
                output = await loop.run_in_executor(
                    None, run_sql, state.notebook_id, cell.name, cell.code
                )
            elif cell.type == "python":
                output = await loop.run_in_executor(
                    None, run_python, state.notebook_id, cell.name, cell.code
                )
            else:
                output = {"type": "stdout", "content": ""}

        except Exception as e:
            output = {"type": "error", "message": str(e)}

        cell.executed = True
        cell.output = output

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

    if name in ("get_mart_schema", "preview_mart", "profile_mart"):
        mart_key = inp.get("mart_key", "")
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
                return await loop.run_in_executor(None, mart_tools.get_mart_schema, mart_key), []
            if name == "preview_mart":
                limit = inp.get("limit", 5)
                return await loop.run_in_executor(None, mart_tools.preview_mart, mart_key, limit), []
            return await loop.run_in_executor(None, mart_tools.profile_mart, mart_key), []
        except Exception as e:
            return {"error": str(e)}, []

    if name == "write_cell_memo":
        cell = next((c for c in state.cells if c.id == inp["cell_id"]), None)
        if not cell:
            return {"success": False, "error": "Cell not found"}, []
        memo = inp.get("memo", "")
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


# ─── System prompt ────────────────────────────────────────────────────────────

def _build_system_prompt(state: NotebookState) -> str:
    marts = ", ".join(state.selected_marts) if state.selected_marts else "없음"
    from . import snowflake_session
    sf_connected = snowflake_session.is_connected()
    sf_status = "연결됨" if sf_connected else "미연결 — Snowflake 관련 도구(get_mart_schema, preview_mart, profile_mart, SQL 실행) 사용 불가. 필요 시 ask_user로 연결 요청"

    # 선택된 마트의 컬럼 스키마를 프롬프트에 미리 주입 → get_mart_schema 재호출 불필요
    mart_schema_block = ""
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
        mart_schema_block = (
            "\n## 선택된 마트 스키마 (이미 로드됨 — `get_mart_schema` 재호출 불필요)\n"
            + "\n".join(lines) + "\n"
        )
    return f"""You are an expert data analyst AI for an advertising platform analytics tool called Vibe EDA.
You help analysts explore ad platform data by creating, modifying, and executing notebook cells.

## Current Analysis
- Theme: {state.analysis_theme}
- Description: {state.analysis_description}
- Data Marts: {marts}
- Snowflake: {sf_status}
{mart_schema_block}

## Tools
- read_notebook_context: See all current cells and their state
- create_cell: Create a new SQL, Python, or Markdown cell with code
- update_cell_code: Modify an existing cell's code
- execute_cell: Run a cell against the REAL Snowflake DB or Python kernel — always call this after creating/updating a cell
- read_cell_output: Read previously executed cell output
- get_mart_schema: **SQL 작성 전 반드시 호출** — 실제 컬럼명/타입/description을 확인해 `column not found` 에러 방지
- preview_mart: 노트북에 셀을 남기지 않고 상위 N행만 확인 (데이터 생김새 파악용)
- profile_mart: 행수, NULL 비율, 카디널리티, 수치형 min/max/avg — 이상치·결측 탐지 목적
- write_cell_memo: **출력을 확인한 뒤 핵심 인사이트·이상치·후속 가설을 해당 셀의 메모(노트)에 기록**. 2~5줄의 불릿이 적당
- ask_user: 요청이 모호하거나 필요한 맥락(기간·지역·지표 등)이 빠졌을 때 **빠르게** 사용자에게 질문한다.
  **헷갈리면 추측하지 말고 반드시 `ask_user` 를 먼저 호출**하라. 호출 후엔 도구를 더 부르지 말고 짧은 안내 텍스트로 응답을 마감.
  `ask_user` 를 써야 하는 대표 시그널:
  - 기간 미지정 ("최근 매출" — 7일? 30일? 이번 달?)
  - 지표 모호 ("많다" / "쏠림" — 어떤 기준?)
  - 선택 마트만으로 데이터가 부족해 보임
  - 같은 요청을 두 번 다른 방식으로 해석 가능할 때

## 인사이트 기록 규칙 (절대 준수 — 서버가 강제)
- **`create_cell` 호출 전에, 직전 실행 셀(sql/python, 정상 출력)의 메모가 비어 있다면 반드시 먼저 `write_cell_memo` 를 호출하라.**
  - 서버는 메모 없이 다음 셀을 만들려 하면 `memo_required_before_next_cell` 에러를 반환하며 거부한다.
  - 메모에는 반드시 (1) 직전 출력에서 관찰한 핵심 수치·인사이트·이상치, (2) 그로부터 "왜 이 다음 셀을 만드는가"의 근거 — 둘 다 담아라. 2~5줄 불릿.
- 차트 셀의 경우 tool_result 에 **렌더링된 PNG 이미지**가 함께 전달된다. 이미지를 실제로 보고(축/범례/분포) 의도에 부합하는지 검증한 뒤 메모를 작성하라. 같은 차트를 반복 생성하지 말고, 의도와 다르면 `update_cell_code`로 수정하라.
- 메모 내용 예: "서울·경기가 전체 예약의 62% 차지 → 지역별 편중을 매장 단위로 분해하기 위해 다음 셀 생성", "강남점 1개 매장이 서울 매출의 38%, 이상치로 판단 → 이 매장을 제외한 분포 재확인"
- 전체 분석 요약은 마지막 Markdown 셀로 별도 작성 (메모는 개별 셀 단위 통찰)

## 맥락 수집 우선순위 (SQL 작성 전 필수)

### 0단계 — **현재 선택 마트만으로 질문을 답할 수 있는지 판단 (첫 턴에 반드시 수행)**
사용자 요청을 받자마자, 다른 도구를 부르기 전에 먼저 **한 문단**으로 아래를 분석해 텍스트로 출력한다:
- (a) 질문이 어떤 지표·차원을 요구하는가 (예: "지역별 매출" → 차원=지역, 지표=매출)
- (b) 현재 **선택된 마트**의 이름과 일반적인 성격만 보고, 해당 지표/차원이 담겨 있을 법한지 판단
- (c) 판단 결과에 따라 분기:
  - **충분해 보임** → 1단계로 진행 ("선택된 마트 [X, Y]로 답할 수 있을 것 같아요. 스키마 확인 후 쿼리 작성할게요.")
  - **부족해 보임 / 모호** → **반드시 `ask_user` 를 호출**하여 추가 마트 선택 또는 범위 재확인을 사용자에게 요청. 금지: 추측으로 다른 테이블 이름 조회 시도
- 예: 선택 마트가 `dim_shop_base` 뿐인데 "예약수" 를 물어봤다면 → `dim_`은 dimension이라 예약 사실(fact)이 없을 가능성이 큼 → `ask_user`로 `fact_reservation` 계열 마트 추가 요청

### 1단계 이후
1. **선택된 마트 스키마는 이미 위에 주입되어 있다** — 해당 컬럼명만으로 SQL 작성 가능하면 `get_mart_schema` 호출 생략 (시간 절약). 컬럼 해석이 애매하거나 description이 비어 있을 때만 호출.
2. 필요시 `preview_mart` 로 샘플 1~5행 확인
3. 추가 모호함이 남으면 `ask_user`로 재질문 — 추측해서 엉뚱한 쿼리 작성 금지

## 셀 파이프라인 (반드시 준수)
모든 셀은 아래 사이클을 따른다:

  [입력 작성] → [자동 실행] → [출력 확인] → [인사이트 메모 작성] → [수정 OR 다음 셀 생성]

- `create_cell` 또는 `update_cell_code`를 호출하면 **자동으로 즉시 실행**되고 tool result에 실제 출력이 포함됨
- 출력을 반드시 확인한 뒤 다음 행동을 결정할 것:
  - 오류 또는 의도와 다른 결과 → `update_cell_code`로 수정 (재실행 자동)
  - 결과가 올바름 → **반드시 `write_cell_memo` 호출** → 그 다음 셀 생성
- `execute_cell`을 직접 호출할 필요 없음 (생성/수정 시 자동 실행됨)
- 서버가 "메모 없이는 다음 셀 생성 금지"를 강제한다. 예외 없음.

## ⚠️ 한 루프당 한 문단 내레이션 — 가장 중요한 규칙 (절대 준수)
- tool_result 를 받은 **직후**, **다음 도구를 호출하기 전에** 반드시 한국어 텍스트 한 문단을 먼저 출력한다.
- 순서: `[텍스트 출력]` → `[다음 tool_use]` — 이 순서가 바뀌거나 텍스트가 생략되면 규칙 위반.
- 한 응답에 여러 tool_use 를 한꺼번에 넣지 말 것. 텍스트 해설 → tool 1개 → (결과 받고) 다시 텍스트 해설 → tool 1개 → ... 의 리듬을 유지.
- 그 문단은 아래 두 가지를 모두 담는다:
  1. 방금 본 결과에 대한 해석·관찰·인사이트 (수치·이상치·에러 원인 등 구체적으로)
  2. 바로 다음에 취할 행동과 그 이유
- 좋은 예시:
  - "`region_sales` 실행 시 컬럼명 오타로 에러가 났네요. 스키마를 다시 보고 정확한 컬럼명으로 수정할게요."
  - "차트를 보니 서울·경기가 전체 예약의 62%를 차지하네요. 이 편중이 특정 매장 때문인지 확인하려고 매장별 쏠림도를 계산해볼게요."
  - "프로파일 결과 `shop_id`의 NULL 비율이 0%로 깨끗합니다. 바로 매장별 예약수 집계 SQL을 작성할게요."
- 나쁜 예시 (금지):
  - 해설 없이 바로 도구만 호출
  - "다음 단계로 넘어갑니다" 같은 공허한 문장
- 단, 맨 처음 사용자 요청을 받은 직후(첫 도구 호출 전)에는 내레이션을 생략해도 된다. 또한 `ask_user` 호출 직후에는 사용자 답변을 기다리는 짧은 안내문만 출력한다.

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

{SQL_STYLE_GUIDE}

{PYTHON_RULES}"""


# ─── Agent loop ───────────────────────────────────────────────────────────────

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
) -> AsyncGenerator[dict, None]:
    if not api_key:
        yield {"type": "error", "message": "Anthropic API 키가 설정되지 않았습니다."}
        return

    client = anthropic.AsyncAnthropic(api_key=api_key)
    system_prompt = _build_system_prompt(notebook_state)

    messages: list[dict] = list(conversation_history)
    messages.append({"role": "user", "content": user_message})

    import time as _time
    created_cell_ids: list[str] = []
    updated_cell_ids: list[str] = []
    MAX_TURNS = 15
    REPEAT_CALL_LIMIT = 3
    TOTAL_TOOL_LIMIT = 40      # 세션당 총 tool_call 상한 (우회 방지)
    NARRATION_MIN_CHARS = 20   # 도구 호출 전 내레이션 최소 길이
    LONG_RUN_SEC = 30          # 이 시간 넘게 분석하면 재질문 고려 리마인더 주입
    repeat_counter: dict[str, int] = {}
    total_tool_calls = 0
    turn_index = 0
    narration_warning_used = False
    long_run_warning_used = False
    loop_started_at = _time.monotonic()
    ask_user_called = False

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
        for _ in range(MAX_TURNS):
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
                async with client.messages.stream(
                    model=model,
                    max_tokens=16000,
                    system=cached_system,  # type: ignore[arg-type]
                    tools=cached_tools,  # type: ignore[arg-type]
                    messages=messages,  # type: ignore[arg-type]
                    thinking={"type": "adaptive"},  # type: ignore[arg-type]
                ) as stream:
                    async for event in stream:
                        if event.type == "content_block_delta":
                            delta = event.delta
                            if delta.type == "thinking_delta":
                                yield {"type": "thinking", "content": delta.thinking}
                            elif delta.type == "text_delta":
                                full_text += delta.text
                                yield {"type": "message_delta", "content": delta.text}
                    response = await stream.get_final_message()

                tool_uses = [b for b in response.content if b.type == "tool_use"]

                # 내레이션 거부 조건: 첫 턴 아니고, tool 호출이 있고, 텍스트 부족 → 재요청
                if (turn_index > 0 and tool_uses
                        and len(full_text.strip()) < NARRATION_MIN_CHARS
                        and not retried_for_narration):
                    retried_for_narration = True
                    # 프론트에 시각적 알림
                    yield {"type": "message_delta", "content": "\n\n_[규칙 위반 감지: 텍스트 없이 도구 호출 — 재요청]_\n\n"}
                    # 응답을 메시지에 추가하지 않고, 강제 지시를 user 메시지로 주입 후 재루프
                    messages.append({
                        "role": "user",
                        "content": (
                            "❗ 방금 응답은 텍스트 해설 없이 도구만 호출해 규칙을 위반했습니다. "
                            "**도구를 호출하지 말고**, 먼저 한국어 텍스트 한 문단으로 "
                            "(1) 직전 tool_result에 대한 관찰·해석 1~3문장 + "
                            "(2) 다음 행동과 그 이유를 출력하세요. "
                            "그 다음 응답에서 도구를 호출하세요."
                        ),
                    })
                    continue
                break

            if not tool_uses:
                break

            # 무한 루프 방지: 정규화된 tool+input 반복 호출 감지 + 총 호출 상한
            safety_break = False
            for tb in tool_uses:
                total_tool_calls += 1
                if total_tool_calls > TOTAL_TOOL_LIMIT:
                    yield {
                        "type": "error",
                        "message": f"총 도구 호출이 {TOTAL_TOOL_LIMIT}회를 넘어 중단했습니다. 요청을 더 작게 쪼개거나 모델을 변경해주세요.",
                    }
                    safety_break = True
                    break
                key = _norm_key(tb.name, tb.input)
                repeat_counter[key] = repeat_counter.get(key, 0) + 1
                if repeat_counter[key] > REPEAT_CALL_LIMIT:
                    yield {
                        "type": "error",
                        "message": f"같은 도구(`{tb.name}`)를 {REPEAT_CALL_LIMIT}회 초과로 반복 호출해 중단했습니다. "
                                    "Snowflake 연결 또는 입력값을 확인해주세요.",
                    }
                    safety_break = True
                    break
            if safety_break:
                return

            tool_results = []
            for tool_block in tool_uses:
                yield {"type": "tool_use", "tool": tool_block.name, "input": tool_block.input}
                if tool_block.name == "ask_user":
                    ask_user_called = True

                result, sse_events = await _execute_tool(tool_block.name, tool_block.input, notebook_state)

                for sse_event in sse_events:
                    yield sse_event
                    if sse_event["type"] == "cell_created":
                        created_cell_ids.append(sse_event["cell_id"])
                    elif sse_event["type"] == "cell_code_updated":
                        updated_cell_ids.append(sse_event["cell_id"])

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

            reminders: list[str] = []
            # 내레이션 강제: 규칙 위반시 매 턴마다 리마인더 재주입 (1회 한정 X)
            if turn_index > 0 and len(full_text.strip()) < NARRATION_MIN_CHARS:
                reminders.append(
                    "❗규칙 위반: 직전 응답에 도구 호출 전 해설 텍스트가 없거나 너무 짧았습니다. "
                    "다음 턴에서는 **반드시** 도구를 호출하기 **전에** "
                    "(1) 방금 받은 tool_result에 대한 관찰·해석 1~3문장 + "
                    "(2) 지금 취할 행동과 그 이유 "
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
