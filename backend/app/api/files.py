"""루트 폴더 통합 파일 트리 + 폴더 조작.

사이드바의 "폴더/파일/히스토리/리포트" 를 단일 파일시스템 트리로 통합한다.
- ipynb → kind: "notebook", notebook_id 포함 (클릭 시 분석 열기)
- reports/{id}.md → kind: "report", report_id 포함 (클릭 시 리포트 열기)
- 기타 디렉터리/파일 → kind: "folder" | "file"
- 히스토리 섹션은 "루트 수준의 ipynb" 만 표시하므로 프론트에서 필터.
"""
from __future__ import annotations

import shutil
import re
from pathlib import Path
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from ..services import notebook_store
from ..services import file_profile_cache


router = APIRouter()

# 업로드 허용 확장자 (분석 관련 포맷만 — .py/.sh 같은 실행 스크립트는 제외)
_UPLOAD_ALLOWED_EXTS = {
    ".csv", ".tsv", ".xlsx", ".xls", ".parquet",
    ".json", ".txt", ".md", ".ipynb",
}
_UPLOAD_MAX_BYTES = 100 * 1024 * 1024  # 100 MB
_SAFE_FILENAME_RE = re.compile(r"[\x00-\x1f<>:\"/\\|?*]")


def _sanitize_filename(name: str) -> str:
    name = _SAFE_FILENAME_RE.sub("_", name.strip())
    name = name.lstrip(".").replace("..", "_")
    return name[:200] or "upload"

_EXCLUDE_NAMES = {"__pycache__", ".vibe_config.json", ".DS_Store", ".vibe", ".categories_cache.json"}
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
        # 신규 리포트 폴더 구조: reports/{id}/ 안에 {id}.md 가 있으면 폴더를 report 노드로 압축.
        # (레거시는 reports/{id}.md 평면 구조라 이 케이스 아님)
        try:
            if path.parent.resolve() == reports_dir.resolve():
                md_inside = path / f"{path.name}.md"
                if md_inside.exists():
                    return {
                        "name": path.name,
                        "path": str(md_inside),
                        "type": "file",
                        "kind": "report",
                        "report_id": path.name,
                        "ext": "md",
                        "size": md_inside.stat().st_size,
                        "modified": int(md_inside.stat().st_mtime),
                    }
        except OSError:
            pass

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
    elif ext == "md":
        reports_dir_r = reports_dir.resolve()
        parent_r = path.parent.resolve()
        is_legacy_report = parent_r == reports_dir_r  # reports/{id}.md
        # 신규 폴더 구조: reports/{id}/{id}.md — 파일 stem 과 폴더명이 일치하고 상위가 reports_dir
        is_folder_report = (
            parent_r.parent == reports_dir_r
            and path.stem == path.parent.name
        )
        if is_legacy_report or is_folder_report:
            rid = _parse_report_id(path.name)
            if rid:
                node["kind"] = "report"
                node["report_id"] = rid
            else:
                node["kind"] = "file"
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


class DeleteFileBody(BaseModel):
    path: str


@router.post("/files/delete")
def delete_file(body: DeleteFileBody):
    """업로드된 일반 파일(csv/xlsx/parquet/md 등) 삭제.
    .ipynb / reports 는 별도 경로(DELETE /notebooks/{id}, /reports/{id}) 사용 — 여기서는 거부."""
    p = _resolve_inside_root(body.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="file not found")
    if not p.is_file():
        raise HTTPException(status_code=400, detail="not a file")
    if p.suffix.lower() == ".ipynb":
        raise HTTPException(status_code=400, detail=".ipynb 는 분석 삭제 메뉴로 제거해주세요")
    try:
        p.unlink()
        # 프로파일 캐시에서도 제거
        try:
            file_profile_cache.clear_cache(str(p))
        except Exception:
            pass
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"삭제 실패: {e}")
    return {"ok": True}


@router.post("/files/upload")
async def upload_file(
    file: UploadFile = File(...),
    dst_dir: str = Form(default=""),
    overwrite: bool = Form(default=False),
):
    """외부 파일(csv/xlsx/parquet/tsv/json/txt/md/ipynb) 업로드.
    dst_dir 가 비어 있으면 NOTEBOOKS_DIR 루트에 저장. 저장 후 분석 포맷은 바로 프로파일링.
    .ipynb 는 저장 후 notebook_store 에 자동 등록하여 파일트리에서 즉시 열 수 있게 함.
    """
    raw_name = file.filename or "upload"
    safe_name = _sanitize_filename(raw_name)
    ext = Path(safe_name).suffix.lower()
    if ext not in _UPLOAD_ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"허용되지 않은 확장자: {ext or '(없음)'} — 허용: {', '.join(sorted(_UPLOAD_ALLOWED_EXTS))}",
        )

    target_dir = (
        _resolve_inside_root(dst_dir) if dst_dir
        else notebook_store.NOTEBOOKS_DIR.resolve()
    )
    if not target_dir.exists() or not target_dir.is_dir():
        raise HTTPException(status_code=400, detail="dst_dir not a directory")

    target = target_dir / safe_name
    if target.exists() and not overwrite:
        # 같은 이름이 있으면 자동 증가 — name (1).csv, name (2).csv ...
        stem, suffix = Path(safe_name).stem, Path(safe_name).suffix
        n = 1
        while True:
            cand = target_dir / f"{stem} ({n}){suffix}"
            if not cand.exists():
                target = cand
                break
            n += 1
            if n > 999:
                raise HTTPException(status_code=409, detail="too many duplicates")

    # 스트리밍 저장 + 크기 상한 감시
    total = 0
    try:
        with target.open("wb") as out:
            while True:
                chunk = await file.read(1 << 20)  # 1 MB
                if not chunk:
                    break
                total += len(chunk)
                if total > _UPLOAD_MAX_BYTES:
                    out.close()
                    target.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"파일이 너무 큽니다 (상한 {_UPLOAD_MAX_BYTES // (1024*1024)} MB)",
                    )
                out.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"업로드 실패: {e}")

    # 분석 가능 포맷은 즉시 프로파일링 (실패해도 업로드 자체는 성공으로 반환)
    profile = None
    if ext in {".csv", ".tsv", ".xlsx", ".xls", ".parquet"}:
        try:
            profile = file_profile_cache.profile_file(target)
        except Exception as e:
            profile = {"error": str(e)}

    # .ipynb 는 notebook_store 에 등록 — vibe.id 가 없으면 새로 부여, rel 경로로 id_to_file 기록
    notebook_id = None
    if ext == ".ipynb":
        try:
            import json as _json, uuid as _uuid
            from ..services.notebook_store._core import _register_file, NOTEBOOKS_DIR
            nb = _json.loads(target.read_text(encoding="utf-8"))
            vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
            nb_id = vibe.get("id") or str(_uuid.uuid4())
            vibe["id"] = nb_id
            if not vibe.get("title"):
                vibe["title"] = target.stem
            target.write_text(_json.dumps(nb, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                rel = str(target.resolve().relative_to(NOTEBOOKS_DIR.resolve()).with_suffix(""))
            except ValueError:
                rel = target.stem
            _register_file(nb_id, rel)
            notebook_id = nb_id
        except Exception as e:
            profile = {"error": f"notebook 등록 실패: {e}"}

    return {
        "ok": True,
        "path": str(target),
        "name": target.name,
        "size": total,
        "profile": profile,
        **({"notebook_id": notebook_id} if notebook_id else {}),
    }


@router.post("/files/open-folder")
def open_folder():
    import sys
    import os
    import subprocess
    nd = str(notebook_store.NOTEBOOKS_DIR.resolve())
    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", nd], close_fds=True)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", nd])
        else:
            subprocess.Popen(["xdg-open", nd])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": nd}


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
    # .ipynb 이동 시 id_to_file 매핑을 새 위치로 업데이트해야 파일 트리에서 notebook_id 를 인식할 수 있음
    if src.suffix.lower() == ".ipynb":
        try:
            root = notebook_store.NOTEBOOKS_DIR.resolve()
            new_rel = str(target.resolve().relative_to(root).with_suffix(""))
            cfg = notebook_store._read_config()
            id_to_file = cfg.setdefault("id_to_file", {})
            # 기존 항목 중 이 파일을 가리키는 id 를 찾아 새 경로로 교체
            old_rel = str(src.resolve().relative_to(root).with_suffix(""))
            for nb_id, fname in list(id_to_file.items()):
                if fname == old_rel or Path(fname) == Path(old_rel):
                    id_to_file[nb_id] = new_rel
                    break
            else:
                # 등록되지 않은 경우: 새 파일의 vibe.id 를 읽어 등록
                try:
                    import json as _json
                    nb = _json.loads(target.read_text(encoding="utf-8"))
                    nb_id = nb.get("metadata", {}).get("vibe", {}).get("id")
                    if nb_id:
                        id_to_file[nb_id] = new_rel
                except Exception:
                    pass
            notebook_store._write_config(cfg)
        except Exception:
            pass
    return {"ok": True, "path": str(target)}
