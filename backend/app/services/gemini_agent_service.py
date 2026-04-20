"""Agent Mode — Gemini API 함수 호출로 노트북 셀 생성/수정/실행"""
import asyncio
import json
import logging
from typing import AsyncGenerator

from google import genai
from google.genai import types

from .claude_agent import _execute_tool, _build_system_prompt, NotebookState

GENERATE_TIMEOUT_SEC = 90  # Gemini 단일 호출 타임아웃
REPEAT_CALL_LIMIT = 3      # 동일 tool+input 반복 허용 횟수

logger = logging.getLogger(__name__)

# ─── Gemini 함수 선언 (Claude TOOLS와 동일한 스펙) ──────────────────────────

_FUNC_DECLARATIONS = [
    {
        "name": "read_notebook_context",
        "description": "Read the current state of all cells in the notebook, including code, execution status, and output summary.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "create_cell",
        "description": "Create a new cell in the notebook with initial code.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "cell_type": {"type": "STRING", "enum": ["sql", "python", "markdown"]},
                "name": {"type": "STRING"},
                "code": {"type": "STRING"},
                "after_cell_id": {"type": "STRING"},
            },
            "required": ["cell_type", "code"],
        },
    },
    {
        "name": "update_cell_code",
        "description": "Update the code of an existing cell.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "cell_id": {"type": "STRING"},
                "code": {"type": "STRING"},
            },
            "required": ["cell_id", "code"],
        },
    },
    {
        "name": "execute_cell",
        "description": "Execute a cell against the real Snowflake DB or Python kernel and get its actual output.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"cell_id": {"type": "STRING"}},
            "required": ["cell_id"],
        },
    },
    {
        "name": "read_cell_output",
        "description": "Read the output of an already-executed cell.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"cell_id": {"type": "STRING"}},
            "required": ["cell_id"],
        },
    },
    {
        "name": "get_mart_schema",
        "description": "Get column schema of a mart. Call before writing SQL.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"mart_key": {"type": "STRING"}},
            "required": ["mart_key"],
        },
    },
    {
        "name": "preview_mart",
        "description": "Fetch top N rows from a mart without creating a cell.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "mart_key": {"type": "STRING"},
                "limit": {"type": "INTEGER"},
            },
            "required": ["mart_key"],
        },
    },
    {
        "name": "profile_mart",
        "description": "Profile a mart: row count, NULL ratio, distinct, numeric stats.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"mart_key": {"type": "STRING"}},
            "required": ["mart_key"],
        },
    },
    {
        "name": "write_cell_memo",
        "description": "Record insight about a cell's output into its memo (2~5줄 한국어).",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "cell_id": {"type": "STRING"},
                "memo": {"type": "STRING"},
            },
            "required": ["cell_id", "memo"],
        },
    },
    {
        "name": "ask_user",
        "description": "Ask user for clarification. Stop calling tools after this.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "question": {"type": "STRING"},
                "options": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
            "required": ["question"],
        },
    },
]

_GEMINI_TOOL = types.Tool(function_declarations=_FUNC_DECLARATIONS)  # type: ignore[arg-type]


def _to_gemini_history(conversation_history: list[dict]) -> list:
    """Claude 형식(user/assistant) → Gemini 형식(user/model) 변환"""
    result = []
    for msg in conversation_history:
        role = "model" if msg["role"] == "assistant" else "user"
        result.append(types.Content(role=role, parts=[types.Part.from_text(text=msg["content"])]))
    return result


async def run_agent_stream_gemini(
    api_key: str,
    model: str,
    user_message: str,
    notebook_state: NotebookState,
    conversation_history: list[dict],
) -> AsyncGenerator[dict, None]:
    if not api_key:
        yield {"type": "error", "message": "Google Gemini API 키가 설정되지 않았습니다."}
        return

    client = genai.Client(api_key=api_key)
    system_prompt = _build_system_prompt(notebook_state)

    contents = _to_gemini_history(conversation_history)
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_message)]))

    created_cell_ids: list[str] = []
    updated_cell_ids: list[str] = []
    MAX_TURNS = 15
    repeat_counter: dict[str, int] = {}  # 동일 툴 호출 반복 감지

    try:
        for turn in range(MAX_TURNS):
            try:
                response = await asyncio.wait_for(
                    client.aio.models.generate_content(
                        model=model,
                        contents=contents,
                        config=types.GenerateContentConfig(
                            system_instruction=system_prompt,
                            tools=[_GEMINI_TOOL],
                            temperature=0.2,
                        ),
                    ),
                    timeout=GENERATE_TIMEOUT_SEC,
                )
            except asyncio.TimeoutError:
                logger.error("Gemini generate_content timeout after %ss (turn=%d)", GENERATE_TIMEOUT_SEC, turn)
                yield {
                    "type": "error",
                    "message": f"Gemini 응답이 {GENERATE_TIMEOUT_SEC}초 내에 오지 않아 중단했습니다. 모델을 Gemini 2.5 Pro로 변경하거나 잠시 후 다시 시도해주세요.",
                }
                return

            if not response.candidates:
                yield {"type": "error", "message": "Gemini가 빈 응답을 반환했습니다."}
                return

            candidate = response.candidates[0]
            parts = (candidate.content.parts if candidate.content else None) or []

            text_parts = [p for p in parts if getattr(p, "text", None)]
            func_call_parts = [p for p in parts if getattr(p, "function_call", None)]

            for p in text_parts:
                yield {"type": "message_delta", "content": p.text}

            if not func_call_parts:
                break

            # 무한 루프 방지: 동일 tool+input 호출 반복 감지
            safety_break = False
            for p in func_call_parts:
                fc = p.function_call
                args = dict(fc.args) if fc.args else {}
                key = f"{fc.name}:{json.dumps(args, sort_keys=True, ensure_ascii=False)}"
                repeat_counter[key] = repeat_counter.get(key, 0) + 1
                if repeat_counter[key] > REPEAT_CALL_LIMIT:
                    logger.warning("Gemini repeat-call guard triggered: %s", key)
                    yield {
                        "type": "error",
                        "message": f"같은 도구(`{fc.name}`) 를 {REPEAT_CALL_LIMIT}회 초과로 반복 호출해 중단했습니다. "
                                    "Snowflake 연결 또는 입력값을 확인해주세요.",
                    }
                    safety_break = True
                    break
            if safety_break:
                return

            contents.append(candidate.content)

            tool_response_parts = []
            for p in func_call_parts:
                fc = p.function_call
                args = dict(fc.args) if fc.args else {}
                yield {"type": "tool_use", "tool": fc.name, "input": args}

                result, sse_events = await _execute_tool(fc.name, args, notebook_state)

                for event in sse_events:
                    yield event
                    if event["type"] == "cell_created":
                        created_cell_ids.append(event["cell_id"])
                    elif event["type"] == "cell_code_updated":
                        updated_cell_ids.append(event["cell_id"])

                tool_response_parts.append(
                    types.Part.from_function_response(name=fc.name, response=result)
                )

            contents.append(types.Content(role="user", parts=tool_response_parts))

    except Exception as e:
        logger.exception("Gemini agent error")
        yield {"type": "error", "message": f"Gemini 에이전트 오류: {str(e)}"}
        return

    yield {
        "type": "complete",
        "created_cell_ids": created_cell_ids,
        "updated_cell_ids": updated_cell_ids,
    }
