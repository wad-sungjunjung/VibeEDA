"""인과추론 도구 (Phase 2 메서드별 — `causal` 메서드 활성 시 사용).

3개 도구:
  compare_groups       — 처치/대조 집단 평균/효과 + t-test (PSM 은 향후)
  confounders_check    — 잠재 교란변수 후보 컬럼들의 분포 차이 진단
  power_analysis       — 표본 크기 + MDE + 검정력 계산

주의:
  - 이 도구들은 통계적 *추정* 만 한다. "X 가 Y 의 원인" 류 인과 결론은 모델이 메모에 직접 쓰되
    confidence 룰이 자동으로 보수화한다.
  - PSM/DiD/IV 같은 정식 인과 식별 전략은 v0.5 범위 밖 — 차후 업그레이드.

설계 원칙:
- 처치/대조는 사용자가 명시한 컬럼 + 값으로 정의
- 모든 결과에 표본 크기 + 신뢰구간 포함 (effect size 만 보지 말 것)
- 결과 dict 에 'caveats' 자동 첨부 (관찰 데이터 여부 등)
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


# ─── Tool specs ───────────────────────────────────────────────────────────────

COMPARE_GROUPS_TOOL_CLAUDE: dict = {
    "name": "compare_groups",
    "description": (
        "Compare a numeric outcome between two groups (treated vs control) on a DataFrame. "
        "Phase 2 method-specific — only call when `causal` or `ab_test` method was selected. "
        "Returns: per-group n/mean/std, mean diff, 95% CI of diff (Welch's t), p-value, "
        "effect size (Cohen's d), and a 'caveats' note about observational vs experimental data.\n\n"
        "If the groups have very different sizes (>5x) or sample is small (<30 per group), "
        "warns about unreliable estimates."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "data_cell_id": {"type": "string", "description": "DataFrame 셀 id"},
            "outcome": {"type": "string", "description": "수치 outcome 컬럼명"},
            "treatment_column": {"type": "string", "description": "처치/대조를 구분하는 컬럼명"},
            "treated_value": {"description": "treatment_column 에서 '처치' 그룹을 정의하는 값"},
            "control_value": {"description": "treatment_column 에서 '대조' 그룹을 정의하는 값"},
        },
        "required": ["data_cell_id", "outcome", "treatment_column", "treated_value", "control_value"],
    },
}


CONFOUNDERS_CHECK_TOOL_CLAUDE: dict = {
    "name": "confounders_check",
    "description": (
        "Check whether candidate confounder columns differ between treated and control groups. "
        "If a confounder candidate has very different distributions, the simple comparison from "
        "compare_groups is biased — flag it. Phase 2 method-specific (causal). \n\n"
        "Returns per-candidate: mean/proportion in each group, standardized mean difference (SMD). "
        "SMD > 0.2 typically indicates imbalance."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "data_cell_id": {"type": "string"},
            "treatment_column": {"type": "string"},
            "treated_value": {},
            "control_value": {},
            "candidates": {
                "type": "array",
                "items": {"type": "string"},
                "description": "잠재 교란변수 후보 컬럼들",
            },
        },
        "required": ["data_cell_id", "treatment_column", "treated_value", "control_value", "candidates"],
    },
}


POWER_ANALYSIS_TOOL_CLAUDE: dict = {
    "name": "power_analysis",
    "description": (
        "Compute the minimum detectable effect (MDE) for a 2-sample comparison given current sample sizes, "
        "or compute required sample size given a target effect size. Use to gauge whether a result "
        "is statistically meaningful. Phase 2 method-specific (causal / ab_test).\n\n"
        "Two modes:\n"
        "- Provide n1/n2 + alpha/power → returns MDE (minimum detectable effect, in units of stdev)\n"
        "- Provide effect_size + alpha/power → returns required n per group\n"
        "Default alpha=0.05, power=0.8."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "n1": {"type": "integer", "description": "그룹1 표본수 (mode 1)"},
            "n2": {"type": "integer", "description": "그룹2 표본수 (mode 1)"},
            "effect_size": {"type": "number", "description": "효과 크기 Cohen's d (mode 2)"},
            "alpha": {"type": "number", "description": "유의수준 (기본 0.05)"},
            "power": {"type": "number", "description": "원하는 검정력 (기본 0.8)"},
        },
        "required": [],
    },
}


def _to_gemini(t: dict) -> dict:
    out = {"name": t["name"], "description": t["description"]}
    schema = t["input_schema"]
    props_g: dict = {}
    for k, v in (schema.get("properties") or {}).items():
        if "type" in v:
            v2 = {"type": v.get("type", "string").upper()}
            if v.get("type") == "array":
                v2["items"] = {"type": (v.get("items") or {}).get("type", "string").upper()}
            if "description" in v:
                v2["description"] = v["description"]
            props_g[k] = v2
        else:
            # 자유 타입(스칼라) 값 — Gemini 에서는 STRING 으로 받기
            props_g[k] = {"type": "STRING"}
            if "description" in v:
                props_g[k]["description"] = v["description"]
    out["parameters"] = {
        "type": "OBJECT",
        "properties": props_g,
        "required": schema.get("required", []),
    }
    return out


CAUSAL_TOOLS_CLAUDE = [
    COMPARE_GROUPS_TOOL_CLAUDE,
    CONFOUNDERS_CHECK_TOOL_CLAUDE,
    POWER_ANALYSIS_TOOL_CLAUDE,
]
CAUSAL_TOOLS_GEMINI = [_to_gemini(t) for t in CAUSAL_TOOLS_CLAUDE]
CAUSAL_TOOL_NAMES = {"compare_groups", "confounders_check", "power_analysis"}


# ─── 핸들러 구현 ──────────────────────────────────────────────────────────────


def _coerce_match(series, value):
    """Series 에서 value 와 일치하는 mask 반환 — 타입 자동 변환."""
    try:
        # 직접 비교
        m = series == value
        if m.any():
            return m
    except Exception:
        pass
    # 문자열로 변환 후 비교
    return series.astype(str) == str(value)


def _get_dataframe(state, cell_id: str):
    cell = next((c for c in state.cells if c.id == cell_id), None)
    if not cell:
        return None, "cell_not_found"
    if not cell.executed:
        return None, "cell_not_executed"
    try:
        from .kernel import get_namespace
        ns = get_namespace(state.notebook_id)
        df = ns.get(cell.name)
        if df is None or not hasattr(df, "columns"):
            return None, "dataframe_missing"
        return df, None
    except Exception as e:
        return None, f"kernel_error: {e}"


def handle_compare_groups(inp: dict, state) -> tuple[dict, list[dict]]:
    df, err = _get_dataframe(state, inp.get("data_cell_id", ""))
    if err:
        return {"success": False, "error": err}, []
    outcome = (inp.get("outcome") or "").strip()
    treat_col = (inp.get("treatment_column") or "").strip()
    treated_value = inp.get("treated_value")
    control_value = inp.get("control_value")

    if outcome not in df.columns:
        return {"success": False, "error": "outcome_not_in_df"}, []
    if treat_col not in df.columns:
        return {"success": False, "error": "treatment_column_not_in_df"}, []

    try:
        import pandas as pd
        import numpy as np
        from scipy import stats

        treated_mask = _coerce_match(df[treat_col], treated_value)
        control_mask = _coerce_match(df[treat_col], control_value)
        y_t = pd.to_numeric(df.loc[treated_mask, outcome], errors="coerce").dropna()
        y_c = pd.to_numeric(df.loc[control_mask, outcome], errors="coerce").dropna()

        n_t, n_c = len(y_t), len(y_c)
        if n_t < 5 or n_c < 5:
            return {
                "success": False,
                "error": "groups_too_small",
                "message": f"treated n={n_t}, control n={n_c} — 비교가 무의미합니다 (≥30 권장).",
            }, []

        mean_t = float(y_t.mean())
        mean_c = float(y_c.mean())
        std_t = float(y_t.std(ddof=1))
        std_c = float(y_c.std(ddof=1))
        diff = mean_t - mean_c

        # Welch's t-test
        t_stat, p_val = stats.ttest_ind(y_t, y_c, equal_var=False)
        # SE of diff
        se = float(np.sqrt(std_t**2 / n_t + std_c**2 / n_c))
        # df Welch
        df_w_num = (std_t**2 / n_t + std_c**2 / n_c) ** 2
        df_w_den = (std_t**2 / n_t)**2 / max(n_t - 1, 1) + (std_c**2 / n_c)**2 / max(n_c - 1, 1)
        df_w = df_w_num / df_w_den if df_w_den > 0 else (n_t + n_c - 2)
        crit = float(stats.t.ppf(0.975, df_w))
        ci = (diff - crit * se, diff + crit * se)

        # Cohen's d (pooled)
        pooled_var = ((n_t - 1) * std_t**2 + (n_c - 1) * std_c**2) / max(n_t + n_c - 2, 1)
        cohens_d = float(diff / np.sqrt(pooled_var)) if pooled_var > 0 else None

        warnings: list[str] = []
        if n_t < 30 or n_c < 30:
            warnings.append(f"표본 크기가 작음 (treated={n_t}, control={n_c}) — 결과 신뢰도 낮음.")
        if max(n_t, n_c) / max(min(n_t, n_c), 1) > 5:
            warnings.append(f"그룹 크기 불균형 ({n_t} vs {n_c}, ≥5배) — 비교 편향 가능.")
        if abs(cohens_d or 0) > 0 and abs(cohens_d) < 0.2 and p_val < 0.05:
            warnings.append("p-value 는 작지만 effect size 가 미미함 — 실용적 의미는 작을 수 있음.")

        return {
            "success": True,
            "outcome": outcome,
            "treatment_column": treat_col,
            "treated": {
                "value": str(treated_value), "n": n_t,
                "mean": round(mean_t, 4), "std": round(std_t, 4),
            },
            "control": {
                "value": str(control_value), "n": n_c,
                "mean": round(mean_c, 4), "std": round(std_c, 4),
            },
            "diff": round(diff, 4),
            "diff_ci_95": [round(ci[0], 4), round(ci[1], 4)],
            "p_value": round(float(p_val), 6),
            "cohens_d": round(cohens_d, 4) if cohens_d is not None else None,
            "warnings": warnings,
            "caveats": (
                "관찰 데이터인 경우 이 차이는 인과 효과가 아닐 수 있음 (교란변수). "
                "confounders_check 로 잠재 교란을 진단하세요."
            ),
            "instruction": (
                "메모에 (1) 평균 차이 + 95% CI 인용 (절대값만이 아니라), (2) p-value 와 effect size 둘 다, "
                "(3) 관찰 데이터 한계 — 셋을 함께 적으세요."
            ),
        }, []
    except Exception as e:
        logger.exception("compare_groups failed")
        return {"success": False, "error": "compare_failed", "message": str(e)}, []


def handle_confounders_check(inp: dict, state) -> tuple[dict, list[dict]]:
    df, err = _get_dataframe(state, inp.get("data_cell_id", ""))
    if err:
        return {"success": False, "error": err}, []
    treat_col = (inp.get("treatment_column") or "").strip()
    treated_value = inp.get("treated_value")
    control_value = inp.get("control_value")
    candidates = inp.get("candidates") or []
    if not candidates or not isinstance(candidates, list):
        return {"success": False, "error": "candidates_required"}, []
    if treat_col not in df.columns:
        return {"success": False, "error": "treatment_column_not_in_df"}, []

    try:
        import pandas as pd
        import numpy as np

        tmask = _coerce_match(df[treat_col], treated_value)
        cmask = _coerce_match(df[treat_col], control_value)
        result_per: list[dict] = []
        n_t = int(tmask.sum())
        n_c = int(cmask.sum())
        if n_t < 5 or n_c < 5:
            return {"success": False, "error": "groups_too_small"}, []

        for col in candidates:
            if col not in df.columns:
                result_per.append({"column": col, "error": "not_in_df"})
                continue
            s_t = df.loc[tmask, col]
            s_c = df.loc[cmask, col]
            entry = {"column": col}
            if pd.api.types.is_numeric_dtype(df[col]):
                a = pd.to_numeric(s_t, errors="coerce").dropna()
                b = pd.to_numeric(s_c, errors="coerce").dropna()
                if len(a) < 2 or len(b) < 2:
                    entry["error"] = "too_few_values"
                    result_per.append(entry)
                    continue
                ma, mb = float(a.mean()), float(b.mean())
                sa, sb = float(a.std(ddof=1)), float(b.std(ddof=1))
                pooled_sd = float(np.sqrt((sa**2 + sb**2) / 2)) if (sa or sb) else 0.0
                smd = (ma - mb) / pooled_sd if pooled_sd > 0 else 0.0
                entry.update({
                    "type": "numeric",
                    "treated_mean": round(ma, 4),
                    "control_mean": round(mb, 4),
                    "smd": round(float(smd), 4),
                    "imbalanced": abs(smd) > 0.2,
                })
            else:
                # 범주형 → 가장 흔한 값의 비율 비교
                mode_a = s_t.mode().iloc[0] if not s_t.dropna().empty else None
                mode_b = s_c.mode().iloc[0] if not s_c.dropna().empty else None
                # 두 그룹의 같은 값 비율 차이로 SMD 근사
                vals = list(set(s_t.dropna().unique()) | set(s_c.dropna().unique()))
                # Cohen's h 근사 - 각 카테고리의 비율 차이 절대값 max
                max_diff = 0.0
                worst_val = None
                for v in vals:
                    p_t = float((s_t == v).mean())
                    p_c = float((s_c == v).mean())
                    if abs(p_t - p_c) > max_diff:
                        max_diff = abs(p_t - p_c)
                        worst_val = v
                entry.update({
                    "type": "categorical",
                    "treated_mode": str(mode_a) if mode_a is not None else None,
                    "control_mode": str(mode_b) if mode_b is not None else None,
                    "max_proportion_diff": round(max_diff, 4),
                    "worst_value": str(worst_val) if worst_val is not None else None,
                    "imbalanced": max_diff > 0.1,
                })
            result_per.append(entry)

        imbalanced_cols = [r["column"] for r in result_per if r.get("imbalanced")]

        return {
            "success": True,
            "n_treated": n_t,
            "n_control": n_c,
            "candidates": result_per,
            "imbalanced_count": len(imbalanced_cols),
            "imbalanced_columns": imbalanced_cols,
            "instruction": (
                f"불균형 컬럼 {len(imbalanced_cols)}개: {imbalanced_cols[:5]}. "
                "이들이 outcome 에 영향을 준다면 compare_groups 결과는 편향됨. "
                "메모에 한계 명시하거나, 분석 가능하면 이 변수로 분층해 다시 비교."
            ) if imbalanced_cols else (
                "주요 후보 모두 균형 — compare_groups 결과 신뢰도 상승 (관찰 데이터 한계는 여전)."
            ),
        }, []
    except Exception as e:
        logger.exception("confounders_check failed")
        return {"success": False, "error": "check_failed", "message": str(e)}, []


def handle_power_analysis(inp: dict, state) -> tuple[dict, list[dict]]:
    """두 가지 모드:
    - n1, n2 제공 → MDE 계산
    - effect_size 제공 → 필요한 n 계산
    """
    alpha = float(inp.get("alpha") or 0.05)
    power = float(inp.get("power") or 0.8)
    if not (0 < alpha < 0.5) or not (0.5 <= power < 1.0):
        return {"success": False, "error": "invalid_alpha_or_power"}, []

    try:
        from scipy import stats
        import math

        z_alpha = float(stats.norm.ppf(1 - alpha / 2))
        z_beta = float(stats.norm.ppf(power))

        n1 = inp.get("n1")
        n2 = inp.get("n2")
        effect_size = inp.get("effect_size")

        if n1 and n2:
            n1, n2 = int(n1), int(n2)
            # MDE = (z_alpha + z_beta) * sqrt(1/n1 + 1/n2) (in stdev units)
            mde = (z_alpha + z_beta) * math.sqrt(1 / n1 + 1 / n2)
            interpretation = (
                "small effect" if mde < 0.2 else
                "medium effect" if mde < 0.5 else
                "large effect required"
            )
            return {
                "success": True,
                "mode": "mde_from_n",
                "n1": n1, "n2": n2,
                "alpha": alpha, "power": power,
                "mde_cohens_d": round(mde, 4),
                "interpretation": interpretation,
                "note": (
                    f"이 표본 크기로는 Cohen's d ≥ {mde:.2f} 인 차이만 검출 가능. "
                    "더 작은 효과를 보려면 표본 키워야 함."
                ),
            }, []
        if effect_size is not None:
            d = float(effect_size)
            if d <= 0:
                return {"success": False, "error": "invalid_effect_size"}, []
            # n per group = 2 * (z_a + z_b)^2 / d^2
            n_per = math.ceil(2 * (z_alpha + z_beta) ** 2 / d ** 2)
            return {
                "success": True,
                "mode": "n_from_effect",
                "effect_size": d,
                "alpha": alpha, "power": power,
                "n_per_group": n_per,
                "n_total": 2 * n_per,
                "note": f"effect_size={d} 검출에는 그룹당 {n_per}명, 총 {2*n_per}명 필요.",
            }, []
        return {
            "success": False,
            "error": "missing_inputs",
            "message": "n1+n2 또는 effect_size 중 하나 필수.",
        }, []
    except Exception as e:
        logger.exception("power_analysis failed")
        return {"success": False, "error": "power_failed", "message": str(e)}, []


def handle_causal_tool(name: str, inp: dict, state) -> tuple[dict, list[dict]]:
    if name == "compare_groups":
        return handle_compare_groups(inp, state)
    if name == "confounders_check":
        return handle_confounders_check(inp, state)
    if name == "power_analysis":
        return handle_power_analysis(inp, state)
    return {"success": False, "error": f"unknown_causal_tool: {name}"}, []
