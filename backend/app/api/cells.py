from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from ..services import notebook_store
from ..services.naming import to_snake_case

router = APIRouter()


class CellCreate(BaseModel):
    id: Optional[str] = None
    name: str
    type: str
    code: str = ""
    memo: str = ""
    ordering: float = 1000.0
    after_id: Optional[str] = None
    agent_generated: bool = False

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, v: str) -> str:
        return to_snake_case(v)


class CellUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    code: Optional[str] = None
    memo: Optional[str] = None
    ordering: Optional[float] = None
    executed: Optional[bool] = None
    output: Optional[dict] = None
    insight: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, v: Optional[str]) -> Optional[str]:
        return to_snake_case(v) if v is not None else None


@router.post("/notebooks/{notebook_id}/cells")
def create_cell(notebook_id: str, body: CellCreate):
    try:
        return notebook_store.create_cell(
            nb_id=notebook_id,
            cell_type=body.type,
            name=body.name,
            code=body.code,
            memo=body.memo,
            ordering=body.ordering,
            cell_id=body.id,
            after_id=body.after_id,
            agent_generated=body.agent_generated,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")


@router.patch("/notebooks/{notebook_id}/cells/{cell_id}")
def update_cell(notebook_id: str, cell_id: str, body: CellUpdate):
    try:
        data = body.model_dump(exclude_unset=True)
        return notebook_store.update_cell(notebook_id, cell_id, **data)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/notebooks/{notebook_id}/cells/{cell_id}")
def delete_cell(notebook_id: str, cell_id: str):
    try:
        notebook_store.delete_cell(notebook_id, cell_id)
        return {"ok": True}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")


@router.delete("/notebooks/{notebook_id}/cells/{cell_id}/chat/{index}")
def delete_chat_entry(notebook_id: str, cell_id: str, index: int):
    try:
        notebook_store.delete_chat_entry(notebook_id, cell_id, index)
        return {"ok": True}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")


class ChatTruncate(BaseModel):
    keep: int


@router.post("/notebooks/{notebook_id}/cells/{cell_id}/chat/truncate")
def truncate_chat_history(notebook_id: str, cell_id: str, body: ChatTruncate):
    try:
        notebook_store.truncate_chat_history(notebook_id, cell_id, body.keep)
        return {"ok": True}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")
