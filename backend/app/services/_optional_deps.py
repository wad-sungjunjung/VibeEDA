"""Vibe EDA — 선택적 의존성(sklearn/scipy/statsmodels/pyarrow) 부재 처리 헬퍼.

코어 설치(`requirements.txt`)에는 이 라이브러리들이 빠져 있다. 메서드별 도구
(agent_ml/agent_predict/agent_causal)는 함수 내부에서 lazy import 하므로 모듈 import 자체는
무사히 통과하고, 도구가 실제로 호출되어야 비로소 ImportError 가 발생한다.

LLM 가 이걸 알아차리고 다른 메서드로 우회할 수 있도록, 일반적인 "fit_failed" 같은 모호한
에러 대신 "missing_optional_dependency" 라는 명시적 에러 코드 + 설치 가이드 를 반환한다.

사용:
    try:
        from sklearn.model_selection import train_test_split
    except ImportError:
        return missing_dep_error("scikit-learn", install="requirements-ml.txt"), []
"""
from __future__ import annotations

from typing import Optional


def missing_dep_error(
    package: str,
    *,
    install: Optional[str] = None,
    suggest_method: Optional[str] = None,
) -> dict:
    """선택적 의존성 부재 시 LLM 이 받을 표준 에러 응답.

    Args:
        package: 누락된 패키지 이름 (예: 'scikit-learn', 'pyarrow')
        install: 설치하면 해결되는 requirements 파일 (예: 'requirements-ml.txt')
        suggest_method: 동등한 결과를 낼 수 있는 다른 Agent 메서드 (예: 'analyze')
    """
    parts = [
        f"선택적 의존성 `{package}` 가 설치되어 있지 않아 이 도구를 실행할 수 없습니다."
    ]
    if install:
        parts.append(f"설치: `pip install -r backend/{install}`")
    if suggest_method:
        parts.append(f"이 환경에서는 `{suggest_method}` 메서드로 대체해 분석을 계속하세요.")
    parts.append(
        "그동안은 이 도구를 다시 호출하지 말고, 위 지시대로 메서드를 변경하거나 사용자에게 보고하세요."
    )
    return {
        "success": False,
        "error": "missing_optional_dependency",
        "package": package,
        "message": " ".join(parts),
    }
