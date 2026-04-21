# Vibe EDA — 에이전트 파이프라인 가이드

> `/v1/agent/stream` 의 내부 동작을 설계·구현·운영 관점에서 총정리한 문서. `docs/vibe-eda-agent-spec.md` 가 "무엇" 을 정의한다면 이 문서는 "어떻게 · 왜" 를 설명한다.

**관련 파일**
- API: `backend/app/api/agent.py`
- Claude 루프: `backend/app/services/claude_agent.py`
- Gemini 루프: `backend/app/services/gemini_agent_service.py`
- 커널: `backend/app/services/kernel.py` (차트 PNG 렌더 포함)
- 마트 헬퍼: `backend/app/services/mart_tools.py`
- 프론트 SSE: `src/lib/api.ts::streamAgentMessage`
- 프론트 UI: `src/components/agent/AgentChatPanel.tsx`

---

## 1. 전체 흐름

```
사용자 → /v1/agent/stream (POST + SSE)
            │
            ├─ X-Agent-Model 헤더로 Claude / Gemini 분기
            │
            ▼
   NotebookState 조립 (cells, selected_marts, mart_metadata, theme, desc, nb_id)
            │
            ▼
   run_agent_stream_claude  또는  run_agent_stream_gemini
            │
            ▼
   ┌────────────────────────────────────┐
   │  한 턴 루프 (최대 MAX_TURNS=15)      │
   │  ┌──────────────────────────────┐  │
   │  │ 1. LLM 호출 (tools 포함)       │  │
   │  │ 2. text / thinking 스트리밍   │  │
   │  │ 3. tool_use 수집              │  │
   │  │ 4. 내레이션 규칙 검증 (재요청)  │  │
   │  │ 5. 반복/총합 가드 검사         │  │
   │  │ 6. 각 tool 실행 → SSE 이벤트   │  │
   │  │ 7. tool_result + 이미지 주입   │  │
   │  │ 8. 시스템 리마인더 추가         │  │
   │  └──────────────────────────────┘  │
   │       ↓ 반복                        │
   └────────────────────────────────────┘
            │
            ▼
   complete 이벤트 (created_cell_ids, updated_cell_ids)
            │
            ▼
   .ipynb 영속화: metadata.vibe.agent_history[] append
```

---

## 2. 두 가지 파이프라인을 "의도적으로" 분리한 이유

| 축 | Claude (`claude_agent.py`) | Gemini (`gemini_agent_service.py`) |
|---|---|---|
| SDK | `anthropic.AsyncAnthropic.messages.stream` | `google-genai.aio.models.generate_content` |
| 도구 스펙 | `TOOLS` (JSONSchema) | `types.FunctionDeclaration` |
| 시스템 프롬프트 | `system=[{..., cache_control: ephemeral}]` (프롬프트 캐싱) | `GenerateContentConfig.system_instruction` |
| 메시지 포맷 | `{role, content: [{type:"text"|"tool_use"|"tool_result", ...}]}` | `types.Content(role, parts=[Part.from_text/from_function_response/from_bytes])` |
| 이미지 주입 | `tool_result.content = [text, {type:"image", source:{base64}}]` | function_response Part 뒤에 `Part.from_bytes(mime_type="image/png")` 이어 붙이기 |
| 사고 단계 | adaptive thinking (`thinking` 이벤트) | — |
| 타임아웃 제어 | stream context manager | `asyncio.wait_for(generate_content, 300s)` |

두 프로바이더의 특성(캐싱·thinking·Parts 유연성)을 풀로 쓰기 위해 **공통 어댑터로 억지로 추상화하지 않았다**. 공통부는 `_execute_tool`, `_build_system_prompt`, `NotebookState` 처럼 **LLM 호출에 의존하지 않는 코어**에만 둔다.

---

## 3. NotebookState 와 맥락 주입

`backend/app/services/claude_agent.py::NotebookState`

```python
@dataclass
class NotebookState:
    cells: list[CellState]
    selected_marts: list[str]
    mart_metadata: list[dict]     # 각 마트의 컬럼 스키마 (프롬프트에 사전 주입)
    analysis_theme: str
    analysis_description: str
    notebook_id: str
```

**핵심 최적화**: `mart_metadata` 를 시스템 프롬프트에 사전 주입하면 에이전트가 `get_mart_schema` 를 또 호출하지 않아도 컬럼명을 안다 → 1턴 절약. 사용자 프롬프트가 애매할 때만 `get_mart_schema` / `preview_mart` 를 호출하도록 프롬프트로 유도.

---

## 4. 도구 카탈로그 상세

### 4.1 셀 조작 도구

| 도구 | 자동 부작용 | 반환 키 포인트 |
|---|---|---|
| `create_cell` | SQL/Python 셀은 생성 직후 `execute_cell` 연쇄 호출 | `output_summary`, `image_png_base64?` |
| `update_cell_code` | 동일하게 자동 재실행 | `output_summary`, `image_png_base64?` |
| `execute_cell` | 실제 Snowflake / Python 커널 호출 | `output_summary`, `image_png_base64?` |
| `read_cell_output` | 상태 조회만 | 캐시된 `output_summary` |
| `read_notebook_context` | 상태 조회만 | 셀 스냅샷 전체 |

### 4.2 가드 & 검증

#### SQL 마트 화이트리스트
`_whitelist_violation(sql, selected_marts)` 이 SQL 의 `from|join` 뒤 테이블 토큰을 파싱해 selected 마트에 없으면 `create_cell`·`update_cell_code` 를 거부한다. CTE 이름은 자동 제외. 위반 시 응답:
```json
{"success": false, "error": "mart_not_selected_in_sql", "message": "..."}
```

#### 메모 강제 가드 (🔒 핵심)
`create_cell` 진입 직후, `state.cells[-1]` 이
- `type ∈ {sql, python}` 이고
- `executed == True` 이고
- `output.type != error` 이고
- `memo` 가 공백이 아닌 문자열이 아니면

→ 요청을 거부하고 `memo_required_before_next_cell` 에러를 반환. 에이전트는 시스템 프롬프트에서도 동일 규칙을 받으며, 서버 가드가 이를 **이중으로 보장**한다. 결과적으로 "분석 → 관찰 → 메모 → 다음 셀" 리듬이 강제된다.

### 4.3 마트 탐색 도구

`mart_tools.py` 가 Snowflake `information_schema` + 직접 집계 쿼리로 구현.

- `get_mart_schema(mart_key)` — 컬럼 N/T/description
- `preview_mart(mart_key, limit≤50)` — 셀을 생성하지 않고 상위 N 행
- `profile_mart(mart_key)` — 10만행 샘플로 row_count, per-column null_ratio, distinct_count, 수치형 min/max/avg

모두 selected_marts 화이트리스트 체크를 우선 수행. 접근 불가 시 `ask_user` 로 마트 추가를 사용자에게 요청하도록 프롬프트 지시.

### 4.4 ask_user

호출 시 SSE 로 `ask_user` 이벤트 발행 + 내부 플래그 `ask_user_called = True`. 에이전트는 그 턴에 도구 호출을 추가로 하지 말고 짧은 안내 텍스트만 남긴 채 종료. 다음 `/agent/stream` 호출에서 사용자 답변이 `conversation_history` 로 주입돼 루프가 재개된다.

---

## 5. 차트 이미지 tool_result 주입

### 5.1 PNG 렌더 (`kernel.py`)

```python
def _render_figure_png_base64(fig) -> str | None:
    try:
        img_bytes = fig.to_image(format="png", width=600, height=400, scale=1)
        return base64.b64encode(img_bytes).decode("ascii")
    except Exception:
        return None
```

- 해상도 600×400 으로 고정 — 토큰/비용 최소화
- `fig.to_image()` 는 **kaleido 파이썬 패키지 필수**. 미설치 시 무음 실패로 PNG 가 빠진다 (서버 로그 무경고 — `fig.to_image` 가 자체 ImportError 를 삼킨다)
- 성공 시 cell output 에 `imagePngBase64` 필드로 저장돼 `.ipynb` 에도 함께 영속화

### 5.2 `_format_output_for_claude` — LLM 에 전달하는 텍스트 메타

차트 출력의 경우 제목, 축 제목, trace 목록(n_points 포함)을 텍스트로 요약해 같이 주입. 이미지가 없을 때도 모델이 무엇을 그렸는지 알 수 있도록.

### 5.3 tool_result 구조

**Claude**
```python
{
  "type": "tool_result",
  "tool_use_id": "...",
  "content": [
    {"type": "text", "text": "<json payload>"},
    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<b64>"}}
  ]
}
```

**Gemini** (같은 Content 의 parts 리스트에 함께 append)
```python
[
  Part.from_function_response(name=fc.name, response=payload),
  Part.from_bytes(data=png_bytes, mime_type="image/png"),
]
```

### 5.4 이미지 제거 후 payload

`image_png_base64` 는 tool_result 에 이미지 블록으로 따로 붙이고, JSON payload 에서는 `pop` 해 제거한다 — 텍스트에 거대한 base64 가 중복 들어가는 것을 방지.

---

## 6. 한 턴 루프 심화

### 6.1 내레이션 강제

**동기**: 에이전트가 텍스트 설명 없이 연속으로 도구만 호출하면 사용자는 "뭐 하는 거지?" 상태가 된다. 또 모델이 맥락을 짧게라도 정리하고 넘어가는 것이 품질에 유의미하게 기여.

**구현**:
1. `turn_index > 0` 이고 tool_use 가 있는데 텍스트가 `NARRATION_MIN_CHARS=20` 미만이면 **한 번** 턴을 폐기하고, `role=user` 메시지로 "텍스트 먼저" 강제 지시를 주입해 다시 호출한다.
2. 재시도 후에도 짧으면 다음 턴의 tool_result 마지막 항목에 `[시스템 리마인더]` 를 append 해 **매 턴 재주입**.

### 6.2 반복 & 총량 가드

`_norm_key(tool_name, input)` 가 대소문자·공백 변형을 정규화한 뒤 JSON 직렬화한 키를 사용한다. 이렇게 하면 모델이 input 에 공백 하나 넣어 우회하는 것을 막을 수 있다.

- `repeat_counter[key] > 3` → `error` 이벤트 + 루프 종료
- `total_tool_calls > 40` → `error` 이벤트 + 루프 종료

### 6.3 장시간 분석 리마인더

`elapsed > LONG_RUN_SEC (30s)` 이면 (아직 `ask_user_called` 아니라면) 마지막 tool_result 에 리마인더 한 번 추가:
> "현재 선택된 마트로 정말 답이 되는가? / 질문에 모호한 범위·기간·지표가 남아있지 않은가? 조금이라도 불확실하면 즉시 `ask_user` 를 호출하라."

이는 "모델이 끝없이 삽질하는 것을 멈추고 사용자와 대화하도록" 유도하기 위한 장치.

### 6.4 프롬프트 캐싱 (Claude 전용)

시스템 프롬프트와 tools 배열 모두 `cache_control: {"type": "ephemeral"}` 로 마킹해 Anthropic 프롬프트 캐시에 넣는다. 멀티턴 루프에서 대용량 상수 재전송 비용 + 지연을 크게 절감.

---

## 7. 실행 엔진과의 상호작용

`_execute_tool("execute_cell", ...)` 은 내부적으로 `asyncio.loop.run_in_executor` 로 동기 드라이버(`kernel.run_sql`, `kernel.run_python`)를 호출. 이유:
- Snowflake Python Connector 가 블로킹 I/O
- Python 커널 exec 도 사용자 코드가 오래 돌 수 있음
- FastAPI 이벤트 루프를 막지 않기 위해 executor 로 위임

### Python 셀 namespace 공유

`kernel.py::_namespaces[notebook_id]` 가 노트북별 전역 namespace. SQL 실행 결과 DataFrame 이 **셀 이름으로** namespace 에 저장되므로, 이후 Python 셀에서 `shop_stats` 같은 변수로 바로 참조 가능. 시스템 프롬프트에서 `_cells["..."]` 같은 존재하지 않는 접근자는 쓰지 말라고 강하게 경고.

### Figure 자동 표시 억제

`_suppress_plotly_show()` 가 `pio.renderers.default = "json"`, `Figure.show = no-op` 을 한 번만 세팅. 에이전트가 만든 `fig.show()` 가 사용자 브라우저에 새 탭을 띄우는 것을 방지.

---

## 8. SSE 이벤트 타임라인 (예시)

사용자: "강남구 세부 분석해줘"

```
1. message_delta  : "분석을 시작하겠습니다. 먼저 선택된 마트..."
2. tool_use       : get_mart_schema(mart_key="ad_sales_mart")
3. message_delta  : "스키마를 확인했어요. 강남구 필터를 넣어 집계해볼게요."
4. tool_use       : create_cell(sql="SELECT ... WHERE gu='강남구' ...")
5. cell_created   : cell_id=..., name=gangnam_sales
6. cell_executed  : output={type:"table", ...}
7. message_delta  : "결과를 보니 CTR 이 전국 평균 대비 18% 높네요."
8. tool_use       : write_cell_memo(cell_id, memo="- 강남구 CTR 18% 상회...")
9. cell_memo_updated
10. tool_use      : create_cell(python="import plotly.express as px; fig=...")
11. cell_created + cell_executed  (PNG 이미지 tool_result에 주입됨)
12. message_delta : "차트에서 시간대별 편차가 크네요. 이어서..."
... (반복)
99. complete      : created_cell_ids=[...], updated_cell_ids=[...]
```

---

## 9. 운영 체크리스트

- [ ] kaleido 설치 (`pip install 'kaleido==0.2.1'`) — 미설치 시 차트 이미지 주입이 무음으로 실패
- [ ] `DEFAULT_AGENT_MODEL` env 설정 (Opus 권장)
- [ ] `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 최소 하나
- [ ] Snowflake 세션은 `snowflake_session.is_connected()` 가 False 면 SQL 도구가 모두 막힘 → 프론트에 연결 가이드 노출
- [ ] 장시간 응답 관찰 시 `/tmp/vibe-backend.log` 확인 (30s 초과 경고)

---

## 10. 자주 만나는 이슈

| 증상 | 원인 | 대처 |
|---|---|---|
| 동일 차트가 여러 셀에서 반복 생성 | repeat guard 를 우회하는 미세한 코드 차이 | 시스템 프롬프트에서 "중복 figure 금지" 강조 + 사용자 프롬프트의 차트 리스트 제시 |
| 메모 없이 다음 셀이 만들어짐 | 가드 이전 버전 구현 또는 예외 경로 | 가드는 `create_cell` 진입 첫 단계에 있음. 우회 불가 |
| 차트 이미지가 LLM 에 안 전달됨 | kaleido 미설치 또는 `fig.to_image` 실패 | 로그 확인 + kaleido 재설치 |
| Gemini 세션이 300초 넘어 타임아웃 | 거대한 맥락 또는 네트워크 | 모델을 Gemini Pro 로 바꾸거나 노트북 셀 수를 줄임 |
| "Snowflake 미연결" 에러 | 세션 만료 | 프론트 "연결 관리" 에서 재연결 |

---

## 11. 분석가 마인드셋 스킬 모듈 (`agent_skills.py`)

Claude/Gemini 파이프라인이 공용으로 사용하는 스킬 프레임워크. 9개 스킬이 시스템 프롬프트 fragment + 선택적 신규 tool + pre-guard + post-hook + end-guard 를 조합해 제공된다.

### 스킬 목록

| # | 스킬 | 제공 메커니즘 | 핵심 효과 |
|---|---|---|---|
| 1 | **planning** | 신규 tool `create_plan` + pre-guard | 가설 3개 이상 Markdown 플랜 없으면 SQL/Python 셀 생성 거부 (trivial 요청은 휴리스틱 스킵) |
| 2 | **plan_revision** | 신규 tool `update_plan` + 메모 post-hook | 메모에 '예상 밖/새 가설' 키워드 감지 시 플랜 갱신 리마인더 |
| 3 | **hypothesis_exhaustion** | end-guard | 루프 종료 직전 미검증 가설 수 체크 → 리마인더 1회 주입 후 재개 |
| 4 | **data_request** | 신규 tool `request_marts` | 구조화된 마트 추가 요청 (ask_user 의 typed variant) |
| 5 | **output_critic** | 프롬프트 강제 | 메모를 `관찰 / 이상 신호 / 비교 기준 / 다음 행동` 구조로 |
| 6 | **sanity_check** | SQL 실행 post-hook | GROUP BY/JOIN 감지 시 rowcount·중복·NULL 검증 셀 권고 |
| 7 | **error_recovery** | execute post-hook | 에러를 `column_not_found/division_by_zero/timeout/type_mismatch/…` 로 분류 + 2회 반복 시 `ask_user` 유도 |
| 8 | **baseline_comparison** | 메모 post-hook | 메모에 상대 비교 표현이 없으면 보강 요구 |
| 9 | **segmentation_exploration** | end-guard | 모든 가설 검증 완료 & 충분히 진행됐으면 미탐색 축 제안 |

### 런타임 상태

`NotebookState.skill_ctx` (dict) 에 요청 단위 상태 저장:
- `plan_cell_id` — 플랜 Markdown 셀 id (`<!-- vibe:analysis_plan -->` 마커로 탐지)
- `error_count_by_cell` — 셀별 에러 반복 수
- `sanity_hinted_cells` — sanity-check 힌트 중복 방지 set
- `memo_count` — 3회마다 drift 정기 체크
- `end_guard_fired` — end-guard 중복 방지
- `initial_user_message` — trivial 요청 휴리스틱용

### 프로바이더 공용화

- 시스템 프롬프트 fragment (`SKILLS_SYSTEM_PROMPT`) 는 `_build_system_prompt` 에서 둘 다 append
- Tool 정의는 Claude JSONSchema (`SKILL_TOOLS_CLAUDE`) + Gemini FunctionDeclaration (`SKILL_TOOLS_GEMINI`) 각각 선언
- pre-guard / post-hook / end-guard 함수는 순수 Python 으로 어느 파이프라인에서도 호출 가능
- `ASK_USER_LIKE_TOOLS = {"ask_user", "request_marts"}` — 두 파이프라인 공용으로 세션 종료 플래그 공유

---

## 12. 향후 개선 아이디어

- **플랜 진행률 UI**: 플랜 셀의 `- [x]/[ ]` 를 프론트에서 진행 바로 시각화
- **셀별 수정 재시도 상한**: 같은 셀에 `update_cell_code` 를 3회 이상 실패하면 `ask_user` 강제 (error_recovery skill 에서 부분 구현됨)
- **`request_marts` 전용 UI**: 제안 키워드 기반 마트 추천 카드
- **행동 요약**: `complete` 이벤트에 한 줄 결과 요약 포함 (지금은 셀 ID 만)
- **비용 추적**: 각 턴의 Claude/Gemini usage 집계 → 프론트 사이드바 표시
- **통계적 엄밀성 스킬 (Tier 3)**: 비교·차이 주장 시 표본 크기 경고
- **차트 선택 스킬 (Tier 3)**: 데이터 shape 로 차트 타입 추천
