"""Snowflake 연결 관리 엔드포인트"""
import asyncio

from fastapi import APIRouter
from pydantic import BaseModel

from ..services import snowflake_session

router = APIRouter()


class ConnectRequest(BaseModel):
    account: str
    user: str
    authenticator: str = "externalbrowser"
    role: str = ""
    warehouse: str = ""
    database: str = ""
    schema: str = ""


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
