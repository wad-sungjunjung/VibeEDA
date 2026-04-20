"""마트 추천 — LLM 기반 (Gemini 또는 Claude)"""
import json
import logging
from typing import Optional

from fastapi import APIRouter, Header
from pydantic import BaseModel

from ..config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


class MartInfo(BaseModel):
    key: str
    description: str
    keywords: list[str] = []
    columns: list[dict] = []


class RecommendRequest(BaseModel):
    analysis_theme: str = ""
    analysis_description: str = ""
    marts: list[MartInfo] = []


def _prefilter_marts(req: RecommendRequest, top_n: int = 20) -> list[MartInfo]:
    """키워드 + 컬럼명 매칭으로 상위 N개를 LLM에 전달합니다."""
    context = (req.analysis_theme + " " + req.analysis_description).lower()
    if not context.strip():
        return req.marts[:top_n]

    def _score(m: MartInfo) -> float:
        s = 0.0
        for kw in m.keywords:
            if kw.lower() in context:
                s += 1.0
        if m.key.lower() in context:
            s += 2.0
        words = (m.key + " " + m.description).lower().split()
        for w in words:
            if len(w) > 2 and w in context:
                s += 0.3
        # 컬럼명/설명도 매칭 — 한영 교차 커버
        for col in m.columns:
            col_name = col.get("name", "").lower()
            col_desc = col.get("desc", "").lower()
            if col_name and col_name in context:
                s += 0.5
            for word in col_desc.split():
                if len(word) > 2 and word in context:
                    s += 0.2
        return s

    scored = sorted(req.marts, key=_score, reverse=True)
    return scored[:top_n]


def _build_prompt(req: RecommendRequest, marts: list[MartInfo]) -> str:
    """컬럼명 + 설명까지 포함해 LLM 정확도를 높입니다."""
    def _col_block(m: MartInfo) -> str:
        lines = []
        for c in m.columns[:30]:
            name = c.get("name", "")
            desc = c.get("desc", "")
            if name:
                lines.append(f"    - {name}: {desc}" if desc else f"    - {name}")
        return "\n".join(lines)

    mart_blocks = []
    for m in marts:
        col_text = _col_block(m)
        block = f"[{m.key}] {m.description}"
        if col_text:
            block += f"\n  columns:\n{col_text}"
        mart_blocks.append(block)
    mart_block = "\n\n".join(mart_blocks) if mart_blocks else "(마트 없음)"

    return f"""You are a data mart recommendation expert. Analyze the analysis goal and recommend the most relevant data marts.

Analysis theme: {req.analysis_theme}
Analysis description: {req.analysis_description}

Available data marts:
{mart_block}

Instructions:
- Score each mart 1-5 based on relevance to the analysis goal
- Consider mart description AND column names/descriptions
- Higher score = more relevant (5 = essential, 3 = useful, 1 = marginally relevant)
- Only include marts with score >= 2
- Write reason in Korean explaining WHY this mart is relevant

Return ONLY a raw JSON array, no markdown, no explanation:
[{{"key":"<mart_key>","score":<1-5>,"reason":"<한국어 이유>"}}]"""


async def _call_gemini(api_key: str, model: str, prompt: str) -> list[dict]:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)
    response = await client.aio.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.1,
            response_mime_type="application/json",
        ),
    )
    return json.loads(response.text.strip())


async def _call_claude(api_key: str, model: str, prompt: str) -> list[dict]:
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=api_key)
    msg = await client.messages.create(
        model=model,
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    return json.loads(msg.content[0].text.strip())


@router.post("/marts/recommend")
async def recommend_marts(
    req: RecommendRequest,
    x_gemini_key: str = Header(default="", alias="X-Gemini-Key"),
    x_anthropic_key: str = Header(default="", alias="X-Anthropic-Key"),
    x_vibe_model: str = Header(default="", alias="X-Vibe-Model"),
    x_agent_model: str = Header(default="", alias="X-Agent-Model"),
):
    if not req.analysis_description.strip() and not req.analysis_theme.strip():
        return {"ok": False, "message": "분석 내용을 먼저 입력해주세요.", "recommendations": []}

    if not req.marts:
        return {"ok": False, "message": "마트 목록이 없습니다. 스노우플레이크에 연결해주세요.", "recommendations": []}

    filtered = _prefilter_marts(req)
    prompt = _build_prompt(req, filtered)

    # 바이브 모델 우선 사용 (기본 Gemini), 없으면 에이전트 모델
    vibe_model = x_vibe_model or settings.default_vibe_model
    agent_model = x_agent_model or settings.default_agent_model

    try:
        if vibe_model.startswith("gemini-"):
            api_key = x_gemini_key or settings.gemini_api_key
            if not api_key:
                return {"ok": False, "message": "Gemini API 키가 필요합니다.", "recommendations": []}
            results = await _call_gemini(api_key, vibe_model, prompt)
        else:
            api_key = x_anthropic_key or settings.anthropic_api_key
            if not api_key:
                # fallback to agent model
                if agent_model.startswith("gemini-"):
                    api_key = x_gemini_key or settings.gemini_api_key
                    results = await _call_gemini(api_key, agent_model, prompt)
                else:
                    return {"ok": False, "message": "Anthropic API 키가 필요합니다.", "recommendations": []}
            else:
                results = await _call_claude(api_key, vibe_model, prompt)

        # score를 float으로 정규화
        for r in results:
            r["score"] = float(r.get("score", 1.0))

        return {"ok": True, "recommendations": results}

    except json.JSONDecodeError:
        logger.warning("LLM returned non-JSON for mart recommendation")
        return {"ok": False, "message": "LLM 응답을 파싱하지 못했습니다. 다시 시도해주세요.", "recommendations": []}
    except Exception as e:
        logger.error("Mart recommendation failed: %s", e)
        return {"ok": False, "message": f"추천 실패: {str(e)}", "recommendations": []}
