"""노트북 단위 CRUD + 레거시 마이그레이션 + 온보딩 시딩."""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from ._core import (
    NOTEBOOKS_DIR, _ensure_dir, _iter_notebook_paths, _nb_path,
    _read_config, _write_config, _read_nb, _write_nb,
    _register_file, _unregister_file, _unique_filename,
)
from ._formatters import _fmt_cell, _fmt_agent_messages
from ._onboarding_data import _ONBOARDING_TITLE, _ONBOARDING_CELLS


def _migrate_legacy_notebook(p: Path) -> str:
    """Migrate old UUID-filename notebooks: assign id in metadata and register in id_to_file."""
    from . import _core  # for current NOTEBOOKS_DIR
    nb = json.loads(p.read_text(encoding="utf-8"))
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    nb_id = p.stem
    title = vibe.get("title") or "새 분석"
    vibe["id"] = nb_id
    fname = _unique_filename(title)
    new_path = _core.NOTEBOOKS_DIR / f"{fname}.ipynb"
    vibe["title"] = title
    p.write_text(json.dumps(nb, ensure_ascii=False, indent=2), encoding="utf-8")
    if p != new_path:
        p.rename(new_path)
    _register_file(nb_id, fname)
    return nb_id


def list_notebooks() -> list[dict]:
    _ensure_dir()
    paths = _iter_notebook_paths()
    if not paths:
        try:
            create_onboarding_notebook()
        except Exception:
            pass
        paths = _iter_notebook_paths()
    result = []
    from . import _core
    for p in sorted(paths, key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            try:
                text = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                # 파일에 비 UTF-8 바이트가 있는 경우 (corruption) — 손실 없이 읽기 시도
                text = p.read_bytes().decode("utf-8", errors="ignore")
            try:
                nb = json.loads(text)
            except json.JSONDecodeError:
                # JSON 뒤에 쓰레기 데이터가 붙은 경우 (예: 파일 이중 기록) — 첫 JSON 객체만 파싱
                nb, _ = json.JSONDecoder().raw_decode(text)
            vibe = nb.get("metadata", {}).get("vibe", {})
            nb_id = vibe.get("id")
            if not nb_id:
                nb_id = _migrate_legacy_notebook(p)
                p = _nb_path(nb_id)
                nb = json.loads(p.read_text(encoding="utf-8"))
                vibe = nb.get("metadata", {}).get("vibe", {})
            try:
                rel = str(p.relative_to(_core.NOTEBOOKS_DIR).with_suffix(""))
                cfg = _read_config()
                if cfg.setdefault("id_to_file", {}).get(nb_id) != rel:
                    cfg["id_to_file"][nb_id] = rel
                    _write_config(cfg)
            except Exception:
                pass
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


def create_notebook(title: str = "새 분석", folder_id: Optional[str] = None, folder_path: Optional[str] = None) -> dict:
    _ensure_dir()
    nb_id = str(uuid.uuid4())
    base_fname = _unique_filename(title)
    if folder_path:
        fp = Path(folder_path).expanduser()
        if not fp.is_absolute():
            fp = NOTEBOOKS_DIR / fp
        fp = fp.resolve()
        try:
            rel_dir = fp.relative_to(NOTEBOOKS_DIR.resolve())
            fp.mkdir(parents=True, exist_ok=True)
            fname = str(rel_dir / base_fname)
        except ValueError:
            fname = base_fname
    else:
        fname = base_fname
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


def create_onboarding_notebook() -> dict:
    """첫 실행 시 사용자가 기능을 빠르게 익힐 수 있도록 예시 셀이 채워진
    '온보딩' 노트북을 생성한다. 분석이 하나도 없을 때 한 번 시딩된다."""
    _ensure_dir()
    nb_id = str(uuid.uuid4())
    fname = _unique_filename(_ONBOARDING_TITLE)
    _register_file(nb_id, fname)

    description = (
        "Vibe EDA를 처음 사용하는 분들을 위한 가이드 노트북입니다. "
        "셀 타입, 바이브 채팅, 에이전트 모드 사용법을 담고 있어요."
    )

    cells: list[dict] = []
    for i, spec in enumerate(_ONBOARDING_CELLS):
        cells.append({
            "id": str(uuid.uuid4()),
            "cell_type": "code" if spec["type"] in ("sql", "python") else "markdown",
            "source": spec["code"],
            "metadata": {
                "vibe_type": spec["type"],
                "vibe_name": spec["name"],
                "vibe_memo": "",
                "vibe_ordering": float(i + 1) * 1000.0,
                "vibe_agent_generated": False,
                "vibe_onboarding": True,
            },
            "outputs": [],
            "execution_count": None,
        })

    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "vibe": {
                "id": nb_id,
                "title": _ONBOARDING_TITLE,
                "description": description,
                "selected_marts": [],
                "folder_id": None,
                "chat_history": [],
                "agent_history": [],
                "onboarding": True,
            },
        },
        "cells": cells,
    }
    _write_nb(nb_id, nb)
    return get_notebook(nb_id)


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
    from . import _core
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})

    new_title = kwargs.get("title")
    if new_title is not None and new_title != vibe.get("title"):
        old_path = _nb_path(nb_id)
        new_fname = _unique_filename(new_title, exclude_id=nb_id)
        new_path = _core.NOTEBOOKS_DIR / f"{new_fname}.ipynb"
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
