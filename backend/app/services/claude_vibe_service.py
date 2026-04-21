"""Vibe Chat — Claude API 스트리밍으로 셀 코드 수정 (Gemini 버전과 동일한 프롬프트)"""
import re
from typing import AsyncGenerator, Optional

import anthropic

from .gemini_service import (
    _build_sql_system,
    _build_python_system,
    _clean_code,
    _lowercase_sql,
)


def _build_sql_prompt(current_code: str, message: str) -> str:
    return f"[현재 코드]\n{current_code}\n\n[요청]\n{message}"


async def stream_vibe_chat_claude(
    api_key: str,
    model: str,
    cell_type: str,
    current_code: str,
    message: str,
    selected_marts: list[str],
    mart_metadata: list[dict],
    analysis_theme: str,
    df_summaries: dict[str, str] | None = None,
    cell_above_name: Optional[str] = None,
) -> AsyncGenerator[dict, None]:
    if not api_key:
        yield {"type": "error", "message": "Anthropic API 키가 설정되지 않았습니다."}
        return

    client = anthropic.AsyncAnthropic(api_key=api_key)

    if cell_type == "sql":
        system = _build_sql_system(analysis_theme, mart_metadata)
        prompt = _build_sql_prompt(current_code, message)
    elif cell_type == "python":
        system = _build_python_system(analysis_theme, df_summaries or {}, cell_above_name)
        prompt = f"[현재 코드]\n{current_code}\n\n[요청]\n{message}"
    else:
        system = (
            f"You are a markdown writing assistant. Analysis theme: {analysis_theme}.\n"
            "Output: ONLY the markdown content."
        )
        prompt = f"[현재 내용]\n{current_code}\n\n[요청]\n{message}"

    accumulated = ""
    try:
        async with client.messages.stream(
            model=model,
            max_tokens=8000,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            async for text in stream.text_stream:
                accumulated += text
                yield {"type": "code_delta", "delta": text}
    except anthropic.APIStatusError as e:
        yield {"type": "error", "message": f"Claude 오류: {e.message}"}
        return
    except Exception as e:
        yield {"type": "error", "message": f"오류: {str(e)}"}
        return

    clean = _clean_code(accumulated)
    if cell_type == "sql":
        clean = _lowercase_sql(clean)
    yield {
        "type": "complete",
        "full_code": clean,
        "explanation": f'"{message}" 요청을 반영해 코드를 수정했어요.',
    }
