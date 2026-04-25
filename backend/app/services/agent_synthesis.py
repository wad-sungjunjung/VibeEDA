"""Phase 3 (Synthesis) — 종합 정리.

세션 종료 직전에 모델이 호출해야 하는 3개 도구:
  1. rate_findings           — 각 결론에 confidence 등급 부여
  2. self_consistency_check  — 메모/플랜 재독, 모순 검출 (세션당 1회)
  3. synthesize_report       — 청자별 최종 요약 셀 생성

Tier 별 동작:
  L1: 모두 스킵. 답변 텍스트로 끝.
  L2: rate_findings + synthesize_report (간이 — Markdown 1장)
  L3: 3개 모두 + 청자별 풀 요약 + 한계·재현 정보

설계 원칙:
- 종료 직전 강제 (`pending_guard` 가 synthesis_done 검사)
- self_consistency_check 는 세션당 1회만 — 무한 루프 방지
- rate_findings 는 표본 크기·인과 주장·단일 셀 근거 룰 기반 보강
- synthesize_report 는 audience 강제 (exec/ds/pm)
"""
from __future__ import annotations

from typing import Literal

Audience = Literal["exec", "ds", "pm"]
Confidence = Literal["high", "mid", "low"]


# ─── Tool 정의 ────────────────────────────────────────────────────────────────

RATE_FINDINGS_TOOL_CLAUDE: dict = {
    "name": "rate_findings",
    "description": (
        "Assign confidence grade to each finding from this analysis session. "
        "Phase 3 step — call after analysis is largely done, before synthesize_report. "
        "Each finding needs: (a) the claim, (b) evidence cell ids, (c) confidence (high/mid/low), "
        "(d) caveats. Server applies rule-based downgrades automatically:\n"
        "- sample n<30 → cap at low\n"
        "- causal language without `causal` method → cap at low\n"
        "- single-cell evidence → cap at mid\n\n"
        "Replace entire findings list each call (idempotent). Aim for 3~7 findings, the most important ones."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim": {
                            "type": "string",
                            "description": "한 문장 한국어 — 발견 내용",
                        },
                        "evidence_cell_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "이 주장을 뒷받침하는 셀 id 목록 (1개 이상)",
                        },
                        "confidence": {
                            "type": "string",
                            "enum": ["high", "mid", "low"],
                            "description": "스스로 매긴 등급 — 서버가 룰로 추가 하향 가능",
                        },
                        "caveats": {
                            "type": "string",
                            "description": "한계·주의사항 (선택). 표본 적음 / 외삽 / 관찰 데이터 등",
                        },
                    },
                    "required": ["claim", "evidence_cell_ids", "confidence"],
                },
                "minItems": 1,
            },
        },
        "required": ["findings"],
    },
}

RATE_FINDINGS_TOOL_GEMINI: dict = {
    "name": "rate_findings",
    "description": RATE_FINDINGS_TOOL_CLAUDE["description"],
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "findings": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "claim": {"type": "STRING"},
                        "evidence_cell_ids": {"type": "ARRAY", "items": {"type": "STRING"}},
                        "confidence": {"type": "STRING"},
                        "caveats": {"type": "STRING"},
                    },
                    "required": ["claim", "evidence_cell_ids", "confidence"],
                },
            },
        },
        "required": ["findings"],
    },
}


SELF_CONSISTENCY_TOOL_CLAUDE: dict = {
    "name": "self_consistency_check",
    "description": (
        "Re-read the session's memos and plan, flag any contradictions or unsupported claims. "
        "Phase 3 step — **call AT MOST ONCE per session**. Server hard-rejects 2nd call. "
        "Output a list of issues (or empty list if all consistent). Each issue: "
        "(a) which finding/memo (b) what's inconsistent (c) suggested fix.\n\n"
        "Only flag CLEAR contradictions like:\n"
        "- Same number cited differently in two memos\n"
        "- Conclusion contradicts earlier observation\n"
        "- Final claim has no supporting cell\n"
        "Don't flag interpretive differences or stylistic issues. If no issues, pass empty array."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "issues": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "where": {"type": "string", "description": "문제 위치 (셀 이름 또는 finding claim 발췌)"},
                        "what": {"type": "string", "description": "어떤 모순/문제인지"},
                        "fix": {"type": "string", "description": "어떻게 해결할지 1줄 제안"},
                    },
                    "required": ["where", "what"],
                },
                "description": "발견된 문제 (없으면 빈 배열)",
            },
            "summary": {
                "type": "string",
                "description": "한 줄 요약 — 'all consistent' 또는 '3 issues found' 등",
            },
        },
        "required": ["issues", "summary"],
    },
}

SELF_CONSISTENCY_TOOL_GEMINI: dict = {
    "name": "self_consistency_check",
    "description": SELF_CONSISTENCY_TOOL_CLAUDE["description"],
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "issues": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "where": {"type": "STRING"},
                        "what": {"type": "STRING"},
                        "fix": {"type": "STRING"},
                    },
                    "required": ["where", "what"],
                },
            },
            "summary": {"type": "STRING"},
        },
        "required": ["issues", "summary"],
    },
}


SYNTHESIZE_REPORT_TOOL_CLAUDE: dict = {
    "name": "synthesize_report",
    "description": (
        "Generate the final summary as a Markdown cell at the bottom of the notebook. "
        "Phase 3 final step — calling this marks the session as complete.\n\n"
        "Audience templates (server enforces structure):\n"
        "  exec — 결론·임팩트·다음 액션 (최대 5줄)\n"
        "  ds   — 방법론·결과·한계·재현 정보 (full)\n"
        "  pm   — 의사결정 포인트·옵션·리스크\n\n"
        "Body MUST cite evidence cell names like `[cell_name]` and include confidence grades from rate_findings. "
        "L2 sessions: brief format (~10 lines). L3 sessions: full template."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "audience": {
                "type": "string",
                "enum": ["exec", "ds", "pm"],
                "description": "청자. exec=임원, ds=데이터과학자, pm=PM",
            },
            "title": {
                "type": "string",
                "description": "리포트 제목 (한국어, 8~20자)",
            },
            "body_markdown": {
                "type": "string",
                "description": (
                    "Markdown 본문. audience 템플릿 준수 + 셀 인용 `[cell_name]` + finding confidence 표시. "
                    "이 텍스트가 그대로 마크다운 셀로 노트북 마지막에 추가됨."
                ),
            },
            "next_steps": {
                "type": "array",
                "items": {"type": "string"},
                "description": "다음 분석/액션 제안 1~3개 (선택)",
            },
        },
        "required": ["audience", "title", "body_markdown"],
    },
}

SYNTHESIZE_REPORT_TOOL_GEMINI: dict = {
    "name": "synthesize_report",
    "description": SYNTHESIZE_REPORT_TOOL_CLAUDE["description"],
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "audience": {"type": "STRING"},
            "title": {"type": "STRING"},
            "body_markdown": {"type": "STRING"},
            "next_steps": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["audience", "title", "body_markdown"],
    },
}


SYNTHESIS_TOOLS_CLAUDE = [
    RATE_FINDINGS_TOOL_CLAUDE,
    SELF_CONSISTENCY_TOOL_CLAUDE,
    SYNTHESIZE_REPORT_TOOL_CLAUDE,
]
SYNTHESIS_TOOLS_GEMINI = [
    RATE_FINDINGS_TOOL_GEMINI,
    SELF_CONSISTENCY_TOOL_GEMINI,
    SYNTHESIZE_REPORT_TOOL_GEMINI,
]

SYNTHESIS_TOOL_NAMES = {"rate_findings", "self_consistency_check", "synthesize_report"}


# ─── Confidence 룰 기반 하향 ──────────────────────────────────────────────────

_CAUSAL_KEYWORDS = ("때문", "원인", "기인", "야기", "초래", "cause", "due to", "because of")


def _downgrade_confidence(stated: str, caveats: str = "") -> str:
    """모델이 매긴 등급을 룰로 더 보수적으로 만든다.
    high → mid → low 단방향 하향만.
    """
    stated_low = (stated or "").strip().lower()
    if stated_low not in ("high", "mid", "low"):
        return "low"
    return stated_low


def apply_finding_rules(
    finding: dict,
    *,
    methods: list[str],
    cells_by_id: dict[str, dict],
) -> tuple[dict, list[str]]:
    """단일 finding 에 룰 기반 하향 + 경고 메시지 생성.

    Returns:
        (정규화된 finding dict, 경고 리스트)
    """
    warnings: list[str] = []
    claim = (finding.get("claim") or "").strip()
    evidence_ids = finding.get("evidence_cell_ids") or []
    if not isinstance(evidence_ids, list):
        evidence_ids = []
    confidence = (finding.get("confidence") or "low").strip().lower()
    if confidence not in ("high", "mid", "low"):
        confidence = "low"
    caveats = (finding.get("caveats") or "").strip()

    # Rule 1: 인과 표현 + causal 메서드 미선택 → low 강제
    if any(k in claim.lower() for k in _CAUSAL_KEYWORDS):
        if "causal" not in (methods or []):
            if confidence != "low":
                warnings.append(f"인과 표현 감지 — causal 메서드 미선택 → confidence 'low' 강제")
            confidence = "low"

    # Rule 2: 단일 셀 근거 → mid 상한
    valid_evidence = [eid for eid in evidence_ids if eid in cells_by_id]
    if len(valid_evidence) <= 1 and confidence == "high":
        warnings.append(f"단일 셀 근거 — confidence 'high' → 'mid' 로 상한")
        confidence = "mid"

    # Rule 3: 증거 셀이 모두 무효 → low + 경고
    if evidence_ids and not valid_evidence:
        warnings.append(f"증거 셀 id 가 모두 노트북에 없음 — confidence 'low' 강제")
        confidence = "low"

    # Rule 4: 표본 크기 — 주 증거 셀의 rowCount 가 30 미만이면 cap at low
    # (이 정보는 cell.output 에 있을 때만)
    if valid_evidence:
        first_cell = cells_by_id.get(valid_evidence[0]) or {}
        out = first_cell.get("output") or {}
        if isinstance(out, dict):
            row_count = out.get("rowCount")
            if isinstance(row_count, int) and row_count > 0 and row_count < 30:
                if confidence != "low":
                    warnings.append(f"증거 셀 rowCount={row_count} (<30) — confidence 'low' 강제")
                confidence = "low"

    return {
        "claim": claim,
        "evidence_cell_ids": valid_evidence or evidence_ids,
        "confidence": confidence,
        "caveats": caveats,
    }, warnings
