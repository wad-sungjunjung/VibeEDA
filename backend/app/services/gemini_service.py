import re
from typing import AsyncGenerator, Optional
from google import genai
from google.genai import types

from .code_style import SQL_STYLE_GUIDE as _SQL_STYLE_GUIDE, PYTHON_RULES as _PYTHON_RULES


def _clean_code(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```[a-z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    return text.strip()


def _lowercase_sql(sql: str) -> str:
    # 싱글쿼트 문자열 리터럴은 보존, 나머지(식별자·키워드)는 소문자로
    parts = re.split(r"('(?:''|[^'])*')", sql)
    return "".join(
        part if i % 2 == 1 else part.lower()
        for i, part in enumerate(parts)
    )



def _build_sql_system(analysis_theme: str, mart_metadata: list[dict]) -> str:
    schema_lines = []
    for mart in mart_metadata:
        cols = ", ".join(
            f"{c['name']} ({c['type']})" + (f" — {c['desc']}" if c.get("desc") else "")
            for c in mart.get("columns", [])
        )
        schema_lines.append(
            f"  [{mart['key']}] {mart.get('description', '')}\n    Columns: {cols}"
        )
    schema_block = "\n".join(schema_lines) if schema_lines else "  (선택된 마트 없음)"

    return (
        "You are a precise Snowflake SQL expert for an ad platform analytics tool.\n"
        f"Analysis theme: {analysis_theme}\n\n"
        f"Available marts (Snowflake tables):\n{schema_block}\n\n"
        f"{_SQL_STYLE_GUIDE}\n"
        "Output: ONLY the SQL code. No explanations, no markdown fences."
    )


def _build_python_system(
    analysis_theme: str,
    df_summaries: dict[str, str],
    cell_above_name: Optional[str],
) -> str:
    if df_summaries:
        df_blocks = []
        for name, info in df_summaries.items():
            priority = " ★ (바로 위 셀 — 최우선 사용)" if name == cell_above_name else ""
            df_blocks.append(f"### DataFrame: `{name}`{priority}\n{info}")
        df_context = "\n\n".join(df_blocks)
    else:
        df_context = "  (아직 실행된 SQL 셀 없음 — 빈 DataFrame 처리 주의)"

    priority_hint = (
        f"\n우선순위: `{cell_above_name}` DataFrame을 가장 먼저 고려하라 (바로 위 셀 결과)."
        if cell_above_name
        else ""
    )

    return (
        "You are a precise Python data analyst for an ad platform analytics tool.\n"
        f"Analysis theme: {analysis_theme}\n\n"
        f"## 사용 가능한 DataFrame\n{df_context}\n"
        f"{priority_hint}\n\n"
        f"{_PYTHON_RULES}\n"
        "Output: ONLY the Python code. No explanations, no markdown fences."
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
) -> AsyncGenerator[dict, None]:
    if not api_key:
        yield {"type": "error", "message": "Gemini API 키가 설정되지 않았습니다."}
        return

    client = genai.Client(api_key=api_key)

    if cell_type == "sql":
        system_instruction = _build_sql_system(analysis_theme, mart_metadata)
    elif cell_type == "python":
        system_instruction = _build_python_system(
            analysis_theme, df_summaries or {}, cell_above_name
        )
    else:
        system_instruction = (
            f"You are a markdown writing assistant. Analysis theme: {analysis_theme}.\n"
            "Output: ONLY the markdown content."
        )

    if cell_type == "sql":
        prompt = (
            f"아래 예시를 보고 동일한 스타일로 SQL을 재작성하라.\n\n"
            f"## 변환 예시\n"
            f"### Before (이런 스타일은 절대 출력하지 말 것)\n"
            f"```sql\n"
            f"SELECT\n"
            f"    SI_DO_NAME,\n"
            f"    SI_GUN_GU_NAME,\n"
            f"    COUNT(DISTINCT SHOP_ID) AS shop_count\n"
            f"FROM dim_shop_base\n"
            f"GROUP BY SI_DO_NAME, SI_GUN_GU_NAME\n"
            f"ORDER BY SI_DO_NAME\n"
            f"```\n\n"
            f"### After (반드시 이 스타일로 출력)\n"
            f"```sql\n"
            f"WITH shop_cnt AS (\n"
            f"    SELECT\n"
            f"        CASE WHEN GROUPING(si_do_name) = 1 THEN '0. 전체' ELSE si_do_name END AS si_do_name,\n"
            f"        CASE WHEN GROUPING(si_gun_gu_name) = 1 THEN '0. 전체' ELSE si_gun_gu_name END AS si_gun_gu_name,\n"
            f"        COUNT(DISTINCT shop_id) AS \"매장수\"\n"
            f"    FROM dim_shop_base\n"
            f"    GROUP BY GROUPING SETS (\n"
            f"        (si_do_name, si_gun_gu_name),\n"
            f"        (si_do_name),\n"
            f"        ()\n"
            f"    )\n"
            f")\n"
            f"SELECT *\n"
            f"FROM shop_cnt\n"
            f"ORDER BY ALL\n"
            f"```\n\n"
            f"## 스타일 규칙 (After 예시에서 반드시 확인)\n"
            f"- 컬럼명·테이블명은 모두 소문자 스네이크케이스 (si_do_name, shop_id, dim_shop_base)\n"
            f"- 전체를 WITH ... AS (...) CTE로 감쌀 것\n"
            f"- GROUP BY → 반드시 GROUPING SETS으로 대체\n"
            f"- CASE WHEN GROUPING(col)=1 THEN '0. 전체' ELSE col END 패턴\n"
            f"- 집계 컬럼 별칭은 한국어 큰따옴표 (\"매장수\")\n"
            f"- ORDER BY ALL\n\n"
            f"## 현재 코드\n{current_code}\n\n"
            f"## 요청\n{message}\n\n"
            f"After 스타일로 재작성한 SQL 코드만 출력하라 (설명, 마크다운 fence 금지):"
        )
    elif cell_type == "python":
        prompt = (
            f"아래 Python 코드를 요청에 맞게 수정하라.\n\n"
            f"[현재 코드]\n{current_code}\n\n"
            f"[요청]\n{message}\n\n"
            f"[필수 규칙]\n"
            f"- 시각화 결과는 반드시 마지막 줄을 변수 참조로 끝낼 것\n"
            f"- 변수명은 fig_<주제>_<차트타입> 형식 (예: fig_sido_bar, fig_daily_trend_line)\n"
            f"- `fig` 단독 사용 절대 금지 — 주제와 차트 유형을 반드시 포함할 것\n\n"
            f"Python 코드만 출력하라:"
        )
    else:
        prompt = (
            f"[현재 내용]\n{current_code}\n\n"
            f"[요청]\n{message}\n\n"
            f"마크다운 내용만 출력하라:"
        )

    accumulated = ""
    try:
        async for chunk in await client.aio.models.generate_content_stream(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.2,
            ),
        ):
            if chunk.text:
                accumulated += chunk.text
                yield {"type": "code_delta", "delta": chunk.text}
    except Exception as e:
        yield {"type": "error", "message": f"Gemini 오류: {str(e)}"}
        return

    clean = _clean_code(accumulated)
    if cell_type == "sql":
        clean = _lowercase_sql(clean)
    yield {
        "type": "complete",
        "full_code": clean,
        "explanation": f'"{message}" 요청을 반영해 코드를 수정했어요.',
    }
