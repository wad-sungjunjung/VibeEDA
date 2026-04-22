"""Vibe Chat — Gemini API 스트리밍으로 셀 코드 수정"""
import json
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Header

logger = logging.getLogger(__name__)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import settings
from ..services import notebook_store
from ..services import category_cache
from ..services.kernel import get_dataframe_summaries
from ..services.gemini_service import stream_vibe_chat as stream_vibe_gemini
from ..services.claude_vibe_service import stream_vibe_chat_claude as stream_vibe_claude
from ..services.sheet_vibe_service import vibe_sheet as vibe_sheet_run

router = APIRouter()


class MartColumnMeta(BaseModel):
    name: str
    type: str
    desc: str = ""

class VibeMartMeta(BaseModel):
    key: str
    description: str = ""
    columns: list[MartColumnMeta] = []

class VibeRequest(BaseModel):
    cell_id: str
    cell_type: Literal["sql", "python", "markdown"]
    current_code: str
    message: str
    selected_marts: list[str] = []
    mart_metadata: list[VibeMartMeta] = []
    analysis_theme: str = ""
    notebook_id: Optional[str] = None


@router.post("/vibe")
async def vibe_endpoint(
    req: VibeRequest,
    x_gemini_key: str = Header(default="", alias="X-Gemini-Key"),
    x_anthropic_key: str = Header(default="", alias="X-Anthropic-Key"),
    x_vibe_model: str = Header(default="", alias="X-Vibe-Model"),
):
    model = x_vibe_model or settings.default_vibe_model
    use_claude = model.startswith("claude-")
    api_key = (x_anthropic_key or settings.anthropic_api_key) if use_claude else (x_gemini_key or settings.gemini_api_key)

    df_summaries: dict[str, str] = {}
    cell_above_name: Optional[str] = None
    if req.cell_type == "python" and req.notebook_id:
        df_summaries = get_dataframe_summaries(req.notebook_id)
        cell_above_name = notebook_store.get_cell_above_name(req.notebook_id, req.cell_id)

    async def generate():
        full_code = ""
        explanation = ""

        stream_fn = stream_vibe_claude if use_claude else stream_vibe_gemini
        async for event in stream_fn(
            api_key=api_key,
            model=model,
            cell_type=req.cell_type,
            current_code=req.current_code,
            message=req.message,
            selected_marts=req.selected_marts,
            mart_metadata=category_cache.enrich_mart_metadata(
                [m.model_dump() for m in req.mart_metadata]
            ),
            analysis_theme=req.analysis_theme,
            df_summaries=df_summaries,
            cell_above_name=cell_above_name,
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event.get("type") == "complete":
                full_code = event.get("full_code", "")
                explanation = event.get("explanation", "")

        if req.notebook_id and full_code:
            try:
                notebook_store.add_chat_entry(
                    req.notebook_id, req.cell_id,
                    req.message, explanation or full_code[:80], req.current_code,
                    code_result=full_code,
                )
            except Exception as e:
                logger.warning("Failed to save chat entry: %s", e)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ─── Sheet Vibe ────────────────────────────────────────────────────────────

class SheetVibeRequest(BaseModel):
    cell_id: str
    message: str
    selection: Optional[str] = None
    data_region: list[list[Any]] = []
    data_origin: str = "A1"
    notebook_id: Optional[str] = None


@router.post("/vibe/sheet")
async def vibe_sheet_endpoint(
    req: SheetVibeRequest,
    x_gemini_key: str = Header(default="", alias="X-Gemini-Key"),
    x_anthropic_key: str = Header(default="", alias="X-Anthropic-Key"),
    x_vibe_model: str = Header(default="", alias="X-Vibe-Model"),
):
    model = x_vibe_model or settings.default_vibe_model
    use_claude = model.startswith("claude-")
    api_key = (x_anthropic_key or settings.anthropic_api_key) if use_claude else (x_gemini_key or settings.gemini_api_key)
    result = await vibe_sheet_run(
        use_claude=use_claude,
        api_key=api_key,
        model=model,
        message=req.message,
        selection=req.selection,
        data_region=req.data_region,
        data_origin=req.data_origin,
    )
    return result
