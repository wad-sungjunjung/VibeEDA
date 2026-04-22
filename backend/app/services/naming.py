"""셀 이름 새니타이저 — 영문 소문자/숫자/언더스코어만 허용 (snake_case)."""
import re

_VALID_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


def to_snake_case(name: str, fallback: str = "cell") -> str:
    """임의 문자열을 유효한 snake_case 식별자로 변환.

    - 영문 대문자 → 소문자
    - 공백/하이픈/점 → 언더스코어
    - [a-z0-9_] 외 문자(한글 등) 제거
    - 연속 언더스코어 축약, 양끝 언더스코어 제거
    - 숫자로 시작하거나 빈 문자열이면 fallback prefix
    """
    if not name:
        return fallback
    s = name.strip().lower()
    s = re.sub(r"[\s\-.]+", "_", s)
    s = re.sub(r"[^a-z0-9_]", "", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        return fallback
    if s[0].isdigit():
        s = f"{fallback}_{s}"
    return s


def is_valid_snake_name(name: str) -> bool:
    return bool(name) and _VALID_RE.match(name) is not None


# ─── LLM 기반 셀명 추천 ────────────────────────────────────────────────

_CHEAPEST_GEMINI = "gemini-2.5-flash-lite"
_CHEAPEST_CLAUDE = "claude-haiku-4-5-20251001"

_NAME_PROMPT_TEMPLATE = (
    "아래 셀({cell_type})의 내용을 읽고 목적을 요약하는 짧은 snake_case 식별자 하나만 출력해.\n"
    "규칙: 영문 소문자+숫자+언더스코어만, 최대 30자, 가장 핵심적인 동작/대상을 담아. "
    "설명/따옴표/코드블록 금지, 식별자 한 줄만.\n\n"
    "[셀 내용]\n{code}\n"
)


async def suggest_name_from_code(
    code: str,
    cell_type: str,
    gemini_api_key: str | None,
    anthropic_api_key: str | None,
    fallback: str = "cell",
) -> str:
    """셀 코드로부터 snake_case 이름을 LLM(가장 저렴한 모델)으로 추천."""
    snippet = (code or "").strip()
    if not snippet:
        return fallback
    if len(snippet) > 4000:
        snippet = snippet[:4000]

    prompt = _NAME_PROMPT_TEMPLATE.format(cell_type=cell_type or "cell", code=snippet)
    text = ""

    if gemini_api_key:
        from google import genai  # 지연 임포트
        client = genai.Client(api_key=gemini_api_key)
        resp = await client.aio.models.generate_content(
            model=_CHEAPEST_GEMINI,
            contents=prompt,
        )
        text = (resp.text or "").strip()
    elif anthropic_api_key:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=anthropic_api_key)
        msg = await client.messages.create(
            model=_CHEAPEST_CLAUDE,
            max_tokens=64,
            messages=[{"role": "user", "content": prompt}],
        )
        parts = [b.text for b in msg.content if getattr(b, "type", None) == "text"]
        text = "".join(parts).strip()
    else:
        raise ValueError("LLM API 키가 없음 (Gemini 또는 Claude)")

    # 응답 첫 줄만 사용 + snake_case 새니타이즈
    first_line = text.splitlines()[0] if text else ""
    return to_snake_case(first_line, fallback=fallback)
