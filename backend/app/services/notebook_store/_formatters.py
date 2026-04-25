"""출력/셀/에이전트 메시지 포맷 변환 헬퍼."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional


def _sanitize_nan(obj):
    """Recursively replace float NaN/Inf with None so JSON serialization never fails."""
    import math
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    if isinstance(obj, dict):
        return {k: _sanitize_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_nan(v) for v in obj]
    return obj


def _parse_output(outputs: list) -> Optional[dict]:
    if not outputs:
        return None
    for out in outputs:
        data = out.get("data", {})
        if "application/vnd.vibe+json" in data:
            val = data["application/vnd.vibe+json"]
            parsed = json.loads(val) if isinstance(val, str) else val
            return _sanitize_nan(parsed)
        if out.get("output_type") == "error":
            return {
                "type": "error",
                "message": out.get("evalue", "") + "\n" + "".join(out.get("traceback", [])),
            }
        if "text/plain" in data:
            return {"type": "stdout", "content": "".join(data["text/plain"])}
    return None


def _make_output_block(output: dict) -> dict:
    return {
        "output_type": "display_data",
        "data": {"application/vnd.vibe+json": output},
        "metadata": {},
    }


_LEGACY_AGENT_ASSISTANT_CREATE = "(에이전트가 생성한 셀)"
_LEGACY_AGENT_ASSISTANT_UPDATE = "(에이전트가 수정한 셀)"
_AGENT_ASSISTANT_REPLY = "코드가 업데이트되었습니다. 아래 버튼으로 이 시점 코드를 확인하거나 되돌릴 수 있습니다."


def _maybe_migrate_legacy_agent_entry(user_msg: dict, asst_msg: dict) -> tuple[str, str, bool]:
    """옛 포맷(assistant_reply 가 '(에이전트가 생성/수정한 셀)')을 에이전트 보이스로 변환.
    반환: (표시용 user_message, 표시용 assistant_reply, agent_created 플래그)

    저장된 데이터는 건드리지 않고, 조회 시점에만 새 포맷으로 렌더링한다.
    프론트는 agent_created=True 엔트리에 '에이전트' 배지를 붙이므로 별도 보일러플레이트 없이
    원 요청 텍스트만 그대로 보여준다. (Image #3 에서 모든 셀이 동일 문구로 보이던 문제 해결)"""
    user_content = user_msg.get("content", "")
    asst_content = asst_msg.get("content", "")
    already_marked = bool(user_msg.get("agent_created"))
    if already_marked:
        return user_content, asst_content, True
    is_legacy = asst_content in (_LEGACY_AGENT_ASSISTANT_CREATE, _LEGACY_AGENT_ASSISTANT_UPDATE)
    if not is_legacy:
        return user_content, asst_content, False
    # 레거시 엔트리는 내레이션 텍스트가 없어 원 요청만 남음 — 보일러플레이트 없이 그대로 표시.
    display_user = (user_content or "").strip() or (
        "에이전트가 이 셀을 생성했습니다."
        if asst_content == _LEGACY_AGENT_ASSISTANT_CREATE
        else "에이전트가 이 셀을 수정했습니다."
    )
    return display_user, _AGENT_ASSISTANT_REPLY, True


def _get_cell_chat_entries(vibe: dict, cell_id: str) -> list[dict]:
    """flat message pairs → ChatEntryRow list"""
    for entry in vibe.get("chat_history", []):
        if entry.get("cell_id") != cell_id:
            continue
        messages = entry.get("messages", [])
        result = []
        i = 0
        while i < len(messages):
            user_msg = messages[i] if messages[i].get("role") == "user" else None
            asst_msg = messages[i + 1] if (i + 1 < len(messages) and messages[i + 1].get("role") == "assistant") else None
            if user_msg and asst_msg:
                display_user, display_asst, agent_created = _maybe_migrate_legacy_agent_entry(user_msg, asst_msg)
                result.append({
                    "id": f"{cell_id}-{i}",
                    "user_message": display_user,
                    "assistant_reply": display_asst,
                    "code_snapshot": user_msg.get("code_snapshot", ""),
                    "code_result": asst_msg.get("code_result", ""),
                    "created_at": user_msg.get("ts", datetime.now().isoformat()),
                    "agent_created": agent_created,
                })
                i += 2
            else:
                i += 1
        return result
    return []


def _fmt_cell(cell: dict, vibe: dict) -> dict:
    m = cell.get("metadata", {})
    src = cell.get("source", "")
    return {
        "id": cell.get("id", ""),
        "name": m.get("vibe_name", cell.get("id", "")),
        "type": m.get("vibe_type", "python"),
        "code": "".join(src) if isinstance(src, list) else src,
        "memo": m.get("vibe_memo", ""),
        "ordering": m.get("vibe_ordering", 0),
        "executed": bool(cell.get("outputs")),
        "output": _parse_output(cell.get("outputs", [])),
        "insight": m.get("vibe_insight"),
        "agent_generated": m.get("vibe_agent_generated", False),
        "onboarding": m.get("vibe_onboarding", False),
        "chat_entries": _get_cell_chat_entries(vibe, cell.get("id", "")),
    }


def _fmt_agent_messages(vibe: dict) -> list[dict]:
    return [
        {
            "id": f"agent-{i}",
            "role": m.get("role", "user"),
            "content": m.get("content", ""),
            "created_cell_ids": m.get("created_cell_ids", []),
            "created_at": m.get("ts", datetime.now().isoformat()),
            "blocks": m.get("blocks", []),
        }
        for i, m in enumerate(vibe.get("agent_history", []))
    ]
