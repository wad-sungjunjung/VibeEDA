from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import notebook_store

router = APIRouter()


class NotebookCreate(BaseModel):
    title: str = "새 분석"
    folder_id: Optional[str] = None


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
    return notebook_store.create_notebook(title=body.title, folder_id=body.folder_id)


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
