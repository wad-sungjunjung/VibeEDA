# Vibe EDA — 시니어 분석가 에이전트 플랜

> 현재 에이전트(미드 레벨)를 **탐색·분석·예측·인과추론·ML·커뮤니케이션** 6축 모두 시니어 수준으로 끌어올리기 위한 통합 설계. 단순/복잡 요청을 구분해 **정도에 맞는 시간·노력**을 쓰는 것까지 포함.

**관련 문서**
- 현재 파이프라인: `docs/vibe-eda-agent-pipeline.md`
- 에이전트 명세: `docs/vibe-eda-agent-spec.md`
- 리포팅 파이프라인: `docs/vibe-eda-reporting-pipeline.md`

---

## 1. 현황 진단

| 축 | 현재 수준 | 한 줄 평가 |
|---|---|---|
| 탐색 (Explore) | **시니어** ✅ | explore-before-query, 카테고리 prefetch, query_data 스크래치 — 가드와 도구가 단단함 |
| 분석 (Analyze) | **미드** 🟡 | 메모·sanity·baseline 골격은 있으나 *형식*만 강제, 통계적 엄밀성은 없음 |
| 예측 (Predict) | **주니어** ❌ | 시계열·신뢰구간·이상치 진단 도구 전무 |
| 인과추론 (Causal) | **거의 없음** ❌ | Simpson's paradox 리마인더만 존재 |
| 머신러닝 (ML) | **거의 없음** ❌ | 모델이 매번 sklearn 직접 코딩, 데이터 누수 방지 가드 없음 |
| 커뮤니케이션 | **약함** 🟡 | Reporting 파이프라인은 있으나 에이전트가 그걸 의식하며 분석하지 않음 |
| 복잡도 인지 | **없음** ❌ | "총 매출" 한 줄에도 풀 가드가 적용됨 |

---

## 2. 최종 아키텍처

**3-Tier × 4-Phase × 7-Method** 통합 시스템.

```
[사용자 요청]
   │
   ▼ ┌─ Phase -1: 복잡도 분류 ─────────────────────────────┐
     │  휴리스틱 → 애매하면 Haiku 분류기                    │
     │  output: tier ∈ {L1, L2, L3}, budget, 추정 시간     │
     │  SSE: tier_classified (프론트 즉시 노출 + override)  │
     └─────────────────────────────────────────────────────┘
   │
   ▼ ┌─ Phase 0: 메서드 라우팅 (L2/L3 만) ──────────────────┐
     │  select_methods(primary, secondary[], rationale)     │
     │  output: methods ⊂ {explore, analyze, predict,       │
     │                     causal, ml, ab_test, benchmark}  │
     │  → 시스템 프롬프트 fragment 동적 로드 (토큰 절약)     │
     └─────────────────────────────────────────────────────┘
   │
   ▼ ┌─ Phase 1: 메서드 인식 플래닝 (L2/L3) ────────────────┐
     │  메서드별 템플릿:                                    │
     │   explore  → 가설 + 분해 차원                        │
     │   predict  → target/features/split/baseline_metric   │
     │   causal   → outcome/treatment/confounders/strategy  │
     │   ml       → task/model/CV/eval_metric               │
     │   ab_test  → groups/MDE/power                        │
     │  누락 필드 있으면 거부 (구조적 완전성 강제)            │
     └─────────────────────────────────────────────────────┘
   │
   ▼ ┌─ Phase 2: 실행 + 메서드별 가드 ──────────────────────┐
     │  기존 5중 가드 (plan/explore/memo/chart/repeat)       │
     │  + 메서드별 동적 가드:                                │
     │    predict: 시간 누수 / forecast 신뢰구간 강제         │
     │    ml:      baseline-first / train-test 분리 / 누수   │
     │    causal:  교란 미선언 거부 / 인과 표현 가드          │
     │    ab_test: 검정력 < 0.8 경고                         │
     │  iterative — Phase 1 으로 회귀해 replan 가능           │
     └─────────────────────────────────────────────────────┘
   │
   ▼ ┌─ Phase 3: 종합 정리 ─────────────────────────────────┐
     │  self_consistency_check (1회 한정 — 모순만)           │
     │  rate_findings (high/mid/low + reason)                │
     │  synthesize_report(audience='exec'|'ds'|'pm')         │
     │  L1 은 답변 텍스트만, L2 는 Markdown 1장,             │
     │  L3 은 청자별 풀 요약 + 한계·재현 정보                 │
     └─────────────────────────────────────────────────────┘
   │
   ▼ complete
```

---

## 3. 3-Tier × 4-Phase 매트릭스

| | L1 Quick | L2 Standard | L3 Deep |
|---|---|---|---|
| 트리거 예시 | "총 매출", "row 수" | "지역별 매출 분석" | "종합 분석 + 예측 + 임원 보고용" |
| Phase -1 분류 | 휴리스틱 즉시 확정 | 보통 휴리스틱, 애매하면 Haiku | 휴리스틱 또는 Haiku |
| Phase 0 라우팅 | **스킵** (자동 `analyze`) | 1줄 메서드 선택 | 풀 라우팅 (다중 메서드) |
| Phase 1 플래닝 | **스킵** | 가설 3개 (간이) | 메서드별 풀 템플릿 |
| Phase 2 가드 | explore-before-query만 | 기본 + 1~2 메서드 가드 | 풀 가드 |
| Phase 3 종합 | **스킵** (답변만) | Markdown 1장 + confidence | 청자별 풀 + 자기검증 + 한계 |
| 메모 강제 | **약화** (1줄 OK) | 표준 (2~5줄) | 표준 |
| **예산 (turns/tools)** | **5 / 10** | **25 / 60** | **80 / 200** |
| 예상 시간 | ~30초 | 2~5분 | 10~20분 |

---

## 4. 메서드 카탈로그

### 4.1 라우팅 신호와 게이트

| 메서드 | 라우팅 신호 (사용자 요청) | 핵심 신규 도구 | 핵심 가드 |
|---|---|---|---|
| `explore` | "탐색", "분포", "어떻게 생겼나" | (기존) profile/preview/analyze_output | (기존) explore-before-query |
| `analyze` | "비교", "왜", "원인" (관찰) | (기존) analyze_output, query_data | (기존) baseline·sanity |
| `predict` | "예측", "추세", "다음 달" | `fit_trend`, `forecast`, `detect_anomalies` | 시간 누수, 신뢰구간 출력 강제 |
| `causal` | "효과", "영향", "차이" + 처치 | `compare_groups`, `confounders_check`, `power_analysis` | 교란 미선언 거부, 인과 표현 가드 |
| `ml` | "분류", "모델", 피처/타겟 명시 | `fit_model`, `evaluate_model`, `feature_importance` | 데이터 누수, baseline-first |
| `ab_test` | "A/B", "실험", 처치/대조 | `power_analysis`, `compare_groups` | 검정력 < 0.8 경고 |
| `benchmark` | "기준", "동종", "지난 분기 대비" | (기존) analyze_output 확장 | baseline 명시 |

### 4.2 신규 Phase 도구

| Phase | 도구 | 설명 |
|---|---|---|
| -1 | (자동) | classify_complexity — 코드 내부 (도구 X) |
| 0 | `select_methods(primary, secondary[], rationale, expected_artifacts[])` | 첫 turn 강제 호출 |
| 3 | `self_consistency_check()` | 메모/플랜 재독, 모순 검출 (세션당 1회) |
| 3 | `rate_findings(findings[])` | 각 결론에 confidence 등급 부여 |
| 3 | `synthesize_report(audience)` | 청자별 최종 요약 셀 생성 |

---

## 5. 데이터 모델 변경

### 5.1 NotebookState 확장
```python
@dataclass
class NotebookState:
    # ... 기존 ...
    # Phase -1
    budget: BudgetState           # tier, max_turns, max_tool_calls, started_at
    # Phase 0
    methods: list[str]
    method_rationale: str
    expected_artifacts: list[str]
    # Phase 3
    findings: list[dict]          # {claim, evidence_cell_ids, confidence, caveats}
    synthesis_done: bool
    consistency_checked: bool     # 세션 1회 한정
```

### 5.2 셀 메타 확장
```python
metadata.vibe_method: 'explore' | 'analyze' | 'predict' | 'causal' | 'ml' | 'ab_test'
metadata.vibe_confidence: 'high' | 'mid' | 'low'
```

### 5.3 SSE 이벤트 추가
- `tier_classified`: tier, reason, estimated_cells, estimated_seconds, methods[]
- `methods_selected`: methods[], rationale
- `phase_transition`: from, to, reason
- `budget_warning`: percent_used, remaining_turns
- `synthesis_started`, `consistency_check`, `findings_rated`

### 5.4 AgentRequest 확장
```python
class AgentRequest(BaseModel):
    # ... 기존 ...
    tier_override: Literal['L1', 'L2', 'L3'] | None = None
    methods_override: list[str] | None = None  # 사용자가 직접 메서드 지정 시
```

---

## 6. 리스크 & 극복 방안

### 6.1 모델 행동 리스크

| # | 리스크 | 시나리오 | 극복 방안 |
|---|---|---|---|
| A1 | **MAX_TURNS 부족** | L3 다중 메서드는 80턴도 빠듯 | tier 별 동적 예산 + 80% soft warning 시 강제 Phase 3 진입 + Gemini 도 컨텍스트 압축 적용 |
| A2 | **시스템 프롬프트 비대화** | 6 메서드 × fragment = 토큰 폭발 | Phase 0 결과로 fragment **동적 로드**. 미선택 메서드 fragment 미주입. 도구도 미사용 메서드는 tools 배열에서 제외 |
| A3 | **가드 인플레이션 / 무한 루프** | plan/explore/memo/chart/repeat + 메서드별 4종 = 9개 가드 충돌 | 메서드별 가드는 **선택된 메서드에서만 활성**. `pending_guard_count < 3` 상한 유지. 가드 우선순위 표 명시 (plan > explore > memo > chart > 메서드별) |
| A4 | **자기 일관성 체크 무한 루프** | Phase 3 가 매번 모순 지적 → 종료 못 함 | 세션당 **1회 한정** + 명백한 모순(같은 수치 다르게 인용)만 잡고 해석 차이 허용 |
| A5 | **인과 표현 false positive** | "기인", "때문" 단어 자동 감지 시 일상 표현도 거부 | 가드 단계: (a) **권고 모드**부터 시작 → (b) 1주일 운영 데이터로 false positive 비율 측정 → (c) <10% 면 거부 모드 승격 |
| A6 | **Tier 오분류** | L3 요청을 L1 으로 분류 → 부실 답변 | (a) 휴리스틱 **상향 편향**, (b) **자동 승격**: L1 인데 셀 5+ 만들어지면 L2 로, L2 인데 turn 20+ 면 L3 로, (c) 프론트 override 버튼 즉시 가능 |

### 6.2 시스템/인프라 리스크

| # | 리스크 | 시나리오 | 극복 방안 |
|---|---|---|---|
| B1 | **Kaleido 차트 PNG 실패** | Windows chromium hang → LLM 이 차트 못 봄 | 이미 30s timeout + None 폴백 존재. 차후 matplotlib fallback 렌더러 추가 |
| B2 | **Claude/Gemini 비대칭** | Gemini 는 캐싱·압축 미지원 | Gemini 도 `_compact_messages_inplace` 적용. Phase 0 결과 기반 도구 풀 축소가 Gemini 에서도 효과 큼 |
| B3 | **세션 메모리 휘발** | `explored_marts`, `findings`, `skill_ctx` 가 프로세스 메모리 | (a) 세션 단위는 그대로 두되 **노트북별 `learnings.md` 로 누적 finding 영속화**, (b) 다음 세션 시작 시 시스템 프롬프트에 자동 주입 |
| B4 | **Haiku 분류기 비용/지연** | 모든 애매한 요청에 +1초 +$0.001 | (a) 휴리스틱 커버리지 70%↑ 목표, (b) 같은 노트북 내 유사 요청 결과 캐싱, (c) 휴리스틱이 강한 신호(글자수<20 + 단순 키워드)면 Haiku 스킵 |
| B5 | **컨텍스트 압축 거칢** | 600자 prefix 컷 → 핵심 수치 손실 | LLM 요약 기반 압축으로 단계적 교체 (Haiku 로 압축 — 비용 < 압축 안 한 비용) |
| B6 | **run_in_executor cancel 불가** | timeout 후에도 백그라운드 thread 점유 | 진짜 강제 종료는 프로세스 재시작. 차선: thread pool 사이즈 제한, executor 재생성 주기화 |

### 6.3 UX 리스크

| # | 리스크 | 시나리오 | 극복 방안 |
|---|---|---|---|
| C1 | **사용자 기대 미스매치** | "L1 로 분류돼 답변 짧음 → 실망" | (a) tier 분류 결과 **즉시 노출** (예상 시간 + 셀 수), (b) **override 버튼** ("더 깊게" / "간단히"), (c) 답변 끝에 "더 깊게 보고 싶으면" 후속 제안 한 줄 |
| C2 | **메서드 라우팅 오해** | "예측해줘" → predict ML 인지 단순 추세인지 모호 | Phase 0 에서 **모호하면 자동 ask_user**. select_methods 호출 직전 confidence 체크: 휴리스틱+분류기 둘 다 약하면 사용자 확인 |
| C3 | **L3 분석이 너무 길어 사용자가 이탈** | 15분 진행되는 동안 무엇 보고 있는지 모름 | 이미 `exec_heartbeat` 존재. 추가로 Phase 전환 시 SSE `phase_transition` 이벤트 + 프론트가 progress stepper 표시 |
| C4 | **종합 정리가 청자 부적절** | exec 요청에 ds 형식 출력 | synthesize_report 호출 시 `audience` 강제 + 사용자에게 한 줄 확인 ("임원/DS/PM 누구를 위한 정리인가요?") — L3 만 |
| C5 | **finding confidence 등급 신뢰성** | high/mid/low 가 자의적 | 룰 기반 보강: "표본 < 30 → low 자동", "관찰 데이터 + 인과 주장 → low 강제", "단일 셀 근거 → mid 상한" |

### 6.4 운영/유지보수 리스크

| # | 리스크 | 극복 방안 |
|---|---|---|
| D1 | **단위 테스트 부족** — 가드가 9개 넘어가면 회귀 검증이 수기로 불가능 | 메서드별 시나리오 골든 노트북 5~10개 + CI 에서 매일 1회 자동 재실행, 셀 개수·메서드·confidence 등급으로 결과 비교 |
| D2 | **에러 분류 휴리스틱이 약함** | LLM judge 로 점진 교체 (Haiku 1회 호출 — Snowflake 에러 메시지 변경에도 강건) |
| D3 | **문서가 코드를 못 따라감** | 도구 정의를 단일 소스 (`agent_tools.py`) 에서 docstring + 메서드 카탈로그 자동 추출 |

---

## 7. 구현 로드맵

총 **7 단계** — 각 단계 끝에 회귀 테스트 통과 확인.

| 단계 | 범위 | 예상 기간 | 위험도 | 검증 |
|---|---|---|---|---|
| **S1** | Phase -1 복잡도 분류 + 예산 시스템 + 자동 승격 + 프론트 tier UI | 1주 | 낮음 | L1/L2/L3 각 5개 시나리오 정상 분류 |
| **S2** | Phase 0 라우팅 + 메서드별 fragment 동적 로드 | 1주 | 낮음 | 메서드 6종 라우팅 정확도 ≥ 80% |
| **S3** | Phase 3 종합 정리 (self_consistency / rate_findings / synthesize_report) | 1.5주 | 중 | tier 별 결과물 형태 다른지 + 청자별 차이 확인 |
| **S4** | ML 도구 + 가드 (fit_model / evaluate / feature_importance) | 2주 | 중 | 기본 분류·회귀 시나리오 + 데이터 누수 케이스 거부 확인 |
| **S5** | 인과추론 도구 + 가드 (compare_groups / confounders / power) | 2주 | 높음 | 권고 모드 1주 운영 후 거부 모드 결정 |
| **S6** | 예측/시계열 도구 (fit_trend / forecast / anomalies) | 1.5주 | 중 | 신뢰구간 강제 + 시간 누수 가드 검증 |
| **S7** | 기존 플래닝/메모/sanity 가드 메서드 분기 + Gemini 컨텍스트 압축 + learnings.md 누적 | 1.5주 | 중 | L3 풀 사이클 시나리오 5개 통과 |

**총 ~10.5주** (~2.5개월). S1+S2+S3 로 **뼈대만 먼저** 완성하면 (~3.5주) 이후 메서드 도구는 plug-in 방식으로 차례차례 추가 가능 — 즉 **3.5주 시점에 첫 시니어 에이전트 v0.5** 가 나옴.

---

## 8. 성공 지표

운영 후 측정할 KPI:
- **Tier 분류 정확도**: 사용자 override 비율 < 15%
- **메서드 라우팅 정확도**: Phase 0 결과를 사용자가 수정한 비율 < 20%
- **가드 false positive**: 가드 거부 후 사용자가 우회 요청한 비율 < 10% (특히 인과 가드)
- **세션 완료율**: hard stop 으로 절단된 세션 < 5%
- **종합 정리 채택률**: Phase 3 산출물을 사용자가 그대로 리포트로 발행한 비율 > 50%
- **재요청 감소**: "더 깊게 분석해줘" 같은 후속 요청 비율 (tier 오분류 시그널)

---

## 9. S1 즉시 다음 액션

1. **타입 정의** (`backend/app/services/agent_budget.py` 신설):
   - `Tier = Literal['L1', 'L2', 'L3']`
   - `BudgetState` dataclass (tier, max_turns, max_tool_calls, soft_warning_at, hard_stop_at, started_at)
   - `TIER_BUDGETS: dict[Tier, BudgetState]` 상수

2. **휴리스틱 분류기**:
   - `classify_complexity_heuristic(message, mart_count, has_image, history_depth) -> Tier | None`
   - 강한 시그널이면 확정, 애매하면 None 반환 (LLM fallback 으로)

3. **SSE 이벤트** (`agent_events.py`):
   - `TierClassifiedEvent`, `BudgetWarningEvent`, `PhaseTransitionEvent` 추가
   - 프론트 `AgentEvent` union 동기화

4. **agent.py 통합**:
   - `MAX_TURNS=50`, `TOTAL_TOOL_LIMIT=200` 하드코딩 제거 → `state.budget` 사용
   - `_is_trivial_request` 휴리스틱 → 분류기로 흡수
   - `AgentRequest` 에 `tier_override`, `methods_override` 추가

5. **프론트 UI**:
   - `AgentChatPanel` 에 tier chip 추가 (분류 결과 + 예상 시간)
   - override 버튼 ("더 깊게" / "간단히")
   - progress display (남은 예산 %)

6. **Haiku fallback**:
   - 휴리스틱이 None 일 때만 호출
   - 같은 노트북 내 유사 요청 캐싱 (in-memory dict)

---

## 10. 단계별 의존성 그래프

```
S1 (예산/Tier) ──┬── S2 (라우팅)  ──┬── S4 (ML)
                │                  ├── S5 (인과)  
                │                  └── S6 (예측)
                └── S3 (종합 정리) ──┘
                                    │
                            S7 (메서드별 가드 분기)
```

- S1 은 모든 단계의 전제 (예산 없으면 다른 단계 무한 루프 위험)
- S2/S3 는 병렬 진행 가능
- S4/S5/S6 는 S2 후 병렬 (서로 독립적인 메서드)
- S7 은 마지막 통합 단계
