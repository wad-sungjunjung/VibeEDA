"""
.ipynb 파일 기반 노트북 저장소.
~/vibe-notebooks/{uuid}.ipynb 형태로 저장.
채팅 히스토리·에이전트 히스토리는 metadata.vibe 에 저장.
폴더 메타데이터는 ~/.vibe-notebooks/.vibe_config.json 에 저장.
"""
import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

_SETTINGS_FILE = Path.home() / ".vibe_eda_settings.json"


def _load_settings() -> dict:
    if _SETTINGS_FILE.exists():
        try:
            return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_settings(data: dict) -> None:
    try:
        _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


_settings = _load_settings()
NOTEBOOKS_DIR = Path(_settings.get("notebooks_dir", str(Path.home() / "vibe-notebooks"))).expanduser().resolve()
CONFIG_FILE = NOTEBOOKS_DIR / ".vibe_config.json"


# ── 초기화 ────────────────────────────────────────────────────────────────────

def _ensure_dir() -> None:
    NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)


def set_notebooks_dir(new_path: str) -> Path:
    """노트북 저장 경로를 변경하고 설정 파일에 저장합니다."""
    global NOTEBOOKS_DIR, CONFIG_FILE
    resolved = Path(new_path).expanduser().resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    NOTEBOOKS_DIR = resolved
    CONFIG_FILE = NOTEBOOKS_DIR / ".vibe_config.json"
    _save_settings({**_load_settings(), "notebooks_dir": str(resolved)})
    return resolved


def _read_config() -> dict:
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    return {"folders": []}


def _write_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ── 파일명 관리 ───────────────────────────────────────────────────────────────

def _sanitize_title(title: str) -> str:
    """타이틀을 Windows 유효 파일명으로 변환."""
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title).strip('. ') or 'notebook'
    return sanitized


def _unique_filename(title: str, exclude_id: str | None = None) -> str:
    """title 기반 충돌 없는 파일명(확장자 제외) 반환."""
    base = _sanitize_title(title)
    cfg = _read_config()
    used = set(v for k, v in cfg.get("id_to_file", {}).items() if k != exclude_id)
    if base not in used:
        return base
    n = 1
    while f"{base} {n}" in used:
        n += 1
    return f"{base} {n}"


def _register_file(nb_id: str, fname: str) -> None:
    cfg = _read_config()
    cfg.setdefault("id_to_file", {})[nb_id] = fname
    _write_config(cfg)


def _unregister_file(nb_id: str) -> None:
    cfg = _read_config()
    cfg.setdefault("id_to_file", {}).pop(nb_id, None)
    _write_config(cfg)


# ── 파일 I/O ──────────────────────────────────────────────────────────────────

def _nb_path(nb_id: str) -> Path:
    cfg = _read_config()
    fname = cfg.get("id_to_file", {}).get(nb_id)
    if fname:
        return NOTEBOOKS_DIR / f"{fname}.ipynb"
    # 하위 호환: 기존 UUID 파일명
    return NOTEBOOKS_DIR / f"{nb_id}.ipynb"


def _read_nb(nb_id: str) -> dict:
    return json.loads(_nb_path(nb_id).read_text(encoding="utf-8"))


def _write_nb(nb_id: str, nb: dict) -> None:
    _nb_path(nb_id).write_text(
        json.dumps(nb, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )


# ── 출력 직렬화 ───────────────────────────────────────────────────────────────

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


# ── 채팅 히스토리 변환 ────────────────────────────────────────────────────────

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
        }
        for i, m in enumerate(vibe.get("agent_history", []))
    ]


# ── 노트북 CRUD ───────────────────────────────────────────────────────────────

def _migrate_legacy_notebook(p: Path) -> str:
    """Migrate old UUID-filename notebooks: assign id in metadata and register in id_to_file."""
    nb = json.loads(p.read_text(encoding="utf-8"))
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    nb_id = p.stem  # UUID was the filename
    title = vibe.get("title") or "새 분석"
    vibe["id"] = nb_id
    # Rename file to title-based name
    fname = _unique_filename(title)
    new_path = NOTEBOOKS_DIR / f"{fname}.ipynb"
    vibe["title"] = title
    p.write_text(json.dumps(nb, ensure_ascii=False, indent=2), encoding="utf-8")
    if p != new_path:
        p.rename(new_path)
    _register_file(nb_id, fname)
    return nb_id


def list_notebooks() -> list[dict]:
    _ensure_dir()
    cfg = _read_config()
    registered_files = set(cfg.get("id_to_file", {}).values())
    result = []
    for p in sorted(NOTEBOOKS_DIR.glob("*.ipynb"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            nb = json.loads(p.read_text(encoding="utf-8"))
            vibe = nb.get("metadata", {}).get("vibe", {})
            nb_id = vibe.get("id")
            # Migrate legacy notebooks that have no id in metadata
            if not nb_id:
                nb_id = _migrate_legacy_notebook(p)
                cfg = _read_config()
                registered_files = set(cfg.get("id_to_file", {}).values())
                # Re-read after migration
                p = _nb_path(nb_id)
                nb = json.loads(p.read_text(encoding="utf-8"))
                vibe = nb.get("metadata", {}).get("vibe", {})
            stat = p.stat()
            result.append({
                "id": nb_id,
                "title": vibe.get("title", nb_id),
                "description": vibe.get("description", ""),
                "selected_marts": vibe.get("selected_marts", []),
                "folder_id": vibe.get("folder_id"),
                "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
        except Exception:
            pass
    return result


def create_notebook(title: str = "새 분석", folder_id: Optional[str] = None) -> dict:
    _ensure_dir()
    nb_id = str(uuid.uuid4())
    fname = _unique_filename(title)
    _register_file(nb_id, fname)
    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "vibe": {
                "id": nb_id,
                "title": title,
                "description": "",
                "selected_marts": [],
                "folder_id": folder_id,
                "chat_history": [],
                "agent_history": [],
            },
        },
        "cells": [],
    }
    _write_nb(nb_id, nb)
    p = _nb_path(nb_id)
    stat = p.stat()
    return {
        "id": nb_id,
        "title": title,
        "description": "",
        "selected_marts": [],
        "folder_id": folder_id,
        "cells": [],
        "agent_messages": [],
        "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
        "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


def get_notebook(nb_id: str) -> dict:
    nb = _read_nb(nb_id)
    vibe = nb.get("metadata", {}).get("vibe", {})

    # 과거 중복 persistence 버그로 동일 id 셀이 쌓인 .ipynb 자동 복구 —
    # 첫 등장 셀만 유지하고 나머지는 버린 뒤 파일을 재기록.
    raw_cells = nb.get("cells", [])
    seen: set[str] = set()
    deduped: list[dict] = []
    for c in raw_cells:
        cid = c.get("id")
        if cid and cid in seen:
            continue
        if cid:
            seen.add(cid)
        deduped.append(c)
    if len(deduped) != len(raw_cells):
        nb["cells"] = deduped
        _write_nb(nb_id, nb)

    cells = [_fmt_cell(c, vibe) for c in deduped]
    p = _nb_path(nb_id)
    stat = p.stat()
    return {
        "id": nb_id,
        "title": vibe.get("title", nb_id),
        "description": vibe.get("description", ""),
        "selected_marts": vibe.get("selected_marts", []),
        "folder_id": vibe.get("folder_id"),
        "cells": cells,
        "agent_messages": _fmt_agent_messages(vibe),
        "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
        "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


def update_notebook_meta(nb_id: str, **kwargs) -> dict:
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})

    new_title = kwargs.get("title")
    if new_title is not None and new_title != vibe.get("title"):
        old_path = _nb_path(nb_id)
        new_fname = _unique_filename(new_title, exclude_id=nb_id)
        new_path = NOTEBOOKS_DIR / f"{new_fname}.ipynb"
        if old_path.exists() and old_path != new_path:
            old_path.rename(new_path)
        _register_file(nb_id, new_fname)

    for k, v in kwargs.items():
        if v is not None or k == "folder_id":
            vibe[k] = v
    _write_nb(nb_id, nb)
    return get_notebook(nb_id)


def delete_notebook(nb_id: str) -> None:
    p = _nb_path(nb_id)
    if p.exists():
        p.unlink()
    _unregister_file(nb_id)


# ── 셀 CRUD ───────────────────────────────────────────────────────────────────

def create_cell(
    nb_id: str,
    cell_type: str,
    name: str,
    code: str = "",
    memo: str = "",
    ordering: float = None,
    cell_id: str = None,
    after_id: str = None,
    agent_generated: bool = False,
) -> dict:
    nb = _read_nb(nb_id)
    cells = nb.setdefault("cells", [])

    # Idempotency: 동일 cell_id가 이미 존재하면 새로 추가하지 않고 기존 셀을 반환.
    # 에이전트 스트림(frontend POST)과 백엔드 persistence가 중복 호출되는 경우를 방어한다.
    if cell_id:
        existing = next((c for c in cells if c.get("id") == cell_id), None)
        if existing:
            return _fmt_cell(existing, nb.get("metadata", {}).get("vibe", {}))

    if ordering is None:
        ordering = float(len(cells) + 1) * 1000.0
    new_id = cell_id or str(uuid.uuid4())
    cell = {
        "id": new_id,
        "cell_type": "code" if cell_type in ("sql", "python") else "markdown",
        "source": code,
        "metadata": {
            "vibe_type": cell_type,
            "vibe_name": name,
            "vibe_memo": memo,
            "vibe_ordering": ordering,
            "vibe_agent_generated": agent_generated,
        },
        "outputs": [],
        "execution_count": None,
    }
    if after_id:
        idx = next((i for i, c in enumerate(cells) if c.get("id") == after_id), len(cells) - 1)
        cells.insert(idx + 1, cell)
    else:
        cells.append(cell)
    _write_nb(nb_id, nb)
    return {
        "id": new_id, "name": name, "type": cell_type, "code": code,
        "memo": memo, "ordering": ordering, "executed": False,
        "output": None, "insight": None, "agent_generated": agent_generated,
        "chat_entries": [],
    }


def update_cell(nb_id: str, cell_id: str, **kwargs) -> dict:
    nb = _read_nb(nb_id)
    cell = next((c for c in nb.get("cells", []) if c.get("id") == cell_id), None)
    if not cell:
        raise ValueError(f"Cell {cell_id} not found in {nb_id}")
    m = cell.setdefault("metadata", {})
    field_map = {
        "code": lambda v: cell.__setitem__("source", v),
        "name": lambda v: m.__setitem__("vibe_name", v),
        "type": lambda v: (m.__setitem__("vibe_type", v), cell.__setitem__("cell_type", "code" if v in ("sql","python") else "markdown")),
        "memo": lambda v: m.__setitem__("vibe_memo", v),
        "ordering": lambda v: m.__setitem__("vibe_ordering", v),
        "insight": lambda v: m.__setitem__("vibe_insight", v),
        "output": lambda v: cell.__setitem__("outputs", [] if v is None else [_make_output_block(v)]),
        "executed": lambda v: None,  # derived from outputs
    }
    for k, v in kwargs.items():
        if k in field_map:
            field_map[k](v)
    _write_nb(nb_id, nb)
    return _fmt_cell(cell, nb.get("metadata", {}).get("vibe", {}))


def delete_cell(nb_id: str, cell_id: str) -> None:
    nb = _read_nb(nb_id)
    nb["cells"] = [c for c in nb.get("cells", []) if c.get("id") != cell_id]
    _write_nb(nb_id, nb)


def get_cell_above_name(nb_id: str, cell_id: str) -> Optional[str]:
    """Return vibe_name of the nearest SQL/Python cell directly above cell_id."""
    nb = _read_nb(nb_id)
    cells = nb.get("cells", [])
    target_ordering = None
    for c in cells:
        if c.get("id") == cell_id:
            target_ordering = c.get("metadata", {}).get("vibe_ordering", 0)
            break
    if target_ordering is None:
        return None
    best = None
    best_ordering = float("-inf")
    for c in cells:
        if c.get("id") == cell_id:
            continue
        m = c.get("metadata", {})
        o = m.get("vibe_ordering", 0)
        vtype = m.get("vibe_type", "python")
        if o < target_ordering and o > best_ordering and vtype in ("sql", "python"):
            best_ordering = o
            best = m.get("vibe_name")
    return best


# ── 채팅 저장 ─────────────────────────────────────────────────────────────────

def add_chat_entry(nb_id: str, cell_id: str, user_msg: str, assistant_reply: str, code_snapshot: str) -> None:
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    chat_history = vibe.setdefault("chat_history", [])
    entry = next((e for e in chat_history if e.get("cell_id") == cell_id), None)
    if not entry:
        entry = {"cell_id": cell_id, "messages": []}
        chat_history.append(entry)
    ts = datetime.now().isoformat()
    entry["messages"].append({"role": "user", "content": user_msg, "code_snapshot": code_snapshot, "ts": ts})
    entry["messages"].append({"role": "assistant", "content": assistant_reply, "ts": ts})
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


def add_agent_message(nb_id: str, role: str, content: str, created_cell_ids: list = None) -> None:
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    vibe.setdefault("agent_history", []).append({
        "role": role, "content": content,
        "created_cell_ids": created_cell_ids or [],
        "ts": datetime.now().isoformat(),
    })
    _write_nb(nb_id, nb)


# ── 폴더 ──────────────────────────────────────────────────────────────────────

def list_folders() -> list[dict]:
    _ensure_dir()
    return _read_config().get("folders", [])


def create_folder(name: str) -> dict:
    _ensure_dir()
    cfg = _read_config()
    folder = {"id": str(uuid.uuid4()), "name": name, "is_open": True, "ordering": len(cfg.get("folders", [])) * 1000.0}
    cfg.setdefault("folders", []).append(folder)
    _write_config(cfg)
    return folder


def update_folder(folder_id: str, **kwargs) -> dict:
    cfg = _read_config()
    folder = next((f for f in cfg.get("folders", []) if f["id"] == folder_id), None)
    if not folder:
        raise ValueError(f"Folder {folder_id} not found")
    folder.update({k: v for k, v in kwargs.items() if v is not None})
    _write_config(cfg)
    return folder


def delete_folder(folder_id: str) -> None:
    cfg = _read_config()
    cfg["folders"] = [f for f in cfg.get("folders", []) if f["id"] != folder_id]
    _write_config(cfg)
    # Unlink notebooks from this folder
    for p in NOTEBOOKS_DIR.glob("*.ipynb"):
        try:
            nb = json.loads(p.read_text(encoding="utf-8"))
            vibe = nb.get("metadata", {}).get("vibe", {})
            if vibe.get("folder_id") == folder_id:
                vibe["folder_id"] = None
                p.write_text(json.dumps(nb, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
