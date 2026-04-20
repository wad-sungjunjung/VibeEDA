from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import notebook_store

router = APIRouter()


class FolderCreate(BaseModel):
    name: str


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    is_open: Optional[bool] = None
    ordering: Optional[float] = None


@router.get("/folders")
def list_folders():
    return notebook_store.list_folders()


@router.post("/folders")
def create_folder(body: FolderCreate):
    return notebook_store.create_folder(body.name)


@router.patch("/folders/{folder_id}")
def update_folder(folder_id: str, body: FolderUpdate):
    try:
        return notebook_store.update_folder(folder_id, **body.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: str):
    notebook_store.delete_folder(folder_id)
    return {"ok": True}
