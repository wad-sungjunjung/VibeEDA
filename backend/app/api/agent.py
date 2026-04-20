"""Agent Mode — Claude tool use + .ipynb 파일 기반"""
import json
import logging
import datetime as _dt
from decimal import Decimal
from typing import Literal, Optional


def _json_default(o):
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, (_dt.datetime, _dt.date, _dt.time)):
        return o.isoformat()
    if isinstance(o, (bytes, bytearray)):
        return o.decode("utf-8", errors="replace")
    return str(o)

from fastapi import APIRouter, Header

logger = logging.getLogger(__name__)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import get_llm_config, settings
from ..services import notebook_store
from ..services.claude_agent import NotebookState, CellState, run_agent_stream as run_agent_claude
from ..services.gemini_agent_service import run_agent_stream_gemini as run_agent_gemini

router = APIRouter()


class CellSnapshot(BaseModel):
    id: str
    name: str
    type: Literal["sql", "python", "markdown"]
    code: str
    executed: bool = False


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AgentRequest(BaseModel):
    message: str
    cells: list[CellSnapshot] = []
    selected_marts: list[str] = []
    analysis_theme: str = ""
    analysis_description: str = ""
    conversation_history: list[ConversationMessage] = []
    notebook_id: Optional[str] = None


@router.post("/agent/stream")
async def agent_stream_endpoint(
    req: AgentRequest,
    x_anthropic_key: str = Header(default="", alias="X-Anthropic-Key"),
    x_gemini_key: str = Header(default="", alias="X-Gemini-Key"),
    x_agent_model: str = Header(default="", alias="X-Agent-Model"),
):
    config = get_llm_config(x_anthropic_key=x_anthropic_key, x_agent_model=x_agent_model)
    use_gemini = config.agent_model.startswith("gemini-")
    agent_api_key = (x_gemini_key or settings.gemini_api_key) if use_gemini else config.anthropic_api_key

    notebook_state = NotebookState(
        cells=[CellState(id=c.id, name=c.name, type=c.type, code=c.code, executed=c.executed) for c in req.cells],
        selected_marts=req.selected_marts,
        analysis_theme=req.analysis_theme,
        analysis_description=req.analysis_description,
        notebook_id=req.notebook_id or "",
    )
    history = [{"role": m.role, "content": m.content} for m in req.conversation_history]

    async def generate():
        created_cell_ids: list[str] = []
        assistant_content: list[str] = []

        run_fn = run_agent_gemini if use_gemini else run_agent_claude
        async for event in run_fn(
            api_key=agent_api_key,
            model=config.agent_model,
            user_message=req.message,
            notebook_state=notebook_state,
            conversation_history=history,
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False, default=_json_default)}\n\n"

            if event.get("type") == "message_delta":
                assistant_content.append(event.get("content", ""))
            elif event.get("type") == "cell_created":
                created_cell_ids.append(event["cell_id"])
            elif event.get("type") == "complete" and req.notebook_id:
                # 에이전트 대화 히스토리만 저장. 셀 자체는 프론트엔드가 cell_created 이벤트마다
                # 이미 POST /cells 로 저장하므로 여기서 중복 저장하지 않는다.
                try:
                    notebook_store.add_agent_message(req.notebook_id, "user", req.message)
                    notebook_store.add_agent_message(
                        req.notebook_id, "assistant",
                        "".join(assistant_content), created_cell_ids
                    )
                except Exception as e:
                    logger.warning("Failed to persist agent session: %s", e)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class TitleRequest(BaseModel):
    question: str


_TITLE_PROMPT = (
    "다음 데이터 분석 질문을 8~16자 사이의 한국어 제목으로 요약하세요. "
    "따옴표/마침표/이모지 없이 명사구로만 답하고, 제목 외의 어떤 텍스트도 출력하지 마세요.\n\n"
    "질문: {question}\n\n제목:"
)


def _clean_title(raw: str) -> str:
    t = (raw or "").strip().splitlines()[0] if (raw or "").strip() else ""
    t = t.strip().strip("\"'“”‘’`.。").strip()
    if len(t) > 24:
        t = t[:24] + "…"
    return t


@router.post("/agent/title")
async def agent_title_endpoint(
    req: TitleRequest,
    x_anthropic_key: str = Header(default="", alias="X-Anthropic-Key"),
    x_gemini_key: str = Header(default="", alias="X-Gemini-Key"),
    x_vibe_model: str = Header(default="", alias="X-Vibe-Model"),
):
    question = (req.question or "").strip()
    if not question:
        return {"ok": False, "title": ""}

    prompt = _TITLE_PROMPT.format(question=question[:400])
    vibe_model = x_vibe_model or settings.default_vibe_model

    try:
        if vibe_model.startswith("gemini-"):
            api_key = x_gemini_key or settings.gemini_api_key
            if not api_key:
                return {"ok": False, "title": ""}
            from google import genai
            client = genai.Client(api_key=api_key)
            resp = await client.aio.models.generate_content(model=vibe_model, contents=prompt)
            title = _clean_title(resp.text or "")
        else:
            api_key = x_anthropic_key or settings.anthropic_api_key
            if not api_key:
                return {"ok": False, "title": ""}
            import anthropic
            client = anthropic.AsyncAnthropic(api_key=api_key)
            msg = await client.messages.create(
                model=vibe_model,
                max_tokens=64,
                messages=[{"role": "user", "content": prompt}],
            )
            title = _clean_title(msg.content[0].text if msg.content else "")
        return {"ok": True, "title": title}
    except Exception as e:
        logger.warning("agent/title generation failed: %s", e)
        return {"ok": False, "title": ""}
