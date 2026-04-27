# Vibe EDA — 에이전트 파이프라인 가이드

> `/v1/agent/stream` 의 내부 동작을 설계·구현·운영 관점에서 총정리한 문서. `docs/vibe-eda-agent-spec.md` 가 "무엇" 을 정의한다면 이 문서는 "어떻게 · 왜" 를 설명한다. **시니어 분석가 v0.5 (S7 완료) 기준으로 갱신.**

**관련 파일**
- API: `backend/app/api/agent.py`
- Claude 루프: `backend/app/services/claude_agent.py`
- Gemini 루프: `backend/app/services/gemini_agent_service.py`
- 공용 tool 스펙: `backend/app/services/agent_tools.py`
- 공용 SSE 이벤트 타입: `backend/app/services/agent_events.py`
- 분석가 스킬: `backend/app/services/agent_skills.py`
- **Phase -1**: `backend/app/services/agent_budget.py`, `agent_classifier.py`
- **Phase 0**: `backend/app/services/agent_methods.py`
- **Phase 3**: `backend/app/services/agent_synthesis.py`
- **메서드별 도구**: `agent_ml.py` (S4) · `agent_causal.py` (S5) · `agent_predict.py` (S6)
- **세션 간 학습**: `agent_learnings.py`
- 커널 + Plotly→PNG: `backend/app/services/kernel.py`
- 마트 헬퍼: `backend/app/services/mart_tools.py`
- 카테고리 캐시: `backend/app/services/category_cache.py`
- 로컬 파일 프로파일 캐시: `backend/app/services/file_profile_cache.py`
- 프론트 SSE: `src/lib/api.ts::streamAgentMessage`
- 프론트 UI: `src/components/agent/AgentChatPanel.tsx`

---

## 1. 시스템 구조도 (Phase × Tier × Method)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  사용자 요청 → POST /v1/agent/stream  (SSE keepalive 5s)                  │
│  X-Agent-Model 로 Claude / Gemini 분기, X-*-Key 로 키 주입                 │
│  images[] 첨부 가능, conversation_history + tier_override 옵션            │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
       ┌──────────────────────────────────────────────────────────┐
       │  Phase -1 — 복잡도 분류 + 예산 (agent_budget/classifier)  │
       │  ─────────────────────────────────────────────────────── │
       │  1) 휴리스틱 (글자수·키워드·마트수·이미지) — 즉시 결정     │
       │  2) 애매하면 Haiku fallback (4s timeout, in-mem cache)    │
       │  3) 둘 다 실패 → default L2                              │
       │  결과: tier ∈ {L1, L2, L3} + budget(turns/tools/시간 추정) │
       │  SSE: tier_classified                                    │
       └──────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼ L1 (Quick)              ▼ L2 (Standard)            ▼ L3 (Deep)
  스킵 → Phase 2 만               Phase 0 + 1 + 2 + 3        풀 사이클
  budget 5/10                    budget 25/60               budget 100/250
                                  │
                                  ▼
       ┌──────────────────────────────────────────────────────────┐
       │  Phase 0 — 메서드 라우팅 (agent_methods)                  │
       │  ─────────────────────────────────────────────────────── │
       │  L2/L3 첫 턴: select_methods 강제 (pre-guard)             │
       │  primary 1 + secondary 0~2 + rationale + artifacts        │
       │  결과: methods[] (analyze/explore/predict/causal/ml/      │
       │                  ab_test/benchmark)                      │
       │  → 시스템 프롬프트에 메서드별 fragment 동적 주입           │
       │  SSE: methods_selected                                   │
       └──────────────────────────────────────────────────────────┘
                                  │
                                  ▼
       ┌──────────────────────────────────────────────────────────┐
       │  Phase 1 — 플래닝 (agent_skills::create_plan)             │
       │  ─────────────────────────────────────────────────────── │
       │  가설 3+ Markdown 셀 강제 (trivial 휴리스틱은 스킵)        │
       │  분석 도중 update_plan 으로 갱신·체크                     │
       │  ⚠️ 메서드별 분기는 deferred (현재 generic)               │
       └──────────────────────────────────────────────────────────┘
                                  │
                                  ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Phase 2 — 실행 루프 (`while turn_index < budget.max_turns:`)         │
  │  ──────────────────────────────────────────────────────────────────  │
  │  ┌──────────────────────────────────────────────────────────────┐   │
  │  │ 1. LLM 호출 (system+tools 캐싱, watchdog 90s)                 │   │
  │  │ 2. text/thinking 스트리밍                                     │   │
  │  │ 3. tool_use 수집                                              │   │
  │  │ 4. 내레이션 부족 → 1회 재요청 (reset_current_bubble)          │   │
  │  │ 5. 반복/총합 가드 (3회 / budget.max_tool_calls)              │   │
  │  │ 6. 읽기 전용 도구 → asyncio.gather (병렬), 그 외 순차          │   │
  │  │ 7. 도구 실행 → SSE 이벤트 즉시 yield                          │   │
  │  │    └ 메서드별 도구는 method 미선택 시 거부                    │   │
  │  │ 8. SQL/Python 셀이면 자동 실행 + heartbeat (30/120/300/900s)  │   │
  │  │ 9. tool_result (+ 차트 PNG 이미지 블록 옵션) → JSON safe      │   │
  │  │ 10. 스킬 post-hook 리마인더 누적                              │   │
  │  │ 11. 종료 직전 pending-guard (PENDING_GUARD_MAX=3):            │   │
  │  │     - 차트 셀에 check_chart_quality 미호출                    │   │
  │  │     - sql/python 셀에 메모 미작성                             │   │
  │  │     - L2/L3: rate_findings + synthesize_report 미호출         │   │
  │  │     - L3:    self_consistency_check 미호출                    │   │
  │  │     - 스킬 end-guard (미검증 가설 / 세그먼트 미탐색)           │   │
  │  │ 12. 20턴↑ → 오래된 tool_result 600자 압축 (Claude+Gemini)     │   │
  │  │ 13. Auto-promotion: L1 셀 4+ → L2, L2 turn 20+ → L3           │   │
  │  │ 14. Soft warning at 80% → 마무리 압박 시스템 리마인더         │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
       ┌──────────────────────────────────────────────────────────┐
       │  Phase 3 — 종합 정리 (agent_synthesis)                    │
       │  ─────────────────────────────────────────────────────── │
       │  Sequential gates (서버가 순서 강제):                      │
       │    1) rate_findings — 핵심 결론 3~7개 + confidence         │
       │       confidence 자동 하향 룰:                            │
       │         · 인과 표현 + causal 메서드 미선택 → low            │
       │         · 단일 셀 근거 → mid 상한                          │
       │         · 표본 n<30 → low                                 │
       │         · 증거 셀 id 무효 → low                            │
       │    2) self_consistency_check (L3 만, 1회 한정)             │
       │    3) synthesize_report(audience='exec'/'ds'/'pm')        │
       │       → markdown summary 셀 자동 생성, .ipynb 영속화       │
       │       → high-conf findings 를 learnings.md 에 누적         │
       └──────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                     SSE: complete (cell ids)
                     .ipynb metadata.vibe.agent_history append
                     ~/vibe-notebooks/.vibe/learnings/{nb}.md append
```

---

## 2. 3-Tier × 4-Phase 매트릭스

| | L1 Quick | L2 Standard | L3 Deep |
|---|---|---|---|
| 트리거 예시 | "총 매출", "row 수" | "지역별 매출 분석" | "종합 분석 + 예측 + 임원 보고" |
| Phase -1 분류 | 휴리스틱 즉시 | 휴리스틱 또는 Haiku | 휴리스틱 또는 Haiku |
| Phase 0 라우팅 | **스킵** (자동 `analyze`) | 1줄 메서드 선택 | 풀 라우팅 (다중 메서드) |
| Phase 1 플래닝 | **스킵** | 가설 3개 (간이) | 가설 3개 + update_plan |
| Phase 2 가드 | explore-before-query 만 | 기본 + 1~2 메서드 가드 | 풀 가드 + 메서드별 |
| Phase 3 종합 | **스킵** (답변만) | rate_findings + synthesize | rate + consistency + synthesize |
| 메모 강제 | **약화** (1줄 OK) | 표준 (2~5줄) | 표준 |
| **예산 (turns/tools)** | **5 / 10** | **25 / 60** | **100 / 250** |
| 예상 시간 | ~30초 | 2~5분 | 10~20분 |

(L3 예산은 S7 에서 80/200 → 100/250 으로 상향 — 메서드별 도구 9개 추가에 대응)

---

## 3. 도구 카탈로그 (총 34개 / Gemini 31개)

```
agent_tools.CORE_TOOLS (S0 — 18개) ─────────────────────────────────
  ┌─ 셀 조작
  │   read_notebook_context · create_cell · update_cell_code · execute_cell
  │   read_cell_output · write_cell_memo · check_chart_quality
  │   create_sheet_cell · update_sheet_cell
  ├─ 데이터 탐색
  │   profile_mart · preview_mart · get_mart_schema · get_category_values
  │   query_data · analyze_output · list_available_marts
  └─ 흐름 관리
      todo_write · ask_user

agent_skills.SKILL_TOOLS_CLAUDE (S0 — 3개) ─────────────────────────
  create_plan · update_plan · request_marts

agent_methods (S2 — 1개) ──────────────────────────────────────────
  select_methods    [Phase 0 — L2/L3 첫 턴 강제]

agent_synthesis (S3 — 3개) ────────────────────────────────────────
  rate_findings    [confidence 자동 하향 룰]
  self_consistency_check    [L3 만, 세션당 1회]
  synthesize_report    [Sequential gate: findings → consistency → report]

agent_ml (S4 — 3개, ml 메서드 활성 시) ─────────────────────────────
  fit_model    [data leakage / class imbalance / time-leakage 가드]
  evaluate_model    [confusion matrix / AUC / R² / 잔차]
  feature_importance    [permutation, top-N]

agent_causal (S5 — 3개, causal/ab_test 메서드 활성 시) ─────────────
  compare_groups    [Welch t / Cohen's d / 95% CI]
  confounders_check    [SMD per candidate, imbalanced flag]
  power_analysis    [MDE 또는 required n]

agent_predict (S6 — 3개, predict 메서드 활성 시) ───────────────────
  fit_trend    [선형 + STL 분해 + Ljung-Box]
  forecast    [Holt-Winters + 신뢰구간 강제]
  detect_anomalies    [rolling z-score / IQR]
```

---

## 4. 메서드 게이팅 다이어그램

```
사용자 요청
    │
    ▼ select_methods(primary, secondary[], rationale)
    │
    ▼ state.methods = [analyze, predict, causal, ...]
    │
도구 호출 시 _execute_tool_impl 의 라우팅:
    │
    ├─ name in agent_ml.ML_TOOL_NAMES
    │     ├─ 'ml' ∈ state.methods?  → handle_ml_tool(...)
    │     └─ NO                      → reject(method_not_selected)
    │
    ├─ name in agent_causal.CAUSAL_TOOL_NAMES
    │     ├─ 'causal' or 'ab_test' ∈ state.methods?  → handle_causal_tool(...)
    │     └─ NO                                       → reject
    │
    ├─ name in agent_predict.PREDICT_TOOL_NAMES
    │     ├─ 'predict' ∈ state.methods?  → handle_predict_tool(...)
    │     └─ NO                          → reject
    │
    ├─ Phase 0/3 도구 → 항상 허용
    └─ 그 외 코어/스킬 도구 → Phase 0 가드만 통과하면 허용
```

---

## 5. SSE 이벤트 카탈로그 (`agent_events.py` 단일 소스)

| 이벤트 | 페이로드 | 발사 시점 |
|---|---|---|
| `tier_classified` | tier, reason, estimated_cells, estimated_seconds, max_turns, max_tool_calls, methods | Phase -1 직후 (1회) |
| `tier_promoted` | from_tier, to_tier, reason, new_max_* | auto-promotion 발생 시 |
| `methods_selected` | methods, rationale, expected_artifacts | Phase 0 select_methods 호출 |
| `budget_warning` | percent_used, remaining_turns, remaining_tool_calls, message | 80% 도달 시 1회 |
| `thinking` | content | adaptive thinking delta (Claude) |
| `message_delta` | content | 텍스트 delta |
| `reset_current_bubble` | — | 내레이션 재요청 |
| `tool_use` | tool, input | 도구 실행 직전 |
| `cell_created` | cell_id, cell_type, cell_name, code, after_cell_id?, agent_chat_entry? | create_cell 등 |
| `cell_code_updated` | cell_id, code, agent_chat_entry? | update_cell_code 등 |
| `cell_executed` | cell_id, output | 자동/명시 실행 완료 |
| `cell_memo_updated` | cell_id, memo | write_cell_memo |
| `chart_quality` | cell_id, passed, summary, issues | check_chart_quality |
| `todos_updated` | todos[] | todo_write |
| `ask_user` | question, options, request_type? | ask_user / request_marts |
| `exec_heartbeat` | cell_id, cell_name, elapsed_sec, message | 30/120/300/900s + 60s 간격 |
| `exec_completed_notice` | (동일) | 자동 실행 ≥30s 완료 시 |
| `complete` | created_cell_ids, updated_cell_ids | 정상 종료 |
| `error` | message | API/타임아웃/가드 종료 |

---

## 6. 가드 우선순위 (서버에서 강제)

```
도구 호출 시 가드 적용 순서 (위에서 아래로 평가, 거부되면 즉시 종료):

  1. Phase 0 가드          (L2/L3 첫 도구가 select_methods 가 아니면 거부)
  2. Phase 3 sequential   (synthesize_report 전 findings/consistency 체크)
  3. 메서드 게이팅          (ml/causal/predict 도구는 해당 메서드 선택 시만)
  4. 스킬 pre-guard         (create_cell 전 plan 강제, mart_not_explored)
  5. SQL whitelist         (create_cell sql, query_data — selected_marts 외 거부)
  6. 메모 강제              (이전 셀 memo 비었으면 create_cell 거부)
  7. self_consistency 1회   (이미 호출했으면 재호출 거부)

종료 직전 pending-guard (PENDING_GUARD_MAX=3):
  · 차트 셀의 check_chart_quality / 메모 누락 → 시스템 리마인더 주입
  · L2/L3 의 rate_findings / synthesize_report 누락 → 강제
  · L3 의 self_consistency_check 누락 → 강제
  · 스킬 end-guard (미검증 가설 / 세그먼트 미탐색)
```

---

## 7. NotebookState 필드

```python
@dataclass
class NotebookState:
    # 기본
    cells: list[CellState]                    # 노트북 셀 스냅샷
    selected_marts: list[str]
    mart_metadata: list[dict]                 # 컬럼 + 카테고리 prefetch
    analysis_theme: str
    analysis_description: str
    notebook_id: str

    # Phase 0 (S2)
    methods: list[str]                        # ['analyze', 'predict', ...]
    method_rationale: str
    expected_artifacts: list[str]

    # Phase -1 (S1)
    budget: BudgetState | None                # tier, turns/tools 한도, started_at

    # Phase 3 (S3)
    findings: list[dict]                      # rate_findings 결과
    synthesis_done: bool
    consistency_checked: bool                 # 1회 한정

    # 기존 가드 / 흐름
    skill_ctx: dict                           # 스킬 런타임 (plan_cell_id 등)
    user_message_latest: str
    current_turn_narration: str               # 셀 chat history 용
    chart_quality_checked: set
    explored_marts: set                       # explore-before-query 용
    todos: list                               # todo_write 누적
```

---

## 8. 시스템 프롬프트 동적 주입 블록

`_build_system_prompt(state)` 가 진입 시 다음을 조립 (순서대로):

1. **base** — Vibe EDA 분석가 정의 + 셀 사이클 + 코드 스타일
2. **tier 라벨** — `L1`/`L2`/`L3` (답변 분량 가이드)
3. **`learnings_block`** — 이전 세션의 high-confidence 발견 (1500자 cap, 노트북별)
4. **`date_block`** — KST 오늘 날짜 + D-1 데이터 컷오프 ("최근 7일" 해석 안내)
5. **`mart_schema_block`** — 선택 마트 컬럼/타입/카테고리 distinct (Snowflake 마트만)
5a. **`cell_dataframes_block`** — `selected_marts` 중 실행된 SQL 셀과 이름이 겹치는 항목을 "노트북 셀 DataFrame" 섹션으로 주입. `profile_mart` 금지 + `analyze_output` / Python 변수 직접 참조 가이드 포함. 에러 가드: `_execute_tool` 에서 셀 이름으로 `profile_mart/preview_mart/get_mart_schema` 호출 시 `cell_dataframe_not_mart` 에러 반환.
6. **`local_files_block`** — 루트 폴더의 CSV/Parquet 프로파일
7. **`routing_block`** — 메서드 선택 결과 (또는 미선택 시 select_methods 강제 안내)
8. **`methods_block`** — 메서드별 fragment (`agent_methods.METHOD_FRAGMENTS`)
9. **`synthesis_block`** — Phase 3 안내 (L2 간이 / L3 풀 템플릿)
10. **`SKILLS_SYSTEM_PROMPT`** — 분석가 마인드셋 9개 스킬
11. **`SQL_STYLE_GUIDE` / `PYTHON_RULES` / `MARKDOWN_RULES`**

---

## 9. 차트 이미지 tool_result 주입

### 9.1 PNG 렌더 (`kernel.py::_render_figure_png_base64`)
- `fig.layout.width/height` 가 있으면 비율 유지하며 width 600 으로 다운스케일. 없으면 600×400 (2:3).
- **kaleido 패키지 필수**. Windows chromium hang 방지로 `KALEIDO_RENDER_TIMEOUT_SEC=30` 의 ThreadPoolExecutor 안에서 실행.
- timeout 시 None 폴백 + worker abandon — 차트 JSON 자체는 정상 반환되어 UI 에는 그려지고 LLM 만 이미지를 못 보는 상태로 graceful degrade.

### 9.2 tool_result 구조
**Claude**: `tool_result.content = [text_json, {type:"image", source:{base64}}]`
**Gemini**: 같은 Content.parts 안에 `Part.from_function_response` + `Part.from_bytes(mime_type="image/png")` 이어붙임.

### 9.3 JSON safe 변환 (필수)
모든 tool result 는 `_make_json_safe()` 를 통과 — Decimal→float, NaN/Inf→None, datetime→ISO, set→list, numpy/pandas 스칼라 unwrap. Claude/Gemini 양쪽 직렬화 안전.

---

## 10. 한 턴 루프 심화

### 10.1 내레이션 강제
- `turn_index > 0` + tool_use 있는데 텍스트 < `NARRATION_MIN_CHARS=20` → 1회 재요청 (`reset_current_bubble` 후 user 메시지로 강제 지시)
- 재시도 후에도 짧으면 매 턴 시스템 리마인더 append
- **pending-guard `continue` 시 bubble 리셋**: pending-guard 가 외부 루프를 `continue` 할 때 이미 스트리밍된 텍스트를 `reset_current_bubble` 로 지운다. 다음 턴 모델이 동일 맺음 문구를 반복해 마지막 단어가 두 번 보이는 현상을 방지.

### 10.2 반복 / 총량 가드
- `_norm_key(tool, input)` — 대소문자/공백 정규화 후 JSON 키
- `repeat_counter[key] > REPEAT_CALL_LIMIT(=3)` → error + 종료
- `total_tool_calls > budget.max_tool_calls` → error + 종료

### 10.3 병렬 실행
`PARALLEL_SAFE_TOOLS` (read_notebook_context, read_cell_output, profile_mart, preview_mart, get_mart_schema, get_category_values, query_data, list_available_marts, analyze_output) — 한 턴에 이 도구만 있고 2개 이상이면 `asyncio.gather` 로 동시 실행. 쓰기성 도구가 섞이면 전체 순차 실행.

### 10.4 자동 실행
`_auto_execute_after_create_or_update` — `create_cell(sql|python)` / `update_cell_code(sql|python)` 직후 즉시 `execute_cell` 호출, tool_result 에 `auto_executed/output_summary/image_png_base64/elapsed_sec` in-place 머지. `cell_executed` SSE 는 즉시 yield. 장기 실행이면 `LONG_EXEC_HEARTBEAT_THRESHOLDS_SEC=(30,120,300,900)` 임계마다 + 그 이후 60초 간격으로 heartbeat 발사.

### 10.5 컨텍스트 압축
- **Claude**: `_compact_messages_inplace(messages, keep_recent_turns=10)` — 20턴↑ 시 오래된 tool_result content 600자 컷, 이미지 보존
- **Gemini**: `_compact_gemini_contents_inplace(contents, keep_recent=10)` — function_response Part 의 텍스트 필드 600자 컷

### 10.6 Auto-promotion
- L1 + (셀 ≥4 또는 turn ≥4) → L2 승격
- L2 + (셀 ≥12 또는 turn ≥20) → L3 승격
- `user_overridden=True` 면 비활성 (사용자 의사 존중)
- 승격 시 `tier_promoted` SSE + 새 budget 으로 max_turns/max_tool_calls 재계산

### 10.7 Soft warning + Hard cap
- `pct >= 0.8` 도달 시 `budget_warning` SSE + 모델에 마무리 압박 시스템 리마인더 (1회)
- `pct >= 1.0` 도달 시 새 도구 호출 차단 + error 종료

### 10.8 프롬프트 캐싱 (Claude 전용)
시스템 프롬프트 + tools 마지막 항목에 `cache_control: {"type": "ephemeral"}` — 멀티턴 비용/지연 절감.

### 10.9 Stream watchdog
- Claude: 단일 stream event 도착 간격 `STREAM_EVENT_WATCHDOG_SEC=90` 초과 시 stall 로 간주 → error 종료
- Final message 회수 `STREAM_FINAL_MESSAGE_SEC=30`
- SDK read timeout 600s, connect 10s
- Gemini: `asyncio.wait_for(generate_content, 300)` — 5분 단일 호출 상한

### 10.10 SSE keepalive
`_with_keepalive` 가 청크 사이에 `: keepalive\n\n` comment 를 5초마다 끼워 — 모델이 thinking 으로 무송신일 때 프록시·LB idle timeout 방지.

---

## 11. 세션 간 학습 (`agent_learnings.py`)

```
synthesize_report 호출 시:
    high-confidence findings 만 dedup append
    파일: ~/vibe-notebooks/.vibe/learnings/{nb_id}.md
    크기 cap: 8000 bytes (앞부분 잘림, 헤더 보존)

다음 세션 진입 시:
    _build_system_prompt 가 prefix 로 주입
    크기 cap: 1500 bytes (마지막 우선)

목적:
    "같은 노트북에서 이전에 검증한 사실 재발견 방지"
    "stale 위험은 timestamp 와 사용자 명시적 부정에 의존"
```

---

## 12. 운영 체크리스트

- [ ] **kaleido 설치** (`pip install 'kaleido==0.2.1'`)
- [ ] `DEFAULT_AGENT_MODEL` env (Opus 권장)
- [ ] `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 최소 하나
  - Gemini 모드라도 **Anthropic 키가 있으면** 분류기 Haiku fallback 활성
- [ ] Snowflake 세션 (`snowflake_session.is_connected()`) — 미연결 시 마트 도구 모두 차단
- [ ] 장시간 작업 시 `AGENT_PYTHON_EXEC_TIMEOUT_SEC` / `AGENT_SQL_EXEC_TIMEOUT_SEC` 조정
- [ ] 카테고리 캐시: `~/vibe-notebooks/.vibe/.categories_cache.json` (30분 주기 갱신)
- [ ] 학습 누적: `~/vibe-notebooks/.vibe/learnings/{nb}.md` — 사용자가 수동 편집 가능
- [ ] sklearn / scipy / statsmodels 설치 (S4-S6 도구의 백엔드 필수)

---

## 13. 자주 만나는 이슈

| 증상 | 원인 | 대처 |
|---|---|---|
| `method_routing_required` 에러 | L2/L3 첫 도구가 select_methods 아님 | 정상 동작 — 모델이 다음 턴에 select_methods 호출 |
| `method_not_selected` 에러 | ML/causal/predict 도구를 해당 메서드 미선택 상태에서 호출 | 모델이 select_methods 재호출해 메서드 추가 |
| `consistency_check_required` 에러 | L3 인데 self_consistency_check 안 부르고 synthesize_report | 모델이 self_consistency 먼저 호출 |
| `findings_required_first` 에러 | L2/L3 인데 rate_findings 안 부르고 synthesize_report | 모델이 rate_findings 먼저 호출 |
| 차트 이미지가 LLM 에 안 전달됨 | kaleido 미설치 또는 chromium hang (30s timeout) | 로그에 `kaleido PNG render timed out` 있는지 확인 |
| Gemini 300초 타임아웃 | 거대 맥락 또는 네트워크 | Gemini Pro 모델로 변경하거나 셀 수 줄임 |
| 세션 안전 상한 도달 (예산) | 같은 시도 반복 / 분석 너무 큼 | 새 메시지로 "이어서 분석해줘" 또는 '더 깊게' override |
| 메모에 볼드/헤더가 들어감 | 프롬프트 위반 | 서버 sanitizer 가 자동 제거 — UI 표시 시점엔 평문 |
| `Object of type Decimal is not JSON serializable` | (구) Snowflake Decimal 타입 | `_make_json_safe` wrapper 가 모든 tool result sanitize — 발생 안 함 |
| `cell_dataframe_not_mart` 에러 | 노트북 SQL 셀 이름으로 `profile_mart` 등 호출 | 정상 동작 — 에이전트가 `analyze_output` 또는 Python 변수로 전환 |
| 에이전트가 셀로 만든 마트를 카탈로그에서 못 찾음 | 실행된 SQL 셀이 `selected_marts` 에 포함돼 있으나 Snowflake 마트로 오인 | `cell_dataframes_block` 이 시스템 프롬프트에 주입되어 자동 구분됨 |

---

## 14. 분석가 마인드셋 스킬 모듈 (`agent_skills.py`)

9개 스킬 — Claude/Gemini 공용 프레임워크:

| # | 스킬 | 메커니즘 |
|---|---|---|
| 1 | planning | `create_plan` tool + pre-guard (가설 3+ 강제) |
| 2 | plan_revision | `update_plan` tool + 메모 post-hook (drift 감지) |
| 3 | hypothesis_exhaustion | end-guard (미검증 가설 리마인더) |
| 4 | data_request | `request_marts` tool |
| 5 | output_critic | 메모 구조 강제 + sanitizer (볼드/헤더 제거) |
| 6 | sanity_check | SQL post-hook (GROUP BY/JOIN 시 검증 권고) |
| 7 | error_recovery | 에러 분류 (column_not_found/timeout/...) + 2회 반복 시 ask_user |
| 8 | baseline_comparison | 메모 post-hook (상대 비교 표현 강제) |
| 9 | segmentation_exploration | end-guard (가설 검증 후 미탐색 축 제안) |

---

## 15. 향후 개선 (deferred)

- **Phase 1 메서드 인식 플래닝** — `create_plan` 이 method 별 다른 스키마 (predict→target/split, causal→outcome/confounders) 강제 — 현재 generic
- **회귀 테스트 골든 노트북** — CI 에서 매일 자동 재실행, tier/methods/cell 수로 결과 비교
- **인과 표현 가드 권고→거부 모드 승격** — 1주 운영 false positive 비율 측정 후 결정
- **`learnings.md` 사용자 뷰/편집 UI** — 현재 백엔드만, 프론트 노출 없음
- **Findings confidence 카드 UI** — 채팅 영역에 등급 시각화
- **에러 분류 LLM judge 교체** — 현재 휴리스틱, Snowflake 메시지 변경에 약함
- **PSM/DiD/IV** — 현재 compare_groups 는 단순 평균차. 정식 인과 식별 전략은 v0.6 범위
