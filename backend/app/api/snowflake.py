"""Snowflake 연결 관리 엔드포인트"""
import asyncio
import logging

from fastapi import APIRouter
from pydantic import BaseModel

from ..services import snowflake_session
from ..services import category_cache

logger = logging.getLogger(__name__)

router = APIRouter()


class ConnectRequest(BaseModel):
    account: str
    user: str
    authenticator: str = "externalbrowser"
    role: str = ""
    warehouse: str = ""
    database: str = ""
    schema: str = ""


def _run_prewarm_bg():
    """백그라운드에서 카테고리 캐시 프리워밍."""
    try:
        result = category_cache.prewarm_all_marts()
        logger.info("category prewarm done: %s", result)
    except Exception as e:
        logger.warning("category prewarm failed: %s", e)


@router.post("/snowflake/connect")
async def connect_snowflake(req: ConnectRequest):
    """브라우저 SSO 인증 후 연결. login_timeout=120s."""
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(
            None,
            snowflake_session.connect,
            req.model_dump(),
        )
        # 연결 직후 카테고리 캐시 프리워밍을 백그라운드로 시작
        # (응답은 바로 반환 — 사용자는 기다릴 필요 없음)
        loop.run_in_executor(None, _run_prewarm_bg)
        return {"ok": True, "message": "Snowflake 연결 성공"}
    except Exception as e:
        return {"ok": False, "message": str(e)}


@router.get("/snowflake/status")
def snowflake_status():
    return snowflake_session.get_status()


@router.delete("/snowflake/connect")
def disconnect_snowflake():
    snowflake_session.disconnect()
    return {"ok": True}


@router.get("/categories/status")
def categories_status():
    """프리워밍 진행 상황 조회 (UI 토스트용)."""
    return category_cache.get_prewarm_progress()


@router.post("/categories/refresh")
def categories_refresh():
    """카테고리 캐시 수동 재생성 — 마트 값 변경 시 호출."""
    category_cache.clear_cache()
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run_prewarm_bg)
    return {"ok": True, "message": "카테고리 캐시 재생성 시작"}
