"""에이전트 요청 복잡도 분류기 — 휴리스틱 우선, 애매하면 Haiku fallback.

분류 단계:
  [1] heuristic — 강한 신호로 L1 또는 L3 즉시 확정. 애매하면 None.
  [2] haiku fallback — 1~2초 + ~$0.001. 휴리스틱이 None 일 때만.
  [3] 둘 다 None 이면 안전한 기본값으로 L2 폴백.

오분류 비대칭성: L3→L1 (deep 을 quick 로) 가 더 위험.
→ 휴리스틱은 **상향 편향**. 애매하면 더 높은 tier 로 흘러가게.

운영 원칙:
- 휴리스틱 룰을 한 줄로 명확히 → reason 필드로 노출 (디버깅·텔레메트리).
- 키워드 셋은 한국어 / 영어 둘 다.
- 사용자가 후속 메시지에서 "더 깊게" override → 휴리스틱 무시 (state.budget.user_overridden=True).
- Haiku 호출은 **best-effort** — 실패·타임아웃 시 무음 폴백.
- 캐시: in-process dict, key = sha1(message[:200]) — 같은 메시지 반복 시 호출 절약.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass
from typing import Optional

from .agent_budget import Tier

logger = logging.getLogger(__name__)


# ─── 키워드 셋 ────────────────────────────────────────────────────────────────

# L1 강신호: 이 단어가 짧은 메시지에 단독으로 나오면 즉시 L1.
# 단순 집계 / 단일 lookup 성격.
_L1_KEYWORDS = {
    # ko
    "총합", "총", "총계", "총수", "합계", "합", "평균", "개수", "건수", "행수",
    "row 수", "row수", "최대", "최소", "최댓값", "최솟값", "중앙값",
    # en
    "count", "sum", "avg", "average", "min", "max", "median", "rowcount",
    "total",
}

# L3 강신호: 이 단어들이 등장하면 통상 다중 메서드 분석.
# (개별로 등장만 해도 L3 후보, 2개 이상 조합되면 확정.)
_L3_KEYWORDS = {
    # ko - 깊이/다중 분석
    "종합", "전반", "전체적으로", "정리", "보고서", "리포트", "임원", "발표",
    "분석하고", "정리해줘", "정리해주세요", "리포트로", "보고서로",
    # 메서드 키워드 — 두 개 이상 조합되면 다중 메서드
    "예측", "추세", "포캐스팅", "forecast",
    "원인", "왜", "추론", "인과", "효과", "영향",
    "분류", "클러스터", "모델링", "ML", "머신러닝", "특성중요도", "shap",
    "A/B", "AB테스트", "실험", "통제", "처치",
    "세그먼트", "코호트", "분해",
}

# L3 매우 강한 신호 — 이거 하나만 있어도 L3 확정.
_L3_STRONG_SIGNALS = {
    "종합 분석", "전반 분석", "임원 보고", "보고서로 정리", "리포트로 정리",
    "분석하고 예측", "분석하고 정리", "예측해서 정리",
    "다 분석", "모두 분석", "다양하게 분석",
}

# 깊이 분석 힌트 — 길이와 무관하게 L1 으로 떨어지지 않게 하는 시그널.
_DEEP_HINTS = {
    "분석", "비교", "탐색", "패턴", "변화", "추이",
    "분포", "구조", "특성",
    "explore", "compare", "analyze", "pattern", "trend",
}

# 명확한 L1 패턴 (정규식) — 사용자가 진짜 단순 lookup 요청.
_L1_PATTERNS = [
    re.compile(r"^\s*[\w가-힣\s]{0,15}(개수|건수|총합|합계|평균)[가-힣\s\?\.]*$"),
    re.compile(r"^\s*[\w가-힣\s]{0,20}(알려|보여)\s*줘\.?\?*\s*$"),
    re.compile(r"^\s*how many\b", re.IGNORECASE),
    re.compile(r"^\s*what is the\s+(total|count|sum|average|max|min)\b", re.IGNORECASE),
]


# ─── 분류 결과 ────────────────────────────────────────────────────────────────


@dataclass
class ClassificationResult:
    tier: Optional[Tier]   # None 이면 휴리스틱이 결정 못 했고 fallback 필요
    reason: str            # 한 줄 사유 — 텔레메트리 / 디버깅
    method: str            # 'heuristic' | 'haiku' | 'override' | 'default'


# ─── 휴리스틱 분류 ────────────────────────────────────────────────────────────


def classify_heuristic(
    message: str,
    *,
    mart_count: int = 0,
    has_image: bool = False,
    history_depth: int = 0,
) -> ClassificationResult:
    """글자수 + 키워드 + 컨텍스트 시그널로 분류.

    Args:
        message: 사용자 요청 본문
        mart_count: 선택된 마트 수 (≥3 이면 L3 후보)
        has_image: 이미지 첨부 여부 (있으면 L3 후보)
        history_depth: 대화 히스토리 길이 (5+ 이면 깊은 컨텍스트)

    Returns:
        ClassificationResult — tier 가 None 이면 fallback 필요.
    """
    msg = (message or "").strip()
    if not msg:
        return ClassificationResult(tier="L1", reason="empty_message", method="heuristic")

    msg_low = msg.lower()
    char_len = len(msg)

    # ─── L3 강신호 즉시 매칭 ────────────────────────────────────────────────
    for sig in _L3_STRONG_SIGNALS:
        if sig in msg_low:
            return ClassificationResult(
                tier="L3",
                reason=f"L3_strong_signal: '{sig}'",
                method="heuristic",
            )

    # ─── 컨텍스트 강신호 ────────────────────────────────────────────────────
    if mart_count >= 3:
        return ClassificationResult(
            tier="L3",
            reason=f"multi_mart: {mart_count} marts selected",
            method="heuristic",
        )

    if has_image:
        # 이미지 첨부 = 통상 차트 분석/벤치마크 요청 — 시간 충분히 줘야 함
        return ClassificationResult(
            tier="L3",
            reason="image_attached",
            method="heuristic",
        )

    # ─── L3 약신호 카운트 ────────────────────────────────────────────────────
    l3_hits = [k for k in _L3_KEYWORDS if k in msg_low]
    if len(l3_hits) >= 2:
        return ClassificationResult(
            tier="L3",
            reason=f"L3_keywords: {l3_hits[:3]}",
            method="heuristic",
        )

    # 매우 긴 요청 (200자+) → L3
    if char_len > 200:
        return ClassificationResult(
            tier="L3",
            reason=f"long_request: {char_len} chars",
            method="heuristic",
        )

    # ─── L1 강신호 (짧고 단순 집계) ──────────────────────────────────────────
    # 깊이 힌트가 하나라도 있으면 L1 후보에서 제외 — 길이 무관
    has_deep_hint = any(k in msg_low for k in _DEEP_HINTS)

    if not has_deep_hint:
        # 정규식 패턴 매칭
        for pat in _L1_PATTERNS:
            if pat.search(msg):
                return ClassificationResult(
                    tier="L1",
                    reason=f"L1_pattern: {pat.pattern[:40]}",
                    method="heuristic",
                )

        # 짧고 단일 집계 키워드 포함 → L1
        if char_len < 25:
            l1_hits = [k for k in _L1_KEYWORDS if k in msg_low]
            if l1_hits:
                return ClassificationResult(
                    tier="L1",
                    reason=f"short_aggregation: '{l1_hits[0]}'",
                    method="heuristic",
                )
            # 짧지만 단순 lookup 도 아닌 — 애매. fallback 으로.
            return ClassificationResult(
                tier=None, reason="short_but_unclear", method="heuristic",
            )

    # ─── L3 약신호 1개만 — 애매. fallback 으로 ────────────────────────────────
    if len(l3_hits) == 1:
        return ClassificationResult(
            tier=None,
            reason=f"single_L3_hit: '{l3_hits[0]}' — needs fallback",
            method="heuristic",
        )

    # ─── 깊은 컨텍스트 + 중간 길이 ────────────────────────────────────────────
    if history_depth >= 5 and char_len >= 50:
        # 대화가 길어졌고 후속 요청이 짧지 않음 → L2 가 안전
        return ClassificationResult(
            tier="L2",
            reason=f"deep_context_followup: history={history_depth}",
            method="heuristic",
        )

    # ─── 중간 길이 + 깊이 힌트 → L2 ────────────────────────────────────────
    if has_deep_hint:
        return ClassificationResult(
            tier="L2",
            reason="standard_analysis: deep_hint_present",
            method="heuristic",
        )

    # 어느 것도 결정 못 했으면 fallback
    return ClassificationResult(
        tier=None,
        reason=f"unclear: len={char_len}, deep_hint={has_deep_hint}, l3_hits={len(l3_hits)}",
        method="heuristic",
    )


# ─── Haiku fallback 분류 ─────────────────────────────────────────────────────

# 같은 노트북에서 유사 메시지가 반복되는 경우(예: "이어서 분석해줘" 류) 호출 절약.
# 프로세스 메모리 단위, 최대 256 entries — 단순 LRU 가까운 dict.
_HAIKU_CACHE: dict[str, ClassificationResult] = {}
_HAIKU_CACHE_MAX = 256
_HAIKU_TIMEOUT_SEC = 4.0   # 휴리스틱 fallback 으로 빠지지 않게 짧게.
_HAIKU_MODEL = "claude-haiku-4-5-20251001"

_HAIKU_PROMPT = """이 데이터 분석 요청을 L1/L2/L3 한 글자로만 답하시오.

L1 = 단일 집계 lookup (예: "총 매출", "row 수", "최근 한 달 평균")
L2 = 표준 분석 (예: "지역별 매출 분석", "이상치 찾기", "분포 비교")
L3 = 다중 메서드 deep 분석 (예: "종합 분석 + 예측 + 임원 보고", "원인 추론 후 실험 설계")

판단 기준: L3 는 (a) 둘 이상의 메서드 조합 (분석+예측, 분석+인과 등), (b) 임원/보고서 요청, (c) 200자+ 긴 multi-step 지시.

답변 형식: "L1" 또는 "L2" 또는 "L3" — 다른 텍스트 일절 금지.

요청: {message}

답변:"""


def _cache_key(message: str, mart_count: int, has_image: bool) -> str:
    base = f"{message[:200]}|m={mart_count}|i={int(has_image)}"
    return hashlib.sha1(base.encode("utf-8", errors="ignore")).hexdigest()


def _cache_set(key: str, result: ClassificationResult) -> None:
    if len(_HAIKU_CACHE) >= _HAIKU_CACHE_MAX:
        # 단순 절반 잘라내기 (LRU 가깝게)
        for k in list(_HAIKU_CACHE.keys())[:_HAIKU_CACHE_MAX // 2]:
            _HAIKU_CACHE.pop(k, None)
    _HAIKU_CACHE[key] = result


async def classify_haiku(
    message: str,
    *,
    api_key: str,
    mart_count: int = 0,
    has_image: bool = False,
) -> Optional[ClassificationResult]:
    """Haiku 로 분류. 실패하면 None — 호출자가 default 폴백.

    Returns:
        ClassificationResult(tier='L1'|'L2'|'L3', method='haiku')
        또는 None (api 키 없음 / 타임아웃 / 파싱 실패).
    """
    if not api_key or not (message or "").strip():
        return None

    # 캐시 hit
    key = _cache_key(message, mart_count, has_image)
    cached = _HAIKU_CACHE.get(key)
    if cached is not None:
        return ClassificationResult(
            tier=cached.tier,
            reason=f"haiku_cache_hit ({cached.reason})",
            method="haiku",
        )

    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=api_key)
        prompt = _HAIKU_PROMPT.format(message=message[:600])
        msg = await asyncio.wait_for(
            client.messages.create(
                model=_HAIKU_MODEL,
                max_tokens=8,
                messages=[{"role": "user", "content": prompt}],
            ),
            timeout=_HAIKU_TIMEOUT_SEC,
        )
        text = ""
        if msg.content:
            for blk in msg.content:
                if getattr(blk, "type", "") == "text":
                    text += getattr(blk, "text", "")
        text = text.strip().upper()
        # 응답 파싱 — "L1", "L2", "L3" 만 허용
        m = re.search(r"\bL([123])\b", text)
        if not m:
            logger.warning("Haiku classifier returned unparseable response: %r", text[:50])
            return None
        tier: Tier = f"L{m.group(1)}"  # type: ignore[assignment]
        result = ClassificationResult(
            tier=tier,
            reason=f"haiku_classified: {tier}",
            method="haiku",
        )
        _cache_set(key, result)
        return result
    except asyncio.TimeoutError:
        logger.warning("Haiku classifier timed out after %ss", _HAIKU_TIMEOUT_SEC)
        return None
    except Exception as e:
        logger.warning("Haiku classifier failed: %s", e)
        return None


# ─── 통합 진입점 (override 우선, heuristic, haiku, default) ──────────────────


def classify_request(
    message: str,
    *,
    mart_count: int = 0,
    has_image: bool = False,
    history_depth: int = 0,
    tier_override: Optional[Tier] = None,
) -> ClassificationResult:
    """동기 진입점 — override / heuristic / default. Haiku 미사용.

    Haiku 까지 쓰려면 `classify_request_async` 를 호출하라.
    """
    if tier_override:
        return ClassificationResult(
            tier=tier_override,
            reason=f"user_override: {tier_override}",
            method="override",
        )

    h = classify_heuristic(
        message,
        mart_count=mart_count,
        has_image=has_image,
        history_depth=history_depth,
    )
    if h.tier is not None:
        return h

    return ClassificationResult(
        tier="L2",
        reason=f"default_fallback ({h.reason})",
        method="default",
    )


async def classify_request_async(
    message: str,
    *,
    api_key: str = "",
    mart_count: int = 0,
    has_image: bool = False,
    history_depth: int = 0,
    tier_override: Optional[Tier] = None,
) -> ClassificationResult:
    """비동기 진입점 — override / heuristic / haiku / default 순서.

    api_key 가 비어있으면 Haiku 단계 자동 스킵 → default 폴백.
    """
    if tier_override:
        return ClassificationResult(
            tier=tier_override,
            reason=f"user_override: {tier_override}",
            method="override",
        )

    h = classify_heuristic(
        message,
        mart_count=mart_count,
        has_image=has_image,
        history_depth=history_depth,
    )
    if h.tier is not None:
        return h

    # Haiku fallback — heuristic 이 애매할 때만 호출.
    if api_key:
        haiku = await classify_haiku(
            message,
            api_key=api_key,
            mart_count=mart_count,
            has_image=has_image,
        )
        if haiku is not None:
            return haiku

    return ClassificationResult(
        tier="L2",
        reason=f"default_fallback ({h.reason})",
        method="default",
    )
