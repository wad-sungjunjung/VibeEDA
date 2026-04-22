"""셀 CRUD — .ipynb 의 cells 배열 조작."""
from __future__ import annotations

import uuid
from typing import Optional

from ._core import _read_nb, _write_nb
from ._formatters import _fmt_cell, _make_output_block


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
        "cell_type": "code" if cell_type in ("sql", "python") else ("raw" if cell_type == "sheet" else "markdown"),
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
        "type": lambda v: (m.__setitem__("vibe_type", v), cell.__setitem__("cell_type", "code" if v in ("sql","python") else ("raw" if v == "sheet" else "markdown"))),
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
