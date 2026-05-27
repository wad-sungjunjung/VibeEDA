"""외부 MCP 서버 클라이언트 — 에이전트 모드에서 DataHub 등 stdio MCP 도구를 사용.

설계 메모
- VibeEDA 는 `mcp_server.py` 로 MCP **서버** 도 제공하지만, 이 모듈은 반대로
  에이전트가 외부 MCP 서버(예: `uvx mcp-server-datahub`)의 도구를 **클라이언트** 로
  호출하기 위한 것이다.
- 설정 소스: `~/vibe-notebooks/.vibe/mcp.json` (표준 mcp.json 포맷 — `mcpServers` 키).
  Cortex 의 `~/.snowflake/cortex/mcp.json` 과 동일 포맷이라 복사해 쓸 수 있다.
- 각 서버는 stdio 하위프로세스로 1회 띄워 세션을 유지한다. stdio_client / ClientSession
  은 "같은 태스크에서 열고 닫아야" 하므로, 서버마다 전용 백그라운드 태스크를 돌리고
  asyncio.Queue 로 도구 호출 요청을 직렬 전달한다 (요청-future 패턴).
- 도구 이름은 충돌 방지를 위해 `mcp__{server}__{tool}` 로 prefix 한다 (Claude Code 관례).
- 실패는 에이전트를 죽이지 않는다 — 설정 없음/패키지 없음/서버 기동 실패 시 도구가
  비어있을 뿐이고, 호출 실패는 tool_result 의 error 로 반환된다.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import timedelta
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ─── 설정 ──────────────────────────────────────────────────────────────────────
MCP_CONFIG_PATH = Path.home() / "vibe-notebooks" / ".vibe" / "mcp.json"

TOOL_PREFIX = "mcp"          # 도구 이름 prefix
TOOL_SEP = "__"              # 구분자 — mcp__{server}__{tool}
TOOL_PREFIX_FULL = f"{TOOL_PREFIX}{TOOL_SEP}"   # "mcp__"

# 서버 1대 기동(첫 list_tools 응답)까지 대기 상한. uvx 콜드스타트(패키지 다운로드) 고려해 넉넉히.
SERVER_START_TIMEOUT_SEC = 60
# 단일 도구 호출 상한.
TOOL_CALL_TIMEOUT_SEC = 120


def is_mcp_tool(name: str) -> bool:
    return name.startswith(TOOL_PREFIX_FULL)


def _read_config() -> dict[str, dict]:
    """mcp.json 의 mcpServers 딕셔너리 반환 (없으면 빈 dict)."""
    if not MCP_CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(MCP_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        logger.warning("MCP 설정 파싱 실패 (%s): %s", MCP_CONFIG_PATH, e)
        return {}
    servers = data.get("mcpServers") or {}
    return servers if isinstance(servers, dict) else {}


class _ServerConn:
    """단일 MCP 서버에 대한 stdio 세션을 전용 태스크에서 유지한다."""

    def __init__(self, name: str, spec: dict):
        self.name = name
        self.spec = spec
        # 도구 스펙 (Claude 포맷, prefix 적용된 이름) + 원본 이름 역매핑
        self.tool_specs: list[dict] = []
        self._orig_name: dict[str, str] = {}  # qualified -> original tool name
        self._queue: asyncio.Queue = asyncio.Queue()
        self._ready = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self.error: Optional[str] = None

    def _qualified(self, tool_name: str) -> str:
        return f"{TOOL_PREFIX_FULL}{self.name}{TOOL_SEP}{tool_name}"

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"mcp-{self.name}")
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=SERVER_START_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            self.error = f"기동 타임아웃 ({SERVER_START_TIMEOUT_SEC}s)"
            logger.warning("MCP 서버 '%s' 기동 타임아웃", self.name)

    async def _run(self) -> None:
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
        except Exception as e:  # noqa: BLE001
            self.error = f"mcp 패키지 import 실패: {e}"
            self._ready.set()
            return

        # 하위프로세스 env: 현재 환경 + 설정 env. uvx 탐색을 위해 ~/.local/bin 도 PATH 에 보강.
        env = dict(os.environ)
        env.update(self.spec.get("env") or {})
        local_bin = str(Path.home() / ".local" / "bin")
        if local_bin not in env.get("PATH", "").split(os.pathsep):
            env["PATH"] = local_bin + os.pathsep + env.get("PATH", "")

        params = StdioServerParameters(
            command=self.spec.get("command", ""),
            args=list(self.spec.get("args") or []),
            env=env,
            cwd=self.spec.get("cwd"),
        )

        try:
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    for t in listed.tools:
                        qn = self._qualified(t.name)
                        self._orig_name[qn] = t.name
                        self.tool_specs.append({
                            "name": qn,
                            "description": (t.description or t.name)[:2048],
                            "input_schema": _normalize_schema(t.inputSchema),
                        })
                    self._ready.set()
                    logger.info("MCP 서버 '%s' 연결됨 — 도구 %d개", self.name, len(self.tool_specs))

                    # 요청 루프: (qualified_name, args, future) 를 받아 처리.
                    while True:
                        req = await self._queue.get()
                        if req is None:  # 종료 신호
                            break
                        qn, args, fut = req
                        if fut.done():
                            continue
                        try:
                            res = await session.call_tool(
                                self._orig_name.get(qn, qn),
                                args or {},
                                read_timeout_seconds=timedelta(seconds=TOOL_CALL_TIMEOUT_SEC),
                            )
                            fut.set_result(_result_to_dict(res))
                        except Exception as e:  # noqa: BLE001
                            if not fut.done():
                                fut.set_exception(e)
        except Exception as e:  # noqa: BLE001
            self.error = str(e)
            logger.warning("MCP 서버 '%s' 세션 실패: %s", self.name, e)
            self._ready.set()
            # 큐에 남은(혹은 이후 들어올) 요청을 즉시 에러로 응답하도록 비운다.
            self._drain_with_error()

    def _drain_with_error(self) -> None:
        while not self._queue.empty():
            try:
                req = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if req is None:
                continue
            _, _, fut = req
            if not fut.done():
                fut.set_exception(RuntimeError(self.error or "MCP 세션 종료됨"))

    async def call(self, qualified_name: str, args: dict) -> dict:
        if self.error:
            return {"error": "mcp_server_unavailable", "message": f"MCP 서버 '{self.name}' 사용 불가: {self.error}"}
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        await self._queue.put((qualified_name, args, fut))
        try:
            return await asyncio.wait_for(fut, timeout=TOOL_CALL_TIMEOUT_SEC + 5)
        except asyncio.TimeoutError:
            return {"error": "mcp_tool_timeout", "message": f"MCP 도구 '{qualified_name}' 응답 타임아웃"}
        except Exception as e:  # noqa: BLE001
            return {"error": "mcp_tool_error", "message": str(e)}


def _normalize_schema(schema: Any) -> dict:
    """MCP inputSchema 를 Claude input_schema 로 사용 가능한 형태로 보정."""
    if not isinstance(schema, dict) or "type" not in schema:
        return {"type": "object", "properties": {}}
    return schema


def _result_to_dict(res: Any) -> dict:
    """mcp CallToolResult → JSON-safe dict (텍스트/구조화 컨텐츠 추출)."""
    out: dict[str, Any] = {}
    is_error = bool(getattr(res, "isError", False))
    if is_error:
        out["error"] = "mcp_tool_error"

    structured = getattr(res, "structuredContent", None)
    if structured is not None:
        out["data"] = structured

    texts: list[str] = []
    for block in (getattr(res, "content", None) or []):
        btype = getattr(block, "type", None)
        if btype == "text":
            texts.append(getattr(block, "text", ""))
        else:
            # image/resource 등 비텍스트 블록은 타입만 기록 (LLM 토큰 절약).
            texts.append(f"[{btype} content]")
    if texts:
        out["text" if not is_error else "message"] = "\n".join(texts)
    if not out:
        out["text"] = ""
    return out


class MCPManager:
    def __init__(self):
        self._conns: dict[str, _ServerConn] = {}
        self._lock = asyncio.Lock()
        self._initialized = False

    async def ensure_started(self) -> None:
        """최초 1회 설정을 읽어 모든 MCP 서버에 연결한다 (프로세스 수명 동안 유지).

        연결된 서버가 하나도 없으면(설정 없음/전부 실패) 다음 호출에서 재시도한다 —
        사용자가 설치 후 mcp.json 을 추가했을 때 백엔드 재시작 없이도 잡히게.
        """
        async with self._lock:
            if self._initialized and self._conns:
                return
            servers = _read_config()
            if not servers:
                self._initialized = True
                return
            for name, spec in servers.items():
                if name in self._conns and not self._conns[name].error:
                    continue
                if not isinstance(spec, dict) or not spec.get("command"):
                    logger.warning("MCP 서버 '%s' 설정에 command 없음 — 건너뜀", name)
                    continue
                conn = _ServerConn(name, spec)
                await conn.start()
                self._conns[name] = conn
            self._initialized = True

    def claude_tool_specs(self) -> list[dict]:
        out: list[dict] = []
        for conn in self._conns.values():
            out.extend(conn.tool_specs)
        return out

    def has_tools(self) -> bool:
        return any(c.tool_specs for c in self._conns.values())

    async def call_tool(self, qualified_name: str, args: dict) -> dict:
        # qualified_name = mcp__{server}__{tool} — server 로 라우팅.
        rest = qualified_name[len(TOOL_PREFIX_FULL):] if is_mcp_tool(qualified_name) else qualified_name
        server = rest.split(TOOL_SEP, 1)[0]
        conn = self._conns.get(server)
        if conn is None:
            return {"error": "mcp_server_not_found", "message": f"MCP 서버 '{server}' 를 찾을 수 없습니다."}
        return await conn.call(qualified_name, args)

    def prompt_block(self) -> str:
        """에이전트 시스템 프롬프트에 주입할 외부 MCP 도구 안내 + 메타 우선 지침."""
        if not self.has_tools():
            return ""
        lines: list[str] = [
            "\n## 🔗 외부 메타데이터 도구 (MCP — 사실 기반, 추론 금지)",
            "아래 외부 MCP 도구들이 연결되어 있다. 테이블 구조·컬럼 정의·lineage·비즈니스 의미를 "
            "확인할 때는 **메모리/일반지식으로 추측하지 말고 반드시 이 도구로 사실을 조회**하라.",
        ]
        for conn in self._conns.values():
            for spec in conn.tool_specs:
                desc = (spec.get("description") or "").splitlines()[0][:120]
                lines.append(f"- `{spec['name']}`: {desc}")
        lines += [
            "",
            "활용 원칙:",
            "- SQL 작성 전 테이블 존재·컬럼명·타입이 불확실하면 먼저 MCP 로 조회해 확정한다.",
            "- 마트 풀(get_mart_schema 등)에 없는 테이블/컬럼의 의미가 필요하면 MCP 검색을 우선 사용.",
            "- MCP 에서 확인한 사실을 인용할 때는 출처(예: 'DataHub 기준')를 메모/내레이션에 명시.",
            "- 정보가 없으면 추측하지 말고 그 사실을 명시하고 `ask_user` 로 확인.",
        ]
        return "\n".join(lines) + "\n"


# 프로세스 단위 싱글톤.
manager = MCPManager()
