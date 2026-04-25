# Vibe EDA — 에이전트 파이프라인 가이드

> `/v1/agent/stream` 의 내부 동작을 설계·구현·운영 관점에서 총정리한 문서. `docs/vibe-eda-agent-spec.md` 가 "무엇" 을 정의한다면 이 문서는 "어떻게 · 왜" 를 설명한다.

**관련 파일**
- API: `backend/app/api/agent.py`
- Claude 루프: `backend/app/services/claude_agent.py`
- Gemini 루프: `backend/app/services/gemini_agent_service.py`
- 공용 tool 스펙: `backend/app/services/agent_tools.py`
- 공용 SSE 이벤트 타입: `backend/app/services/agent_events.py`
- 분석가 스킬 모듈: `backend/app/services/agent_skills.py`
- 커널 + Plotly→PNG: `backend/app/services/kernel.py`
- 마트 헬퍼: `backend/app/services/mart_tools.py`
- 카테고리 캐시: `backend/app/services/category_cache.py`
- 로컬 파일 프로파일 캐시: `backend/app/services/file_profile_cache.py`
- 프론트 SSE: `src/lib/api.ts::streamAgentMessage`
- 프론트 UI: `src/components/agent/AgentChatPanel.tsx`

---

## 1. 전체 흐름

```
사용자 → /v1/agent/stream (POST + SSE, keepalive 5s)
            │
            ├─ X-Agent-Model 헤더로 Claude / Gemini 분기
            ├─ X-Anthropic-Key / X-Gemini-Key 로 키 주입
            ├─ images[] 가 있으면 사용자 메시지에 이미지 블록 첨부
            ├─ category_cache.enrich_mart_metadata() 로 *_status/_type 카테고리 prefetch
            │
            ▼
   NotebookState 조립
   (cells, selected_marts, mart_metadata(+카테고리),
    theme/desc, notebook_id, skill_ctx, explored_marts,
    chart_quality_checked, todos, current_turn_narration)
            │
            ▼
   run_agent_stream  (Claude)  또는  run_agent_stream_gemini
            │
            ▼
   ┌──────────────────────────────────────────────┐
   │  한 턴 루프 (최대 MAX_TURNS=50)                │
   │  ┌──────────────────────────────────────┐   │
   │  │ 1. LLM 호출 (system + tools, 캐싱)     │   │
   │  │ 2. text/thinking 스트리밍 + watchdog   │   │
   │  │ 3. tool_use 수집                      │   │
   │  │ 4. 내레이션 부족 → 1회 재요청          │   │
   │  │    (reset_current_bubble 발사)        │   │
   │  │ 5. 반복/총합 가드 (3회/200회)         │   │
   │  │ 6. 읽기 전용 도구 → asyncio.gather    │   │
   │  │    그 외 → 순차 실행                  │   │
   │  │ 7. 도구별 SSE 이벤트 즉시 yield        │   │
   │  │ 8. SQL/Python 셀이면 자동 실행        │   │
   │  │    + 30/120/300/900s heartbeat       │   │
   │  │ 9. tool_result + (옵션) 이미지 블록    │   │
   │  │ 10. 스킬 post-hook 리마인더 누적       │   │
   │  │ 11. 시스템 리마인더 append             │   │
   │  │ 12. 20턴 이상이면 오래된 tool_result    │   │
   │  │     600자로 압축                      │   │
   │  └──────────────────────────────────────┘   │
   │       ↓ 반복                                 │
   │  종료 직전 pending-guard (PENDING_GUARD_MAX=3)│
   │   ├ 차트 셀에 check_chart_quality 미호출      │
   │   ├ sql/python 셀에 메모 미작성              │
   │   └ 스킬 end-guard (미검증 가설/세그먼트)     │
   └──────────────────────────────────────────────┘
            │
            ▼
   complete 이벤트 (created_cell_ids, updated_cell_ids)
            │
            ▼
   .ipynb 영속화: metadata.vibe.agent_history[] append
   (assistant 메시지에 SSE blocks[] 도 같이 저장)
```

---

## 2. 두 가지 파이프라인을 "의도적으로" 분리한 이유

| 축 | Claude (`claude_agent.py`) | Gemini (`gemini_agent_service.py`) |
|---|---|---|
| SDK | `anthropic.AsyncAnthropic.messages.stream` | `google-genai.aio.models.generate_content` |
| 도구 스펙 | `agent_tools.CORE_TOOLS` (JSONSchema) + `SKILL_TOOLS_CLAUDE` | 동일 소스에서 `_to_gemini_declaration()` 으로 자동 변환 + `SKILL_TOOLS_GEMINI` |
| 시스템 프롬프트 | `system=[{text, cache_control: ephemeral}]` (프롬프트 캐싱) | `GenerateContentConfig.system_instruction` |
| Adaptive thinking | `thinking={"type": "adaptive"}` | `ThinkingConfig(include_thoughts=False)` (Gemini 3 thought 텍스트 필터링) |
| 메시지 포맷 | `{role, content: [{type:"text"\|"tool_use"\|"tool_result", ...}]}` | `types.Content(role, parts=[from_text/from_function_response/from_bytes])` |
| 이미지 주입 (사용자) | `content[{type:"image", source:{base64}}]` 블록 | `Part.from_bytes(mime_type=...)` |
| 이미지 주입 (tool_result) | `tool_result.content = [text_json, image]` | function_response Part 뒤에 `Part.from_bytes` 이어 붙임 |
| 사용자 메시지 시스템 리마인더 | tool_result 의 마지막 `text` 블록에 append | function_response payload 의 `_system_reminder` 키로 주입 |
| 타임아웃 | stream-event watchdog 90s + final 30s + SDK read 600s | `asyncio.wait_for(generate_content, 300s)` |
| keepalive | SSE comment `: keepalive\n\n` 5초마다 (공통) | 동일 |
| 컨텍스트 압축 | `_compact_messages_inplace` (Claude 전용, 20턴 이상) | 미적용 |

두 프로바이더의 특성(캐싱·thinking·Parts 유연성)을 풀로 쓰기 위해 **공통 어댑터로 억지로 추상화하지 않았다**. 공통부는 `_execute_tool`, `_build_system_prompt`, `_auto_execute_after_create_or_update`, `NotebookState`, `PARALLEL_SAFE_TOOLS` 처럼 **LLM 호출에 의존하지 않는 코어**에만 둔다 — Gemini 루프는 Claude 모듈에서 이를 직접 import 해서 재사용한다.

---

## 3. NotebookState 와 맥락 주입

`backend/app/services/claude_agent.py::NotebookState`

```python
@dataclass
class NotebookState:
    cells: list[CellState]
    selected_marts: list[str]
    mart_metadata: list[dict]          # 컬럼 스키마 + 카테고리 distinct (시스템 프롬프트에 사전 주입)
    analysis_theme: str
    analysis_description: str
    notebook_id: str
    skill_ctx: dict                    # 스킬 프레임워크 런타임 상태
    user_message_latest: str           # 셀 chat_history user_msg 폴백
    current_turn_narration: str        # 이번 턴 텍스트 — 셀 chat 내레이션으로 사용
    chart_quality_checked: set         # check_chart_quality 통과한 셀 id 모음
    explored_marts: set                # profile/preview/schema/category/query_data 로 탐색한 마트 키
    todos: list                        # Claude Code 스타일 진행 상황 todo 리스트
```

**시스템 프롬프트 사전 주입 블록** (`_build_system_prompt`):
1. **오늘 날짜 + D-1 데이터 컷오프 (KST)** — '최근 7일' 같은 상대 기간 해석을 고정 날짜 리터럴로 안내. 재실행 시 결과가 달라지는 것을 방지.
2. **선택 마트 스키마** — 컬럼명/타입/description. → `get_mart_schema` 재호출 1턴 절약.
3. **카테고리 컬럼 허용 값** — `*_status`, `*_type` distinct 값. `category_cache` 가 백그라운드에서 30분 주기로 갱신, 요청 시 `enrich_mart_metadata` 로 prefetch.
4. **로컬 파일 프로파일** — `~/vibe-notebooks/` 루트의 CSV/Parquet/Excel 스키마·카테고리.
5. **스킬 프롬프트 프래그먼트** (`SKILLS_SYSTEM_PROMPT`) — 분석가 마인드셋 (planning/baseline/sanity/error_recovery/segmentation).
6. **SQL/Python/Markdown 코드 스타일 가이드** (`code_style.py`).

---

## 4. 도구 카탈로그 상세

도구 정의는 모두 `agent_tools.py::CORE_TOOLS` 단일 소스 (Claude JSONSchema). Gemini 는 `_to_gemini_declaration()` 으로 자동 변환. 스킬 도구는 `agent_skills.py::SKILL_TOOLS_CLAUDE` / `SKILL_TOOLS_GEMINI` 에 별도 선언.

### 4.1 셀 조작

| 도구 | 동작 | 반환 키 포인트 |
|---|---|---|
| `create_cell` (sql/python/markdown) | 셀 생성. 호출부(run loop)가 SQL/Python 이면 즉시 자동 실행 | `cell_id`, `cell_type`, `success`, (auto_executed 후) `output_summary`, `image_png_base64?` |
| `update_cell_code` | 코드 교체. 호출부가 SQL/Python 이면 자동 재실행 | 동일 |
| `execute_cell` | 명시적 실행 (자동 실행이 디폴트라 거의 불필요) | `output_summary`, `image_png_base64?` |
| `read_cell_output` / `read_notebook_context` | 상태 조회만 | 캐시된 `output_summary` |
| `write_cell_memo` | 셀 메모 작성. 서버에서 볼드/헤더/라벨 머리말 자동 새니타이즈 | `success` |
| `check_chart_quality` | 차트 셀 PNG 검토 후 판정 (passed/issues/summary) | `instruction` (passed=true → write_cell_memo, false → update_cell_code) |
| `create_sheet_cell` / `update_sheet_cell` | UniverJS 워크북 패치 (A1 노테이션, 수식 지원). sheet 셀은 비실행 | `applied_patches`, `skipped_ranges` |

### 4.2 데이터 탐색 / 스크래치

| 도구 | 동작 | 비고 |
|---|---|---|
| `profile_mart` | 행수·NULL·카디널리티·수치형 min/max/avg | explore-before-query 통과 마크 |
| `preview_mart` | 상위 N행 (limit ≤ 50, 셀 X) | explore 통과 |
| `get_mart_schema` | 컬럼 N/T/description | explore 통과 |
| `get_category_values` | 임의 컬럼 distinct 값 (≤100개, on-demand) | `category_cache` 활용, 100개 초과 시 `too_many` |
| `query_data` | 즉석 SELECT (셀 X, 100행 상한) | DML/DDL 차단, 단일 statement, purpose 필수 |
| `analyze_output` | 기존 셀 DataFrame 의 자동 통계 (describe/top/bottom/IQR outlier/NULL/categorical_top) | 큰 결과 ≥30행은 이걸로 메모 근거 확보 |
| `list_available_marts` | 선택 안 된 마트까지 전체 카탈로그 (filter_keyword) | `request_marts` 의 추천 키 정확도용 |

### 4.3 계획 · 흐름 관리 (스킬 도구)

| 도구 | 동작 |
|---|---|
| `create_plan` | 가설 3+ 플랜 Markdown 셀을 노트북 최상단에 자동 배치. SQL/Python 셀 전 호출 강제 (trivial 휴리스틱은 스킵) |
| `update_plan` | 전체 플랜 Markdown 교체. `- [x]/[ ]` 체크 상태 유지하며 갱신 |
| `request_marts` | 구조화된 마트 추가 요청 (reason + suggested_keywords + missing_dimensions). `ask_user` 와 함께 세션 종료 플래그 공유 |
| `todo_write` | Claude Code 스타일 todo 리스트. 한 번에 1개만 `in_progress`, 3+ 단계 작업에서만 사용 |
| `ask_user` | 모호한 요청 시 즉시 사용자 질문. 호출 후 추가 도구 금지, 짧은 안내 텍스트로 마감 |

### 4.4 가드 & 검증

#### SQL 마트 화이트리스트
`_whitelist_violation(sql, selected_marts)` 가 SQL 의 `from|join` 뒤 토큰을 파싱해 selected 마트에 없으면 거부. CTE 이름은 자동 제외. `create_cell`, `update_cell_code`, `query_data` 모두 동일 가드 적용.

#### Explore-before-query (`mart_not_explored`)
`agent_skills.check_pre_guard` 에서 `create_cell(sql)` 호출 시, SQL 이 참조하는 마트 중 `state.explored_marts` 에 없는 게 하나라도 있으면 거부. 통과시키려면 먼저 `profile_mart` / `preview_mart` / `get_mart_schema` / `get_category_values` / `query_data` 중 하나로 마트를 스치라.

#### 메모 강제 가드 (🔒 핵심)
`create_cell` 진입 직후, `state.cells[-1]` 이 sql/python 이고 executed && output != error && memo 가 비었으면 → `memo_required_before_next_cell` 으로 거부. 결과적으로 "분석 → 관찰 → 메모 → 다음 셀" 리듬 강제.

#### 차트 퀄리티 게이트
차트 셀(output.type == "chart") 이 생성되면, 그 셀 id 가 `chart_quality_checked` 집합에 들어올 때까지 (= `check_chart_quality(passed=True)` 호출) 종료가 봉쇄된다 (pending-guard). 미달이면 `update_cell_code` 로 같은 셀 재렌더 유도.

#### 플래닝 게이트
SQL/Python 셀을 만들기 전에 `create_plan` 호출 강제. 단, `_is_trivial_request(initial_user_message)` 휴리스틱 — 25자 미만이고 깊이 분석 키워드 ('분석', '비교', '왜', 'why' 등) 가 없으면 자동 스킵.

### 4.5 ask_user / request_marts (세션 종료 플래그 공유)
`ASK_USER_LIKE_TOOLS = {"ask_user", "request_marts"}`. 호출 시 SSE `ask_user` 이벤트 발행 + 내부 `ask_user_called=True`. 그 턴에 추가 도구 호출 금지, 짧은 안내 텍스트로 종료. 다음 `/agent/stream` 요청 시 `conversation_history` 로 답변이 들어와 루프 재개.

---

## 5. 차트 이미지 tool_result 주입

### 5.1 PNG 렌더 (`kernel.py::_render_figure_png_base64`)

- `fig.layout.width/height` 가 있으면 비율을 유지하며 width 600 으로 다운스케일. 없으면 600×400 (2:3).
- `fig.to_image()` 는 **kaleido 패키지 필수**. Windows 의 chromium 재사용 hang 방지를 위해 **`KALEIDO_RENDER_TIMEOUT_SEC=30`** 의 ThreadPoolExecutor 안에서 실행, timeout 시 None 폴백 + 워커 abandon.
- 차트 JSON 자체는 항상 정상 반환되므로 UI 에는 차트가 그려지고, **LLM 만 이미지를 못 보는** 상태로 graceful degrade.
- 성공 시 cell output 의 `imagePngBase64` 필드에 저장돼 `.ipynb` 에도 함께 영속화.

### 5.2 Figure 자동 표시 억제
`_suppress_plotly_show()` 가 `pio.renderers.default = "json"`, `Figure.show / pio.show = no-op` 을 한 번만 세팅. 에이전트 코드의 `fig.show()` 가 사용자 브라우저에 새 탭을 띄우는 것을 방지. 또한 `_to_cell_output` 이 이번 실행에서 **새로 바인딩/변경된 변수**(touched_keys) 중에서만 Figure 후보를 고르므로, 이전 셀의 figure 가 엉뚱한 셀 출력으로 재사용되지 않는다.

### 5.3 텍스트 메타 (`_format_output_for_claude`)
차트 출력의 경우 제목/축 제목/trace 목록(n_points 포함)을 텍스트로 같이 주입. 이미지가 없을 때도 모델이 무엇을 그렸는지 알 수 있도록.

### 5.4 tool_result 구조

**Claude**
```python
{
  "type": "tool_result",
  "tool_use_id": "...",
  "content": [
    {"type": "text", "text": "<json payload>"},
    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<b64>"}},
  ],
}
```

**Gemini** (같은 Content 의 parts 리스트에 함께 append)
```python
[
  Part.from_function_response(name=fc.name, response=payload),
  Part.from_bytes(data=png_bytes, mime_type="image/png"),
]
```

`image_png_base64` 는 tool_result 이미지 블록으로만 붙이고, JSON payload 에서는 `pop` 해서 제거 — 거대한 base64 가 텍스트에 중복되는 것을 방지.

---

## 6. 한 턴 루프 심화

### 6.1 내레이션 강제 (1회 재요청 + 매턴 리마인더)

**동기**: 도구만 연속 호출하면 사용자에게 "뭐 하는지" 가 안 보이고, 짧은 정리 텍스트가 모델 품질에도 도움이 된다.

**구현**:
1. `turn_index > 0` 이고 tool_use 가 있는데 텍스트가 `NARRATION_MIN_CHARS=20` 미만이면 **턴을 폐기**하고, "텍스트 먼저" 강제 user 메시지를 주입해 다시 호출. 이때 짧은 텍스트가 이미 흘러갔다면 `reset_current_bubble` 이벤트로 프론트 버블 비움.
2. 재시도 후에도 짧으면 다음 턴의 tool_result 마지막 텍스트 블록에 `[시스템 리마인더]` 매 턴 append (한 턴 한정 X).

### 6.2 반복 & 총량 가드

`_norm_key(tool_name, input)` 가 대소문자·공백 변형을 정규화한 뒤 JSON 직렬화한 키 사용. 모델이 input 에 공백 하나 넣어 우회하는 것을 방지.

- `repeat_counter[key] > REPEAT_CALL_LIMIT(=3)` → `error` + 루프 종료
- `total_tool_calls > TOTAL_TOOL_LIMIT(=200)` → `error` + 루프 종료
- 루프 자체는 `MAX_TURNS=50` (Claude/Gemini 동일)

### 6.3 병렬 도구 실행

`PARALLEL_SAFE_TOOLS` 집합의 읽기 전용 도구(`profile_mart`, `preview_mart`, `get_mart_schema`, `get_category_values`, `query_data`, `read_cell_output`, `read_notebook_context`, `list_available_marts`, `analyze_output`) 만 한 턴에 호출됐다면 `asyncio.gather` 로 병렬 실행. 쓰기성 도구가 하나라도 섞이면 전체를 순차 실행 (순서 의존성 보존).

### 6.4 SQL/Python 자동 실행 (`_auto_execute_after_create_or_update`)

- `create_cell(sql|python)` / `update_cell_code(sql|python)` 직후 호출.
- `cell_executed` SSE 이벤트는 즉시 yield, tool_result 에는 `auto_executed/output_summary/image_png_base64/elapsed_sec` 를 in-place 머지 — 모델은 단일 도구 호출로 인식.
- **장기 실행 신호**:
  - `LONG_EXEC_HEARTBEAT_THRESHOLDS_SEC = (30, 120, 300, 900)` 임계마다 + 그 이후엔 60초 간격으로 `exec_heartbeat` 이벤트 발사 ("아직 실행 중이에요").
  - 완료 시 `LONG_EXEC_NOTIFY_MIN_SEC=30` 이상 걸렸으면 `exec_completed_notice` 발사 ("X초 만에 완료됐어요"). 모델 tool_result 에도 `elapsed_sec` 포함되어 응답에 자연스럽게 멘트 가능.

### 6.5 종료 직전 pending-guard

LLM 이 도구 호출 없이 끝나려는 순간 (`tool_uses == []`), 아래를 체크해서 한 가지라도 걸리면 `[시스템 리마인더]` 를 user 메시지로 주입하고 루프 재개. 단 `pending_guard_count < PENDING_GUARD_MAX(=3)` 까지만 — 무한 루프 방지.

- 차트 셀에 `check_chart_quality` 미호출
- 차트 셀에 메모 미작성
- 일반 sql/python 셀에 메모 미작성
- 스킬 end-guard (`agent_skills.get_end_guard_reminder`):
  - 미검증 가설 ≥1 + 분석 셀 ≥2 → 검증 또는 `update_plan` 체크 권고
  - 모든 가설 검증 + 셀 ≥3 + ≤8 → 미탐색 세그먼트 축 1개 제안

### 6.6 컨텍스트 압축 (Claude 전용)

`_compact_messages_inplace(messages, keep_recent_turns=10)`: 20턴 이상 길어지면 첫 user 메시지와 최근 10개 tool_result 를 제외한 오래된 tool_result 의 텍스트 content 를 **앞 600자 + "(...truncated for context budget)"** 로 치환. 이미지 블록은 원본 유지 (차트 해석에 필수).

### 6.7 프롬프트 캐싱 (Claude 전용)

시스템 프롬프트와 tools 배열의 마지막 항목에 `cache_control: {"type": "ephemeral"}` 마킹. 멀티턴 루프에서 대용량 상수 재전송 비용/지연 절감.

### 6.8 Stream watchdog & keepalive

- **Claude**: 단일 stream 이벤트 도착 간격이 `STREAM_EVENT_WATCHDOG_SEC=90` 을 넘으면 stream stall 로 간주, `error` 이벤트 후 종료. final_message 회수도 `STREAM_FINAL_MESSAGE_SEC=30` 으로 상한.
- **공통**: `_with_keepalive` 가 SSE 청크 사이에 `: keepalive\n\n` comment 를 5초마다 끼워 넣어, 모델이 thinking 으로 무송신일 때 프록시·LB idle timeout 으로 끊기는 것 방지.
- **Gemini**: `asyncio.wait_for(generate_content, timeout=300)` 으로 단일 호출 상한.

### 6.9 셀 chat history 자동 기록

에이전트가 만들거나 수정한 셀은 vibe chat history 에도 한 줄 항목으로 남는다 (`agent_chat_entry` SSE 페이로드 + `notebook_store.add_chat_entry`). user_msg 는 우선순위:
1. 이번 턴 내레이션 (`current_turn_narration`, 400자 컷)
2. 원 사용자 요청 (`user_message_latest`)
3. 짧은 기본 문구 ("에이전트가 이 셀을 생성/수정했습니다")

코드 스냅샷도 함께 저장해 셀별 타임라인에서 이전 시점 코드 비교/복원 가능.

---

## 7. 실행 엔진과의 상호작용

`_execute_tool("execute_cell", ...)` 은 `loop.run_in_executor(None, run_sql/run_python, ...)` 로 동기 드라이버를 실행. 이유:
- Snowflake Python Connector 가 블로킹 I/O
- Python 커널 exec 도 사용자 코드가 오래 돌 수 있음 — FastAPI 이벤트 루프 보호

### Python/SQL 실행 타임아웃

| 매개변수 | 기본 | env override | 동작 |
|---|---|---|---|
| `PYTHON_EXEC_TIMEOUT_SEC` | 1800 (30분) | `AGENT_PYTHON_EXEC_TIMEOUT_SEC` | 모델링/대용량 처리 대비 넉넉히 |
| `SQL_EXEC_TIMEOUT_SEC` | 300 (5분) | `AGENT_SQL_EXEC_TIMEOUT_SEC` | Snowflake warehouse 지연 포함 |

`asyncio.wait_for` 로 상한. 0/음수면 무한 대기 (escape hatch). 주의: `run_in_executor` 의 thread 자체는 cancel 되지 않으므로 timeout 후에도 백그라운드에서 돌 수 있다 — 그러나 에이전트 흐름은 즉시 복귀해 사용자 피드백 가능.

### Python 셀 namespace 공유

`kernel.py::_namespaces[notebook_id]` 가 노트북별 전역 namespace. SQL 결과 DataFrame 이 **셀 이름** 으로 namespace 에 저장되므로, 이후 Python 셀에서 `shop_stats` 같은 변수로 직접 참조. 시스템 프롬프트에서 `_cells["..."]` 같은 존재하지 않는 접근자는 쓰지 말라고 강하게 경고.

### Jupyter 호환

- 마지막 statement 가 표현식이면 그 값을 `cell_name` 으로 자동 바인딩 (Jupyter 의 last-expr 표시와 동일).
- `!pip install ...`, `%pip install ...`, `!shell-cmd` 라인은 in-process subprocess 호출로 변환해 stdout 을 셀 출력으로 흘림.
- VibeDf wrapper 가 pandas DataFrame 에 `.to_pandas()` 메서드를 주입 (Snowpark 스타일 호환).

### 메모 sanitizer

`_sanitize_memo` 가 `**볼드**`, `__강조__`, `# 헤더`, `- **관찰:**` 같은 라벨 머리말을 일괄 제거. 메모는 셀 단위 짧은 인사이트라 강조 마커 불필요 — 프롬프트로도 금지하지만 서버에서 한 번 더 강제.

---

## 8. SSE 이벤트 카탈로그

`agent_events.py` 가 단일 소스. 프론트 `src/lib/api.ts::AgentEvent` union 과 동기화.

| 이벤트 | 페이로드 | 발사 시점 |
|---|---|---|
| `thinking` | `content` | adaptive thinking delta (Claude) |
| `message_delta` | `content` | 텍스트 delta |
| `reset_current_bubble` | — | 내레이션 재요청 시 프론트 버블 비움 |
| `tool_use` | `tool`, `input` | 도구 호출 직전 (실행 전) |
| `cell_created` | `cell_id`, `cell_type`, `cell_name`, `code`, `after_cell_id?`, `agent_chat_entry?` | create_cell / create_sheet_cell / create_plan |
| `cell_code_updated` | `cell_id`, `code`, `agent_chat_entry?` | update_cell_code / update_sheet_cell / update_plan |
| `cell_executed` | `cell_id`, `output` | 자동/명시 실행 완료 |
| `cell_memo_updated` | `cell_id`, `memo` | write_cell_memo |
| `chart_quality` | `cell_id`, `passed`, `summary`, `issues` | check_chart_quality |
| `todos_updated` | `todos[]` | todo_write |
| `ask_user` | `question`, `options`, (request_marts) `request_type`, `suggested_keywords`, `missing_dimensions`, `reason` | ask_user / request_marts |
| `exec_heartbeat` | `cell_id`, `cell_name`, `elapsed_sec`, `message` | 자동 실행 30/120/300/900s + 그 이후 60s 간격 |
| `exec_completed_notice` | 동일 | 자동 실행이 ≥30s 걸려 끝났을 때 |
| `complete` | `created_cell_ids[]`, `updated_cell_ids[]` | 정상 종료 |
| `error` | `message` | API/타임아웃/가드 종료 |

### 타임라인 예시 — "강남구 세부 분석해줘"

```
1. tool_use         : create_plan(hypotheses=[...3개])
2. cell_created     : analysis_plan (markdown, 노트북 최상단)
3. message_delta    : "플랜을 세웠어요. 먼저 선택 마트 프로파일을 확인할게요."
4. tool_use         : profile_mart(mart_key="ad_sales_mart")  ← 병렬 가능
5. tool_use         : profile_mart(mart_key="dim_shop_base")
6. message_delta    : "두 마트 모두 NULL 0%. 강남구 필터 쿼리 작성할게요."
7. tool_use         : create_cell(sql="SELECT ... WHERE gu='강남구' ...")
8. cell_created     : gangnam_sales (sql)
9. cell_executed    : output={type:"table", rows:[...]}
10. tool_use        : write_cell_memo(memo="강남구 CTR 18% 상회 ...")
11. cell_memo_updated
12. tool_use        : create_cell(python="import plotly.express as px; ...")
13. cell_created    : fig_gangnam (python)
14. cell_executed   : output={type:"chart", imagePngBase64:"..."}  + tool_result에 PNG 주입
15. tool_use        : check_chart_quality(cell_id, passed=true, summary="...")
16. chart_quality   : passed=true
17. tool_use        : write_cell_memo(memo="시간대별 편차 ...")
... (반복)
99. complete        : created_cell_ids=[...], updated_cell_ids=[...]
```

---

## 9. 운영 체크리스트

- [ ] **kaleido 설치** (`pip install 'kaleido==0.2.1'`) — 미설치 시 차트 PNG 가 LLM 으로 안 감 (UI 에는 차트 정상 표시).
- [ ] `DEFAULT_AGENT_MODEL` env (Opus 권장) — 프론트 헤더로 런타임 override 가능.
- [ ] `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 최소 하나.
- [ ] Snowflake 세션이 `is_connected()==False` 면 `get_mart_schema/preview_mart/profile_mart/query_data/list_available_marts/get_category_values` 가 모두 `snowflake_not_connected` 를 반환 → 프론트에 연결 가이드 노출.
- [ ] 장시간 작업 시 `AGENT_PYTHON_EXEC_TIMEOUT_SEC` / `AGENT_SQL_EXEC_TIMEOUT_SEC` 로 상한 조정.
- [ ] 카테고리 캐시는 `~/vibe-notebooks/.vibe/.categories_cache.json` 에 저장. 30분 주기 백그라운드 갱신 (`main.py` 스케줄러).
- [ ] `/notebooks/{id}/agent/archive` POST 로 현재 세션 아카이브 처리 — 프론트가 localStorage 에 세션 저장 후 호출하면 다음 로드 시 같은 메시지가 '현재 대화' 로 다시 안 올라옴.

---

## 10. 자주 만나는 이슈

| 증상 | 원인 | 대처 |
|---|---|---|
| 같은 차트가 여러 셀에서 재출력 | 이전 셀의 namespace 잔존 Figure | `_to_cell_output` 의 `touched_keys` 가드로 해결됨 — 그래도 발생하면 `DELETE /kernel/{nb_id}` 로 namespace 초기화 |
| 메모 없이 다음 셀이 만들어짐 | 가드 이전 버전 | 현재 가드는 `create_cell` 진입 첫 단계 + 종료 직전 pending-guard 이중 — 우회 불가 |
| 차트 이미지가 LLM 에 안 전달됨 | kaleido 미설치 또는 Windows 의 chromium hang (30초 timeout) | 로그의 `kaleido PNG render timed out` 확인. 프로세스 재시작 시 종종 회복. UI 에는 영향 없음 |
| Gemini 300초 타임아웃 | 거대 맥락 또는 네트워크 | Pro 모델로 변경하거나 셀 수 줄임 |
| 세션 안전 상한 도달 (200회 tool_call) | 같은 시도 반복 | 새 메시지로 "이어서 분석해줘" — 누적 상태에서 재개 |
| MAX_TURNS=50 초과 | 작업 단위가 너무 큼 | 더 짧게 쪼개 재요청 |
| `mart_not_explored` 거부 | profile/preview 안 거치고 SQL 작성 | 프롬프트에 명시 — 모델은 통상 자동 회복 |
| 메모에 볼드/헤더가 들어감 | 프롬프트 위반 | 서버 sanitizer 가 자동 제거 — UI 표시 시점에는 평문 |

---

## 11. 분석가 마인드셋 스킬 모듈 (`agent_skills.py`)

Claude/Gemini 파이프라인이 공용으로 사용하는 스킬 프레임워크. 9개 스킬이 시스템 프롬프트 fragment + 선택적 신규 tool + pre-guard + post-hook + end-guard 를 조합해 제공된다.

### 스킬 목록

| # | 스킬 | 메커니즘 | 핵심 효과 |
|---|---|---|---|
| 1 | **planning** | `create_plan` tool + pre-guard | 가설 3개 이상 Markdown 플랜 없으면 SQL/Python 셀 생성 거부 (trivial 휴리스틱 스킵) |
| 2 | **plan_revision** | `update_plan` tool + 메모 post-hook | 메모에 '예상 밖/새 가설' 키워드 감지 시 플랜 갱신 리마인더 + 메모 3회마다 정기 drift 점검 |
| 3 | **hypothesis_exhaustion** | end-guard | 루프 종료 직전 미검증 가설 수 체크 → 리마인더 1회 주입 후 재개 |
| 4 | **data_request** | `request_marts` tool | 구조화된 마트 추가 요청 (ask_user 의 typed variant) |
| 5 | **output_critic** | 프롬프트 강제 + 메모 sanitizer | 메모 구조: 관찰 / 이상 신호 / 비교 기준 / 다음 행동 (강조 마커 금지) |
| 6 | **sanity_check** | SQL post-hook | GROUP BY/JOIN 감지 시 rowcount/중복/NULL 검증 셀 권고 (한 셀당 1회) |
| 7 | **error_recovery** | execute post-hook | 에러를 column_not_found/division_by_zero/timeout/type_mismatch/permission/sql_syntax 로 분류 + 2회 반복 시 `ask_user` 유도 |
| 8 | **baseline_comparison** | 메모 post-hook | 메모에 상대 비교 표현(대비/평균/%/배 등)이 없으면 보강 요구 |
| 9 | **segmentation_exploration** | end-guard | 모든 가설 검증 완료 & 셀 3~7개면 미탐색 축(시간/공간/주체/채널) 1개 제안 |

추가로 `claude_agent.py` 에 직접 살아있는 가드:
- **explore-before-query** (`mart_not_explored`) — `agent_skills.check_pre_guard` 가 explored_marts 집합으로 강제
- **chart_quality_gate** — 종료 전 pending-guard 가 chart_quality_checked 와 메모를 함께 체크

### 런타임 상태

`NotebookState.skill_ctx` (dict):
- `plan_cell_id` — 플랜 셀 id (`<!-- vibe:analysis_plan -->` 마커 또는 `analysis_plan` 이름으로 탐지)
- `error_count_by_cell` — 셀별 에러 반복 수
- `sanity_hinted_cells` — sanity-check 힌트 중복 방지 set
- `memo_count` — 3회마다 drift 정기 체크
- `end_guard_fired` / `end_guard_reason` — end-guard 중복 방지
- `initial_user_message` — trivial 요청 휴리스틱

### 프로바이더 공용화

- 프롬프트 fragment (`SKILLS_SYSTEM_PROMPT`) 는 `_build_system_prompt` 에서 둘 다 append
- Tool 정의는 Claude (`SKILL_TOOLS_CLAUDE` JSONSchema) + Gemini (`SKILL_TOOLS_GEMINI` 경량 dict) 각각 선언
- pre-guard / post-hook / end-guard 함수는 순수 Python 으로 어느 파이프라인에서도 호출 가능
- `ASK_USER_LIKE_TOOLS = {"ask_user", "request_marts"}` — 두 파이프라인 공용 종료 플래그

---

## 12. 향후 개선 아이디어

- **플랜 진행률 UI**: 플랜 셀의 `- [x]/[ ]` 를 프론트에서 진행 바로 시각화 (todo_write 와 시각 통합 가능)
- **셀별 수정 재시도 상한**: 같은 셀에 `update_cell_code` 를 3회 이상 실패하면 `ask_user` 강제 (error_recovery skill 에서 부분 구현됨)
- **`request_marts` 전용 UI**: 제안 키워드 기반 마트 추천 카드
- **complete 이벤트 행동 요약**: 한 줄 결과 요약 포함 (지금은 셀 ID 만)
- **비용 추적**: 각 턴의 Claude/Gemini usage 집계 → 프론트 사이드바 표시
- **통계적 엄밀성 스킬 (Tier 3)**: 비교·차이 주장 시 표본 크기 경고
- **차트 선택 스킬 (Tier 3)**: 데이터 shape 로 차트 타입 추천
- **Gemini 컨텍스트 압축**: 현재 Claude 만 `_compact_messages_inplace` 적용 — Gemini 도 동등 처리
- **Kaleido 대체**: chromium hang 회피용 다른 렌더러(matplotlib fallback) 또는 plotly orca 시도
