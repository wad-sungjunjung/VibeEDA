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
