"""Vibe Chat — Claude API 스트리밍으로 셀 코드 수정 (Gemini 버전과 동일한 프롬프트)"""
from typing import AsyncGenerator, Optional

import anthropic

from .vibe_prompts import (
    build_sql_system,
    build_python_system,
    build_markdown_system,
    build_user_prompt,
    clean_code,
    lowercase_sql,
)


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
    images: list[dict] | None = None,
    current_output_summary: str = "",
) -> AsyncGenerator[dict, None]:
    if not api_key:
        yield {"type": "error", "message": "Anthropic API 키가 설정되지 않았습니다."}
        return

    client = anthropic.AsyncAnthropic(api_key=api_key)

    if cell_type == "sql":
        system = build_sql_system(analysis_theme, mart_metadata)
    elif cell_type == "python":
        system = build_python_system(analysis_theme, df_summaries or {}, cell_above_name)
    else:
        system = build_markdown_system(analysis_theme)

    prompt = build_user_prompt(current_code, message, current_output_summary)

    user_content: list[dict] = []
    for img in (images or []):
        user_content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": img["media_type"], "data": img["data"]},
        })
    user_content.append({"type": "text", "text": prompt})

    accumulated = ""
    try:
        async with client.messages.stream(
            model=model,
            max_tokens=8000,
            system=system,
            messages=[{"role": "user", "content": user_content}],
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

    clean = clean_code(accumulated)
    if cell_type == "sql":
        clean = lowercase_sql(clean)
    yield {
        "type": "complete",
        "full_code": clean,
        "explanation": f'"{message}" 요청을 반영해 코드를 수정했어요.',
    }
