from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..services import notebook_store

router = APIRouter()


class ExtraMartCreate(BaseModel):
    # /marts/columns 응답의 mart 객체를 그대로 전달.
    # BaseModel.schema() 와 충돌하므로 schema_name 으로 받고 'schema' alias 매핑.
    model_config = ConfigDict(populate_by_name=True, protected_namespaces=())

    key: str
    database: Optional[str] = None
    schema_name: Optional[str] = Field(default=None, alias="schema")
    table_name: Optional[str] = None
    description: str = ""
    keywords: list[str] = []
    columns: list[dict[str, Any]] = []
    rules: list[str] = []
    recommendationScore: float = 0
    updatedAt: Optional[str] = None
    extra: bool = True


class NotebookCreate(BaseModel):
    title: str = "새 분석"
    folder_id: Optional[str] = None
    folder_path: Optional[str] = None


class NotebookUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    selected_marts: Optional[list[str]] = None
    folder_id: Optional[str] = None


@router.get("/notebooks")
def list_notebooks():
    return notebook_store.list_notebooks()


@router.post("/notebooks")
def create_notebook(body: NotebookCreate):
    return notebook_store.create_notebook(title=body.title, folder_id=body.folder_id, folder_path=body.folder_path)


@router.get("/notebooks/{notebook_id}")
def get_notebook(notebook_id: str):
    try:
        return notebook_store.get_notebook(notebook_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")


@router.patch("/notebooks/{notebook_id}")
def update_notebook(notebook_id: str, body: NotebookUpdate):
    try:
        data = body.model_dump(exclude_unset=True)
        return notebook_store.update_notebook_meta(notebook_id, **data)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")


@router.delete("/notebooks/{notebook_id}")
def delete_notebook(notebook_id: str):
    notebook_store.delete_notebook(notebook_id)
    return {"ok": True}


@router.post("/notebooks/{notebook_id}/extras")
def add_extra_mart(notebook_id: str, body: ExtraMartCreate):
    """히든룰 — 확장 검색으로 찾은 마트를 노트북에 영구 저장."""
    try:
        # alias 'schema' 를 'schema' 키로 저장 (프론트가 그대로 사용)
        mart_dict = body.model_dump(by_alias=True, exclude_none=True)
        notebook_store.add_extra_mart(notebook_id, mart_dict)
        return {"ok": True, "mart": mart_dict}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/notebooks/{notebook_id}/extras/{mart_key:path}")
def delete_extra_mart(notebook_id: str, mart_key: str):
    try:
        notebook_store.remove_extra_mart(notebook_id, mart_key)
        return {"ok": True}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")
