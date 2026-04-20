"""Reporting — 선택 셀 기반 Markdown 리포트 스트리밍 생성 + 파일 저장."""
import json
import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel

from ..config import settings
from ..services import report_service

logger = logging.getLogger(__name__)
router = APIRouter()


class ReportCreateRequest(BaseModel):
    notebook_id: str
    cell_ids: list[str]
    goal: Optional[str] = ""


@router.post("/reports/stream")
async def create_report_stream(
    req: ReportCreateRequest,
    x_anthropic_key: str = Header(default="", alias="X-Anthropic-Key"),
    x_gemini_key: str = Header(default="", alias="X-Gemini-Key"),
    x_report_model: str = Header(default="", alias="X-Report-Model"),
):
    model = x_report_model or settings.default_report_model
    is_gemini = model.startswith("gemini-")
    api_key = (x_gemini_key or settings.gemini_api_key) if is_gemini else (x_anthropic_key or settings.anthropic_api_key)

    async def generate():
        async for event in report_service.run_report_stream(
            api_key=api_key,
            model=model,
            notebook_id=req.notebook_id,
            cell_ids=req.cell_ids,
            goal=req.goal or "",
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/reports")
def list_reports():
    return report_service.list_reports()


@router.get("/reports/{report_id}")
def get_report(report_id: str):
    r = report_service.get_report(report_id)
    if not r:
        raise HTTPException(status_code=404, detail="Report not found")
    return r


@router.delete("/reports/{report_id}")
def delete_report(report_id: str):
    ok = report_service.delete_report(report_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"ok": True}


@router.get("/reports/{report_id}/assets/{filename}")
def get_report_asset(report_id: str, filename: str):
    p = report_service.get_asset_path(report_id, filename)
    if not p:
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(p, media_type="image/png")
