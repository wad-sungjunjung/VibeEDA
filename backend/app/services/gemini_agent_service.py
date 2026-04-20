"""Agent Mode — Gemini API 함수 호출로 노트북 셀 생성/수정/실행"""
import asyncio
import json
import logging
import re
from typing import AsyncGenerator

from google import genai
from google.genai import types

from .claude_agent import _execute_tool, _build_system_prompt, NotebookState

GENERATE_TIMEOUT_SEC = 300  # Gemini 단일 호출 타임아웃 (5분)
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
    import time as _time
    updated_cell_ids: list[str] = []
    MAX_TURNS = 15
    NARRATION_MIN_CHARS = 20
    LONG_RUN_SEC = 30
    TOTAL_TOOL_LIMIT = 40
    repeat_counter: dict[str, int] = {}  # 동일 툴 호출 반복 감지
    total_tool_calls = 0
    narration_warning_used = False
    long_run_warning_used = False
    loop_started_at = _time.monotonic()
    ask_user_called = False

    def _norm_key(tool_name: str, inp: dict) -> str:
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
        for turn in range(MAX_TURNS):
            retried_for_narration = False
            while True:
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
                text_total = sum(len(getattr(p, "text", "") or "") for p in text_parts)

                # 내레이션 거부: 첫 턴 아니고 tool call 있고 텍스트 부족 → 재요청
                if (turn > 0 and func_call_parts and text_total < NARRATION_MIN_CHARS
                        and not retried_for_narration):
                    retried_for_narration = True
                    yield {"type": "message_delta", "content": "\n\n_[규칙 위반 감지: 텍스트 없이 도구 호출 — 재요청]_\n\n"}
                    contents.append(types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=(
                            "❗ 방금 응답은 텍스트 해설 없이 function_call 만 있었습니다. "
                            "도구를 호출하지 말고, 먼저 한국어 텍스트 한 문단으로 "
                            "(1) 직전 결과 관찰·해석 1~3문장 + (2) 다음 행동·이유를 출력하세요."
                        ))],
                    ))
                    continue
                break

            for p in text_parts:
                yield {"type": "message_delta", "content": p.text}

            if not func_call_parts:
                break

            # 무한 루프 방지: 동일 tool+input 호출 반복 감지
            safety_break = False
            for p in func_call_parts:
                fc = p.function_call
                args = dict(fc.args) if fc.args else {}
                total_tool_calls += 1
                if total_tool_calls > TOTAL_TOOL_LIMIT:
                    yield {
                        "type": "error",
                        "message": f"총 도구 호출이 {TOTAL_TOOL_LIMIT}회를 넘어 중단했습니다. 요청을 더 작게 쪼개거나 모델을 변경해주세요.",
                    }
                    safety_break = True
                    break
                key = _norm_key(fc.name, args)
                repeat_counter[key] = repeat_counter.get(key, 0) + 1
                if repeat_counter[key] > REPEAT_CALL_LIMIT:
                    logger.warning("Gemini repeat-call guard triggered: %s", key)
                    yield {
                        "type": "error",
                        "message": f"같은 도구(`{fc.name}`)를 {REPEAT_CALL_LIMIT}회 초과로 반복 호출해 중단했습니다. "
                                    "Snowflake 연결 또는 입력값을 확인해주세요.",
                    }
                    safety_break = True
                    break
            if safety_break:
                return

            contents.append(candidate.content)

            # 리마인더 준비 (내레이션 규칙 위반은 매 턴 재주입)
            text_total = sum(len(getattr(p, "text", "") or "") for p in text_parts)
            narration_short = turn > 0 and text_total < NARRATION_MIN_CHARS
            elapsed = _time.monotonic() - loop_started_at
            long_run_trigger = elapsed > LONG_RUN_SEC and not long_run_warning_used and not ask_user_called
            reminder_msgs: list[str] = []
            if narration_short:
                reminder_msgs.append(
                    "❗규칙 위반: 직전 응답에 도구 호출 전 해설 텍스트가 없거나 너무 짧았습니다. "
                    "다음 턴에서는 반드시 도구 호출 전에 (1) tool_result 관찰·해석 1~3문장 "
                    "+ (2) 지금 취할 행동과 이유 — 한 문단의 한국어 텍스트를 먼저 출력한 뒤 도구를 호출하세요. "
                    "이 규칙은 매 턴 적용됩니다."
                )
            if long_run_trigger:
                reminder_msgs.append(
                    f"분석이 {int(elapsed)}초째 진행 중입니다. "
                    "지금 시점에서 (1) 현재 선택된 마트로 정말 답이 되는가, "
                    "(2) 질문의 범위·기간·지표가 모호하지 않은가를 자문하세요. "
                    "조금이라도 불확실하면 즉시 `ask_user` 를 호출해 사용자에게 재질문하세요."
                )

            tool_response_parts = []
            for idx, p in enumerate(func_call_parts):
                fc = p.function_call
                args = dict(fc.args) if fc.args else {}
                yield {"type": "tool_use", "tool": fc.name, "input": args}
                if fc.name == "ask_user":
                    ask_user_called = True

                result, sse_events = await _execute_tool(fc.name, args, notebook_state)

                for event in sse_events:
                    yield event
                    if event["type"] == "cell_created":
                        created_cell_ids.append(event["cell_id"])
                    elif event["type"] == "cell_code_updated":
                        updated_cell_ids.append(event["cell_id"])

                payload = dict(result) if isinstance(result, dict) else {"result": result}
                image_b64 = payload.pop("image_png_base64", None)
                if reminder_msgs and idx == len(func_call_parts) - 1:
                    payload["_system_reminder"] = " / ".join(reminder_msgs)

                tool_response_parts.append(
                    types.Part.from_function_response(name=fc.name, response=payload)
                )
                if image_b64:
                    try:
                        import base64 as _b64
                        img_bytes = _b64.b64decode(image_b64)
                        tool_response_parts.append(
                            types.Part.from_bytes(data=img_bytes, mime_type="image/png")
                        )
                    except Exception:
                        pass

            if long_run_trigger:
                long_run_warning_used = True

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
