import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    sso_id: Mapped[Optional[str]] = mapped_column(String(128), unique=True, nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(100))
    team: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    notebooks: Mapped[list["Notebook"]] = relationship(back_populates="user")
    folders: Mapped[list["Folder"]] = relationship(back_populates="user")


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100))
    ordering: Mapped[float] = mapped_column(Float, default=1.0)
    is_open: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship(back_populates="folders")
    notebooks: Mapped[list["Notebook"]] = relationship(back_populates="folder")


class Notebook(Base):
    __tablename__ = "notebooks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    folder_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(255), default="새 분석")
    description: Mapped[str] = mapped_column(Text, default="")
    selected_marts: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    user: Mapped["User"] = relationship(back_populates="notebooks")
    folder: Mapped[Optional["Folder"]] = relationship(back_populates="notebooks")
    cells: Mapped[list["Cell"]] = relationship(
        back_populates="notebook",
        order_by="Cell.ordering",
        cascade="all, delete-orphan",
    )
    agent_messages: Mapped[list["AgentMessage"]] = relationship(
        back_populates="notebook",
        order_by="AgentMessage.created_at",
        cascade="all, delete-orphan",
    )


class Cell(Base):
    __tablename__ = "cells"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    notebook_id: Mapped[str] = mapped_column(ForeignKey("notebooks.id", ondelete="CASCADE"))
    ordering: Mapped[float] = mapped_column(Float, default=1.0)
    name: Mapped[str] = mapped_column(String(255), default="query_1")
    type: Mapped[str] = mapped_column(String(20), default="sql")
    code: Mapped[str] = mapped_column(Text, default="")
    memo: Mapped[str] = mapped_column(Text, default="")
    output: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    executed: Mapped[bool] = mapped_column(Boolean, default=False)
    insight: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    agent_generated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    notebook: Mapped["Notebook"] = relationship(back_populates="cells")
    chat_entries: Mapped[list["ChatEntry"]] = relationship(
        back_populates="cell",
        order_by="ChatEntry.created_at",
        cascade="all, delete-orphan",
    )


class ChatEntry(Base):
    __tablename__ = "chat_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    cell_id: Mapped[str] = mapped_column(ForeignKey("cells.id", ondelete="CASCADE"))
    user_message: Mapped[str] = mapped_column(Text)
    assistant_reply: Mapped[str] = mapped_column(Text)
    code_snapshot: Mapped[str] = mapped_column(Text, default="")
    model_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    cell: Mapped["Cell"] = relationship(back_populates="chat_entries")


class AgentMessage(Base):
    __tablename__ = "agent_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    notebook_id: Mapped[str] = mapped_column(ForeignKey("notebooks.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    created_cell_ids: Mapped[list] = mapped_column(JSON, default=list)
    model_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    notebook: Mapped["Notebook"] = relationship(back_populates="agent_messages")
