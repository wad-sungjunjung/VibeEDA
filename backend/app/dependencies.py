from typing import Optional

from fastapi import Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from .config import LLMConfig, settings
from .database import get_db, AsyncSessionLocal
from .models import User


async def get_llm_config(
    x_gemini_key: Optional[str] = Header(None, alias="X-Gemini-Key"),
    x_anthropic_key: Optional[str] = Header(None, alias="X-Anthropic-Key"),
    x_vibe_model: Optional[str] = Header(None, alias="X-Vibe-Model"),
    x_agent_model: Optional[str] = Header(None, alias="X-Agent-Model"),
) -> LLMConfig:
    # TODO(auth): After Google OAuth, replace env fallback with user.api_keys from DB
    return LLMConfig(
        gemini_api_key=x_gemini_key or settings.gemini_api_key,
        anthropic_api_key=x_anthropic_key or settings.anthropic_api_key,
        vibe_model=x_vibe_model or settings.default_vibe_model,
        agent_model=x_agent_model or settings.default_agent_model,
    )


async def get_current_user(db: AsyncSession = Header(None)) -> User:
    # Placeholder until Google OAuth is implemented.
    # Returns the hardcoded dev user from DB.
    pass


async def get_dev_user(db: AsyncSession) -> User:
    result = await db.execute(select(User).where(User.id == settings.dev_user_id))
    user = result.scalar_one_or_none()
    if not user:
        user = User(
            id=settings.dev_user_id,
            sso_id=settings.dev_user_sso_id,
            email="hawoo@company.com",
            name=settings.dev_user_name,
            team="광고사업부",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user
