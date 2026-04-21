"""루트 폴더 통합 파일 트리 + 폴더 조작.

사이드바의 "폴더/파일/히스토리/리포트" 를 단일 파일시스템 트리로 통합한다.
- ipynb → kind: "notebook", notebook_id 포함 (클릭 시 분석 열기)
- reports/{id}.md → kind: "report", report_id 포함 (클릭 시 리포트 열기)
- 기타 디렉터리/파일 → kind: "folder" | "file"
- 히스토리 섹션은 "루트 수준의 ipynb" 만 표시하므로 프론트에서 필터.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import notebook_store
from ..services import file_profile_cache


router = APIRouter()

_EXCLUDE_NAMES = {"__pycache__", ".vibe_config.json", ".DS_Store"}
_MAX_DEPTH = 6
_MAX_ENTRIES = 2000


def _is_hidden(name: str) -> bool:
    return name.startswith(".")


def _resolve_inside_root(path_str: str) -> Path:
    """Root 경계 밖으로 나가는 경로를 차단하고 resolve."""
    root = notebook_store.NOTEBOOKS_DIR.resolve()
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = root / p
    p = p.resolve()
    try:
        p.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="path is outside root")
    return p


def _build_ipynb_index() -> dict[str, str]:
    """Path(str) → notebook_id 매핑. id_to_file 과 stem 매칭."""
    cfg = notebook_store._read_config()
    id_to_file = cfg.get("id_to_file", {})
    root = notebook_store.NOTEBOOKS_DIR
    index: dict[str, str] = {}
    for nb_id, fname in id_to_file.items():
        p = root / f"{fname}.ipynb"
        if p.exists():
            index[str(p.resolve())] = nb_id
    # id_to_file 에 등록 안 된 레거시: stem 자체가 id 인 경우
    for p in root.glob("*.ipynb"):
        key = str(p.resolve())
        if key not in index:
            index[key] = p.stem
    return index


def _parse_report_id(md_filename: str) -> str | None:
    """reports/{timestamp}_{slug}.md → report_id = stem."""
    if md_filename.lower().endswith(".md"):
        return md_filename[:-3]
    return None


def _walk(path: Path, depth: int, counter: dict, ipynb_index: dict[str, str], reports_dir: Path) -> dict | None:
    if counter["n"] >= _MAX_ENTRIES:
        return None
    counter["n"] += 1
    try:
        stat = path.stat()
    except OSError:
        return None

    name = path.name
    node: dict = {"name": name, "path": str(path)}

    if path.is_dir():
        node["type"] = "folder"
        node["kind"] = "folder"
        if depth >= _MAX_DEPTH:
            node["children"] = []
            node["truncated"] = True
            return node
        children: list[dict] = []
        try:
            entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return node
        for child in entries:
            if _is_hidden(child.name) or child.name in _EXCLUDE_NAMES:
                continue
            sub = _walk(child, depth + 1, counter, ipynb_index, reports_dir)
            if sub is not None:
                children.append(sub)
        node["children"] = children
        return node

    # file
    node["type"] = "file"
    node["size"] = stat.st_size
    node["modified"] = int(stat.st_mtime)
    ext = path.suffix.lower().lstrip(".")
    if ext:
        node["ext"] = ext

    if ext == "ipynb":
        node["kind"] = "notebook"
        nb_id = ipynb_index.get(str(path.resolve()))
        if nb_id:
            node["notebook_id"] = nb_id
    elif ext == "md" and path.parent.resolve() == reports_dir.resolve():
        rid = _parse_report_id(path.name)
        if rid:
            node["kind"] = "report"
            node["report_id"] = rid
        else:
            node["kind"] = "file"
    else:
        node["kind"] = "file"

    return node


@router.get("/files/tree")
def get_files_tree():
    root = notebook_store.NOTEBOOKS_DIR
    if not root.exists():
        return {"root": str(root), "tree": []}
    # notebook 목록 시딩 (온보딩 노트북 자동 생성) + 최신 상태 반영
    try:
        notebook_store.list_notebooks()
    except Exception:
        pass
    # 로컬 데이터 파일 프로파일링을 백그라운드로 트리거 (CSV/Parquet 등)
    # mtime 이 그대로면 캐시 히트라 빠름 — 첫 드롭/변경 파일만 실제로 읽음
    try:
        import threading as _th
        _th.Thread(target=file_profile_cache.scan_and_profile_root, daemon=True).start()
    except Exception:
        pass
    ipynb_index = _build_ipynb_index()
    reports_dir = root / "reports"
    counter = {"n": 0}
    children: list[dict] = []
    try:
        entries = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError:
        return {"root": str(root), "tree": []}
    for child in entries:
        if _is_hidden(child.name) or child.name in _EXCLUDE_NAMES:
            continue
        node = _walk(child, 1, counter, ipynb_index, reports_dir)
        if node is not None:
            children.append(node)
    return {
        "root": str(root),
        "tree": children,
        "truncated": counter["n"] >= _MAX_ENTRIES,
    }


class MkdirBody(BaseModel):
    parent: str = ""   # 절대경로 or root 상대경로. 빈 문자열 = root
    name: str


@router.post("/files/mkdir")
def mkdir(body: MkdirBody):
    name = (body.name or "").strip()
    if not name or "/" in name or "\\" in name or name in ("..", "."):
        raise HTTPException(status_code=400, detail="invalid folder name")
    parent = _resolve_inside_root(body.parent or str(notebook_store.NOTEBOOKS_DIR))
    if not parent.exists() or not parent.is_dir():
        raise HTTPException(status_code=400, detail="parent not a directory")
    target = parent / name
    if target.exists():
        raise HTTPException(status_code=409, detail="already exists")
    try:
        target.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        # macOS NFD/NFC 한글 정규화 차이로 target.exists() 는 False 지만
        # 실제 디스크엔 같은 이름이 있는 경우
        raise HTTPException(status_code=409, detail="already exists (unicode normalization)")
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"mkdir failed: {e}")
    return {"ok": True, "path": str(target)}


class RmdirBody(BaseModel):
    path: str
    recursive: bool = False


@router.post("/files/rmdir")
def rmdir(body: RmdirBody):
    p = _resolve_inside_root(body.path)
    if p == notebook_store.NOTEBOOKS_DIR.resolve():
        raise HTTPException(status_code=400, detail="cannot delete root")
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=404, detail="not a directory")
    if body.recursive:
        shutil.rmtree(p)
    else:
        try:
            p.rmdir()
        except OSError:
            raise HTTPException(status_code=409, detail="directory not empty (use recursive=true)")
    return {"ok": True}


class MoveBody(BaseModel):
    src: str
    dst_dir: str   # 대상 폴더 (root 내부)


class ProfileBody(BaseModel):
    path: str
    force: bool = False


@router.post("/files/profile")
def profile_file(body: ProfileBody):
    p = _resolve_inside_root(body.path)
    return file_profile_cache.profile_file(p, force=body.force)


@router.post("/files/profile/rescan")
def profile_rescan():
    """루트 전체 재스캔 + 필요시 재프로파일."""
    return file_profile_cache.scan_and_profile_root()


@router.post("/files/move")
def move_entry(body: MoveBody):
    src = _resolve_inside_root(body.src)
    dst_dir = _resolve_inside_root(body.dst_dir)
    if not src.exists():
        raise HTTPException(status_code=404, detail="src not found")
    if not dst_dir.exists() or not dst_dir.is_dir():
        raise HTTPException(status_code=400, detail="dst_dir not a directory")
    target = dst_dir / src.name
    if target.exists():
        raise HTTPException(status_code=409, detail="target already exists")
    shutil.move(str(src), str(target))
    return {"ok": True, "path": str(target)}
