import base64
from typing import AsyncGenerator, Optional
from google import genai
from google.genai import types

from .vibe_prompts import (
    build_sql_system,
    build_python_system,
    build_markdown_system,
    build_user_prompt,
    clean_code,
    lowercase_sql,
)


async def stream_vibe_chat(
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
        yield {"type": "error", "message": "Gemini API 키가 설정되지 않았습니다."}
        return

    client = genai.Client(api_key=api_key)

    if cell_type == "sql":
        system_instruction = build_sql_system(analysis_theme, mart_metadata)
    elif cell_type == "python":
        system_instruction = build_python_system(
            analysis_theme, df_summaries or {}, cell_above_name
        )
    else:
        system_instruction = build_markdown_system(analysis_theme)

    prompt = build_user_prompt(current_code, message, current_output_summary)

    parts: list = []
    for img in (images or []):
        parts.append(types.Part.from_bytes(data=base64.b64decode(img["data"]), mime_type=img["media_type"]))
    parts.append(types.Part.from_text(text=prompt))
    contents = types.Content(role="user", parts=parts)

    accumulated = ""
    try:
        async for chunk in await client.aio.models.generate_content_stream(
            model=model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.2,
                max_output_tokens=8000,
                thinking_config=types.ThinkingConfig(include_thoughts=False),
            ),
        ):
            if chunk.text:
                accumulated += chunk.text
                yield {"type": "code_delta", "delta": chunk.text}
    except Exception as e:
        yield {"type": "error", "message": f"Gemini 오류: {str(e)}"}
        return

    clean = clean_code(accumulated)
    if cell_type == "sql":
        clean = lowercase_sql(clean)
    yield {
        "type": "complete",
        "full_code": clean,
        "explanation": f'"{message}" 요청을 반영해 코드를 수정했어요.',
    }
