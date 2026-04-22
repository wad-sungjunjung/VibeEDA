"""출력/셀/에이전트 메시지 포맷 변환 헬퍼."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional


def _parse_output(outputs: list) -> Optional[dict]:
    if not outputs:
        return None
    for out in outputs:
        data = out.get("data", {})
        if "application/vnd.vibe+json" in data:
            val = data["application/vnd.vibe+json"]
            return json.loads(val) if isinstance(val, str) else val
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
                result.append({
                    "id": f"{cell_id}-{i}",
                    "user_message": user_msg.get("content", ""),
                    "assistant_reply": asst_msg.get("content", ""),
                    "code_snapshot": user_msg.get("code_snapshot", ""),
                    "code_result": asst_msg.get("code_result", ""),
                    "created_at": user_msg.get("ts", datetime.now().isoformat()),
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
