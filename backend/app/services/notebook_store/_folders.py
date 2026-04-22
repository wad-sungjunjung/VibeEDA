"""폴더 CRUD — .vibe_config.json 에 저장."""
from __future__ import annotations

import json
import uuid

from ._core import _ensure_dir, _read_config, _write_config


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
    from . import _core
    cfg = _read_config()
    cfg["folders"] = [f for f in cfg.get("folders", []) if f["id"] != folder_id]
    _write_config(cfg)
    # Unlink notebooks from this folder
    for p in _core.NOTEBOOKS_DIR.glob("*.ipynb"):
        try:
            nb = json.loads(p.read_text(encoding="utf-8"))
            vibe = nb.get("metadata", {}).get("vibe", {})
            if vibe.get("folder_id") == folder_id:
                vibe["folder_id"] = None
                p.write_text(json.dumps(nb, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
