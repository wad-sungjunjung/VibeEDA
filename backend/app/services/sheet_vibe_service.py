"""Sheet Vibe — 스프레드시트 셀의 자연어 요청을 값/수식 패치 JSON 으로 변환."""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """당신은 구글 시트/엑셀 스프레드시트를 편집하는 도우미입니다.
사용자의 자연어 요청을 받아 **JSON 패치 배열** 만 반환합니다.

## 반환 포맷 (엄격)
```json
{
  "patches": [
    {"range": "A1", "value": "매출"},
    {"range": "B2", "value": 12345},
    {"range": "B10", "value": "=SUM(B2:B9)"}
  ],
  "explanation": "한 줄 한국어 설명"
}
```

## 규칙
- `range` 는 A1 표기법. 단일 셀만 허용(범위 X). 여러 셀 쓰려면 각각 객체로 반환.
- `value` 는 문자열/숫자/불리언. 수식은 반드시 `=` 로 시작.
- 수식은 표준 스프레드시트 함수 사용: SUM, AVERAGE, COUNT, IF, VLOOKUP, INDEX, MATCH 등.
- 사용자가 "선택된 범위"라고 하면 제공된 `selection` 기준으로 추론.
- 기존 값을 참고해 합리적인 결과를 만듦. 예: 선택이 B2:B9 고 "합계 내려줘" → B10 에 =SUM(B2:B9).
- 설명은 간결히 한 문장. 장황 금지.
- 반드시 위 JSON 포맷만 반환. markdown fence 도 가능.

## 예시
사용자: "A1:A5 평균을 A6에"
→ {"patches":[{"range":"A6","value":"=AVERAGE(A1:A5)"}],"explanation":"A6에 A1:A5 평균 수식 삽입"}

사용자: "선택 영역 오른쪽에 전월 대비 증감률"
(selection=B2:B5, 왼쪽 A2:A5 에 값 있음 가정)
→ 각 행마다 C2..C5 에 =B2/A2-1 같은 수식.
"""


def _build_context(
    selection: Optional[str],
    data_region: list[list[object]],
    data_origin: str,
    message: str,
) -> str:
    parts = []
    if selection:
        parts.append(f"현재 선택 범위: {selection}")
    if data_region:
        # 가독성을 위해 TSV 형태로 압축, 최대 30행 x 20열
        trimmed = [row[:20] for row in data_region[:30]]
        lines = []
        for i, row in enumerate(trimmed):
            cells = [("" if v is None else str(v)) for v in row]
            lines.append(f"[{i+1}] " + "\t".join(cells))
        parts.append(f"현재 시트 내용 ({data_origin} 기준):\n" + "\n".join(lines))
    parts.append(f"사용자 요청: {message}")
    return "\n\n".join(parts)


def _extract_json(text: str) -> dict:
    # ```json ... ``` 펜스 제거
    t = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", t, re.DOTALL)
    if m:
        t = m.group(1)
    else:
        # 첫 { 부터 마지막 } 까지 추출
        i = t.find("{")
        j = t.rfind("}")
        if i != -1 and j != -1 and j > i:
            t = t[i : j + 1]
    return json.loads(t)


async def vibe_sheet_claude(
    api_key: str,
    model: str,
    message: str,
    selection: Optional[str],
    data_region: list[list[object]],
    data_origin: str = "A1",
) -> dict:
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=api_key)
    user_prompt = _build_context(selection, data_region, data_origin, message)
    resp = await client.messages.create(
        model=model,
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    return _extract_json(text)


async def vibe_sheet_gemini(
    api_key: str,
    model: str,
    message: str,
    selection: Optional[str],
    data_region: list[list[object]],
    data_origin: str = "A1",
) -> dict:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    user_prompt = _build_context(selection, data_region, data_origin, message)
    resp = await client.aio.models.generate_content(
        model=model,
        contents=user_prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
        ),
    )
    return _extract_json(resp.text or "{}")


async def vibe_sheet(
    *,
    use_claude: bool,
    api_key: str,
    model: str,
    message: str,
    selection: Optional[str],
    data_region: list[list[object]],
    data_origin: str = "A1",
) -> dict:
    try:
        if use_claude:
            result = await vibe_sheet_claude(api_key, model, message, selection, data_region, data_origin)
        else:
            result = await vibe_sheet_gemini(api_key, model, message, selection, data_region, data_origin)
    except Exception as e:
        logger.exception("sheet vibe failed")
        return {"patches": [], "explanation": f"오류: {e}"}
    # 안전 검증
    patches = result.get("patches") or []
    valid = []
    for p in patches:
        if not isinstance(p, dict):
            continue
        rng = p.get("range")
        val = p.get("value")
        if isinstance(rng, str) and rng and val is not None:
            valid.append({"range": rng.upper(), "value": val})
    return {
        "patches": valid,
        "explanation": str(result.get("explanation", ""))[:200],
    }
