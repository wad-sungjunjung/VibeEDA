# Vibe EDA — Agent Mode 기능 명세

> 사내 광고 플랫폼 분석가가 자연어로 노트북 EDA를 지시하면, 에이전트가 SQL/Python/Markdown 셀을 직접 만들고 실행·해석하는 AI 파이프라인.

---

## 1. 개요

| 항목 | 값 |
|---|---|
| 엔드포인트 | `POST /agent/stream` (SSE) |
| 백엔드 모듈 | `backend/app/api/agent.py`, `backend/app/services/claude_agent.py` |
| 보조 백엔드 | `backend/app/services/mart_tools.py` (마트 조회 헬퍼) |
| LLM | Claude Opus (`claude-opus-4-7`) / Gemini (`gemini-*`) |
| 호출 프로토콜 | Anthropic Tool Use / Gemini Function Calling |
| 최대 턴 수 | `MAX_TURNS = 15` |
| 스트리밍 | SSE (`text/event-stream`) |
| MCP 미러 | `backend/app/api/mcp_server.py` — Claude Code에서 동일 도구 사용 가능 |

---

## 2. 실행 파이프라인

```
사용자 요청
   │
   ▼
[1] 플래닝
    - 요청 파악 + 필요시 ask_user로 명확화
    - 선택된 마트의 get_mart_schema / preview_mart 로 맥락 파악
    - (권장) 첫 Markdown 셀에 분석 계획 기록
   │
   ▼
[2] 셀 생성 + 자동 실행  ← create_cell(name, code)
    - name은 snake_case 강제 (영문/숫자/_)
    - SQL/Python 셀은 생성 즉시 Snowflake/Python 커널에서 실행
    - tool_result에 실제 출력 포함
   │
   ▼
[3] 출력 피드백 (채팅 + 셀명 참조)
    ├── 에러·의도 불일치 → update_cell_code (재실행 자동)
    ├── 새로운 셀 필요    → [2] 반복
    ├── 재계획 필요       → 첫 Markdown 플랜 셀 update
    ├── 명확화 필요       → ask_user → 세션 종료 (사용자 답변 대기)
    └── 분석 종료         → 최종 인사이트 Markdown 셀 작성
```

### 2.1 셀 자동 실행 사이클

`create_cell` 또는 `update_cell_code` 호출 시 내부에서 `execute_cell` 이 자동 실행되며, tool result에 실제 출력 요약이 포함된다. 에이전트는 `execute_cell`을 직접 호출할 필요가 없다.

### 2.2 셀 네이밍 규칙 (강제)

- `[a-z_][a-z0-9_]*` — 영문 소문자, 숫자, 언더스코어
- 한글·공백·하이픈·대문자 금지
- 서버가 자동 새니타이즈 (`backend/app/services/naming.py::to_snake_case`)
- Python 셀 마지막 표현식: `fig_<주제>_<차트타입>` 형식 (예: `fig_region_bar`)

---

## 3. 도구 카탈로그

### 3.1 노트북 조작 도구

| 이름 | 입력 | 설명 |
|---|---|---|
| `read_notebook_context` | — | 전체 셀 상태 + selected_marts + analysis_theme 조회 |
| `create_cell` | `cell_type, name?, code, after_cell_id?` | 셀 생성 → SQL/Python은 **자동 실행** |
| `update_cell_code` | `cell_id, code` | 셀 코드 수정 → **자동 재실행** |
| `execute_cell` | `cell_id` | 셀 수동 실행 (보통 불필요) |
| `read_cell_output` | `cell_id` | 기존 실행 결과 조회 |

### 3.2 마트 맥락 수집 도구 (SQL 작성 전 필수)

| 이름 | 입력 | 반환 | 용도 |
|---|---|---|---|
| `get_mart_schema` | `mart_key` | 컬럼명/타입/description/nullable | **SQL 작성 전 반드시 호출** — `column not found` 방지 |
| `preview_mart` | `mart_key, limit?` (기본 5, 최대 50) | 컬럼명 + 상위 N행 | 데이터 생김새 파악 (노트북 셀 미생성) |
| `profile_mart` | `mart_key` | 행수, 컬럼별 NULL 비율·카디널리티, 수치형 min/max/avg | 이상치·결측 탐지 (10만행 샘플) |

구현: `backend/app/services/mart_tools.py` → Snowflake `information_schema` + 직접 `SELECT * LIMIT` / 집계 쿼리.

### 3.3 인사이트 기록 도구

| 이름 | 입력 | 동작 |
|---|---|---|
| `write_cell_memo` | `cell_id, memo` | 셀의 메모(노트)에 핵심 인사이트 기록. 실행 결과 확인 후 호출 권장. `cell_memo_updated` SSE 이벤트 발행 + `.ipynb` 즉시 영속화 |

**에이전트 셀 기본 레이아웃**: 실행 시 자동으로 `splitMode: h` + **좌=출력, 우=메모**로 전환되어 인사이트를 바로 기록할 수 있는 공간이 확보됨.

### 3.4 사용자 상호작용 도구

| 이름 | 입력 | 동작 |
|---|---|---|
| `ask_user` | `question, options?` | SSE `ask_user` 이벤트 송출 → 에이전트는 짧은 안내 텍스트만 남기고 세션 종료. 사용자 답변이 새 `/agent/stream` 호출로 들어와 루프 재개 |

**사용 시점**:
- 요청이 모호 (예: "매출 분석해줘" — 기간/세그먼트 미지정)
- 필수 맥락 부재 (기간, 지역, 지표, 비교 대상 등)
- 애매한 분기 결정 (예: 이탈률 정의가 2개 이상)

---

## 4. SSE 이벤트 프로토콜

클라이언트는 `data: <json>\n\n` 형태로 스트리밍을 수신한다.

| `type` | 필드 | 의미 |
|---|---|---|
| `thinking` | `content` | Claude 추론 과정 (adaptive thinking) |
| `message_delta` | `content` | 에이전트 텍스트 청크 |
| `tool_use` | `tool, input` | 도구 호출 시작 |
| `cell_created` | `cell_id, cell_type, cell_name, code, after_cell_id` | 신규 셀 생성됨 |
| `cell_executed` | `cell_id, output` | 셀 실행 완료 + 출력 |
| `cell_code_updated` | `cell_id, code` | 셀 코드 변경됨 |
| `cell_memo_updated` | `cell_id, memo` | 셀 메모(노트) 변경됨 — 인사이트 기록 |
| `ask_user` | `question, options[]` | 사용자 답변 대기 요청 |
| `complete` | `created_cell_ids[], updated_cell_ids[]` | 세션 종료 (`.ipynb` 영속화 트리거) |
| `error` | `message` | 오류 |

---

## 5. 대화 히스토리 & 영속화

- 각 턴마다 `assistant` 메시지 + `tool_result` 를 히스토리에 append (멀티턴 유지)
- `complete` 이벤트 시 `.ipynb` 의 `metadata.vibe.agent_history` 에 영구 저장
- 재진입 시 `req.conversation_history` 로 주입 → 이어서 대화 가능

위치: `backend/app/services/notebook_store.py::add_agent_message`

---

## 6. 시스템 프롬프트 규칙 (요약)

1. **셀 파이프라인**: 생성/수정 → 자동 실행 → 출력 확인 → 수정 or 다음 셀
2. **맥락 수집 우선순위**: `get_mart_schema` → `preview_mart` → (모호하면) `ask_user`
3. **분석 순서**: SQL 셀 → Python 시각화 (Plotly only, matplotlib 금지) → Markdown 인사이트
4. **변수 공유**: SQL 셀의 결과 DataFrame은 **셀 이름**으로 커널 namespace에 저장되며 Python 셀에서 직접 참조 (`_cells["..."]` 같은 존재하지 않는 접근자 금지)
5. **네이밍**: 모든 셀 이름은 snake_case
6. 모든 응답·설명·인사이트는 **한국어**

전체 내용은 `claude_agent.py::_build_system_prompt()` 참고.

---

## 7. MCP 서버 노출 도구

`mcp_server.py` 는 Claude Code 에서 동일 기능을 호출할 수 있도록 아래를 expose:

- `list_notebooks`, `read_notebook`
- `create_cell`, `update_cell_code`, `execute_cell`, `read_cell_output`
- `get_mart_schema`, `preview_mart`, `profile_mart`

> `ask_user` 는 MCP에 미노출 (Claude Code는 자체 대화로 질문 가능)

실행:
```bash
cd backend
python -m app.api.mcp_server
```

---

## 8. 가드레일 / 권장 개선 포인트

| 항목 | 현재 | 향후 |
|---|---|---|
| 전역 턴 제한 | `MAX_TURNS = 15` | ✅ |
| 셀별 수정 재시도 제한 | ❌ | 같은 셀 3회 수정 실패 시 강제 종료 권장 |
| 플래닝 산출물 | 채팅 텍스트만 | 첫 Markdown 플랜 셀로 영속화 권장 |
| 재계획(replan) 분기 | 암묵적 | 명시적 프롬프트 규칙화 권장 |
| `ask_user` UI | 일반 텍스트로 노출 | 전용 카드 + options 버튼 UI 권장 |

---

## 9. 관련 파일

| 역할 | 경로 |
|---|---|
| API 핸들러 | `backend/app/api/agent.py` |
| Claude 에이전트 루프 | `backend/app/services/claude_agent.py` |
| Gemini 에이전트 루프 | `backend/app/services/gemini_agent_service.py` |
| 마트 조회 헬퍼 | `backend/app/services/mart_tools.py` |
| 셀 네이밍 유틸 | `backend/app/services/naming.py` |
| 노트북 파일 I/O | `backend/app/services/notebook_store.py` |
| Python/SQL 커널 | `backend/app/services/kernel.py` |
| MCP 서버 | `backend/app/api/mcp_server.py` |
| 프론트 SSE 클라이언트 | `src/lib/api.ts::streamAgentMessage` |
| 프론트 UI | `src/components/agent/AgentChatPanel.tsx` |
