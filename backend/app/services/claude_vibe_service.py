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
    return (
        f"아래 예시를 보고 동일한 스타일로 SQL을 재작성하라.\n\n"
        f"## 변환 예시\n"
        f"### Before (이런 스타일은 절대 출력하지 말 것)\n"
        f"```sql\n"
        f"SELECT SI_DO_NAME, COUNT(DISTINCT SHOP_ID) AS shop_count\n"
        f"FROM dim_shop_base GROUP BY SI_DO_NAME ORDER BY SI_DO_NAME\n"
        f"```\n\n"
        f"### After (반드시 이 스타일로 출력)\n"
        f"```sql\n"
        f"WITH shop_cnt AS (\n"
        f"    SELECT\n"
        f"        CASE WHEN GROUPING(si_do_name) = 1 THEN '0. 전체' ELSE si_do_name END AS si_do_name,\n"
        f"        COUNT(DISTINCT shop_id) AS \"매장수\"\n"
        f"    FROM dim_shop_base\n"
        f"    GROUP BY GROUPING SETS ((si_do_name), ())\n"
        f")\nSELECT * FROM shop_cnt ORDER BY ALL\n"
        f"```\n\n"
        f"## 현재 코드\n{current_code}\n\n"
        f"## 요청\n{message}\n\n"
        f"After 스타일로 재작성한 SQL 코드만 출력하라 (설명, 마크다운 fence 금지):"
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
        prompt = (
            f"아래 Python 코드를 요청에 맞게 수정하라.\n\n"
            f"[현재 코드]\n{current_code}\n\n"
            f"[요청]\n{message}\n\n"
            f"[필수 규칙]\n"
            f"- 시각화 결과는 반드시 마지막 줄을 변수 참조로 끝낼 것\n"
            f"- 변수명은 fig_<주제>_<차트타입> 형식 (예: fig_sido_bar)\n\n"
            f"Python 코드만 출력하라:"
        )
    else:
        system = (
            f"You are a markdown writing assistant. Analysis theme: {analysis_theme}.\n"
            "Output: ONLY the markdown content."
        )
        prompt = f"[현재 내용]\n{current_code}\n\n[요청]\n{message}\n\n마크다운 내용만 출력하라:"

    accumulated = ""
    try:
        async with client.messages.stream(
            model=model,
            max_tokens=4096,
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
