"""에이전트 SSE 이벤트 타입 단일 소스.

프론트 `src/lib/api.ts` 의 `AgentEvent` union 과 동기화 필수.
새 이벤트 추가 시: 여기 상수 + 타입 힌트 + 프론트 union 모두 갱신.
"""
from typing import Literal, TypedDict, Union


# ─── 이벤트 종류 (Literal) ───────────────────────────────────────────────────
AgentEventType = Literal[
    "thinking",
    "tool_use",
    "message_delta",
    "reset_current_bubble",
    "cell_created",
    "cell_code_updated",
    "cell_executed",
    "cell_memo_updated",
    "chart_quality",
    "todos_updated",
    "ask_user",
    "exec_heartbeat",
    "exec_completed_notice",
    # Phase -1: 복잡도 분류 결과 (run loop 진입 직후 1회)
    "tier_classified",
    # 예산 80% 도달 시 1회. 프론트가 progress bar / 마무리 안내에 사용.
    "budget_warning",
    # tier 자동 승격 알림 (L1 → L2 등). 분류기가 부실해도 실행 중 보정됨을 노출.
    "tier_promoted",
    "complete",
    "error",
]

ALL_EVENT_TYPES: tuple[str, ...] = (
    "thinking",
    "tool_use",
    "message_delta",
    "reset_current_bubble",
    "cell_created",
    "cell_code_updated",
    "cell_executed",
    "cell_memo_updated",
    "chart_quality",
    "todos_updated",
    "ask_user",
    "exec_heartbeat",
    "exec_completed_notice",
    "tier_classified",
    "budget_warning",
    "tier_promoted",
    "complete",
    "error",
)


# ─── TypedDict (검증·IDE 도움용, 런타임 강제 X) ─────────────────────────────
class ThinkingEvent(TypedDict):
    type: Literal["thinking"]
    content: str


class ToolUseEvent(TypedDict):
    type: Literal["tool_use"]
    tool: str
    input: dict


class MessageDeltaEvent(TypedDict):
    type: Literal["message_delta"]
    content: str


class CellCreatedEvent(TypedDict, total=False):
    type: Literal["cell_created"]
    cell_id: str
    cell_type: str
    cell_name: str
    code: str
    after_cell_id: str | None


class CellCodeUpdatedEvent(TypedDict):
    type: Literal["cell_code_updated"]
    cell_id: str
    code: str


class CellExecutedEvent(TypedDict, total=False):
    type: Literal["cell_executed"]
    cell_id: str
    output: dict | None


class CellMemoUpdatedEvent(TypedDict):
    type: Literal["cell_memo_updated"]
    cell_id: str
    memo: str


class AskUserEvent(TypedDict):
    type: Literal["ask_user"]
    question: str
    options: list[str]


class ChartQualityEvent(TypedDict, total=False):
    type: Literal["chart_quality"]
    cell_id: str
    passed: bool
    summary: str
    issues: list[str]


class TodosUpdatedEvent(TypedDict):
    type: Literal["todos_updated"]
    todos: list[dict]


class ResetCurrentBubbleEvent(TypedDict):
    type: Literal["reset_current_bubble"]


class CompleteEvent(TypedDict):
    type: Literal["complete"]
    created_cell_ids: list[str]
    updated_cell_ids: list[str]


class ErrorEvent(TypedDict):
    type: Literal["error"]
    message: str


class ExecHeartbeatEvent(TypedDict):
    type: Literal["exec_heartbeat"]
    cell_id: str
    cell_name: str
    elapsed_sec: int
    message: str


class ExecCompletedNoticeEvent(TypedDict):
    type: Literal["exec_completed_notice"]
    cell_id: str
    cell_name: str
    elapsed_sec: int
    message: str


class TierClassifiedEvent(TypedDict, total=False):
    type: Literal["tier_classified"]
    tier: Literal["L1", "L2", "L3"]
    reason: str
    estimated_cells: int
    estimated_seconds: int
    max_turns: int
    max_tool_calls: int
    # Phase 0 결과로 채워질 자리. S1 단계에선 빈 배열.
    methods: list[str]


class BudgetWarningEvent(TypedDict):
    type: Literal["budget_warning"]
    percent_used: float
    remaining_turns: int
    remaining_tool_calls: int
    message: str


class TierPromotedEvent(TypedDict):
    type: Literal["tier_promoted"]
    from_tier: Literal["L1", "L2", "L3"]
    to_tier: Literal["L1", "L2", "L3"]
    reason: str
    new_max_turns: int
    new_max_tool_calls: int


AgentEvent = Union[
    ThinkingEvent,
    ToolUseEvent,
    MessageDeltaEvent,
    ResetCurrentBubbleEvent,
    CellCreatedEvent,
    CellCodeUpdatedEvent,
    CellExecutedEvent,
    CellMemoUpdatedEvent,
    ChartQualityEvent,
    TodosUpdatedEvent,
    AskUserEvent,
    ExecHeartbeatEvent,
    ExecCompletedNoticeEvent,
    TierClassifiedEvent,
    BudgetWarningEvent,
    TierPromotedEvent,
    CompleteEvent,
    ErrorEvent,
]


def is_valid_event_type(t: str) -> bool:
    return t in ALL_EVENT_TYPES
