"""Agent Mode — Gemini API 함수 호출로 노트북 셀 생성/수정/실행"""
import asyncio
import json
import logging
import re
from typing import AsyncGenerator

from google import genai
from google.genai import types

from .claude_agent import (
    _execute_tool,
    _build_system_prompt,
    _auto_execute_after_create_or_update,
    NotebookState,
    PARALLEL_SAFE_TOOLS,
)
from . import agent_skills, agent_tools

GENERATE_TIMEOUT_SEC = 300  # Gemini 단일 호출 타임아웃 (5분)
REPEAT_CALL_LIMIT = 3      # 동일 tool+input 반복 허용 횟수

logger = logging.getLogger(__name__)

# ─── Gemini 함수 선언 (agent_tools 모듈에서 Claude 스펙 자동 변환) ────────────

_FUNC_DECLARATIONS = agent_tools.gemini_function_declarations([])

_GEMINI_TOOL = types.Tool(
    function_declarations=[*_FUNC_DECLARATIONS, *agent_skills.SKILL_TOOLS_GEMINI]  # type: ignore[arg-type]
)


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
    images: list[dict] | None = None,
) -> AsyncGenerator[dict, None]:
    if not api_key:
        yield {"type": "error", "message": "Google Gemini API 키가 설정되지 않았습니다."}
        return

    client = genai.Client(api_key=api_key)
    agent_skills.init_skill_ctx(notebook_state, user_message)
    notebook_state.user_message_latest = user_message
    system_prompt = _build_system_prompt(notebook_state)

    contents = _to_gemini_history(conversation_history)
    if images:
        import base64 as _b64
        user_parts = [
            types.Part.from_bytes(data=_b64.b64decode(img["data"]), mime_type=img["media_type"])
            for img in images
        ]
        user_parts.append(types.Part.from_text(text=user_message))
        contents.append(types.Content(role="user", parts=user_parts))
    else:
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_message)]))

    created_cell_ids: list[str] = []
    import time as _time
    updated_cell_ids: list[str] = []
    MAX_TURNS = 50
    NARRATION_MIN_CHARS = 20
    LONG_RUN_SEC = 30
    TOTAL_TOOL_LIMIT = 200
    repeat_counter: dict[str, int] = {}  # 동일 툴 호출 반복 감지
    total_tool_calls = 0
    narration_warning_used = False
    long_run_warning_used = False
    loop_started_at = _time.monotonic()
    ask_user_called = False
    pending_guard_count = 0
    PENDING_GUARD_MAX = 3

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
                                max_output_tokens=32000,
                                thinking_config=types.ThinkingConfig(include_thoughts=False),
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

                # Gemini 3 계열은 추론 흔적(`thought=True`)을 텍스트 파트로 함께 돌려주는데,
                # 이건 내부 사고로 표시용이 아니라서 사용자에게 노출되면 안 된다.
                text_parts = [
                    p for p in parts
                    if getattr(p, "text", None) and not getattr(p, "thought", False)
                ]
                func_call_parts = [p for p in parts if getattr(p, "function_call", None)]
                text_total = sum(len(getattr(p, "text", "") or "") for p in text_parts)

                # 내레이션 거부: 첫 턴 아니고 tool call 있고 텍스트 부족 → 재요청
                if (turn > 0 and func_call_parts and text_total < NARRATION_MIN_CHARS
                        and not retried_for_narration):
                    retried_for_narration = True
                    # 짧은 텍스트가 이미 버블에 흘러갔다면 재요청 전 비운다 (중복 노출 방지)
                    if text_total > 0:
                        yield {"type": "reset_current_bubble"}
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
                # 차트 퀄리티/메모 강제 가드 — 빠른 모델이 차트 후속 단계를 건너뛰는 문제 대응
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

                end_reminder = agent_skills.get_end_guard_reminder(notebook_state)

                if (pending_msgs or end_reminder) and pending_guard_count < PENDING_GUARD_MAX:
                    pending_guard_count += 1
                    lines = []
                    if pending_msgs:
                        lines.append("❗ 종료 전 필수 후속 작업이 남아 있습니다:")
                        lines.extend(pending_msgs)
                    if end_reminder:
                        if lines:
                            lines.append("")
                        lines.append(end_reminder)
                    reminder_text = "\n".join(lines) + "\n\n이 리마인더에 따라 **지금 바로 해당 도구를 호출**해 마무리하세요. 그냥 종료하지 마세요."
                    contents.append(candidate.content)
                    contents.append(types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=f"[시스템 리마인더]\n{reminder_text}")],
                    ))
                    continue
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
                        "message": (
                            f"세션 안전 상한에 도달했어요 (총 도구 호출 {TOTAL_TOOL_LIMIT}회 초과). "
                            "여기서 일단 멈춥니다. 이어서 진행하려면 **새 메시지로 \"이어서 분석해줘\" "
                            "또는 남은 하위 질문** 을 주시면 현 상태에서 재개합니다. "
                            "매번 새 분석을 더 짧은 단위로 쪼개 요청하는 것도 도움이 돼요."
                        ),
                    }
                    safety_break = True
                    break
                key = _norm_key(fc.name, args)
                repeat_counter[key] = repeat_counter.get(key, 0) + 1
                if repeat_counter[key] > REPEAT_CALL_LIMIT:
                    logger.warning("Gemini repeat-call guard triggered: %s", key)
                    yield {
                        "type": "error",
                        "message": (
                            f"같은 도구(`{fc.name}`)를 {REPEAT_CALL_LIMIT}회 넘게 반복해서 무한 루프 방지를 위해 중단했어요. "
                            "Snowflake 연결 상태나 전달한 입력값(컬럼·마트 이름 등)을 확인해 주시고, "
                            "질문을 조금 더 구체화해서 새 메시지로 다시 요청해주세요."
                        ),
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
            skill_reminders: list[str] = []

            # 이번 턴 내레이션을 state 에 싣어, create_cell/update_cell_code 가 셀 chat history 의 user_msg 로 사용.
            notebook_state.current_turn_narration = "\n".join(
                (getattr(p, "text", "") or "").strip() for p in text_parts
            ).strip()

            # 병렬 안전한 읽기 전용 툴만 한 턴에 호출됐으면 asyncio.gather 로 병렬 실행
            fc_args_list: list[tuple[str, dict]] = []
            for p in func_call_parts:
                fc = p.function_call
                args = dict(fc.args) if fc.args else {}
                fc_args_list.append((fc.name, args))
                yield {"type": "tool_use", "tool": fc.name, "input": args}
                if fc.name in agent_skills.ASK_USER_LIKE_TOOLS:
                    ask_user_called = True

            all_parallel_safe = all(n in PARALLEL_SAFE_TOOLS for n, _ in fc_args_list)
            if all_parallel_safe and len(fc_args_list) > 1:
                exec_results = await asyncio.gather(
                    *[_execute_tool(n, a, notebook_state) for n, a in fc_args_list],
                    return_exceptions=True,
                )
                results_list = []
                for res in exec_results:
                    if isinstance(res, Exception):
                        results_list.append(({"error": "tool_exception", "message": str(res)}, []))
                    else:
                        results_list.append(res)
            else:
                results_list = []
                for n, a in fc_args_list:
                    result, sse_events = await _execute_tool(n, a, notebook_state)
                    # 이벤트 즉시 yield: 프론트가 셀 생성→실행→분석 단계를 실시간으로 보게.
                    for ev in sse_events:
                        yield ev
                        if ev["type"] == "cell_created":
                            created_cell_ids.append(ev["cell_id"])
                        elif ev["type"] == "cell_code_updated":
                            updated_cell_ids.append(ev["cell_id"])
                    # SQL/Python 셀 자동 실행 — 결과는 동일 tool_result 에 머지
                    async for ev in _auto_execute_after_create_or_update(
                        n, a, result, notebook_state
                    ):
                        yield ev
                    # sse_events 는 위에서 이미 흘렸으므로 빈 리스트로 교체 (아래 trailing 루프 중복 방지)
                    results_list.append((result, []))

            for idx, ((name, args), (result, sse_events)) in enumerate(zip(fc_args_list, results_list)):
                for event in sse_events:
                    yield event
                    if event["type"] == "cell_created":
                        created_cell_ids.append(event["cell_id"])
                    elif event["type"] == "cell_code_updated":
                        updated_cell_ids.append(event["cell_id"])

                skill_reminders.extend(
                    agent_skills.collect_post_hook_reminders(name, args, result, notebook_state)
                )

                payload = dict(result) if isinstance(result, dict) else {"result": result}
                image_b64 = payload.pop("image_png_base64", None)
                combined_reminders = list(reminder_msgs) + skill_reminders if idx == len(fc_args_list) - 1 else []
                if combined_reminders:
                    payload["_system_reminder"] = " / ".join(combined_reminders)

                tool_response_parts.append(
                    types.Part.from_function_response(name=name, response=payload)
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
        else:
            # for-else: MAX_TURNS 소진
            yield {
                "type": "error",
                "message": (
                    f"모델 왕복 상한에 도달했어요 (MAX_TURNS={MAX_TURNS}). "
                    "남은 분석이 있다면 **새 메시지로 \"이어서 진행해줘\"** 라고 주시거나, "
                    "다음 단계를 더 짧게 쪼개서 다시 요청해주세요."
                ),
            }
            return

    except Exception as e:
        logger.exception("Gemini agent error")
        yield {"type": "error", "message": f"Gemini 에이전트 오류: {str(e)}"}
        return

    yield {
        "type": "complete",
        "created_cell_ids": created_cell_ids,
        "updated_cell_ids": updated_cell_ids,
    }
