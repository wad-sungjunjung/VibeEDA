"""에이전트 메서드 카탈로그 + 라우팅 인프라.

각 메서드는 이후 단계 (S4~S6) 에서 자체 도구·가드·프롬프트 fragment 를 추가한다.
S2 단계에선 **카탈로그 정의 + 라우팅 자체** 만 담당.

메서드 키:
  explore   — 탐색·분포·기본 통계 (현재 핵심 기능, 항상 포함)
  analyze   — 비교·관찰형 분석 (현재 분석 기능)
  predict   — 시계열 예측·추세·이상치 (S6 에서 도구 추가)
  causal    — 인과추론·교란 통제·실험 분석 (S5 에서 도구 추가)
  ml        — 분류/회귀 학습·평가·feature importance (S4 에서 도구 추가)
  ab_test   — A/B 검정력·집단 비교 (S5 와 부분 공유)
  benchmark — 기준 대비 (전기·평균·세그먼트). 별도 도구 X — analyze 의 변종.

설계 원칙:
- 모든 메서드 fragment 는 plain string. 시스템 프롬프트에 동적 append.
- 메서드 미선택(L1, 또는 select_methods 호출 전) 상태에서는 fragment 없음.
- 프롬프트가 비대해지지 않도록 fragment 는 30~50줄 이내로 제한 (S4+ 에서 채울 때).
- 메서드 의존도구(예: ml 의 fit_model) 는 S4+ 에서 메서드 선택 시 동적 로드.
"""
from __future__ import annotations

from typing import Literal

Method = Literal["explore", "analyze", "predict", "causal", "ml", "ab_test", "benchmark"]

ALL_METHODS: tuple[str, ...] = (
    "explore", "analyze", "predict", "causal", "ml", "ab_test", "benchmark",
)


# ─── 메서드별 시스템 프롬프트 fragment (S4~S6 에서 본격 채움) ───────────────────
# 각 fragment 는 "이 메서드를 쓰는 분석가는 이렇게 행동해야 한다" 를 한 단락 또는
# 짧은 체크리스트로 정의. 너무 두꺼워지면 토큰 폭발 → 30~50줄 상한.

_FRAGMENT_EXPLORE = """
### 탐색 (Explore) 모드
이 분석에서는 *데이터 구조 파악* 이 우선이다. 가설을 세우기 전에:
- 모든 선택 마트에 `profile_mart` 를 한 턴에 병렬로 호출
- 결과를 보고 NULL/카디널리티/수치 분포에서 이상한 점 1~2개를 메모로 기록
- WHERE 절 후보 컬럼은 `get_category_values` 로 실제 값 확인 (추측 금지)
- 플랜 작성 시 `exploration_plan` (marts_to_profile, checks) 채우면 체크리스트가 플랜 셀에 표시됨
""".strip()

_FRAGMENT_ANALYZE = """
### 분석 (Analyze) 모드
관찰 데이터에서 패턴·차이·원인 후보를 찾는다. **인과 주장 금지** — 인과는 별도 메서드.
- 비교는 반드시 baseline (전기/평균/다른 세그먼트) 과 함께 제시
- 차이 발견 시 **표본 크기** 부터 확인 — n<30 이면 메모에 "표본 적음" 명시
- 단순 차이를 "원인" 으로 단언하지 말 것 ("X 가 높음" O, "X 때문" X)
""".strip()

_FRAGMENT_PREDICT = """
### 예측 (Predict) 모드 (S6 에서 활성)
시계열·추세·예측 분석. 도구는 S6 에서 추가됨. 현재 단계에선 Python 셀로 직접 처리:
- 학습 데이터의 최대 시점이 예측 대상보다 앞서야 함 (시간 누수 금지)
- 예측에는 반드시 신뢰구간 or 분산 정보 포함
- 메모에 "이 예측의 한계 (외삽 / 계절성 / 충격)" 1줄 명시
- **`create_plan` 호출 시 `forecast_spec` 필수**: time_column, target_metric, train_window, horizon, seasonality
""".strip()

_FRAGMENT_CAUSAL = """
### 인과추론 (Causal) 모드 (S5 에서 본격 활성)
관찰 데이터에서 *효과* 를 추정하려면 교란을 통제해야 한다.
- "처치(treatment)" 와 "결과(outcome)" 변수를 명시
- 교란 후보 (confounders) 를 최소 2개 이상 나열
- 무작위 배정/준실험이 아니면 결론에 "관찰 데이터 — 인과 약함" 표시
- 도구: S5 에서 compare_groups, confounders_check, power_analysis 추가
- **`create_plan` 호출 시 `causal_design` 필수**: treatment, outcome, confounders(≥2), assignment
""".strip()

_FRAGMENT_ML = """
### 머신러닝 (ML) 모드 (S4 에서 본격 활성)
모델 학습은 baseline 부터. **데이터 누수 절대 금지**.
- train/test 분리 → train 으로만 fit, test 는 평가에만 사용
- 분류 작업은 클래스 균형 확인 + class_weight 조정 고려
- 단순 정확도만 보지 말 것 — confusion matrix / AUC / 잔차 함께
- 도구: S4 에서 fit_model, evaluate_model, feature_importance 추가
- **`create_plan` 호출 시 `ml_design` 필수**: target, features, task_type, evaluation_metric
""".strip()

_FRAGMENT_AB_TEST = """
### A/B 테스트 (AB Test) 모드 (S5 일부 활성)
처치/대조 집단 비교. 검정력이 핵심.
- 표본 크기와 MDE (minimum detectable effect) 를 먼저 계산
- power < 0.8 이면 결론을 "결정 불가" 로 명시
- 다중 메트릭 비교 시 Bonferroni / FDR 보정 언급
- 도구: S5 의 power_analysis, compare_groups 활용
- **`create_plan` 호출 시 `ab_design` 필수**: control_group, treatment_group, primary_metric, MDE, power, alpha
""".strip()

_FRAGMENT_BENCHMARK = """
### 기준 비교 (Benchmark) 모드
모든 수치를 *어떤 기준* 과 함께 제시한다. 절대값만 나열하면 0점.
- 기준 후보: 전기 / 전체 평균 / 동종 세그먼트 / 목표치 / 시장 평균
- 차이의 의미 (상승률, 표준화 점수, p-value 등) 도 함께
- 메모마다 "기준 = X, 차이 = Y%" 형식 권장
""".strip()


METHOD_FRAGMENTS: dict[str, str] = {
    "explore": _FRAGMENT_EXPLORE,
    "analyze": _FRAGMENT_ANALYZE,
    "predict": _FRAGMENT_PREDICT,
    "causal": _FRAGMENT_CAUSAL,
    "ml": _FRAGMENT_ML,
    "ab_test": _FRAGMENT_AB_TEST,
    "benchmark": _FRAGMENT_BENCHMARK,
}


# ─── 메서드별 플래닝 스키마 ─────────────────────────────────────────────────
# 메서드마다 "플래닝의 본질" 이 다르다.
#   analyze / benchmark → 가설 기반 (관찰 가능한 패턴 추측)
#   explore             → 탐색 체크리스트 (마트 순서, 무엇을 먼저 볼지)
#   predict             → 예측 명세 (시계열 컬럼, 학습 구간, 예측 지평)
#   causal              → 변수 선언 (처치, 결과, 교란 후보)
#   ml                  → 모델 설계 (타깃, 피처, 태스크 타입)
#   ab_test             → 통계 설계 (그룹, 메트릭, MDE, 검정력)
#
# 모든 메서드는 공통 가설 섹션(min 3개) 을 유지하되,
# 메서드별로 추가 필수 필드 (REQUIRED) 와 권장 필드 (OPTIONAL) 를 둔다.
# create_plan 도구는 활성 메서드를 보고 필수 필드 누락 시 거부한다.

# 메서드별 플랜 필수 필드 — 누락 시 create_plan 이 plan_field_missing 으로 거부.
PLAN_REQUIRED_FIELDS: dict[str, list[str]] = {
    "explore": [],            # 탐색은 가설만 강제 (체크리스트는 권장)
    "analyze": [],            # 기본 가설만
    "benchmark": [],          # 기본 가설만 (메모 단계에서 baseline 강제)
    "predict": ["forecast_spec"],
    "causal": ["causal_design"],
    "ml": ["ml_design"],
    "ab_test": ["ab_design"],
}

# 메서드별 플랜 추가 필드 안내 — 모델에게 무엇을 채워야 하는지 1줄 설명.
# create_plan 도구 description 동적 보강 + system prompt 안내에 사용.
PLAN_FIELD_HINTS: dict[str, str] = {
    "exploration_plan": (
        "탐색 체크리스트 — 어떤 마트를 어떤 순서로 profile/preview 할지, "
        "확인해야 할 컬럼 분포·NULL·카디널리티 등."
    ),
    "forecast_spec": (
        "예측 명세 — time_column (시계열 키), target_metric (예측 대상), "
        "train_window (학습 구간), horizon (예측 지평), seasonality (예: 주/월/없음)."
    ),
    "causal_design": (
        "인과 설계 — treatment (처치 변수+값), outcome (결과 지표), "
        "confounders (교란 후보 최소 2개), assignment (관찰/무작위/준실험)."
    ),
    "ml_design": (
        "ML 설계 — target (타깃 컬럼), features (피처 후보), "
        "task_type (classification/regression), evaluation_metric (예: AUC, RMSE)."
    ),
    "ab_design": (
        "A/B 설계 — control_group/treatment_group 정의, primary_metric, "
        "MDE (최소 탐지 효과), expected_power (기본 0.8), alpha (기본 0.05)."
    ),
}


def get_required_plan_fields(methods: list[str]) -> list[str]:
    """선택된 메서드들에 따라 필수 플랜 필드 리스트 반환 (중복 제거).
    예: ['causal', 'predict'] → ['causal_design', 'forecast_spec']
    """
    seen: set[str] = set()
    out: list[str] = []
    for m in methods or []:
        for field in PLAN_REQUIRED_FIELDS.get(m, []):
            if field not in seen:
                seen.add(field)
                out.append(field)
    return out


def build_plan_field_hint_block(methods: list[str]) -> str:
    """선택된 메서드들에 해당하는 플랜 필드 안내 블록 (system prompt 보강용).

    필수 필드만 출력. 빈 문자열이면 추가 안내 없음 (analyze/benchmark/explore 단독 등).
    """
    required = get_required_plan_fields(methods)
    if not required:
        return ""
    lines = ["", "### 플랜 추가 필수 필드 (이번 메서드 조합)"]
    for field in required:
        hint = PLAN_FIELD_HINTS.get(field)
        if hint:
            lines.append(f"- `{field}`: {hint}")
    lines.append("`create_plan` 호출 시 위 필드를 hypotheses 와 함께 반드시 채우세요.")
    return "\n".join(lines)


# 메서드 사용자-친화 라벨 (프론트 칩 표시용)
METHOD_LABELS_KO: dict[str, str] = {
    "explore": "탐색",
    "analyze": "분석",
    "predict": "예측",
    "causal": "인과추론",
    "ml": "ML",
    "ab_test": "A/B",
    "benchmark": "기준비교",
}


def normalize_methods(methods: list[str] | None) -> list[str]:
    """모델이 잘못된 키를 보내거나 중복을 보낼 수 있어 정규화.

    - 미지의 키는 무시 (로깅은 호출자 책임)
    - 중복 제거하되 순서 보존
    - 빈 리스트면 ['analyze'] 폴백 (가장 보편적)
    """
    if not methods:
        return ["analyze"]
    seen: set[str] = set()
    out: list[str] = []
    for m in methods:
        m = (m or "").strip().lower()
        if m in ALL_METHODS and m not in seen:
            seen.add(m)
            out.append(m)
    return out or ["analyze"]


def build_methods_fragment(methods: list[str]) -> str:
    """선택된 메서드들의 fragment 를 한 블록으로 병합.

    Returns 빈 문자열이면 fragment 없음 (메서드 미선택 / 모두 무효).
    """
    parts: list[str] = []
    for m in methods:
        frag = METHOD_FRAGMENTS.get(m)
        if frag:
            parts.append(frag)
    if not parts:
        return ""
    return "\n\n## 🧭 선택된 분석 메서드\n\n" + "\n\n".join(parts) + "\n"


# ─── select_methods 도구 정의 ────────────────────────────────────────────────
# Phase 0 의 핵심 도구. 첫 turn 에 호출되도록 pre-guard 로 강제.

SELECT_METHODS_TOOL_CLAUDE: dict = {
    "name": "select_methods",
    "description": (
        "Choose the analytical methods needed for this request. "
        "MUST be called as the FIRST tool in the session (Phase 0). "
        "After calling, proceed normally — the chosen methods unlock relevant prompts and tools.\n\n"
        "Method keys (pick 1~3 — primary required, secondary optional):\n"
        "  explore   — exploration / distribution / data hygiene (default starting point)\n"
        "  analyze   — observational comparison / pattern finding (no causal claims)\n"
        "  predict   — time-series forecasting / trend / anomaly detection\n"
        "  causal    — causal inference / treatment effect / confounder control\n"
        "  ml        — supervised model fit / evaluate / feature importance\n"
        "  ab_test   — A/B test power analysis / group comparison\n"
        "  benchmark — relative comparison vs reference (period/avg/segment)\n\n"
        "Pick `analyze` if unsure — it's the safest default. "
        "Combine 2~3 methods only if the request genuinely requires them "
        "(e.g. '분석하고 예측' = analyze+predict)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "primary": {
                "type": "string",
                "enum": list(ALL_METHODS),
                "description": "주(主) 메서드 — 가장 비중이 큰 분석 방법",
            },
            "secondary": {
                "type": "array",
                "items": {"type": "string", "enum": list(ALL_METHODS)},
                "description": "보조 메서드 (0~2개). primary 와 중복 금지.",
            },
            "rationale": {
                "type": "string",
                "description": "왜 이 메서드 조합을 골랐는지 1문장 한국어",
            },
            "expected_artifacts": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "이 분석이 끝났을 때 생성될 산출물 키 (선택). "
                    "예: 'forecast_chart', 'model_card', 'exec_summary', 'baseline_table'"
                ),
            },
        },
        "required": ["primary", "rationale"],
    },
}

# Gemini 는 enum 미지원이 잦아 STRING 으로 풀어서 description 에 명시.
SELECT_METHODS_TOOL_GEMINI: dict = {
    "name": "select_methods",
    "description": SELECT_METHODS_TOOL_CLAUDE["description"],
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "primary": {"type": "STRING"},
            "secondary": {"type": "ARRAY", "items": {"type": "STRING"}},
            "rationale": {"type": "STRING"},
            "expected_artifacts": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["primary", "rationale"],
    },
}


# pre-guard / handler 가 인식할 도구 이름.
PHASE0_TOOL_NAMES = {"select_methods"}
