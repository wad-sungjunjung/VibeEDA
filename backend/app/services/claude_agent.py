import asyncio
import json
import uuid
from dataclasses import dataclass, field
from typing import Literal, Optional, AsyncGenerator

import anthropic

from .naming import to_snake_case
from . import mart_tools
from .code_style import SQL_STYLE_GUIDE, PYTHON_RULES


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
        return "[차트 생성됨] Plotly 시각화가 성공적으로 생성되었습니다."

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
        cell_id = str(uuid.uuid4())
        cell_type = inp["cell_type"]
        raw_name = inp.get("name") or f"cell_{len(state.cells) + 1}"
        name_val = to_snake_case(raw_name, fallback=f"cell_{len(state.cells) + 1}")
        code = inp.get("code", "")
        after_id = inp.get("after_cell_id")

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
            return {
                "cell_id": cell_id,
                "success": True,
                "auto_executed": True,
                "output_summary": exec_result.get("output_summary"),
            }, events

        return {"cell_id": cell_id, "success": True}, events

    if name == "update_cell_code":
        cell = next((c for c in state.cells if c.id == inp["cell_id"]), None)
        if not cell:
            return {"success": False, "error": "Cell not found"}, []
        cell.code = inp["code"]
        events: list[dict] = [{"type": "cell_code_updated", "cell_id": cell.id, "code": cell.code}]

        # 코드 변경 후 즉시 재실행
        if cell.type in ("sql", "python") and state.notebook_id:
            exec_result, exec_events = await _execute_tool(
                "execute_cell", {"cell_id": cell.id}, state
            )
            events.extend(exec_events)
            return {
                "success": True,
                "auto_executed": True,
                "output_summary": exec_result.get("output_summary"),
            }, events

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
        return (
            {"cell_id": cell.id, "executed": True, "output_summary": output_summary},
            [{"type": "cell_executed", "cell_id": cell.id, "output": output}],
        )

    if name == "read_cell_output":
        cell = next((c for c in state.cells if c.id == inp["cell_id"]), None)
        if not cell:
            return {"error": "Cell not found"}, []
        if not cell.executed:
            return {"error": "Cell has not been executed"}, []
        return {"cell_id": cell.id, "output_summary": _format_output_for_claude(cell.output)}, []

    if name == "get_mart_schema":
        try:
            return mart_tools.get_mart_schema(inp["mart_key"]), []
        except Exception as e:
            return {"error": str(e)}, []

    if name == "preview_mart":
        try:
            return mart_tools.preview_mart(inp["mart_key"], inp.get("limit", 5)), []
        except Exception as e:
            return {"error": str(e)}, []

    if name == "profile_mart":
        try:
            return mart_tools.profile_mart(inp["mart_key"]), []
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
    return f"""You are an expert data analyst AI for an advertising platform analytics tool called Vibe EDA.
You help analysts explore ad platform data by creating, modifying, and executing notebook cells.

## Current Analysis
- Theme: {state.analysis_theme}
- Description: {state.analysis_description}
- Data Marts: {marts}
- Snowflake: {sf_status}

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
- ask_user: 요청이 모호하거나 필요한 맥락(기간·지역·지표 등)이 빠졌을 때 사용자에게 질문. 호출 후엔 더 이상 도구를 부르지 말고 짧은 안내 텍스트로 응답을 마감

## 인사이트 기록 규칙
- SQL/Python 셀 실행 후 결과가 의미 있다고 판단되면 **반드시 `write_cell_memo` 호출**
- 메모 내용 예: "서울·경기가 전체 예약의 62% 차지", "강남점 1개 매장이 서울 매출의 38% — 이상치", "매장 수 대비 예약은 비선형 (log 관계 의심)"
- 전체 분석 요약은 마지막 Markdown 셀로 별도 작성 (메모는 개별 셀 단위 통찰)

## 맥락 수집 우선순위 (SQL 작성 전 필수)
1. 선택된 마트마다 `get_mart_schema` 호출 → 실제 컬럼명 확인
2. 필요시 `preview_mart` 로 샘플 1~5행 확인
3. 요청이 모호하면 즉시 `ask_user`로 재질문 — 추측해서 엉뚱한 쿼리 작성 금지

## 셀 파이프라인 (반드시 준수)
모든 셀은 아래 사이클을 따른다:

  [입력 작성] → [자동 실행] → [출력 확인] → [수정 OR 다음 셀 생성]

- `create_cell` 또는 `update_cell_code`를 호출하면 **자동으로 즉시 실행**되고 tool result에 실제 출력이 포함됨
- 출력을 반드시 확인한 뒤 다음 행동을 결정할 것:
  - 오류 또는 의도와 다른 결과 → `update_cell_code`로 수정 (재실행 자동)
  - 결과가 올바름 → 다음 셀 생성
- `execute_cell`을 직접 호출할 필요 없음 (생성/수정 시 자동 실행됨)

## 한 루프당 한 문단 내레이션 (반드시 준수)
- 도구 실행 결과(tool_result)를 받은 직후 **다음 도구를 호출하기 전에 반드시 짧은 한국어 텍스트 한 문단을 먼저 출력**한다.
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

    created_cell_ids: list[str] = []
    updated_cell_ids: list[str] = []
    MAX_TURNS = 15
    REPEAT_CALL_LIMIT = 3
    repeat_counter: dict[str, int] = {}

    try:
        for _ in range(MAX_TURNS):
            full_text = ""
            response = None

            async with client.messages.stream(
                model=model,
                max_tokens=16000,
                system=system_prompt,
                tools=TOOLS,  # type: ignore[arg-type]
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

            if not tool_uses:
                break

            # 무한 루프 방지: 동일 tool+input 반복 호출 감지
            safety_break = False
            for tb in tool_uses:
                key = f"{tb.name}:{json.dumps(tb.input, sort_keys=True, ensure_ascii=False)}"
                repeat_counter[key] = repeat_counter.get(key, 0) + 1
                if repeat_counter[key] > REPEAT_CALL_LIMIT:
                    yield {
                        "type": "error",
                        "message": f"같은 도구(`{tb.name}`) 를 {REPEAT_CALL_LIMIT}회 초과로 반복 호출해 중단했습니다. "
                                    "Snowflake 연결 또는 입력값을 확인해주세요.",
                    }
                    safety_break = True
                    break
            if safety_break:
                return

            tool_results = []
            for tool_block in tool_uses:
                yield {"type": "tool_use", "tool": tool_block.name, "input": tool_block.input}

                result, sse_events = await _execute_tool(tool_block.name, tool_block.input, notebook_state)

                for sse_event in sse_events:
                    yield sse_event
                    if sse_event["type"] == "cell_created":
                        created_cell_ids.append(sse_event["cell_id"])
                    elif sse_event["type"] == "cell_code_updated":
                        updated_cell_ids.append(sse_event["cell_id"])

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_block.id,
                    "content": json.dumps(result, ensure_ascii=False),
                })

            messages.append({"role": "assistant", "content": _content_to_dict(response.content)})
            messages.append({"role": "user", "content": tool_results})

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
