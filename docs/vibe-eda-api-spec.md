# Vibe EDA — API 명세서

**버전**: v2.0 (로컬 전용 구현 반영)
**Base URL**: `http://localhost:8000`
**Content-Type**: `application/json`
**작성일**: 2026-04-20
**범위**: 실제 구현된 FastAPI 엔드포인트와 SSE 이벤트 스키마. 이전 v1.0 (JWT/WebSocket/Cloud 기반) 스펙은 폐기되었음.

---

## 0. 공통 규약

### 0.1 인증
로컬 전용 앱이므로 별도 인증 헤더 없음. 대신 다음 요청 헤더로 LLM/모델 오버라이드 가능:

| 헤더 | 값 예시 | 우선순위 |
|---|---|---|
| `X-Vibe-Model` | `gemini-2.5-flash` / `claude-haiku-4-5-20251001` | env의 `DEFAULT_VIBE_MODEL`을 override |
| `X-Agent-Model` | `claude-opus-4-7` / `gemini-2.5-pro` | env의 `DEFAULT_AGENT_MODEL`을 override |
| `X-Anthropic-Api-Key` | `sk-ant-...` | env의 `ANTHROPIC_API_KEY`를 override |
| `X-Gemini-Api-Key` | `AIza...` | env의 `GEMINI_API_KEY`를 override |

> **주의**: Google OAuth 기반 멀티유저 인증은 미구현 (`backend/app/dependencies.py`의 TODO 참고).

### 0.2 CORS
`backend/app/config.py`의 `ALLOWED_ORIGINS` (기본 `http://localhost:5173`, `http://localhost:4173`).

### 0.3 SSE
스트리밍 엔드포인트는 `text/event-stream`. 각 이벤트는 JSON 라인 `data: {...}\n\n` 형식.

### 0.4 에러 응답
FastAPI 표준 `HTTPException` 포맷:
```json
{ "detail": "Notebook not found" }
```
SSE 스트림 중 에러는 HTTP 200을 유지하고 스트림 내 `{"type":"error","message":"..."}` 이벤트로 전달.

---

## 1. 시스템 (System)

### 1.1 `GET /healthz`
헬스 체크. 200 OK + `{"status":"ok"}`.

### 1.2 `GET /v1/system/info`
런타임 정보 (Python 버전, notebooks_dir 경로 등).

### 1.3 `POST /v1/system/notebooks-dir`
노트북 저장 디렉터리 변경.
```json
{ "path": "/Users/me/my-vibe-notes" }
```

---

## 2. 노트북 (Notebooks) — `backend/app/api/notebooks.py`

### 2.1 `GET /notebooks`
모든 노트북 요약 목록.

**Response 200**
```json
[
  {
    "id": "8f3k2l...",
    "title": "지역별 광고 매출 분석",
    "description": "...",
    "folder_id": null,
    "updated_at": "2026-04-18T09:12:34Z",
    "cell_count": 3
  }
]
```

### 2.2 `POST /notebooks`
신규 노트북 생성.
```json
{
  "title": "지역별 광고 매출 분석",
  "description": "최근 7일...",
  "selected_marts": ["ad_sales_mart"],
  "folder_id": null
}
```
**Response 201**: 전체 노트북 객체 (셀 배열 포함, 기본 셀 1개 자동 생성 가능).

### 2.3 `GET /notebooks/{notebook_id}`
전체 노트북 (cells, chat_history, agent_history 포함).

### 2.4 `PATCH /notebooks/{notebook_id}`
부분 수정 (`title`, `description`, `selected_marts`, `folder_id`).

### 2.5 `DELETE /notebooks/{notebook_id}`
노트북 삭제 (`.ipynb` 파일 제거).

---

## 3. 셀 (Cells) — `backend/app/api/cells.py`

모든 셀 CRUD는 노트북 ID 컨텍스트 하에 수행.

### 3.1 `POST /notebooks/{notebook_id}/cells`
신규 셀 추가.
```json
{
  "cell_type": "sql",
  "name": "query_1",
  "code": "SELECT * FROM ad_sales_mart LIMIT 10;",
  "after_cell_id": null
}
```
`cell_type`: `sql | python | markdown`. `name`은 `naming.to_snake_case`로 새니타이즈됨.

### 3.2 `PATCH /notebooks/{notebook_id}/cells/{cell_id}`
코드/이름/타입/메모/인사이트 수정.
```json
{
  "code": "SELECT sido, SUM(...) FROM ...",
  "name": "sido_summary",
  "cell_type": "sql",
  "memo": "시도별 매출 요약",
  "insight": ""
}
```

### 3.3 `DELETE /notebooks/{notebook_id}/cells/{cell_id}`
셀 삭제.

### 3.4 `DELETE /notebooks/{notebook_id}/cells/{cell_id}/chat/{index}`
특정 셀 채팅 메시지 1건 삭제 (index 기반).

### 3.5 `POST /notebooks/{notebook_id}/cells/{cell_id}/chat/truncate`
주어진 인덱스까지 유지하고 이후 채팅 모두 제거 (롤백 용도).
```json
{ "keep_until_index": 2 }
```

---

## 4. 실행 (Execute) — `backend/app/api/execute.py`

### 4.1 `POST /execute/{cell_id}`
셀 실행 (SQL은 Snowflake, Python은 in-process 커널).
```json
{ "notebook_id": "8f3k2l..." }
```

**Response 200 (SQL 결과)**
```json
{
  "output": {
    "type": "table",
    "data": {
      "columns": [{"name":"sido","type":"VARCHAR"}],
      "rows": [["서울특별시", 145000000]],
      "row_count": 5,
      "truncated": false
    }
  },
  "executed_at": "2026-04-18T09:15:23Z",
  "execution_time_ms": 423
}
```

**Response 200 (Python)** — `output.type`은 `chart | table | stdout | markdown | error`.
Plotly는 `output.data.plotly_json`으로 전달.

### 4.2 `DELETE /kernel/{notebook_id}`
해당 노트북의 Python 커널 namespace 초기화.

---

## 5. Vibe Chat (셀 단위) — `backend/app/api/vibe.py`

### 5.1 `POST /vibe` (SSE)
셀 코드 자연어 수정.
```json
{
  "notebook_id": "...",
  "cell_id": "...",
  "message": "시도별로 group by 해줘",
  "current_code": "SELECT ...",
  "cell_type": "sql",
  "selected_marts": ["ad_sales_mart"]
}
```
`X-Vibe-Model` 헤더로 모델 선택. `claude-`로 시작하면 Claude, 그 외 Gemini.

**SSE 이벤트**
| `type` | 필드 | 의미 |
|---|---|---|
| `code_delta` | `delta` | 생성 중 코드 청크 |
| `complete` | `full_code`, `explanation` | 전체 코드 + 한국어 설명 |
| `error` | `message` | 오류 |

---

## 6. Agent Mode — `backend/app/api/agent.py`

### 6.1 `POST /agent/stream` (SSE)
노트북 전체 맥락 기반 자율 에이전트.
```json
{
  "notebook_id": "...",
  "message": "강남구 세부 분석해줘",
  "conversation_history": [
    {"role":"user","content":"...","ts":"..."}
  ]
}
```
`X-Agent-Model` 헤더로 모델 선택. `gemini-`로 시작하면 Gemini agent loop, 그 외 Claude tool-use loop.

**SSE 이벤트** — 상세는 `docs/vibe-eda-agent-spec.md` 참고.

| `type` | 필드 |
|---|---|
| `thinking` | `content` |
| `message_delta` | `content` |
| `tool_use` | `tool`, `input` |
| `cell_created` | `cell_id`, `cell_type`, `cell_name`, `code`, `after_cell_id` |
| `cell_code_updated` | `cell_id`, `code` |
| `cell_executed` | `cell_id`, `output` |
| `cell_memo_updated` | `cell_id`, `memo` |
| `ask_user` | `question`, `options[]` |
| `complete` | `created_cell_ids[]`, `updated_cell_ids[]` |
| `error` | `message` |

### 6.2 `POST /agent/title`
에이전트 첫 메시지에서 노트북 제목 자동 생성.
```json
{ "message": "강남구 매출 세부 분석" }
```
**Response**: `{ "title": "강남구 광고 매출 세부 분석" }`

---

## 7. 마트 (Marts) — `backend/app/api/marts.py`, `recommend.py`

### 7.1 `GET /marts`
전체 마트 카탈로그 (하드코딩 또는 Snowflake information_schema 파생).

**Response**
```json
[
  {
    "key": "ad_sales_mart",
    "description": "일별 광고 판매 집계",
    "keywords": ["매출","광고","지역"],
    "columns": [
      {"name":"sale_date","type":"DATE","desc":"판매일자"}
    ],
    "rules": ["지역별 판매 상한 존재"]
  }
]
```

### 7.2 `POST /marts/recommend`
LLM 기반 마트 추천.
```json
{
  "title": "지역별 광고 매출",
  "description": "최근 7일 시도/시군구 단위 매출",
  "marts": [ /* /marts 응답 배열 */ ]
}
```
**Response**: 각 마트에 `score (1-5)` + `reason (한국어)` 추가된 배열.

---

## 8. 폴더 (Folders) — `backend/app/api/folders.py`

저장: `~/vibe-notebooks/.vibe_config.json`.

| 엔드포인트 | 설명 |
|---|---|
| `GET /folders` | 폴더 목록 |
| `POST /folders` | 생성 (`{"name":"Q4 분석"}`) |
| `PATCH /folders/{folder_id}` | 이름 변경 |
| `DELETE /folders/{folder_id}` | 삭제 (노트북은 루트로 이동) |

---

## 9. Snowflake — `backend/app/api/snowflake.py`

세션은 프로세스 전역 싱글톤 (`services/snowflake_session.py`).

### 9.1 `POST /snowflake/connect`
```json
{
  "account": "xy12345.ap-northeast-2.aws",
  "user": "me@company.com",
  "authenticator": "externalbrowser",
  "role": "ANALYST",
  "warehouse": "ANALYTICS_WH",
  "database": "AD_PLATFORM",
  "schema": "MART"
}
```
브라우저 SSO 팝업으로 로그인. 성공 시 토큰을 OS 캐시에 저장.

### 9.2 `GET /snowflake/status`
현재 세션 정보 또는 `connected: false`.

### 9.3 `DELETE /snowflake/connect`
세션 종료.

---

## 10. MCP 서버 — `backend/app/api/mcp_server.py`

FastAPI와 별도 프로세스로 실행되는 MCP(stdio) 서버. Claude Code에서 동일 도구 호출 가능.

```bash
cd backend
python -m app.api.mcp_server
```

노출 도구: `list_notebooks`, `read_notebook`, `create_cell`, `update_cell_code`, `execute_cell`, `read_cell_output`, `get_mart_schema`, `preview_mart`, `profile_mart`.

`~/.claude/claude_desktop_config.json` 설정은 CLAUDE.md 참고.

---

## 11. TypeScript 타입 (프론트 `src/types/index.ts` 발췌)

```typescript
export type CellType = 'sql' | 'python' | 'markdown';

export interface Cell {
  id: string;
  name: string;
  type: CellType;
  code: string;
  ordering: number;
  memo?: string;
  insight?: string;
  output?: CellOutput;
  executed?: boolean;
  executedAt?: string;
  agentGenerated?: boolean;
  splitMode?: 'v' | 'h';
}

export type CellOutput =
  | { type: 'table'; data: TableData }
  | { type: 'chart'; data: { plotly_json: unknown }; stdout?: string }
  | { type: 'markdown'; data: { rendered: string } }
  | { type: 'stdout'; data: { text: string } }
  | { type: 'error'; data: { message: string; traceback?: string } };

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  kind?: 'message' | 'step';
  stepType?: 'tool' | 'cell_created' | 'cell_executed' | 'cell_memo' | 'error';
  stepLabel?: string;
  stepDetail?: string;
  collapsed?: boolean;
}
```

---

## 12. 미구현 / 제거된 엔드포인트

v1.0 스펙에는 있었으나 로컬 MVP에 포함되지 않는 항목:

- `POST /auth/*`, `DELETE /auth/session` — 로컬 앱, JWT 없음
- `POST /notebooks/{id}:duplicate`, `POST /notebooks/{id}:move` — 프론트가 복제/이동을 조합 호출로 처리
- `POST /cells/{id}:cycleType`, `POST /cells/{id}:reorder` — PATCH cell로 통합
- `WS /ws/notebooks/{id}` — 단일 사용자이므로 실시간 구독 불필요
- `POST /notebooks/{id}/reports`, `GET /reports/*` — 리포트는 프론트에서 생성 (`src/components/reporting/`)
- `GET /usage/current` — 사용량 트래킹 미도입

---

## 13. 관련 문서

- 에이전트 프로토콜 상세: `docs/vibe-eda-agent-spec.md`
- 기능 명세: `docs/vibe-eda-functional-spec.md`
- PRD: `docs/vibe-eda-prd.md`
- 데이터 모델: `docs/vibe-eda-data-model.md` (현재 `.ipynb` 파일 기반, DB는 미사용)

*Last updated: 2026-04-20*
