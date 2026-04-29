"""에이전트 예산 시스템 — 요청 복잡도 Tier 와 turn/tool 예산.

3-Tier 정의:
  L1 (Quick)   : "총 매출", "row 수" 등 단일 집계성 요청. 풀 가드 스킵.
  L2 (Standard): "지역별 매출 분석" 등 일반 분석. 가설 + 메모 강제.
  L3 (Deep)    : "종합 분석 + 예측 + 임원 보고" 등 다중 메서드 요청. 풀 사이클.

NotebookState.budget 에 BudgetState 가 박혀 있고, run loop 가 매 턴
- max_turns / max_tool_calls 상한 체크
- soft_warning_at(80%) 도달 시 [시스템 리마인더] 로 마무리 유도
- hard_stop_at(100%) 도달 시 강제 종료 또는 강제 Phase 3 진입

Auto-promotion: L1 인데 셀 5개 넘게 만들어지면 L2 로, L2 인데 turn 20 넘으면
L3 로 자동 승격. 초기 분류기가 부실해도 실행 중 보정.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


Tier = Literal["L1", "L2", "L3"]


@dataclass
class BudgetState:
    """한 에이전트 세션의 예산 + 진행 상황."""

    tier: Tier
    max_turns: int
    max_tool_calls: int
    # 예산 사용률이 이 값을 넘으면 시스템 리마인더로 마무리 압박. (0.0~1.0)
    soft_warning_at: float = 0.8
    # 사용률이 이 값 이상이면 새 도구 호출 차단. (0.0~1.0)
    hard_stop_at: float = 1.0
    started_at: float = 0.0  # monotonic seconds — run loop 가 세팅
    # 분류 사유 (휴리스틱 룰 이름 또는 'haiku_fallback'). 텔레메트리·디버깅용.
    classification_reason: str = ""
    # 추정 정보 (프론트 노출용)
    estimated_cells: int = 0
    estimated_seconds: int = 0
    # 사용자가 override 했는지 — 자동 승격 비활성화 트리거
    user_overridden: bool = False
    # 승격 이력 — 디버깅과 텔레메트리용. ('L1->L2 by cell_count', ...) 형식.
    promotion_history: list[str] = field(default_factory=list)
    # soft warning 1회 발사 후 재발사 방지
    soft_warning_fired: bool = False

    def percent_used(self, turns: int, tool_calls: int) -> float:
        """현재 사용률 = max(turn 사용률, tool 사용률). 더 빠른 쪽 기준."""
        t_pct = turns / self.max_turns if self.max_turns else 0.0
        c_pct = tool_calls / self.max_tool_calls if self.max_tool_calls else 0.0
        return max(t_pct, c_pct)

    def remaining_turns(self, turns: int) -> int:
        return max(0, self.max_turns - turns)

    def remaining_tool_calls(self, tool_calls: int) -> int:
        return max(0, self.max_tool_calls - tool_calls)


# ─── Tier 별 기본 예산 ─────────────────────────────────────────────────────────
# 표는 senior-agent-plan.md 와 동기화.
TIER_BUDGETS: dict[Tier, dict] = {
    "L1": {
        "max_turns": 25,
        "max_tool_calls": 50,
        "estimated_cells": 2,
        "estimated_seconds": 30,
    },
    "L2": {
        "max_turns": 125,
        "max_tool_calls": 300,
        "estimated_cells": 8,
        "estimated_seconds": 240,
    },
    "L3": {
        # 각 Tier 5배 상향 (사용자 요청). 다중 메서드 풀 사이클 여유 + 회복 폭 확보.
        "max_turns": 500,
        "max_tool_calls": 1250,
        "estimated_cells": 22,
        "estimated_seconds": 1000,
    },
}


def make_budget(tier: Tier, reason: str = "") -> BudgetState:
    """Tier 만 주면 기본 예산으로 BudgetState 생성."""
    spec = TIER_BUDGETS[tier]
    return BudgetState(
        tier=tier,
        max_turns=spec["max_turns"],
        max_tool_calls=spec["max_tool_calls"],
        estimated_cells=spec["estimated_cells"],
        estimated_seconds=spec["estimated_seconds"],
        classification_reason=reason,
    )


# ─── Auto-promotion 규칙 ─────────────────────────────────────────────────────
# 실제 진행 상황을 보고 tier 가 부족하다 싶으면 한 단계 승격.
# user_overridden=True 면 비활성 (사용자 명시 의사 존중).

def maybe_promote(
    budget: BudgetState,
    *,
    cells_created: int,
    turns: int,
) -> tuple[BudgetState, str | None]:
    """현재 진행 상황으로 tier 승격이 필요한지 판단.

    Returns:
        (new_budget, promotion_msg) — 승격 안 하면 (budget, None)
    """
    if budget.user_overridden:
        return budget, None

    new_tier: Tier | None = None
    reason = ""

    if budget.tier == "L1":
        # L1 한도(5턴/10도구)를 초과하기 전에 셀 4개 넘으면 즉시 L2 로
        # 또는 turn 4개 (L1 max_turns=5 의 80%) 도달 시.
        if cells_created >= 4 or turns >= 4:
            new_tier = "L2"
            reason = f"cells={cells_created} turns={turns} — exceeds L1 scope"
    elif budget.tier == "L2":
        # L2 한도(25턴/60도구)의 80% 도달 + 분석이 안 끝났으면 L3 로
        if turns >= 20 or cells_created >= 12:
            new_tier = "L3"
            reason = f"cells={cells_created} turns={turns} — exceeds L2 scope"

    if new_tier is None:
        return budget, None

    promoted = make_budget(new_tier, reason=f"auto_promotion: {reason}")
    promoted.started_at = budget.started_at
    promoted.user_overridden = budget.user_overridden
    promoted.promotion_history = budget.promotion_history + [
        f"{budget.tier}->{new_tier} by {reason}"
    ]
    # soft_warning_fired 는 새 예산에서 다시 시작
    return promoted, f"{budget.tier} → {new_tier} 자동 승격: {reason}"
