"""예측·시계열 도구 (Phase 2 메서드별 — `predict` 메서드 활성 시 사용).

3개 도구:
  fit_trend          — 시계열 추세 + 계절성 분해, R², 잔차 진단
  forecast           — 단순 ARIMA/Holt-Winters 래퍼, 신뢰구간 출력 강제
  detect_anomalies   — IQR / rolling z-score 기반 이상치 탐지

설계 원칙:
- 학습 시간 ≤ 예측 시간 강제 (시간 누수 방지)
- forecast 는 반드시 신뢰구간 동반 (point estimate 만 안 됨)
- 외삽 거리(horizon) 가 길면 자동 경고
- statsmodels 미설치 환경 대응 — import 는 함수 내부에서, 실패 시 fallback or 명시적 에러
"""
from __future__ import annotations

import logging
from typing import Optional

from ._optional_deps import missing_dep_error

logger = logging.getLogger(__name__)


def _require_predict_deps(*, need_statsmodels: bool = True) -> Optional[dict]:
    """scipy / statsmodels 임포트 가능 여부 — 미설치면 LLM 용 friendly 에러 dict.
    detect_anomalies 는 statsmodels 없이도 동작 가능(scipy 만 사용)이므로 옵션화.
    """
    try:
        import scipy  # noqa: F401
    except ImportError:
        return missing_dep_error("scipy", install="requirements-ml.txt", suggest_method="analyze")
    if need_statsmodels:
        try:
            import statsmodels  # noqa: F401
        except ImportError:
            return missing_dep_error(
                "statsmodels", install="requirements-ml.txt", suggest_method="analyze",
            )
    return None


# ─── Tool specs ───────────────────────────────────────────────────────────────

FIT_TREND_TOOL_CLAUDE: dict = {
    "name": "fit_trend",
    "description": (
        "Decompose a time series into trend + seasonality + residual using STL or simple linear "
        "regression. Phase 2 method-specific (predict). \n\n"
        "Returns: trend slope (per period), R² of trend fit, seasonal amplitude (if detected), "
        "residual diagnostics (Ljung-Box test for autocorr, Shapiro-Wilk for normality). "
        "Use this BEFORE forecast to understand the underlying signal."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "data_cell_id": {"type": "string", "description": "DataFrame 셀 id"},
            "time_col": {"type": "string", "description": "시간 컬럼명 (parsed to datetime)"},
            "value_col": {"type": "string", "description": "수치 시계열 컬럼명"},
            "seasonality_period": {
                "type": "integer",
                "description": "계절성 주기 (예: 일별 주기 7, 월별 주기 12). 미지정 시 자동 추정 시도.",
            },
        },
        "required": ["data_cell_id", "time_col", "value_col"],
    },
}


FORECAST_TOOL_CLAUDE: dict = {
    "name": "forecast",
    "description": (
        "Generate a forecast for a time series with **mandatory confidence intervals**. "
        "Phase 2 method-specific (predict). Uses Holt-Winters exponential smoothing if seasonality "
        "detected, else simple exponential smoothing. \n\n"
        "Time leakage guard: training data's max(time) must be < forecast start. \n"
        "Horizon guard: warns if horizon > 50% of training period (extrapolation too far)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "data_cell_id": {"type": "string"},
            "time_col": {"type": "string"},
            "value_col": {"type": "string"},
            "horizon": {
                "type": "integer",
                "description": "예측할 미래 시점 개수 (1~365)",
            },
            "seasonality_period": {
                "type": "integer",
                "description": "계절성 주기 (선택)",
            },
            "alpha": {
                "type": "number",
                "description": "신뢰구간 유의수준 (기본 0.05 = 95% CI)",
            },
        },
        "required": ["data_cell_id", "time_col", "value_col", "horizon"],
    },
}


DETECT_ANOMALIES_TOOL_CLAUDE: dict = {
    "name": "detect_anomalies",
    "description": (
        "Detect anomalies in a time series via rolling z-score (default) or IQR over residuals. "
        "Phase 2 method-specific (predict). Returns flagged time points + their z-score / deviation."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "data_cell_id": {"type": "string"},
            "time_col": {"type": "string"},
            "value_col": {"type": "string"},
            "method": {
                "type": "string",
                "enum": ["rolling_zscore", "iqr"],
                "description": "기본 rolling_zscore",
            },
            "window": {
                "type": "integer",
                "description": "rolling window 크기 (rolling_zscore 전용, 기본 7)",
            },
            "threshold": {
                "type": "number",
                "description": "임계값 (z-score: 기본 2.5, IQR: 기본 1.5)",
            },
        },
        "required": ["data_cell_id", "time_col", "value_col"],
    },
}


def _to_gemini(t: dict) -> dict:
    out = {"name": t["name"], "description": t["description"]}
    schema = t["input_schema"]
    props_g: dict = {}
    for k, v in (schema.get("properties") or {}).items():
        v2 = {"type": v.get("type", "string").upper()}
        if v.get("type") == "array":
            v2["items"] = {"type": (v.get("items") or {}).get("type", "string").upper()}
        if "description" in v:
            v2["description"] = v["description"]
        props_g[k] = v2
    out["parameters"] = {
        "type": "OBJECT",
        "properties": props_g,
        "required": schema.get("required", []),
    }
    return out


PREDICT_TOOLS_CLAUDE = [
    FIT_TREND_TOOL_CLAUDE,
    FORECAST_TOOL_CLAUDE,
    DETECT_ANOMALIES_TOOL_CLAUDE,
]
PREDICT_TOOLS_GEMINI = [_to_gemini(t) for t in PREDICT_TOOLS_CLAUDE]
PREDICT_TOOL_NAMES = {"fit_trend", "forecast", "detect_anomalies"}


# ─── Helpers ──────────────────────────────────────────────────────────────────


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


def _prepare_series(df, time_col: str, value_col: str):
    """time_col, value_col 추출 + 정렬 + datetime 파싱 + 결측 제거."""
    import pandas as pd
    if time_col not in df.columns:
        return None, "time_col_missing"
    if value_col not in df.columns:
        return None, "value_col_missing"
    sub = df[[time_col, value_col]].copy()
    sub[time_col] = pd.to_datetime(sub[time_col], errors="coerce")
    sub[value_col] = pd.to_numeric(sub[value_col], errors="coerce")
    sub = sub.dropna().sort_values(time_col)
    if len(sub) < 10:
        return None, "too_few_points"
    return sub, None


# ─── Handlers ─────────────────────────────────────────────────────────────────


def handle_fit_trend(inp: dict, state) -> tuple[dict, list[dict]]:
    if (e := _require_predict_deps(need_statsmodels=True)):
        return e, []
    df, err = _get_dataframe(state, inp.get("data_cell_id", ""))
    if err:
        return {"success": False, "error": err}, []
    time_col = (inp.get("time_col") or "").strip()
    value_col = (inp.get("value_col") or "").strip()
    period = inp.get("seasonality_period")

    series, err = _prepare_series(df, time_col, value_col)
    if err:
        return {"success": False, "error": err}, []

    try:
        import numpy as np
        from scipy import stats

        # 시간을 정수 인덱스로 변환해 선형 추세 적합
        t = np.arange(len(series))
        y = series[value_col].to_numpy()
        slope, intercept, r, p_val, _ = stats.linregress(t, y)
        residuals = y - (slope * t + intercept)
        r_squared = float(r ** 2)

        result: dict = {
            "success": True,
            "n": len(series),
            "time_range": {
                "start": series[time_col].iloc[0].isoformat(),
                "end": series[time_col].iloc[-1].isoformat(),
            },
            "trend": {
                "slope_per_period": round(float(slope), 6),
                "intercept": round(float(intercept), 4),
                "r_squared": round(r_squared, 4),
                "p_value": round(float(p_val), 6),
            },
            "residual_summary": {
                "mean": round(float(residuals.mean()), 4),
                "std": round(float(residuals.std(ddof=1)), 4),
            },
        }

        # 자동 계절성 주기 추정 (단순) — period 미지정 시 7/12/24 중 잔차 자기상관 가장 강한 것
        if not period and len(series) > 30:
            try:
                from statsmodels.stats.diagnostic import acorr_ljungbox
                best_p, best_lag = None, None
                for lag in (7, 12, 24, 30):
                    if lag * 2 < len(residuals):
                        lb = acorr_ljungbox(residuals, lags=[lag], return_df=True)
                        p = float(lb["lb_pvalue"].iloc[0])
                        if best_p is None or p < best_p:
                            best_p, best_lag = p, lag
                if best_p is not None and best_p < 0.05:
                    period = best_lag
                    result["seasonality_estimated_period"] = best_lag
            except Exception:
                pass

        # STL 분해 시도 (statsmodels)
        if period and period > 1 and len(series) >= 2 * period:
            try:
                from statsmodels.tsa.seasonal import STL
                stl = STL(series.set_index(time_col)[value_col], period=period, robust=True).fit()
                seasonal = stl.seasonal
                result["seasonality"] = {
                    "period": int(period),
                    "amplitude": round(float(seasonal.max() - seasonal.min()), 4),
                    "stl_used": True,
                }
            except Exception as e:
                logger.warning("STL decomposition failed: %s", e)

        # 잔차 자기상관 진단 (Ljung-Box) — 추세만으로 설명 안 되는 패턴 남아있는지
        try:
            from statsmodels.stats.diagnostic import acorr_ljungbox
            lb_lag = min(10, max(1, len(residuals) // 5))
            lb = acorr_ljungbox(residuals, lags=[lb_lag], return_df=True)
            result["residual_autocorrelation_p"] = round(float(lb["lb_pvalue"].iloc[0]), 6)
            if result["residual_autocorrelation_p"] < 0.05:
                result.setdefault("warnings", []).append(
                    "잔차에 자기상관이 남아있음 — 단순 선형 추세로 부족, 계절성/AR 모델 검토."
                )
        except Exception:
            pass

        result["instruction"] = (
            "추세 slope 와 R² 를 메모에 기록. R² < 0.3 이면 추세 약함 — forecast 의 신뢰도도 낮음. "
            "계절성이 발견됐으면 forecast 호출 시 같은 period 를 넘기세요."
        )
        return result, []
    except Exception as e:
        logger.exception("fit_trend failed")
        return {"success": False, "error": "trend_failed", "message": str(e)}, []


def handle_forecast(inp: dict, state) -> tuple[dict, list[dict]]:
    if (e := _require_predict_deps(need_statsmodels=True)):
        return e, []
    df, err = _get_dataframe(state, inp.get("data_cell_id", ""))
    if err:
        return {"success": False, "error": err}, []
    time_col = (inp.get("time_col") or "").strip()
    value_col = (inp.get("value_col") or "").strip()
    horizon = int(inp.get("horizon") or 7)
    period = inp.get("seasonality_period")
    alpha = float(inp.get("alpha") or 0.05)

    if not (1 <= horizon <= 365):
        return {"success": False, "error": "invalid_horizon", "message": "1~365"}, []

    series, err = _prepare_series(df, time_col, value_col)
    if err:
        return {"success": False, "error": err}, []

    try:
        import numpy as np
        import pandas as pd

        n = len(series)
        warnings: list[str] = []
        if horizon > n * 0.5:
            warnings.append(
                f"horizon {horizon} > 학습 기간({n}) 의 50% — 외삽 거리가 너무 멀어 신뢰도 낮음."
            )

        # 미래 시간 인덱스 생성 — 학습 데이터 간격 추정 (median)
        time_idx = series[time_col]
        diffs = time_idx.diff().dropna()
        if diffs.empty:
            return {"success": False, "error": "cant_infer_freq"}, []
        median_step = diffs.median()
        last_t = time_idx.iloc[-1]
        future_times = [last_t + median_step * (i + 1) for i in range(horizon)]

        try:
            from statsmodels.tsa.holtwinters import ExponentialSmoothing
            model_kwargs = {}
            if period and period > 1 and n >= 2 * period:
                model_kwargs.update(seasonal_periods=period, seasonal="add", trend="add")
            else:
                model_kwargs.update(trend="add")
            model = ExponentialSmoothing(
                series.set_index(time_col)[value_col].astype(float),
                **model_kwargs,
            ).fit()
            point = model.forecast(steps=horizon)
            # 신뢰구간 — fitted residual 의 std 로 정규근사
            resid = model.resid.dropna()
            sigma = float(resid.std(ddof=1)) if len(resid) > 1 else float(series[value_col].std(ddof=1))
            from scipy import stats
            crit = float(stats.norm.ppf(1 - alpha / 2))
            ci_low = (point - crit * sigma).tolist()
            ci_high = (point + crit * sigma).tolist()
            method = "ExponentialSmoothing"
        except Exception as e:
            logger.warning("statsmodels not available or failed: %s — using naive forecast", e)
            # Fallback: 단순 평균 + 표준편차 기반
            mean = float(series[value_col].mean())
            sigma = float(series[value_col].std(ddof=1))
            point = pd.Series([mean] * horizon)
            from scipy import stats
            crit = float(stats.norm.ppf(1 - alpha / 2))
            ci_low = [mean - crit * sigma] * horizon
            ci_high = [mean + crit * sigma] * horizon
            method = "naive_mean (statsmodels unavailable)"
            warnings.append("statsmodels 사용 불가 — 단순 평균 예측으로 대체. 신뢰도 매우 낮음.")

        result_points = [
            {
                "time": future_times[i].isoformat() if hasattr(future_times[i], "isoformat") else str(future_times[i]),
                "point": round(float(point.iloc[i] if hasattr(point, "iloc") else point[i]), 4),
                "ci_low": round(float(ci_low[i]), 4),
                "ci_high": round(float(ci_high[i]), 4),
            }
            for i in range(horizon)
        ]

        return {
            "success": True,
            "method": method,
            "horizon": horizon,
            "alpha": alpha,
            "n_train": n,
            "training_end": last_t.isoformat() if hasattr(last_t, "isoformat") else str(last_t),
            "forecast": result_points,
            "warnings": warnings,
            "instruction": (
                "메모에 (1) 추세 방향 + (2) **신뢰구간 폭** + (3) horizon 한계 — 셋 모두 적으세요. "
                "point 만 인용하지 말 것 — 시니어는 항상 CI 와 함께 말합니다."
            ),
        }, []
    except Exception as e:
        logger.exception("forecast failed")
        return {"success": False, "error": "forecast_failed", "message": str(e)}, []


def handle_detect_anomalies(inp: dict, state) -> tuple[dict, list[dict]]:
    if (e := _require_predict_deps(need_statsmodels=False)):
        return e, []
    df, err = _get_dataframe(state, inp.get("data_cell_id", ""))
    if err:
        return {"success": False, "error": err}, []
    time_col = (inp.get("time_col") or "").strip()
    value_col = (inp.get("value_col") or "").strip()
    method = (inp.get("method") or "rolling_zscore").strip().lower()
    window = int(inp.get("window") or 7)
    threshold_default = 2.5 if method == "rolling_zscore" else 1.5
    threshold = float(inp.get("threshold") or threshold_default)

    series, err = _prepare_series(df, time_col, value_col)
    if err:
        return {"success": False, "error": err}, []

    try:
        import numpy as np
        s = series[value_col]
        if method == "rolling_zscore":
            if window < 3 or window > len(s) // 2:
                return {"success": False, "error": "invalid_window"}, []
            roll_mean = s.rolling(window=window, min_periods=max(2, window // 2)).mean()
            roll_std = s.rolling(window=window, min_periods=max(2, window // 2)).std(ddof=1)
            z = (s - roll_mean) / roll_std
            anomaly_mask = z.abs() > threshold
            anomalies = []
            for idx in series.index[anomaly_mask.fillna(False)]:
                anomalies.append({
                    "time": series.loc[idx, time_col].isoformat(),
                    "value": round(float(series.loc[idx, value_col]), 4),
                    "z_score": round(float(z.loc[idx]), 3),
                })
        else:  # iqr
            q1 = s.quantile(0.25)
            q3 = s.quantile(0.75)
            iqr = q3 - q1
            low = q1 - threshold * iqr
            high = q3 + threshold * iqr
            anomaly_mask = (s < low) | (s > high)
            anomalies = []
            for idx in series.index[anomaly_mask]:
                v = float(series.loc[idx, value_col])
                anomalies.append({
                    "time": series.loc[idx, time_col].isoformat(),
                    "value": round(v, 4),
                    "deviation": "above_q3" if v > high else "below_q1",
                })

        return {
            "success": True,
            "method": method,
            "threshold": threshold,
            "window": window if method == "rolling_zscore" else None,
            "n_total": len(series),
            "n_anomalies": len(anomalies),
            "anomaly_ratio": round(len(anomalies) / len(series), 4),
            "anomalies": anomalies[:50],  # 너무 많으면 자르기
            "truncated": len(anomalies) > 50,
            "instruction": (
                "이상치 시점을 메모에 1~3개 인용하고 그 시점에 무엇이 있었는지(공휴일/이벤트/오류) "
                "맥락 추가 조사 권장."
            ) if anomalies else "임계값 기준 이상치 없음 — 안정적인 시계열.",
        }, []
    except Exception as e:
        logger.exception("detect_anomalies failed")
        return {"success": False, "error": "anomaly_failed", "message": str(e)}, []


def handle_predict_tool(name: str, inp: dict, state) -> tuple[dict, list[dict]]:
    if name == "fit_trend":
        return handle_fit_trend(inp, state)
    if name == "forecast":
        return handle_forecast(inp, state)
    if name == "detect_anomalies":
        return handle_detect_anomalies(inp, state)
    return {"success": False, "error": f"unknown_predict_tool: {name}"}, []
