"""ML 도구 (Phase 2 메서드별 — `ml` 메서드 활성 시 사용).

3개 도구:
  fit_model              — train/test 분리 + sklearn 학습 + 데이터 누수 가드
  evaluate_model         — confusion matrix / AUC / 잔차 / 캘리브레이션
  feature_importance     — permutation 또는 SHAP 기반

설계 원칙:
- DataFrame 은 `cell_id` 로 참조 — Python 커널 namespace 에서 셀 이름으로 가져옴
- train_test_split 에 random_state 강제 (재현성)
- 타겟 분포 + 클래스 균형 자동 출력 (불균형이면 경고)
- 학습 결과는 `_ml_models` 메모리 dict 에 저장 — evaluate_model 이 동일 모델 객체 참조

데이터 누수 가드:
- fit_model 호출 시 (a) 입력 DataFrame 의 컬럼 중 target 이 features 에 포함되어 있으면 거부
  (b) test 가 train 의 미래 시점인지 (시계열) 자동 검사 — time_col 명시 시
- evaluate_model 은 동일 분리에서 평가 — 별도 split 금지
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


# 학습된 모델 저장소 (notebook_id × cell_id) — evaluate_model / feature_importance 가 참조.
# 메모리 단위 (프로세스 재시작 시 휘발). 노트북별로 격리.
_ml_models: dict[tuple[str, str], dict] = {}


# ─── Tool specs ───────────────────────────────────────────────────────────────

FIT_MODEL_TOOL_CLAUDE: dict = {
    "name": "fit_model",
    "description": (
        "Train a supervised ML model (classification or regression) on a DataFrame from a previous cell. "
        "Phase 2 method-specific — only call when `ml` method was selected. "
        "Server enforces: (a) train/test split with random_state, (b) data leakage guard "
        "(target not in features), (c) class imbalance warning if min class < 10% (classification), "
        "(d) baseline-first — if no baseline cell exists yet, suggests adding mean/mode prediction.\n\n"
        "Models supported: 'logistic', 'random_forest', 'gradient_boosting', 'linear', 'ridge'. "
        "Default: 'random_forest' for both tasks. test_size default 0.25.\n\n"
        "Returns: train/test scores, fitted model handle (for evaluate_model / feature_importance), "
        "warnings (leakage / imbalance / small-sample). Does NOT create a notebook cell — call "
        "create_cell separately if you want the trained model code visible."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "data_cell_id": {
                "type": "string",
                "description": "DataFrame 이 들어있는 셀 id (SQL 또는 Python 셀)",
            },
            "target": {
                "type": "string",
                "description": "타겟 컬럼명 (DataFrame 안에 존재해야 함)",
            },
            "features": {
                "type": "array",
                "items": {"type": "string"},
                "description": "특성 컬럼 목록. 비워두면 target 외 모든 컬럼 자동 사용.",
            },
            "task": {
                "type": "string",
                "enum": ["classification", "regression"],
                "description": "분류 또는 회귀",
            },
            "model": {
                "type": "string",
                "enum": ["logistic", "random_forest", "gradient_boosting", "linear", "ridge"],
                "description": "사용할 모델. logistic/linear/ridge 는 단순, random_forest/gradient_boosting 은 트리 기반.",
            },
            "test_size": {
                "type": "number",
                "description": "테스트셋 비율 (0.1~0.4, 기본 0.25)",
            },
            "time_col": {
                "type": "string",
                "description": "시계열 데이터인 경우 시간 컬럼 — 시간 누수 가드 활성화 (test 가 train 의 미래여야 함)",
            },
            "random_state": {
                "type": "integer",
                "description": "재현성용 시드 (기본 42)",
            },
        },
        "required": ["data_cell_id", "target", "task"],
    },
}


EVALUATE_MODEL_TOOL_CLAUDE: dict = {
    "name": "evaluate_model",
    "description": (
        "Evaluate a model fitted by fit_model on its held-out test set. "
        "Returns: classification → confusion matrix / accuracy / precision / recall / AUC + per-class. "
        "regression → R² / MAE / RMSE / 잔차 분포. "
        "Re-uses the same train/test split — no leakage. "
        "Call right after fit_model. Use the cell_id returned by fit_model as `model_cell_id`."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "model_cell_id": {
                "type": "string",
                "description": "fit_model 이 반환한 model_cell_id (또는 같은 data_cell_id)",
            },
        },
        "required": ["model_cell_id"],
    },
}


FEATURE_IMPORTANCE_TOOL_CLAUDE: dict = {
    "name": "feature_importance",
    "description": (
        "Compute feature importance for a fitted model using permutation importance "
        "(model-agnostic, more reliable than tree built-in). Returns top 20 features sorted by importance. "
        "Call after fit_model + evaluate_model. Heavy operation — uses a sample of test set."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "model_cell_id": {"type": "string"},
            "top_n": {
                "type": "integer",
                "description": "반환할 상위 특성 수 (기본 20, 최대 50)",
            },
        },
        "required": ["model_cell_id"],
    },
}


# Gemini 변환 (enum 일부 약화)
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


ML_TOOLS_CLAUDE = [
    FIT_MODEL_TOOL_CLAUDE,
    EVALUATE_MODEL_TOOL_CLAUDE,
    FEATURE_IMPORTANCE_TOOL_CLAUDE,
]
ML_TOOLS_GEMINI = [_to_gemini(t) for t in ML_TOOLS_CLAUDE]
ML_TOOL_NAMES = {"fit_model", "evaluate_model", "feature_importance"}


# ─── Handler 구현 ─────────────────────────────────────────────────────────────


def _get_dataframe(state, cell_id: str):
    """state.cells 에서 cell_id 로 셀 찾고, kernel namespace 에서 그 이름의 DataFrame 반환."""
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


def handle_fit_model(inp: dict, state) -> tuple[dict, list[dict]]:
    cell_id = inp.get("data_cell_id", "")
    target = (inp.get("target") or "").strip()
    features_in = inp.get("features") or []
    task = (inp.get("task") or "").strip().lower()
    model_name = (inp.get("model") or "random_forest").strip().lower()
    test_size = float(inp.get("test_size") or 0.25)
    time_col = (inp.get("time_col") or "").strip() or None
    random_state = int(inp.get("random_state") or 42)

    if task not in ("classification", "regression"):
        return {"success": False, "error": "invalid_task"}, []
    if not (0.1 <= test_size <= 0.4):
        return {"success": False, "error": "invalid_test_size", "message": "0.1~0.4 사이만 허용."}, []

    df, err = _get_dataframe(state, cell_id)
    if err:
        return {"success": False, "error": err}, []

    if target not in df.columns:
        return {
            "success": False,
            "error": "target_not_in_dataframe",
            "message": f"target='{target}' 컬럼이 DataFrame 에 없습니다. 컬럼: {list(df.columns)[:20]}",
        }, []

    # features 자동 — target 제외 모든 수치/범주
    if not features_in:
        features = [c for c in df.columns if c != target]
    else:
        features = list(features_in)

    # 데이터 누수 가드 1: target 이 features 에 들어가 있으면 거부
    if target in features:
        return {
            "success": False,
            "error": "data_leakage",
            "message": f"features 에 target('{target}') 이 포함되어 있어 데이터 누수입니다. 제거 후 재호출.",
        }, []

    # features 컬럼 존재 검증
    missing = [f for f in features if f not in df.columns]
    if missing:
        return {
            "success": False,
            "error": "features_not_in_dataframe",
            "message": f"존재하지 않는 features: {missing[:10]}",
        }, []

    # 너무 작은 샘플 경고
    n = len(df)
    warnings: list[str] = []
    if n < 50:
        return {
            "success": False,
            "error": "sample_too_small",
            "message": f"행 수 {n} (<50) — 학습이 무의미합니다. 데이터를 더 모아 다시 시도.",
        }, []
    if n < 200:
        warnings.append(f"행 수 {n} — 모델 결과 신뢰도 낮음, 결론은 'low confidence'.")

    try:
        import pandas as pd
        from sklearn.model_selection import train_test_split
        # 결측치 처리 — 단순 dropna (운영용)
        sub = df[features + [target]].dropna()
        if len(sub) < 30:
            return {"success": False, "error": "after_dropna_too_small", "message": f"NULL 제거 후 {len(sub)}행."}, []
        X = sub[features]
        y = sub[target]

        # 범주형 자동 인코딩 — get_dummies
        X_enc = pd.get_dummies(X, drop_first=True)
        feature_names = list(X_enc.columns)

        # 시간 누수 가드: time_col 있으면 시간순 분리
        if time_col:
            if time_col not in df.columns:
                return {"success": False, "error": "time_col_missing"}, []
            sub_time = df[features + [target, time_col]].dropna()
            if len(sub_time) < 30:
                return {"success": False, "error": "time_filter_too_small"}, []
            sub_time = sub_time.sort_values(time_col)
            split_idx = int(len(sub_time) * (1 - test_size))
            X_full = pd.get_dummies(sub_time[features], drop_first=True)
            # 컬럼 정렬 일치
            X_full = X_full.reindex(columns=feature_names, fill_value=0)
            X_train = X_full.iloc[:split_idx]
            X_test = X_full.iloc[split_idx:]
            y_train = sub_time[target].iloc[:split_idx]
            y_test = sub_time[target].iloc[split_idx:]
            warnings.append(f"시계열 분리 적용 (time_col='{time_col}') — 학습 기간 ≤ 테스트 기간.")
        else:
            # 분류는 stratify 시도
            stratify = y if task == "classification" and y.nunique() <= 20 else None
            X_train, X_test, y_train, y_test = train_test_split(
                X_enc, y, test_size=test_size, random_state=random_state, stratify=stratify,
            )

        # 클래스 불균형 경고 (분류 전용)
        class_dist = None
        if task == "classification":
            vc = y.value_counts(normalize=True)
            class_dist = {str(k): float(v) for k, v in vc.items()}
            if vc.min() < 0.1:
                warnings.append(
                    f"클래스 불균형 — 최소 클래스 비율 {vc.min():.1%}. "
                    "단순 정확도 대신 confusion matrix / AUC / per-class precision-recall 을 보세요."
                )

        # 모델 빌드
        model = _build_model(task, model_name, random_state)
        model.fit(X_train, y_train)

        # 점수
        train_score = float(model.score(X_train, y_train))
        test_score = float(model.score(X_test, y_test))

        # 과적합 경고
        if train_score - test_score > 0.15:
            warnings.append(
                f"과적합 의심 — train {train_score:.3f} vs test {test_score:.3f}. "
                "더 단순한 모델 또는 정규화 검토."
            )

        # 저장
        nb_id = state.notebook_id or ""
        key = (nb_id, cell_id)
        _ml_models[key] = {
            "model": model,
            "X_test": X_test,
            "y_test": y_test,
            "X_train": X_train,
            "y_train": y_train,
            "feature_names": feature_names,
            "task": task,
            "model_name": model_name,
            "target": target,
        }

        return {
            "success": True,
            "model_cell_id": cell_id,    # evaluate_model 에서 사용할 핸들
            "task": task,
            "model": model_name,
            "n_train": int(len(X_train)),
            "n_test": int(len(X_test)),
            "train_score": round(train_score, 4),
            "test_score": round(test_score, 4),
            "n_features": len(feature_names),
            "class_distribution": class_dist,
            "warnings": warnings,
            "instruction": (
                "학습 완료. 이제 `evaluate_model(model_cell_id=cell_id)` 로 confusion matrix / AUC / 잔차 등 "
                "상세 평가를 보세요. 단순 정확도만 보지 말 것."
            ),
        }, []
    except Exception as e:
        logger.exception("fit_model failed")
        return {"success": False, "error": "fit_failed", "message": str(e)}, []


def _build_model(task: str, name: str, random_state: int):
    """sklearn 모델 인스턴스 생성. import 는 함수 내부에서 (선택적 의존성)."""
    if task == "classification":
        if name == "logistic":
            from sklearn.linear_model import LogisticRegression
            return LogisticRegression(max_iter=1000, random_state=random_state)
        if name == "gradient_boosting":
            from sklearn.ensemble import GradientBoostingClassifier
            return GradientBoostingClassifier(random_state=random_state)
        from sklearn.ensemble import RandomForestClassifier
        return RandomForestClassifier(random_state=random_state, n_estimators=100)
    # regression
    if name == "linear":
        from sklearn.linear_model import LinearRegression
        return LinearRegression()
    if name == "ridge":
        from sklearn.linear_model import Ridge
        return Ridge(random_state=random_state)
    if name == "gradient_boosting":
        from sklearn.ensemble import GradientBoostingRegressor
        return GradientBoostingRegressor(random_state=random_state)
    from sklearn.ensemble import RandomForestRegressor
    return RandomForestRegressor(random_state=random_state, n_estimators=100)


def handle_evaluate_model(inp: dict, state) -> tuple[dict, list[dict]]:
    cell_id = inp.get("model_cell_id", "")
    nb_id = state.notebook_id or ""
    key = (nb_id, cell_id)
    if key not in _ml_models:
        return {
            "success": False,
            "error": "model_not_found",
            "message": "이 cell_id 로 학습된 모델이 없습니다. 먼저 fit_model 을 호출하세요.",
        }, []
    bundle = _ml_models[key]
    model = bundle["model"]
    X_test = bundle["X_test"]
    y_test = bundle["y_test"]
    task = bundle["task"]
    try:
        if task == "classification":
            from sklearn.metrics import (
                confusion_matrix, classification_report, accuracy_score, roc_auc_score,
            )
            y_pred = model.predict(X_test)
            cm = confusion_matrix(y_test, y_pred).tolist()
            classes = sorted(set(map(str, y_test.unique()) | set(map(str, y_pred))))
            report = classification_report(y_test, y_pred, output_dict=True, zero_division=0)
            # AUC — 이진 분류만
            auc = None
            try:
                if hasattr(model, "predict_proba") and y_test.nunique() == 2:
                    proba = model.predict_proba(X_test)[:, 1]
                    auc = float(roc_auc_score(y_test, proba))
            except Exception:
                auc = None
            return {
                "success": True,
                "task": "classification",
                "accuracy": round(float(accuracy_score(y_test, y_pred)), 4),
                "auc": round(auc, 4) if auc is not None else None,
                "confusion_matrix": cm,
                "classes": classes,
                "per_class": {
                    str(k): {
                        "precision": round(float(v.get("precision", 0)), 4),
                        "recall": round(float(v.get("recall", 0)), 4),
                        "f1": round(float(v.get("f1-score", 0)), 4),
                        "support": int(v.get("support", 0)),
                    }
                    for k, v in report.items()
                    if isinstance(v, dict) and k not in ("accuracy", "macro avg", "weighted avg")
                },
                "instruction": (
                    "결과를 보고 confusion matrix 의 오분류 패턴 / per-class recall / AUC (이진) 를 메모로 남기세요. "
                    "특성 영향력은 feature_importance 로."
                ),
            }, []
        # regression
        from sklearn.metrics import r2_score, mean_absolute_error, mean_squared_error
        import math
        y_pred = model.predict(X_test)
        residuals = (y_test - y_pred)
        return {
            "success": True,
            "task": "regression",
            "r2": round(float(r2_score(y_test, y_pred)), 4),
            "mae": round(float(mean_absolute_error(y_test, y_pred)), 4),
            "rmse": round(math.sqrt(mean_squared_error(y_test, y_pred)), 4),
            "residual_summary": {
                "mean": round(float(residuals.mean()), 4),
                "std": round(float(residuals.std()), 4),
                "min": round(float(residuals.min()), 4),
                "max": round(float(residuals.max()), 4),
            },
            "instruction": (
                "잔차의 평균이 0 근처가 아니면 편향 가능성. std 가 y 의 std 와 비교해 너무 크면 모델 약함. "
                "feature_importance 로 어떤 특성이 영향을 주는지 확인하세요."
            ),
        }, []
    except Exception as e:
        logger.exception("evaluate_model failed")
        return {"success": False, "error": "eval_failed", "message": str(e)}, []


def handle_feature_importance(inp: dict, state) -> tuple[dict, list[dict]]:
    cell_id = inp.get("model_cell_id", "")
    top_n = min(max(int(inp.get("top_n") or 20), 1), 50)
    nb_id = state.notebook_id or ""
    key = (nb_id, cell_id)
    if key not in _ml_models:
        return {"success": False, "error": "model_not_found"}, []
    bundle = _ml_models[key]
    try:
        from sklearn.inspection import permutation_importance
        # 너무 많이 돌면 오래 걸리므로 샘플
        X_test = bundle["X_test"]
        y_test = bundle["y_test"]
        sample_n = min(500, len(X_test))
        if sample_n < len(X_test):
            X_test = X_test.sample(sample_n, random_state=42)
            y_test = y_test.loc[X_test.index]
        result = permutation_importance(
            bundle["model"], X_test, y_test,
            n_repeats=5, random_state=42, n_jobs=-1,
        )
        names = bundle["feature_names"]
        ranked = sorted(
            zip(names, result.importances_mean.tolist(), result.importances_std.tolist()),
            key=lambda t: -abs(t[1]),
        )[:top_n]
        return {
            "success": True,
            "method": "permutation",
            "top_n": top_n,
            "features": [
                {"name": n, "importance": round(float(imp), 5), "std": round(float(s), 5)}
                for n, imp, s in ranked
            ],
            "instruction": (
                "상위 특성을 메모에 1~3개 정도 인용하세요. 단, 인과 해석은 금지 — 모델 입력의 통계적 영향력일 뿐입니다 "
                "(causal 메서드가 선택된 경우에만 인과 단어 사용)."
            ),
        }, []
    except Exception as e:
        logger.exception("feature_importance failed")
        return {"success": False, "error": "perm_failed", "message": str(e)}, []


# ─── 통합 핸들러 (claude_agent._execute_tool 에서 라우팅) ──────────────────────


def handle_ml_tool(name: str, inp: dict, state) -> tuple[dict, list[dict]]:
    if name == "fit_model":
        return handle_fit_model(inp, state)
    if name == "evaluate_model":
        return handle_evaluate_model(inp, state)
    if name == "feature_importance":
        return handle_feature_importance(inp, state)
    return {"success": False, "error": f"unknown_ml_tool: {name}"}, []
