import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import notebook_store
from ..services.kernel import clear_namespace, get_namespace, run_python, run_sql

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


EXPORT_MAX_ROWS = 200_000


@router.get("/execute/{notebook_id}/{cell_id}/export")
def export_full_table(notebook_id: str, cell_id: str):
    """커널 namespace 에 남아 있는 DataFrame 을 전체 행으로 반환.

    실패 경로별로 사용자 친화적인 한국어 detail 을 내려준다:
    - 404 노트북/셀 없음
    - 409 셀 이름 없음 (저장 전 상태)
    - 410 DataFrame 휘발 (백엔드 재시작 등)
    - 413 너무 큰 데이터 (행 수 상한 초과)
    - 500 직렬화/기타 오류
    """
    try:
        nb = notebook_store.get_notebook(notebook_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="노트북을 찾을 수 없습니다.")

    cell = next((c for c in nb["cells"] if c["id"] == cell_id), None)
    if not cell:
        raise HTTPException(status_code=404, detail="셀을 찾을 수 없습니다.")

    cell_name = cell.get("name")
    if not cell_name:
        raise HTTPException(status_code=409, detail="셀에 이름이 없어 결과를 찾을 수 없습니다.")

    ns = get_namespace(notebook_id)
    df = ns.get(cell_name)
    if df is None or not (hasattr(df, "columns") and hasattr(df, "values")):
        raise HTTPException(
            status_code=410,
            detail="셀 결과가 커널에 남아있지 않습니다. 해당 셀을 다시 실행한 뒤 시도해주세요.",
        )

    n = len(df)
    if n > EXPORT_MAX_ROWS:
        raise HTTPException(
            status_code=413,
            detail=(
                f"데이터가 너무 큽니다 (행 수: {n:,} > 한계 {EXPORT_MAX_ROWS:,}). "
                "집계/필터로 범위를 줄이거나 Python 셀에서 `df.to_csv('파일명.csv')` 로 파일 저장 후 사용해주세요."
            ),
        )

    import math
    from decimal import Decimal
    import datetime as _dt

    def _safe(v):
        if v is None:
            return None
        if hasattr(v, "__class__") and v.__class__.__name__ == "NaTType":
            return None
        if isinstance(v, float):
            if math.isnan(v) or math.isinf(v):
                return None
            return v
        if isinstance(v, Decimal):
            return float(v)
        if isinstance(v, (_dt.datetime, _dt.date)):
            return v.isoformat()
        return v

    try:
        columns = [{"name": str(c)} for c in df.columns]
        rows = [[_safe(v) for v in row] for row in df.values.tolist()]
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"결과를 직렬화하지 못했습니다: {type(e).__name__}: {e}",
        )

    return {"columns": columns, "rows": rows, "rowCount": n}
