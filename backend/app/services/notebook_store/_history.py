"""Vibe Chat 히스토리 + 에이전트 메시지 히스토리 — metadata.vibe 에 저장."""
from __future__ import annotations

from datetime import datetime

from ._core import _read_nb, _write_nb


def add_chat_entry(nb_id: str, cell_id: str, user_msg: str, assistant_reply: str, code_snapshot: str, code_result: str = "", agent_created: bool = False) -> None:
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    chat_history = vibe.setdefault("chat_history", [])
    entry = next((e for e in chat_history if e.get("cell_id") == cell_id), None)
    if not entry:
        entry = {"cell_id": cell_id, "messages": []}
        chat_history.append(entry)
    ts = datetime.now().isoformat()
    user_record: dict = {"role": "user", "content": user_msg, "code_snapshot": code_snapshot, "ts": ts}
    if agent_created:
        user_record["agent_created"] = True
    entry["messages"].append(user_record)
    entry["messages"].append({"role": "assistant", "content": assistant_reply, "code_result": code_result, "ts": ts})
    _write_nb(nb_id, nb)


def delete_chat_entry(nb_id: str, cell_id: str, index: int) -> None:
    """Delete the (user, assistant) pair at pair-index `index` for a cell."""
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    chat_history = vibe.setdefault("chat_history", [])
    entry = next((e for e in chat_history if e.get("cell_id") == cell_id), None)
    if not entry:
        return
    messages = entry.get("messages", [])
    start = index * 2
    if 0 <= start < len(messages):
        del messages[start:start + 2]
    _write_nb(nb_id, nb)


def truncate_chat_history(nb_id: str, cell_id: str, keep: int) -> None:
    """Keep only the first `keep` (user, assistant) pairs for a cell."""
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    chat_history = vibe.setdefault("chat_history", [])
    entry = next((e for e in chat_history if e.get("cell_id") == cell_id), None)
    if not entry:
        return
    entry["messages"] = entry.get("messages", [])[: max(keep, 0) * 2]
    _write_nb(nb_id, nb)


def add_agent_message(
    nb_id: str,
    role: str,
    content: str,
    created_cell_ids: list = None,
    blocks: list = None,
) -> None:
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    entry: dict = {
        "role": role, "content": content,
        "created_cell_ids": created_cell_ids or [],
        "ts": datetime.now().isoformat(),
    }
    if blocks:
        entry["blocks"] = blocks
    vibe.setdefault("agent_history", []).append(entry)
    _write_nb(nb_id, nb)


def clear_agent_history(nb_id: str) -> int:
    """현재 진행 중인 에이전트 대화를 아카이브 처리 — agent_history 를 비운다.
    프론트엔드가 세션을 localStorage 에 저장한 뒤 호출. 반환값은 삭제된 메시지 수."""
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    history = vibe.get("agent_history", [])
    count = len(history)
    vibe["agent_history"] = []
    _write_nb(nb_id, nb)
    return count
