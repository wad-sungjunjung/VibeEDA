# Vibe EDA — CLAUDE.md

## 프로젝트 개요

**Vibe EDA**: 캐치테이블 데이터 분석가를 위한 AI 네이티브 EDA 도구.  
Jupyter Notebook의 상위 버전 — 자연어 채팅으로 SQL/Python 코드를 생성·수정하고 리포트를 자동 생성한다.  
**로컬 전용 앱** (Cloud 배포 없음). 노트북은 `.ipynb` 파일로 저장, LLM은 Claude/Gemini 이중 지원 + Claude Code MCP 연동.

## 아키텍처

```
React UI (localhost:9700)
    ↕ REST / SSE
FastAPI 백엔드 (localhost:4750)
    ├── .ipynb 파일 I/O  →  ~/vibe-notebooks/
    ├── 리포트 파일 I/O  →  ~/vibe-notebooks/reports/{id}.md + {id}_images/
    ├── Python 커널 (exec, in-process, 노트북별 namespace, Plotly + kaleido PNG 렌더)
    ├── Snowflake 연결 (SQL 실행, 세션 싱글톤, 네트워크 필요)
    ├── Claude API / Gemini API (Vibe Chat · Agent · Reporting — 각 프로바이더 별도 파이프라인)
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
| Agent Mode | **기본 Claude Opus** (`claude-opus-4-7`) 또는 Gemini. 프론트 `X-Agent-Model` 헤더로 스위치. Tool use + SSE + 차트 PNG 이미지 블록 주입. 메모 강제 가드·반복 호출 가드 내장. 에이전트 세션 연속성(세션 아카이브·복원) 지원. 자세한 내부는 `docs/vibe-eda-agent-pipeline.md`. |
| Reporting | **기본 Claude Opus** (`DEFAULT_REPORT_MODEL`). 프론트 `X-Report-Model` 헤더로 스위치. SSE 스트리밍 Markdown 생성 → `reports/*.md` 저장. 차트는 `{id}_images/*.png` 상대 경로로 임베드. 자세한 내부는 `docs/vibe-eda-reporting-pipeline.md`. |
| Sheet 셀 | UniverJS 기반 스프레드시트 셀. `sheet_snapshot.py`로 workbook JSON 생성·파싱, `sheet_vibe_service.py`로 자연어→JSON 패치 변환. |
| 커널 | in-process Python exec (노트북별 namespace 유지), Plotly Figure 출력 시 600×400 PNG 자동 렌더 (`kaleido` 필요) |
| SQL 실행 | Snowflake Python Connector (externalbrowser SSO, 세션 싱글톤) |
| MCP 서버 | `backend/app/api/mcp_server.py` (Claude Code 연동) |
| DB (미사용) | `backend/app/models.py`, `database.py` — SQLAlchemy 모델 정의만 존재. 현재 초기화되지 않음 (향후 멀티유저 확장용) |

### 데이터 저장
| 데이터 | 저장 위치 |
|---|---|
| 노트북 (셀 코드, 출력, 차트 PNG base64) | `~/vibe-notebooks/{title}.ipynb` |
| 채팅 히스토리 | 동일 `.ipynb` → `metadata.vibe.chat_history` |
| 에이전트 히스토리 | 동일 `.ipynb` → `metadata.vibe.agent_history` (현재 세션만; 아카이브 후 비워짐) |
| 에이전트 세션 목록 | 프론트 localStorage (`vibe_agent_sessions_{notebookId}`) |
| 현재 세션 메타 | 프론트 localStorage (`vibe_current_session_{notebookId}`) |
| 리포트 참조 포인터 | 동일 `.ipynb` → `metadata.vibe.reports[]` |
| 리포트 본문 (`.md`) | `~/vibe-notebooks/reports/{YYYYMMDD_HHMMSS}_{slug}.md` (YAML frontmatter + Markdown) |
| 리포트 이미지 | `~/vibe-notebooks/reports/{report_id}_images/*.png` |
| 폴더/파일 트리 메타 | `~/vibe-notebooks/.vibe_config.json` |
| 카테고리 컬럼 캐시 | `~/vibe-notebooks/.vibe/.categories_cache.json` |
| 로컬 파일 프로파일 캐시 | `~/vibe-notebooks/.files_profile_cache.json` |

## 폴더 구조

```
src/
├── components/
│   ├── layout/          # LeftSidebar (파일트리 + 히스토리 + 리포트), TopMetaHeader, RightNav, CellAddBar
│   ├── cells/           # NotebookArea, CellContainer, CellOutput, CodeEditor, SheetEditor
│   ├── agent/           # AgentFAB, AgentChatPanel
│   ├── reporting/       # ReportModal (목표+모델+셀 선택), ReportResult (진행 단계 · Markdown 렌더)
│   └── common/          # RollbackToast, ModelSettingsModal, ShortcutsModal, HelpModal,
│                        # SnowflakeConnectionGuard, ConnectionModal, Markdown, UserGuideModal
├── store/
│   ├── useAppStore.ts     # 모든 전역 상태 (Zustand) — 에이전트 세션·리포트 스트림 포함
│   ├── modelStore.ts      # API 키 + vibe/agent/report 모델 선택 (localStorage persist)
│   └── connectionStore.ts # Snowflake 연결 정보 (localStorage persist)
├── lib/
│   ├── utils.ts           # loadAgentSessions/saveAgentSessions/loadCurrentSessionMeta 등 세션 헬퍼 포함
│   ├── snowflakeTheme.ts
│   └── api.ts             # 백엔드 API 클라이언트 (SSE 스트리밍) + FileNode 타입 + archiveAgentHistory
├── types/index.ts         # CellType('sheet' 포함), AgentSession, AgentBlock 등
└── data/
    ├── marts.ts
    └── mockNotebook.ts

backend/
├── main.py                # FastAPI 앱 + /healthz + /v1/system/{info,open-folder,notebooks-dir} + 라우터 등록
│                          # 요청 스코프 노트북 파일 캐시 미들웨어 (SSE 엔드포인트는 캐시 제외)
│                          # 카테고리 캐시 30분 주기 갱신 스케줄러
├── requirements.txt       # fastapi/anthropic/google-genai/pandas/plotly/kaleido/snowflake-connector 등
├── .env / .env.example
└── app/
    ├── config.py          # Settings (env + per-request LLM config 조합, DEFAULT_REPORT_MODEL 포함)
    ├── dependencies.py    # get_llm_config() — X-Vibe-Model / X-Agent-Model / X-Report-Model 헤더 지원
    ├── database.py        # (미사용) SQLAlchemy 비동기 세션
    ├── models.py          # (미사용) User/Folder/Notebook/Cell DB 모델 정의
    ├── api/
    │   ├── notebooks.py   # GET/POST/PATCH/DELETE /notebooks[/{id}]
    │   ├── cells.py       # POST/PATCH/DELETE /notebooks/{id}/cells[/{cid}]
    │   │                  # + chat/{index} DELETE, chat/truncate POST
    │   ├── vibe.py        # POST /vibe (Gemini/Claude 스트리밍), POST /vibe/sheet (Sheet 셀 전용)
    │   ├── agent.py       # POST /agent/stream, POST /agent/title
    │   │                  # POST /notebooks/{id}/agent/archive (세션 아카이브)
    │   ├── files.py       # GET /files/tree, POST /files/mkdir|move|rename|delete|upload
    │   │                  # (루트 폴더 통합 파일 트리 — ipynb·report·일반 파일·디렉터리)
    │   ├── execute.py     # POST /execute/{cell_id}, DELETE /kernel/{nb_id}
    │   ├── folders.py     # /folders CRUD
    │   ├── marts.py       # GET /marts
    │   ├── recommend.py   # POST /marts/recommend (LLM 기반 마트 추천)
    │   ├── snowflake.py   # POST /snowflake/connect, GET /status, DELETE /connect
    │   ├── report.py      # POST /reports/stream, GET /reports[/{id}[/assets/{f}]], DELETE /reports/{id}
    │   └── mcp_server.py  # MCP 서버 (Claude Code 연동, 별도 프로세스)
    └── services/
        ├── notebook_store/        # .ipynb 파일 CRUD 패키지 (리팩터 후 서브모듈 분리)
        │   ├── __init__.py        # 외부 진입점 — 이전과 동일한 네임스페이스 유지
        │   ├── _core.py           # NOTEBOOKS_DIR, _read_nb/_write_nb, request_cache_scope
        │   ├── _notebooks.py      # list/create/get/update/delete_notebook, create_onboarding_notebook
        │   ├── _cells.py          # create/update/delete_cell, get_cell_above_name
        │   ├── _history.py        # add/delete/truncate chat + add/clear agent history
        │   ├── _folders.py        # list/create/update/delete_folder
        │   ├── _formatters.py     # _parse_output (출력 포맷 변환)
        │   └── _onboarding_data.py # 온보딩 노트북 초기 데이터
        ├── agent_tools.py         # Claude/Gemini 공용 tool 스펙 단일 소스 + Gemini 변환 헬퍼
        ├── agent_events.py        # 에이전트 SSE 이벤트 타입 단일 소스 (프론트 AgentEvent union 과 동기화)
        ├── agent_skills.py        # 분석가 마인드셋 스킬 모듈 (플래닝·가설·에러 회복·출력 비평 등)
        ├── claude_agent.py        # Claude Agent tool loop (NotebookState, agent_skills 통합)
        ├── claude_vibe_service.py # Claude Vibe Chat
        ├── gemini_agent_service.py # Gemini Agent tool loop (agent_tools/_execute_tool 공유)
        ├── gemini_service.py      # Gemini Vibe Chat
        ├── sheet_snapshot.py      # UniverJS workbook JSON 생성·파싱 헬퍼 (SheetEditor 와 동기화 필수)
        ├── sheet_vibe_service.py  # Sheet 셀 자연어→JSON 패치 변환 (Claude/Gemini)
        ├── vibe_prompts.py        # Vibe Chat 공용 프롬프트·포스트프로세싱 헬퍼 (clean_code 등)
        ├── report_service.py      # 리포트 evidence 빌드 · LLM 스트림(Claude/Gemini 분리) · 후처리 · 파일 저장
        ├── kernel.py              # Python 커널 (exec 기반) + Plotly → PNG(kaleido) 렌더
        ├── snowflake_session.py   # Snowflake 세션 싱글톤
        ├── category_cache.py      # _status/_type 컬럼 distinct 값 캐시 (`.vibe/.categories_cache.json`)
        ├── file_profile_cache.py  # 로컬 CSV/TSV/Parquet/Excel 스키마·카테고리 캐시
        ├── mart_tools.py          # get_mart_schema / preview_mart / profile_mart
        ├── naming.py              # snake_case 셀명 새니타이저
        └── code_style.py          # SQL/Python 스타일 가이드 텍스트
```

## 디자인 시스템

### 색 토큰 (CSS 변수 기반 · 라이트/다크 테마)
`tailwind.config.ts`가 모든 색 토큰을 `rgb(var(--color-*) / <alpha-value>)` 로 정의하고,
실제 팔레트 값은 `src/styles/globals.css` 의 `:root` (라이트) 와 `.dark` (다크) 에서 관리한다.
Tailwind `darkMode: 'class'`, `<html>.dark` 클래스 토글로 전환.

- **Primary (Coral)**: `primary` · `primary-hover` · `primary-light` · `primary-pale` · `primary-border` · `primary-text`
  - 버튼/CTA 는 코랄 `#D95C3F` 계열, tint 배경(`primary-light`/`pale`)은 피치 오렌지 계열 `#FFE8D6`
- **배경**: `bg-page`, `bg-sidebar`, `bg-pane`, `bg-output`, `bg-code` → Tailwind 클래스는 `bg-bg-page` 처럼 접두사 중복 주의
- **Elevated surface**: `surface` (카드/모달/인풋 배경) · `surface-hover`
- **Chip / 중립 hover**: `chip` · `chip-hover` (기존 stone-100 대체)
- **텍스트**: `text-primary`, `text-secondary`, `text-tertiary`, `text-disabled`
- **테두리**: `border`, `border-subtle`, `border-hover`
- **셀 타입**: `bg-sql-bg text-sql-text`, `bg-python-bg text-python-text`, `bg-markdown-bg text-markdown-text` (라이트/다크 자동 전환)
- **상태**: `success`, `danger`, `warning` + `-bg` / `-text` 변종
- **레이아웃**: `w-sidebar-left (224px)`, `w-sidebar-right (256px)`, `h-header/h-cell-bar (56px)`

### 다크모드
- `modelStore.theme`(`'light' | 'dark'`) 에 영속 저장, `<html>.dark` 클래스로 전환
- 토글 버튼: `LeftSidebar` 하단 프로필 행의 Sun/Moon 아이콘
- **외부 위젯 분기** (Tailwind 클래스로 커버 안 되는 영역):
  - Plotly (`CellOutput.tsx`): `plotly_white` ↔ `plotly_dark` 템플릿, `paper_bgcolor`/`plot_bgcolor`/`font.color` 를 `theme` 에 따라 교체
  - Monaco 마크다운 에디터 (`CodeEditor.tsx`): `'light'` ↔ `'dark'` 테마 전환. SQL/Python 에디터는 `snowflakeTheme` 로 항상 다크 고정
- 저장된 차트 PNG (`.ipynb` 출력 또는 리포트 이미지)는 흰 배경 고정 — 재실행 시 Plotly 메타로부터 현재 테마에 맞게 자동 재렌더링됨

### 색상 사용 규칙
- **하드코딩 금지**: `bg-[#xxx]` arbitrary value 나 인라인 `style={{ color: '#xxx' }}` 사용하지 말 것. 기존 토큰으로 매핑하거나 새 시맨틱 토큰 추가
- Tailwind JIT 가 새 토큰을 즉시 픽업하지 못할 때는 `style={{ backgroundColor: 'rgb(var(--color-x))' }}` 로 우회 가능
- `tailwind.config.ts` 에 토큰을 추가/변경하면 Vite 재시작 권장

폰트: Pretendard (CDN) → `-apple-system` → `Malgun Gothic`

## 컴포넌트 규칙

- 상태는 **useAppStore에서만** 읽고 씀
- 아이콘은 **Lucide React만** 사용
- 클래스 조합은 **`cn()`** 유틸 사용
- 스크롤 영역에는 **`.hide-scrollbar`** 클래스
- 모든 아이콘-only 버튼에 **`title` 속성** 필수
- **모달 z-index**: 모달 backdrop은 반드시 `z-[130]` 이상 사용 (RightNav `z-[110]`, AgentChatPanel `z-[115]`, AgentFAB `z-[120]` 보다 높아야 함)

## 개발 실행

```bash
# 백엔드
cd backend
pip install -r requirements.txt   # kaleido 포함 — 차트 PNG 렌더에 필수
cp .env.example .env   # ANTHROPIC_API_KEY / GEMINI_API_KEY 설정 (최소 하나)
                       # DEFAULT_VIBE_MODEL=gemini-2.5-flash
                       # DEFAULT_AGENT_MODEL=claude-opus-4-7
                       # DEFAULT_REPORT_MODEL=claude-opus-4-7
                       # SNOWFLAKE_* (선택, 프론트 UI로도 주입 가능)
uvicorn main:app --reload --port 4750
# → ~/vibe-notebooks/ 폴더 자동 생성 (reports/ 는 최초 리포트 생성 시 자동 생성)

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
        "vibe_type": "sql",          // "sql" | "python" | "markdown" | "sheet"
        "vibe_name": "query_1",
        "vibe_memo": "",
        "vibe_ordering": 1000.0,
        "vibe_agent_generated": false,
        "vibe_insight": "",
        "vibe_sheet_data": { ... }   // sheet 셀 전용: UniverJS IWorkbookData JSON
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
| M5: 에이전트 모드 고도화 (ask_user, 메모 강제 가드, 차트 이미지, 세션 연속성, per-cell 나레이션) | 🟡 진행 중 |
| M6: 리포팅 파이프라인 (LLM 기반 Markdown + 차트 임베드) | ✅ 완료 (HTML/PDF 포맷 확장은 추후) |
| M7: 파일럿 (5명 내부 테스트) | 예정 |

## 주요 문서

| 문서 | 경로 |
|---|---|
| PRD | `docs/vibe-eda-prd.md` |
| 기능 명세 | `docs/vibe-eda-functional-spec.md` |
| 디자인 가이드 | `docs/vibe-eda-design-guide.md` |
| API 명세 | `docs/vibe-eda-api-spec.md` |
| 에이전트 명세 | `docs/vibe-eda-agent-spec.md` |
| **에이전트 파이프라인 가이드** | `docs/vibe-eda-agent-pipeline.md` |
| **리포팅 파이프라인 가이드** | `docs/vibe-eda-reporting-pipeline.md` |
