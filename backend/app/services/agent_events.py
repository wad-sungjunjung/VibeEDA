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
    CompleteEvent,
    ErrorEvent,
]


def is_valid_event_type(t: str) -> bool:
    return t in ALL_EVENT_TYPES
