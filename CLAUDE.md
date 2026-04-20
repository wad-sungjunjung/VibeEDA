# Vibe EDA — CLAUDE.md

## 프로젝트 개요

**Vibe EDA**: 사내 광고 플랫폼 데이터 분석가를 위한 AI 네이티브 EDA 도구.  
Jupyter Notebook의 상위 버전 — 자연어 채팅으로 SQL/Python 코드를 생성·수정하고 리포트를 자동 생성한다.  
**로컬 전용 앱** (Cloud 배포 없음). 노트북은 `.ipynb` 파일로 저장, LLM은 Claude/Gemini 이중 지원 + Claude Code MCP 연동.

## 아키텍처

```
React UI (localhost:5173)
    ↕ REST / SSE
FastAPI 백엔드 (localhost:8000)
    ├── .ipynb 파일 I/O  →  ~/vibe-notebooks/
    ├── Python 커널 (exec, in-process, 노트북별 namespace)
    ├── Snowflake 연결 (SQL 실행, 세션 싱글톤, 네트워크 필요)
    ├── Claude API / Gemini API (Vibe Chat + Agent Mode, 런타임 스위치)
    └── MCP 서버 (Claude Code 연동용, 별도 프로세스)
```

**Claude Code** → MCP 프로토콜로 Vibe EDA 노트북 도구에 접근 가능  
**네트워크 필요 구간**: Snowflake SQL 실행, LLM API(Claude/Gemini) 호출

## 기술 스택

### 프론트엔드
| 영역 | 기술 |
|---|---|
| UI | React 18 + TypeScript + Vite |
| 스타일 | Tailwind CSS v3 (커스텀 디자인 토큰 포함) |
| 상태 | Zustand (`src/store/useAppStore.ts` 단일 스토어) |
| 아이콘 | Lucide React (이모지 사용 금지) |
| 타입 | `src/types/index.ts` 중앙 관리 |

### 백엔드
| 영역 | 기술 |
|---|---|
| 런타임 | Python FastAPI (`backend/`) |
| 저장소 | `.ipynb` 파일 (`~/vibe-notebooks/*.ipynb`) |
| Vibe Chat | **기본 Gemini** (`gemini-2.5-flash`) 또는 Claude (`claude-haiku-4-5-20251001` / sonnet / opus). 프론트 `X-Vibe-Model` 헤더로 런타임 스위치. SSE streaming. |
| Agent Mode | **기본 Claude Opus** (`claude-opus-4-7`) 또는 Gemini. 프론트 `X-Agent-Model` 헤더로 스위치. Tool use + SSE streaming. |
| 커널 | in-process Python exec (노트북별 namespace 유지) |
| SQL 실행 | Snowflake Python Connector (externalbrowser SSO, 세션 싱글톤) |
| MCP 서버 | `backend/app/api/mcp_server.py` (Claude Code 연동) |
| DB (미사용) | `backend/app/models.py`, `database.py` — SQLAlchemy 모델 정의만 존재. 현재 초기화되지 않음 (향후 멀티유저 확장용) |

### 데이터 저장
| 데이터 | 저장 위치 |
|---|---|
| 노트북 (셀 코드, 출력) | `~/vibe-notebooks/{uuid}.ipynb` |
| 채팅 히스토리 | 동일 `.ipynb` → `metadata.vibe.chat_history` |
| 에이전트 히스토리 | 동일 `.ipynb` → `metadata.vibe.agent_history` |
| 폴더 메타데이터 | `~/vibe-notebooks/.vibe_config.json` |

## 폴더 구조

```
src/
├── components/
│   ├── layout/          # LeftSidebar, TopMetaHeader, RightNav, CellAddBar
│   ├── cells/           # NotebookArea, CellContainer, CellOutput, CodeEditor
│   ├── agent/           # AgentFAB, AgentChatPanel
│   ├── reporting/       # ReportModal, ReportResult
│   └── common/          # RollbackToast, ModelSettingsModal, ShortcutsModal,
│                        # SnowflakeConnectionGuard, ConnectionModal, Markdown
├── store/
│   ├── useAppStore.ts     # 모든 전역 상태 (Zustand)
│   ├── modelStore.ts      # API 키 + 모델 선택 (localStorage persist)
│   └── connectionStore.ts # Snowflake 연결 정보 (localStorage persist)
├── lib/
│   ├── utils.ts
│   ├── snowflakeTheme.ts
│   └── api.ts           # 백엔드 API 클라이언트 (SSE 스트리밍)
├── types/index.ts
└── data/
    ├── marts.ts
    └── mockNotebook.ts

backend/
├── main.py                # FastAPI 앱 + /healthz + /v1/system/* + notebooks-dir
├── requirements.txt
├── .env / .env.example
└── app/
    ├── config.py          # Settings (env + per-request LLM config 조합)
    ├── dependencies.py    # get_llm_config() — 헤더/env 기반 모델 선택
    ├── database.py        # (미사용) SQLAlchemy 비동기 세션
    ├── models.py          # (미사용) User/Folder/Notebook/Cell DB 모델 정의
    ├── api/
    │   ├── notebooks.py   # GET/POST/PATCH/DELETE /notebooks[/{id}]
    │   ├── cells.py       # POST/PATCH/DELETE /notebooks/{id}/cells[/{cid}]
    │   │                  # + chat/{index} DELETE, chat/truncate POST
    │   ├── vibe.py        # POST /vibe (Gemini/Claude 스트리밍)
    │   ├── agent.py       # POST /agent/stream, POST /agent/title
    │   ├── execute.py     # POST /execute/{cell_id}, DELETE /kernel/{nb_id}
    │   ├── folders.py     # /folders CRUD
    │   ├── marts.py       # GET /marts
    │   ├── recommend.py   # POST /marts/recommend (LLM 기반 마트 추천)
    │   ├── snowflake.py   # POST /snowflake/connect, GET /status, DELETE /connect
    │   └── mcp_server.py  # MCP 서버 (Claude Code 연동, 별도 프로세스)
    └── services/
        ├── notebook_store.py      # .ipynb 파일 CRUD 핵심
        ├── kernel.py              # Python 커널 (exec 기반)
        ├── snowflake_session.py   # Snowflake 세션 싱글톤
        ├── claude_agent.py        # Claude Agent tool loop (10개 tool)
        ├── claude_vibe_service.py # Claude Vibe Chat
        ├── gemini_agent_service.py # Gemini Agent tool loop
        ├── gemini_service.py      # Gemini Vibe Chat
        ├── mart_tools.py          # get_mart_schema / preview_mart / profile_mart
        ├── naming.py              # snake_case 셀명 새니타이저
        └── code_style.py          # SQL/Python 스타일 가이드 텍스트
```

## 디자인 시스템

`tailwind.config.ts`에 디자인 토큰 정의됨:

- **Primary (Coral)**: `primary` — `#D95C3F`
- **배경**: `bg-page`, `bg-sidebar`, `bg-pane`, `bg-output`, `bg-code`
- **텍스트**: `text-primary`, `text-secondary`, `text-tertiary`, `text-disabled`
- **셀 타입**: SQL `bg-[#e8e4d8] text-[#5c4a1e]`, Python `bg-[#e6ede0] text-[#3d5226]`, Markdown `bg-[#eae4df] text-[#4a3c2e]`
- **레이아웃**: `w-sidebar-left (224px)`, `w-sidebar-right (256px)`, `h-header/h-cell-bar (56px)`

폰트: Pretendard (CDN) → `-apple-system` → `Malgun Gothic`

## 컴포넌트 규칙

- 상태는 **useAppStore에서만** 읽고 씀
- 아이콘은 **Lucide React만** 사용
- 클래스 조합은 **`cn()`** 유틸 사용
- 스크롤 영역에는 **`.hide-scrollbar`** 클래스
- 모든 아이콘-only 버튼에 **`title` 속성** 필수

## 개발 실행

```bash
# 백엔드
cd backend
pip install -r requirements.txt
cp .env.example .env   # ANTHROPIC_API_KEY / GEMINI_API_KEY 설정 (최소 하나)
                       # DEFAULT_VIBE_MODEL=gemini-2.5-flash
                       # DEFAULT_AGENT_MODEL=claude-opus-4-7
                       # SNOWFLAKE_* (선택, 프론트 UI로도 주입 가능)
uvicorn main:app --reload --port 8000
# → ~/vibe-notebooks/ 폴더 자동 생성

# 프론트엔드
npm install && npm run dev
```

## Claude Code MCP 연동

```bash
# MCP 서버 실행 (백엔드와 별도)
cd backend
python -m app.api.mcp_server
```

`~/.claude/claude_desktop_config.json` 에 추가:
```json
{
  "mcpServers": {
    "vibe-eda": {
      "command": "python",
      "args": ["-m", "app.api.mcp_server"],
      "cwd": "/absolute/path/to/VibeEDA/backend"
    }
  }
}
```

## .ipynb 파일 구조

```json
{
  "nbformat": 4,
  "metadata": {
    "vibe": {
      "title": "지역별 매출 분석",
      "description": "...",
      "selected_marts": ["mart_revenue"],
      "folder_id": null,
      "chat_history": [
        {"cell_id": "...", "messages": [{"role":"user","content":"...","ts":"..."}]}
      ],
      "agent_history": [
        {"role": "user", "content": "...", "ts": "..."}
      ]
    }
  },
  "cells": [
    {
      "id": "uuid",
      "cell_type": "code",
      "source": "SELECT ...",
      "metadata": {
        "vibe_type": "sql",
        "vibe_name": "query_1",
        "vibe_memo": "",
        "vibe_ordering": 1000.0,
        "vibe_agent_generated": false,
        "vibe_insight": ""
      },
      "outputs": [
        {
          "output_type": "display_data",
          "data": {"application/vnd.vibe+json": {"type": "table", ...}}
        }
      ]
    }
  ]
}
```

## 변수 공유 (셀 간)

SQL 셀 실행 → 결과 DataFrame이 **셀 이름**으로 커널 namespace에 저장  
Python 셀에서 이전 SQL 결과를 변수로 직접 사용 가능:

```python
# SQL 셀 이름이 "query_1"이라면
import plotly.express as px
fig = px.bar(query_1, x='region', y='revenue')
```

커널 초기화: `DELETE /kernel/{notebook_id}` (execute.py)

## MVP 마일스톤

| 마일스톤 | 상태 |
|---|---|
| M1: UI 구현 | ✅ 완료 |
| M2: LLM 연동 (Vibe Chat + Agent, Claude/Gemini 이중) | ✅ 완료 |
| M3: 실행 엔진 (.ipynb + Python 커널 + Snowflake) | ✅ 완료 |
| M4: Claude Code MCP 연동 | ✅ 완료 |
| M5: 에이전트 모드 고도화 (ask_user, 메모, 재계획 등) | 🟡 진행 중 |
| M6: 리포팅 완성 (Markdown 외 포맷 확장) | 예정 |
| M7: 파일럿 (5명 내부 테스트) | 예정 |

## 주요 문서

| 문서 | 경로 |
|---|---|
| PRD | `docs/vibe-eda-prd.md` |
| 기능 명세 | `docs/vibe-eda-functional-spec.md` |
| 디자인 가이드 | `docs/vibe-eda-design-guide.md` |
| API 명세 | `docs/vibe-eda-api-spec.md` |
| 에이전트 명세 | `docs/vibe-eda-agent-spec.md` |
