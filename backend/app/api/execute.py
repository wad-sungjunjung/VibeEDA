import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import notebook_store
from ..services.kernel import clear_namespace, run_python, run_sql

router = APIRouter()


class ExecuteRequest(BaseModel):
    notebook_id: str


@router.post("/execute/{cell_id}")
async def execute_cell(cell_id: str, body: ExecuteRequest):
    try:
        nb = notebook_store.get_notebook(body.notebook_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Notebook not found")

    cell = next((c for c in nb["cells"] if c["id"] == cell_id), None)
    if not cell:
        raise HTTPException(status_code=404, detail="Cell not found")

    loop = asyncio.get_event_loop()
    if cell["type"] == "python":
        output = await loop.run_in_executor(
            None, run_python, body.notebook_id, cell["name"], cell["code"]
        )
    elif cell["type"] == "sql":
        output = await loop.run_in_executor(
            None, run_sql, body.notebook_id, cell["name"], cell["code"]
        )
    else:
        output = {"type": "stdout", "content": ""}

    notebook_store.update_cell(body.notebook_id, cell_id, output=output)
    return output


@router.delete("/kernel/{notebook_id}")
def reset_kernel(notebook_id: str):
    clear_namespace(notebook_id)
    return {"ok": True}
