#!/usr/bin/env python3
"""
Vibe EDA MCP Server — Claude Code에서 노트북을 직접 조작할 수 있는 도구 노출.

실행: python -m app.mcp_server (backend/ 디렉토리에서)

Claude Code 설정 (~/.claude/claude_desktop_config.json):
{
  "mcpServers": {
    "vibe-eda": {
      "command": "python",
      "args": ["-m", "app.mcp_server"],
      "cwd": "/path/to/vibeeda/backend"
    }
  }
}
"""
import asyncio
import json
import sys
from pathlib import Path

# backend 디렉토리를 path에 추가
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from app.services import notebook_store, mart_tools
from app.services.kernel import run_python, run_sql

app = Server("vibe-eda")


@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="list_notebooks",
            description="노트북 목록 조회",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="read_notebook",
            description="노트북 전체 내용(셀 코드, 출력, 채팅 히스토리) 조회",
            inputSchema={
                "type": "object",
                "properties": {"notebook_id": {"type": "string", "description": "노트북 ID (UUID)"}},
                "required": ["notebook_id"],
            },
        ),
        Tool(
            name="create_cell",
            description="노트북에 새 셀 생성",
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook_id": {"type": "string"},
                    "cell_type": {"type": "string", "enum": ["sql", "python", "markdown"]},
                    "name": {"type": "string"},
                    "code": {"type": "string"},
                    "after_id": {"type": "string", "description": "이 셀 다음에 삽입 (optional)"},
                },
                "required": ["notebook_id", "cell_type", "code"],
            },
        ),
        Tool(
            name="update_cell_code",
            description="셀 코드 수정",
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook_id": {"type": "string"},
                    "cell_id": {"type": "string"},
                    "code": {"type": "string"},
                },
                "required": ["notebook_id", "cell_id", "code"],
            },
        ),
        Tool(
            name="execute_cell",
            description="셀 실행 후 결과 반환",
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook_id": {"type": "string"},
                    "cell_id": {"type": "string"},
                },
                "required": ["notebook_id", "cell_id"],
            },
        ),
        Tool(
            name="read_cell_output",
            description="실행된 셀의 출력 조회",
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook_id": {"type": "string"},
                    "cell_id": {"type": "string"},
                },
                "required": ["notebook_id", "cell_id"],
            },
        ),
        Tool(
            name="get_mart_schema",
            description="마트의 컬럼 스키마 조회 (이름/타입/description). SQL 작성 전 필수.",
            inputSchema={
                "type": "object",
                "properties": {"mart_key": {"type": "string"}},
                "required": ["mart_key"],
            },
        ),
        Tool(
            name="preview_mart",
            description="마트 상위 N행 조회 (셀 생성 없음). limit 기본 5, 최대 50.",
            inputSchema={
                "type": "object",
                "properties": {
                    "mart_key": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["mart_key"],
            },
        ),
        Tool(
            name="write_cell_memo",
            description="셀의 메모(노트)에 인사이트 기록.",
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook_id": {"type": "string"},
                    "cell_id": {"type": "string"},
                    "memo": {"type": "string"},
                },
                "required": ["notebook_id", "cell_id", "memo"],
            },
        ),
        Tool(
            name="profile_mart",
            description="마트 프로파일 (행수, NULL 비율, 카디널리티, 수치형 min/max/avg).",
            inputSchema={
                "type": "object",
                "properties": {"mart_key": {"type": "string"}},
                "required": ["mart_key"],
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    def text(data) -> list[TextContent]:
        return [TextContent(type="text", text=json.dumps(data, ensure_ascii=False, indent=2))]

    try:
        if name == "list_notebooks":
            return text(notebook_store.list_notebooks())

        elif name == "read_notebook":
            return text(notebook_store.get_notebook(arguments["notebook_id"]))

        elif name == "create_cell":
            result = notebook_store.create_cell(
                nb_id=arguments["notebook_id"],
                cell_type=arguments["cell_type"],
                name=arguments.get("name", arguments["cell_type"] + "_cell"),
                code=arguments.get("code", ""),
                after_id=arguments.get("after_id"),
            )
            return text(result)

        elif name == "update_cell_code":
            result = notebook_store.update_cell(
                arguments["notebook_id"], arguments["cell_id"], code=arguments["code"]
            )
            return text(result)

        elif name == "execute_cell":
            nb = notebook_store.get_notebook(arguments["notebook_id"])
            cell = next((c for c in nb["cells"] if c["id"] == arguments["cell_id"]), None)
            if not cell:
                return text({"error": "Cell not found"})

            loop = asyncio.get_event_loop()
            if cell["type"] == "python":
                output = await loop.run_in_executor(
                    None, run_python, arguments["notebook_id"], cell["name"], cell["code"]
                )
            elif cell["type"] == "sql":
                output = await loop.run_in_executor(
                    None, run_sql, arguments["notebook_id"], cell["name"], cell["code"]
                )
            else:
                output = {"type": "stdout", "content": ""}

            notebook_store.update_cell(arguments["notebook_id"], arguments["cell_id"], output=output)
            return text(output)

        elif name == "read_cell_output":
            nb = notebook_store.get_notebook(arguments["notebook_id"])
            cell = next((c for c in nb["cells"] if c["id"] == arguments["cell_id"]), None)
            return text(cell.get("output") if cell else {"error": "Cell not found"})

        elif name == "get_mart_schema":
            return text(mart_tools.get_mart_schema(arguments["mart_key"]))

        elif name == "preview_mart":
            return text(mart_tools.preview_mart(arguments["mart_key"], arguments.get("limit", 5)))

        elif name == "profile_mart":
            return text(mart_tools.profile_mart(arguments["mart_key"]))

        elif name == "write_cell_memo":
            result = notebook_store.update_cell(
                arguments["notebook_id"], arguments["cell_id"], memo=arguments["memo"]
            )
            return text(result)

    except Exception as e:
        return text({"error": str(e)})

    return text({"error": f"Unknown tool: {name}"})


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
