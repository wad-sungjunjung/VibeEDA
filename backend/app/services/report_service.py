"""Report generation — 선택된 셀의 출력·메모를 바탕으로 시니어 분석가 수준 Markdown 리포트 생성.

품질 우선 파이프라인:
  1) Evidence 강화: 테이블 head+tail+수치/범주 프로파일, 셀 의존성 추적
  2) 2-pass 생성: Outline(JSON) → 차트 커버리지 검증 → Writing(Markdown 스트림)
  3) 수치 환각 검증: evidence 수치 집합과 본문 수치 비교
  4) 플레이스홀더 투명성: 미삽입 차트는 경고 블록, 미참조 차트는 부록 자동 추가
  5) processing_notes 를 frontmatter 에 기록 + SSE meta 이벤트로 UI 에 전달

저장 위치: ~/vibe-notebooks/reports/{YYYYMMDD_HHmmss}_{slug}.md
파일 내부: YAML frontmatter + Markdown 본문 (차트는 reports/{id}_images/ 상대 경로 참조)
"""
from __future__ import annotations

import base64
import json
import re
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

import anthropic
from google import genai
from google.genai import types as genai_types

from . import notebook_store

logger = logging.getLogger(__name__)


def _reports_dir() -> Path:
    d = notebook_store.NOTEBOOKS_DIR / "reports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _drafts_dir() -> Path:
    """임시(미저장) 리포트가 놓이는 위치. list_reports 는 root 만 glob 하므로 노출되지 않음."""
    d = _reports_dir() / "_drafts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _report_folder(report_id: str, *, draft: bool) -> Path:
    """리포트 1건이 놓이는 폴더. 폴더 안에 {id}.md + *.png 가 평면 저장된다."""
    base = _drafts_dir() if draft else _reports_dir()
    return base / report_id


def _resolve_report_paths(report_id: str) -> tuple[Optional[Path], Optional[Path], bool]:
    """Return (md_path, report_folder, is_draft).

    우선순위:
      1) reports/{id}/{id}.md (신규 폴더 구조)
      2) _drafts/{id}/{id}.md (draft 폴더 구조)
      3) reports/{id}.md (레거시 평면 구조 — 읽기 전용 폴백, images 는 {id}_images/ 별도 폴더)
    """
    new_final = _report_folder(report_id, draft=False) / f"{report_id}.md"
    if new_final.exists():
        return new_final, _report_folder(report_id, draft=False), False
    new_draft = _report_folder(report_id, draft=True) / f"{report_id}.md"
    if new_draft.exists():
        return new_draft, _report_folder(report_id, draft=True), True
    legacy = _reports_dir() / f"{report_id}.md"
    if legacy.exists():
        legacy_imgs = _reports_dir() / f"{report_id}_images"
        return legacy, (legacy_imgs if legacy_imgs.exists() else None), False
    return None, None, False


# ─── Evidence building ───────────────────────────────────────────────────────

def _slug(text: str) -> str:
    s = re.sub(r"\s+", "_", text.strip())
    s = re.sub(r"[^0-9A-Za-z가-힣_\-]+", "", s)
    return s[:40] or "report"


def _try_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        s = v.replace(",", "").strip()
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * p
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def _compute_table_stats(output: dict) -> str:
    """컬럼별 프로파일 — 수치: min/p25/median/p75/max/mean/null%. 범주: top-5 + unique count."""
    cols = [c.get("name", "") for c in output.get("columns", [])]
    rows = output.get("rows", [])
    if not cols or not rows:
        return ""
    total = len(rows)
    lines: list[str] = []
    for ci, name in enumerate(cols):
        values = [r[ci] if ci < len(r) else None for r in rows]
        non_null = [v for v in values if v is not None and not (isinstance(v, str) and not v.strip())]
        null_pct = (total - len(non_null)) / total * 100 if total else 0.0
        if not non_null:
            lines.append(f"- `{name}`: 전부 NULL")
            continue
        numeric = [_try_float(v) for v in non_null]
        numeric = [x for x in numeric if x is not None]
        numeric_ratio = len(numeric) / len(non_null)
        if numeric_ratio >= 0.8 and len(numeric) >= 2:
            s = sorted(numeric)
            mean = sum(s) / len(s)
            def fmt(x: float) -> str:
                if abs(x) >= 1000 or x != int(x):
                    return f"{x:,.3g}" if abs(x) < 1 else f"{x:,.2f}"
                return f"{int(x)}"
            lines.append(
                f"- `{name}` (수치, n={len(s)}): "
                f"min={fmt(s[0])}, p25={fmt(_percentile(s,0.25))}, "
                f"median={fmt(_percentile(s,0.5))}, p75={fmt(_percentile(s,0.75))}, "
                f"max={fmt(s[-1])}, mean={fmt(mean)}, null={null_pct:.1f}%"
            )
        else:
            freq: dict[str, int] = {}
            for v in non_null:
                key = str(v)
                freq[key] = freq.get(key, 0) + 1
            top = sorted(freq.items(), key=lambda x: -x[1])[:5]
            top_fmt = ", ".join(f"{k!r}×{v}" for k, v in top)
            unique = len(freq)
            lines.append(
                f"- `{name}` (범주, unique={unique}, null={null_pct:.1f}%): top5 — {top_fmt}"
            )
    return "\n".join(lines)


def _fmt_table_evidence(output: dict, head: int = 15, tail: int = 5) -> str:
    cols = [c.get("name", "") for c in output.get("columns", [])]
    rows = output.get("rows", [])
    row_count = output.get("rowCount", len(rows))
    header = " | ".join(cols)
    sep = " | ".join(["---"] * len(cols)) if cols else "---"

    def fmt_row(r: list) -> str:
        return " | ".join(str(v) if v is not None else "" for v in r)

    if len(rows) <= head + tail:
        body = "\n".join(fmt_row(r) for r in rows)
        note = f"(전체 {row_count}행 표시)"
    else:
        head_rows = "\n".join(fmt_row(r) for r in rows[:head])
        tail_rows = "\n".join(fmt_row(r) for r in rows[-tail:])
        body = f"{head_rows}\n... (중간 {len(rows) - head - tail}행 생략) ...\n{tail_rows}"
        note = f"(전체 {row_count}행 중 상위 {head} + 하위 {tail}행 표시)"

    stats = _compute_table_stats(output)
    parts = [f"{header}\n{sep}\n{body}\n{note}"]
    if stats:
        parts.append("**컬럼 프로파일**:\n" + stats)
    return "\n".join(parts)


def _fmt_chart_evidence(output: dict) -> str:
    meta = output.get("chartMeta") or {}
    title = meta.get("title") or "(제목 없음)"
    xt = meta.get("x_title") or ""
    yt = meta.get("y_title") or ""
    traces = meta.get("traces") or []
    trace_lines = []
    for i, tr in enumerate(traces[:10]):
        parts = [f"#{i + 1}", tr.get("type") or "?", tr.get("name") or ""]
        if tr.get("n_points") is not None:
            parts.append(f"n={tr['n_points']}")
        if tr.get("x_range"):
            parts.append(f"x∈{tr['x_range']}")
        if tr.get("y_range"):
            parts.append(f"y∈{tr['y_range']}")
        trace_lines.append(" ".join(p for p in parts if p))
    more = f"\n(+{len(traces) - 10} traces 더 있음)" if len(traces) > 10 else ""
    return f"제목: {title}\n축: x={xt} / y={yt}\nTraces ({len(traces)}):\n" + "\n".join(trace_lines or ["(trace 없음)"]) + more


def _fmt_output_for_llm(output: Optional[dict]) -> str:
    if not output:
        return "(출력 없음)"
    t = output.get("type", "")
    if t == "table":
        return "[테이블]\n" + _fmt_table_evidence(output)
    if t == "chart":
        return "[차트]\n" + _fmt_chart_evidence(output)
    if t == "stdout":
        content = (output.get("content") or "")[:4000]
        return "[stdout]\n" + (content if content.strip() else "(빈 출력)")
    if t == "error":
        return "[오류]\n" + (output.get("message") or "")[:2000]
    return str(output)[:2000]


def _extract_depends_on(code: str, other_names: set[str]) -> list[str]:
    """셀 코드에서 다른 셀 이름을 식별자로 참조하는지 느슨하게 탐지."""
    if not code or not other_names:
        return []
    tokens = set(re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*\b", code))
    return sorted(tokens & other_names)


def build_evidence(
    notebook_id: str,
    cell_ids: list[str],
) -> tuple[dict, list[dict]]:
    """
    Returns (context, evidence_cells).
    context: {title, description, selected_marts}
    evidence_cells: [{id, name, type, code, memo, insight, output_text, image_png_b64?, depends_on}]
    """
    nb = notebook_store._read_nb(notebook_id)
    vibe = nb.get("metadata", {}).get("vibe", {})
    cell_lookup = {c.get("id"): c for c in nb.get("cells", [])}
    selected_names: set[str] = set()
    for cid in cell_ids:
        c = cell_lookup.get(cid)
        if c:
            nm = c.get("metadata", {}).get("vibe_name")
            if nm:
                selected_names.add(nm)

    evidence: list[dict] = []
    for cid in cell_ids:
        c = cell_lookup.get(cid)
        if not c:
            continue
        m = c.get("metadata", {})
        output = notebook_store._parse_output(c.get("outputs", []))
        name = m.get("vibe_name", cid)
        code = "".join(c.get("source", [])) if isinstance(c.get("source"), list) else c.get("source", "")
        entry = {
            "id": cid,
            "name": name,
            "type": m.get("vibe_type", "python"),
            "code": code,
            "memo": m.get("vibe_memo", "") or "",
            "insight": m.get("vibe_insight", "") or "",
            "output": output,
            "output_text": _fmt_output_for_llm(output),
            "depends_on": _extract_depends_on(code, selected_names - {name}),
        }
        if output and output.get("type") == "chart":
            png_b64 = output.get("imagePngBase64")
            if png_b64:
                entry["image_png_b64"] = png_b64
        evidence.append(entry)

    context = {
        "title": vibe.get("title", ""),
        "description": vibe.get("description", ""),
        "selected_marts": vibe.get("selected_marts", []),
    }
    return context, evidence


# ─── 수치 추출 / 환각 검증 ───────────────────────────────────────────────────

# 단위가 붙은 수치, 또는 4자리 이상 순수 숫자 (%·원·만·억·건·명·개·배·회·시간 등)
_NUMBER_WITH_UNIT_RE = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)"
    r"\s*(%|퍼센트|percent|pct|pp|원|￦|만원|억원|만|억|천|건|명|개|배|회|시간|분|초|bp|건수|회차)"
)
# 단위 없이도 의심스러운 큰 수 (4자리 이상) — 별도 집합
_BIG_NUMBER_RE = re.compile(r"(?<![A-Za-z0-9_.])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d{4,}(?:\.\d+)?)(?![A-Za-z0-9_])")


def _normalize_number(raw: str) -> Optional[float]:
    try:
        return float(raw.replace(",", ""))
    except ValueError:
        return None


def _extract_numbers_with_units(text: str) -> set[tuple[float, str]]:
    out: set[tuple[float, str]] = set()
    for m in _NUMBER_WITH_UNIT_RE.finditer(text or ""):
        v = _normalize_number(m.group(1))
        if v is None:
            continue
        out.add((v, m.group(2)))
    return out


def _extract_big_numbers(text: str) -> set[float]:
    out: set[float] = set()
    for m in _BIG_NUMBER_RE.finditer(text or ""):
        v = _normalize_number(m.group(1))
        if v is not None:
            out.add(v)
    return out


def _collect_evidence_numbers(evidence: list[dict]) -> tuple[set[tuple[float, str]], set[float]]:
    """evidence 전체(출력 텍스트 + 테이블 cell + chart meta + 메모)에서 수치 집합 수집."""
    with_units: set[tuple[float, str]] = set()
    bigs: set[float] = set()

    def ingest(text: str) -> None:
        if not text:
            return
        with_units.update(_extract_numbers_with_units(text))
        bigs.update(_extract_big_numbers(text))

    for e in evidence:
        ingest(e.get("output_text", ""))
        ingest(e.get("memo", ""))
        ingest(e.get("insight", ""))
        out = e.get("output") or {}
        # 테이블 셀 값 숫자 직접 수집 (문자열화 손실 방지)
        if out.get("type") == "table":
            for row in out.get("rows", []) or []:
                for v in row:
                    f = _try_float(v)
                    if f is not None:
                        bigs.add(f)
        elif out.get("type") == "chart":
            # chart meta 안의 모든 스칼라 숫자
            def walk(x: Any) -> None:
                if isinstance(x, (int, float)) and not isinstance(x, bool):
                    bigs.add(float(x))
                elif isinstance(x, dict):
                    for v in x.values():
                        walk(v)
                elif isinstance(x, list):
                    for v in x:
                        walk(v)
            walk(out.get("chartMeta"))
    return with_units, bigs


def _match_number(value: float, pool: set[float], tol: float = 0.005) -> bool:
    """±tol 상대오차로 매칭. 0 은 정확 매칭."""
    if value == 0:
        return 0 in pool
    for p in pool:
        if p == 0:
            continue
        if abs(p - value) / max(abs(value), abs(p)) <= tol:
            return True
    return False


def _validate_report_numbers(
    markdown: str,
    ev_with_units: set[tuple[float, str]],
    ev_bigs: set[float],
) -> list[dict]:
    """본문 수치 중 evidence 에 매칭되지 않는 것들을 반환."""
    suspicious: list[dict] = []
    seen: set[tuple[float, str]] = set()
    ev_pool_numbers = {v for v, _u in ev_with_units} | ev_bigs

    # 단위 붙은 숫자 — 가장 민감
    for m in _NUMBER_WITH_UNIT_RE.finditer(markdown):
        v = _normalize_number(m.group(1))
        if v is None:
            continue
        unit = m.group(2)
        key = (v, unit)
        if key in seen:
            continue
        seen.add(key)
        # 단위 불일치 허용: 값만 일치하면 OK (예: evidence 는 "1000건" 인데 본문 "1,000 건")
        if _match_number(v, ev_pool_numbers):
            continue
        # 퍼센트/비율은 원본 값에서 파생 가능 — 여기는 엄격
        context_start = max(0, m.start() - 40)
        context_end = min(len(markdown), m.end() + 40)
        suspicious.append({
            "value": v,
            "unit": unit,
            "raw": m.group(0),
            "context": markdown[context_start:context_end].replace("\n", " ").strip(),
        })

    return suspicious


# ─── Prompting ───────────────────────────────────────────────────────────────

_COMMON_PRINCIPLES = (
    "## 원칙\n"
    "- 숫자·통계는 반드시 제공된 셀 출력에서만 인용하라. 추측·가공 금지.\n"
    "- 메모·인사이트 필드에 기록된 분석가 노트를 적극 활용하되, 중복되지 않게 본문에서 자연스럽게 녹여 쓰라.\n"
    "- 차트 이미지가 첨부된 셀은 실제로 이미지를 보고 의미 있는 패턴을 서술하라.\n"
    "- 테이블 통계(p25/p75/median/top-5 등) 를 활용해 분포·이상치를 구체적으로 지적하라.\n"
    "- 불필요한 일반론·미사여구 금지. 구체적 수치·비율·이상치 중심.\n"
    "- `[출처: 셀 …]` 같은 별도 인용 표기 금지. 본문 차트·표·수치로 충분.\n"
    "- 취소선(`~~text~~`) 절대 사용 금지. 자체 편집·교정 흔적 금지.\n"
    "- 강조는 `**굵게**` 또는 `_기울임_`만.\n"
)


def _build_outline_system_prompt() -> str:
    return (
        "당신은 사내 광고 플랫폼의 시니어 데이터 분석가입니다. "
        "경영진용 리포트를 작성하기 전에, 주어진 셀 증거를 분석해 **리포트 개요(outline)** 를 JSON 으로 설계하라.\n\n"
        + _COMMON_PRINCIPLES
        + "\n## Outline 출력 규칙\n"
        "- 반드시 **유효한 JSON** 만 출력. 다른 설명·코드 펜스 금지.\n"
        "- 구조:\n"
        "```\n"
        "{\n"
        '  "report_title": "간결한 최종 리포트 제목",\n'
        '  "tldr": ["핵심 발견 1", "핵심 발견 2", ...],   // 3~5개\n'
        '  "sections": [\n'
        "    {\n"
        '      "heading": "## 섹션 제목",\n'
        '      "thesis": "이 섹션이 주장하는 한 문장",\n'
        '      "cite_cells": ["cell_name_1", "cell_name_2"],\n'
        '      "cite_charts": ["chart_cell_name"],    // 이 섹션에서 참조할 차트 (첨부된 것만)\n'
        '      "key_numbers": ["8.4%", "1,234건"]    // 섹션에서 인용할 주요 수치 (evidence 에 있는 것)\n'
        "    }\n"
        "  ],\n"
        '  "insights": ["비즈니스 시사점 1", ...],   // 2~4개\n'
        '  "limitations": ["한계 1", ...]           // 1~3개\n'
        "}\n"
        "```\n"
        "- **첨부된 모든 차트는 최소 한 섹션의 `cite_charts` 에 포함되어야 한다.** 누락 금지.\n"
        "- 섹션은 보통 4~6개. 필수 포함: 발견(Findings), 종합 인사이트.\n"
        "- `cite_cells`, `cite_charts` 에는 evidence 에 등장한 셀 이름만 사용.\n"
    )


def _build_outline_user_prompt(
    context: dict,
    evidence: list[dict],
    goal: str,
    missing_charts_hint: Optional[list[str]] = None,
) -> str:
    marts = ", ".join(context.get("selected_marts") or []) or "(지정 없음)"
    goal_line = goal.strip() or f"{context.get('title','')} — {context.get('description','')}".strip(" —")
    chart_cell_names = [e["name"] for e in evidence if e.get("image_png_b64")]
    chart_block = (
        "## 첨부된 차트 (모두 섹션에 배치해야 함)\n"
        + ("\n".join(f"- {n}" for n in chart_cell_names) if chart_cell_names else "(없음)")
        + "\n"
    )

    lines = [
        f"## 분석 목표\n{goal_line or '(미지정 — 제목/설명으로 추론)'}\n",
        f"## 분석 맥락\n- 제목: {context.get('title','')}\n- 설명: {context.get('description','') or '(없음)'}\n- 사용 마트: {marts}\n",
        chart_block,
        "## 셀별 증거 요약",
    ]
    for i, e in enumerate(evidence, 1):
        deps = ", ".join(e.get("depends_on") or []) or "-"
        section = [
            f"\n### [{i}] `{e['name']}` ({e['type'].upper()})",
            f"- 의존 셀: {deps}",
        ]
        if e.get("memo"):
            section.append(f"- 메모: {e['memo']}")
        if e.get("insight"):
            section.append(f"- 인사이트: {e['insight']}")
        section.append(f"- 출력:\n{e['output_text']}")
        if e.get("image_png_b64"):
            section.append(f"- ⚑ 차트 이미지 첨부됨")
        lines.append("\n".join(section))

    if missing_charts_hint:
        lines.append(
            "\n## ⚠ 이전 시도의 문제\n"
            "다음 차트들이 어떤 섹션에도 포함되지 않았다. 이번엔 반드시 각 섹션의 `cite_charts` 에 배치하라:\n"
            + "\n".join(f"- {n}" for n in missing_charts_hint)
        )
    lines.append("\n---\n**유효한 JSON 만** 출력하라.")
    return "\n".join(lines)


def _build_writing_system_prompt() -> str:
    return (
        "당신은 사내 광고 플랫폼의 시니어 데이터 분석가입니다. "
        "제공된 **Outline 과 증거** 를 바탕으로 경영진이 바로 읽을 수 있는 Markdown 리포트를 작성하라.\n\n"
        + _COMMON_PRINCIPLES
        + "\n## 작성 규칙\n"
        "- Outline 의 섹션 순서·thesis·cite_charts·key_numbers 를 충실히 반영하라. 구조를 이탈하지 말 것.\n"
        "- 각 섹션에서 `cite_charts` 에 지정된 모든 차트를 `{{CHART:cell_name}}` 플레이스홀더로 **단독 라인** 삽입. 앞뒤 빈 줄 포함.\n"
        "- 플레이스홀더 이름은 Outline 및 증거의 셀 이름과 **정확히 일치**시킬 것.\n"
        "- 표는 핵심 수치 중심으로 GFM 테이블로 인라인 작성. 전체 행 복제 금지.\n"
        "- `key_numbers` 에 언급된 수치는 반드시 본문에 등장.\n\n"
        "## 출력 구조\n"
        "1. `# {report_title}`\n"
        "2. `## TL;DR` — Outline.tldr 항목을 불릿으로\n"
        "3. `## 배경 및 가설`\n"
        "4. `## 데이터와 방법`\n"
        "5. Outline.sections 를 차례로 (`## 섹션 제목`)\n"
        "6. `## 종합 인사이트` — Outline.insights\n"
        "7. `## 한계와 후속 과제` — Outline.limitations\n\n"
        "## 문체\n"
        "- 한국어, 단정적 서술체(-다/-이다).\n"
        "- 문단은 짧게. 불필요한 연결어 금지.\n"
        "- 리포트 본문만 출력. ```markdown 펜스 금지. 인사말·설명 금지.\n"
    )


def _build_writing_user_prompt(
    context: dict,
    evidence: list[dict],
    goal: str,
    outline: dict,
) -> str:
    marts = ", ".join(context.get("selected_marts") or []) or "(지정 없음)"
    goal_line = goal.strip() or f"{context.get('title','')} — {context.get('description','')}".strip(" —")

    lines = [
        f"## 분석 목표\n{goal_line or '(미지정)'}\n",
        f"## 분석 맥락\n- 제목: {context.get('title','')}\n- 설명: {context.get('description','') or '(없음)'}\n- 사용 마트: {marts}\n",
        "## Outline (이 구조를 엄수)\n```json",
        json.dumps(outline, ensure_ascii=False, indent=2),
        "```",
        "\n## 셀별 증거",
    ]
    for i, e in enumerate(evidence, 1):
        section = [
            f"\n### [{i}] 셀 `{e['name']}` ({e['type'].upper()})",
            f"**코드**:\n```{e['type']}\n{e['code']}\n```",
            f"**메모(분석가 노트)**:\n{e['memo'] or '(비어있음)'}",
        ]
        if e.get("insight"):
            section.append(f"**인사이트 필드**: {e['insight']}")
        if e.get("depends_on"):
            section.append(f"**의존 셀**: {', '.join(e['depends_on'])}")
        section.append(f"**출력**:\n{e['output_text']}")
        if e.get("image_png_b64"):
            section.append(f"(차트 이미지 첨부됨 — 플레이스홀더: `{{{{CHART:{e['name']}}}}}`)")
        lines.append("\n".join(section))
    lines.append(
        "\n---\n위 Outline 과 증거만 사용하여 Markdown 리포트를 작성하라. "
        "본문만, 원시 마크다운으로만 출력."
    )
    return "\n".join(lines)


# ─── LLM 호출 ────────────────────────────────────────────────────────────────

def _build_image_content_blocks_claude(evidence: list[dict]) -> list[dict]:
    blocks: list[dict] = []
    for e in evidence:
        if e.get("image_png_b64"):
            blocks.append({"type": "text", "text": f"[차트 이미지 — 셀 `{e['name']}`]"})
            blocks.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": e["image_png_b64"]},
            })
    return blocks


def _build_image_parts_gemini(evidence: list[dict]) -> list:
    parts: list = []
    for e in evidence:
        if e.get("image_png_b64"):
            try:
                img_bytes = base64.b64decode(e["image_png_b64"])
                parts.append(genai_types.Part.from_text(text=f"[차트 이미지 — 셀 `{e['name']}`]"))
                parts.append(genai_types.Part.from_bytes(data=img_bytes, mime_type="image/png"))
            except Exception as ex:
                logger.warning("gemini image decode failed for cell %s: %s", e.get("name"), ex)
    return parts


async def _call_claude_text(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    evidence: list[dict],
    max_tokens: int = 8000,
) -> str:
    """Non-stream 단발 호출 — outline JSON 생성용."""
    client = anthropic.AsyncAnthropic(api_key=api_key)
    content: list[dict] = [{"type": "text", "text": user_prompt}]
    content.extend(_build_image_content_blocks_claude(evidence))
    resp = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": content}],
    )
    # concatenate text blocks
    out: list[str] = []
    for b in resp.content:
        if getattr(b, "type", None) == "text":
            out.append(b.text)
    return "".join(out)


async def _call_gemini_text(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    evidence: list[dict],
    max_tokens: int = 8000,
    response_mime_type: Optional[str] = None,
) -> str:
    client = genai.Client(api_key=api_key)
    parts: list = [genai_types.Part.from_text(text=user_prompt)]
    parts.extend(_build_image_parts_gemini(evidence))
    contents = [genai_types.Content(role="user", parts=parts)]
    cfg_kwargs: dict = {
        "system_instruction": system_prompt,
        "temperature": 0.2,
        "max_output_tokens": max_tokens,
    }
    if response_mime_type:
        cfg_kwargs["response_mime_type"] = response_mime_type
    resp = await client.aio.models.generate_content(
        model=model,
        contents=contents,
        config=genai_types.GenerateContentConfig(**cfg_kwargs),
    )
    return getattr(resp, "text", "") or ""


async def _stream_claude(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    evidence: list[dict],
) -> AsyncGenerator[str, None]:
    client = anthropic.AsyncAnthropic(api_key=api_key)
    content: list[dict] = [{"type": "text", "text": user_prompt}]
    content.extend(_build_image_content_blocks_claude(evidence))
    async with client.messages.stream(
        model=model,
        max_tokens=32000,
        system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": content}],
    ) as stream:
        async for event in stream:
            if event.type == "content_block_delta" and event.delta.type == "text_delta":
                yield event.delta.text


async def _stream_gemini(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    evidence: list[dict],
) -> AsyncGenerator[str, None]:
    client = genai.Client(api_key=api_key)
    parts: list = [genai_types.Part.from_text(text=user_prompt)]
    parts.extend(_build_image_parts_gemini(evidence))
    contents = [genai_types.Content(role="user", parts=parts)]
    async for chunk in await client.aio.models.generate_content_stream(
        model=model,
        contents=contents,
        config=genai_types.GenerateContentConfig(
            system_instruction=system_prompt,
            temperature=0.3,
            max_output_tokens=32000,
        ),
    ):
        text = getattr(chunk, "text", None)
        if text:
            yield text


# ─── Outline 파싱 / 검증 ─────────────────────────────────────────────────────

def _parse_outline_json(text: str) -> Optional[dict]:
    """LLM 출력에서 JSON 객체를 방어적으로 추출."""
    if not text:
        return None
    # 코드 펜스 제거
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        candidate = fenced.group(1)
    else:
        # 첫 { 부터 마지막 } 까지
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end < 0 or end <= start:
            return None
        candidate = text[start : end + 1]
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as e:
        logger.warning("outline JSON parse failed: %s", e)
        return None
    return data if isinstance(data, dict) else None


def _validate_outline_coverage(outline: dict, evidence: list[dict]) -> list[str]:
    """첨부된 차트 중 outline 의 어떤 섹션에도 포함되지 않은 것 반환."""
    attached = [e["name"] for e in evidence if e.get("image_png_b64")]
    if not attached:
        return []
    cited: set[str] = set()
    for sec in outline.get("sections", []) or []:
        for c in sec.get("cite_charts", []) or []:
            cited.add(str(c))
    return [n for n in attached if n not in cited]


# ─── 차트 플레이스홀더 주입 ──────────────────────────────────────────────────

_CHART_PLACEHOLDER_RE = re.compile(r"\{\{CHART:([^}]+)\}\}")
_CHART_PLACEHOLDER_LINE_RE = re.compile(r"(?m)^[ \t]*\{\{CHART:[^}]+\}\}[ \t]*\n?")
_STRIKETHROUGH_RE = re.compile(r"~~(.+?)~~", re.DOTALL)


def _norm_cell_name(s: str) -> str:
    return re.sub(r"[^0-9a-z_]+", "", s.strip().lower())


def _safe_image_filename(cell_name: str, used: set[str]) -> str:
    base = _slug(cell_name) or "chart"
    candidate = base
    n = 1
    while candidate in used:
        n += 1
        candidate = f"{base}_{n}"
    used.add(candidate)
    return candidate


def _inject_chart_images(
    markdown: str,
    evidence: list[dict],
    report_id: str,
    target_dir: Path,
) -> tuple[str, dict]:
    """플레이스홀더를 파일 경로 이미지로 치환 + 미삽입/미참조 경고 처리.

    target_dir 는 리포트 폴더 (예: reports/{id}/ 또는 _drafts/{id}/).
    PNG 는 해당 폴더에 평면 저장되고, markdown 은 `./{stem}.png` 로 참조.

    반환값: (new_markdown, notes)
    """
    file_map: dict[str, tuple[str, str]] = {}  # cell_name -> (filename_stem, base64)
    used_files: set[str] = set()
    for e in evidence:
        if e.get("image_png_b64"):
            fname = _safe_image_filename(e["name"], used_files)
            file_map[e["name"]] = (fname, e["image_png_b64"])
    norm_to_orig = {_norm_cell_name(k): k for k in file_map}

    referenced: set[str] = set()
    missing_names: list[str] = []

    def _replace(m: re.Match) -> str:
        name = m.group(1).strip()
        orig = name if name in file_map else norm_to_orig.get(_norm_cell_name(name))
        if not orig:
            missing_names.append(name)
            return f"\n> ⚠ 차트 미삽입: `{name}` (증거에 없음)\n"
        fname = file_map[orig][0]
        referenced.add(fname)
        return f"![{orig}](./{fname}.png)"

    result = _CHART_PLACEHOLDER_RE.sub(_replace, markdown)
    result = _STRIKETHROUGH_RE.sub(r"\1", result)
    result = re.sub(r"(?<!\\)~", r"\\~", result)
    result = re.sub(r"\n{3,}", "\n\n", result)

    unreferenced: list[str] = []
    appendix_lines: list[str] = []
    for orig, (fname, _b64) in file_map.items():
        if fname not in referenced:
            unreferenced.append(orig)
            referenced.add(fname)
            appendix_lines.append(f"\n### {orig}\n\n![{orig}](./{fname}.png)\n")
    if appendix_lines:
        result = result.rstrip() + "\n\n## 부록: 본문 미참조 차트\n" + "".join(appendix_lines)

    if referenced:
        target_dir.mkdir(parents=True, exist_ok=True)
        for _orig, (fname, b64) in file_map.items():
            if fname in referenced:
                try:
                    (target_dir / f"{fname}.png").write_bytes(base64.b64decode(b64))
                except Exception as ex:
                    logger.warning("image save failed %s: %s", fname, ex)

    notes = {
        "missing_charts": sorted(set(missing_names)),
        "unreferenced_charts": unreferenced,
        "saved_images": sorted(referenced),
    }
    return result, notes


# ─── Frontmatter ─────────────────────────────────────────────────────────────

def _yaml_escape(v: Any) -> str:
    if v is None:
        return '""'
    s = str(v).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'


def _build_frontmatter(meta: dict) -> str:
    lines = ["---"]
    for k, v in meta.items():
        if isinstance(v, list):
            if not v:
                lines.append(f"{k}: []")
            else:
                items = ", ".join(_yaml_escape(x) for x in v)
                lines.append(f"{k}: [{items}]")
        elif isinstance(v, dict):
            # dict 는 compact JSON 한 줄로 직렬화해 싣는다 (파서는 raw 문자열로 받음)
            payload = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
            lines.append(f"{k}: {_yaml_escape(payload)}")
        else:
            lines.append(f"{k}: {_yaml_escape(v)}")
    lines.append("---\n")
    return "\n".join(lines)


def _allocate_report_id(title: str, now: datetime) -> str:
    base = f"{now.strftime('%Y%m%d_%H%M%S')}_{_slug(title)}"
    final_root = _reports_dir()
    draft_root = _drafts_dir()
    candidate = base
    n = 1
    while (
        (final_root / candidate).exists()         # 신규 폴더 구조
        or (final_root / f"{candidate}.md").exists()        # 레거시 평면
        or (final_root / f"{candidate}_images").exists()    # 레거시 이미지 폴더
        or (draft_root / candidate).exists()
    ):
        n += 1
        candidate = f"{base}_{n}"
    return candidate


def save_draft(
    markdown_body: str,
    title: str,
    source_notebook_id: str,
    source_cell_ids: list[str],
    goal: str,
    model: str,
    report_id: str,
    created_at: datetime,
    processing_notes: Optional[dict] = None,
    outline: Optional[dict] = None,
) -> dict:
    """미저장(draft) 상태로 _drafts/{id}/ 폴더에 기록. 노트북 reports[] 에는 append 하지 않는다."""
    now = created_at
    folder = _report_folder(report_id, draft=True)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{report_id}.md"

    meta: dict = {
        "id": report_id,
        "title": title,
        "source_notebook_id": source_notebook_id,
        "source_cell_ids": source_cell_ids,
        "goal": goal,
        "model": model,
        "created_at": now.isoformat(),
    }
    if processing_notes:
        meta["processing_notes"] = processing_notes
    if outline:
        meta["outline"] = outline

    content = _build_frontmatter(meta) + markdown_body.strip() + "\n"
    path.write_text(content, encoding="utf-8")

    return {
        "id": report_id,
        "title": title,
        "path": str(path),
        "created_at": now.isoformat(),
        "byte_size": path.stat().st_size,
        "model": model,
        "source_notebook_id": source_notebook_id,
        "is_draft": True,
    }


def promote_draft(report_id: str) -> Optional[dict]:
    """_drafts/{id}/ 폴더 전체를 reports/{id}/ 로 이동 + 노트북 reports[] append.

    이미 영구 저장돼 있으면 no-op 으로 현재 메타만 반환.
    """
    draft_folder = _report_folder(report_id, draft=True)
    final_folder = _report_folder(report_id, draft=False)
    final_md = final_folder / f"{report_id}.md"

    if final_md.exists():
        text = final_md.read_text(encoding="utf-8")
        meta, _ = _parse_frontmatter(text)
        return {
            "id": report_id,
            "title": meta.get("title", report_id),
            "path": str(final_md),
            "created_at": meta.get("created_at", ""),
            "byte_size": final_md.stat().st_size,
            "model": meta.get("model", ""),
            "source_notebook_id": meta.get("source_notebook_id", ""),
            "is_draft": False,
        }

    draft_md = draft_folder / f"{report_id}.md"
    if not draft_md.exists():
        return None

    # 폴더 통째로 rename
    if final_folder.exists():
        import shutil
        shutil.rmtree(final_folder, ignore_errors=True)
    draft_folder.rename(final_folder)

    text = final_md.read_text(encoding="utf-8")
    meta, _ = _parse_frontmatter(text)
    source_notebook_id = meta.get("source_notebook_id", "")
    title = meta.get("title", report_id)
    created_at = meta.get("created_at", "")
    if source_notebook_id:
        try:
            nb = notebook_store._read_nb(source_notebook_id)
            vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
            vibe.setdefault("reports", []).append({
                "report_id": report_id,
                "title": title,
                "created_at": created_at,
            })
            notebook_store._write_nb(source_notebook_id, nb)
        except Exception as e:
            logger.warning("source 노트북 reports[] append 실패: %s", e)

    return {
        "id": report_id,
        "title": title,
        "path": str(final_md),
        "created_at": created_at,
        "byte_size": final_md.stat().st_size,
        "model": meta.get("model", ""),
        "source_notebook_id": source_notebook_id,
        "is_draft": False,
    }


def delete_draft(report_id: str) -> bool:
    """draft 폴더 전체 제거."""
    folder = _report_folder(report_id, draft=True)
    if folder.exists() and folder.is_dir():
        import shutil
        shutil.rmtree(folder, ignore_errors=True)
        return True
    return False


# ─── Pipeline ────────────────────────────────────────────────────────────────

async def _run_outline_pass(
    *,
    api_key: str,
    model: str,
    context: dict,
    evidence: list[dict],
    goal: str,
    is_gemini: bool,
) -> Optional[dict]:
    """2회까지 시도 — 차트 커버리지 확보 못하면 마지막 결과 그대로 반환."""
    system_prompt = _build_outline_system_prompt()
    missing_hint: Optional[list[str]] = None
    last_outline: Optional[dict] = None
    for attempt in range(2):
        user_prompt = _build_outline_user_prompt(context, evidence, goal, missing_hint)
        if is_gemini:
            text = await _call_gemini_text(
                api_key, model, system_prompt, user_prompt, evidence,
                max_tokens=8000, response_mime_type="application/json",
            )
        else:
            text = await _call_claude_text(
                api_key, model, system_prompt, user_prompt, evidence, max_tokens=8000,
            )
        outline = _parse_outline_json(text)
        if not outline:
            logger.warning("outline parse failed on attempt %d", attempt + 1)
            continue
        last_outline = outline
        missing = _validate_outline_coverage(outline, evidence)
        if not missing:
            return outline
        missing_hint = missing
        logger.info("outline missing charts on attempt %d: %s", attempt + 1, missing)
    return last_outline


async def run_report_stream(
    *,
    api_key: str,
    model: str,
    notebook_id: str,
    cell_ids: list[str],
    goal: str,
) -> AsyncGenerator[dict, None]:
    if not api_key:
        yield {"type": "error", "message": "API 키가 설정되지 않았습니다."}
        return

    yield {"type": "stage", "stage": "collecting", "label": "셀 데이터 수집"}
    try:
        context, evidence = build_evidence(notebook_id, cell_ids)
    except Exception as e:
        yield {"type": "error", "message": f"노트북 로드 실패: {e}"}
        return
    if not evidence:
        yield {"type": "error", "message": "선택된 셀에서 유효한 데이터를 찾지 못했습니다."}
        return
    chart_count = sum(1 for e in evidence if e.get("image_png_b64"))
    yield {
        "type": "stage",
        "stage": "collected",
        "label": f"셀 {len(evidence)}개 · 차트 {chart_count}개 수집 완료",
    }

    is_gemini = model.startswith("gemini-")

    # ── Pass 1: Outline ──────────────────────────────────────────────────
    yield {"type": "stage", "stage": "outlining", "label": "리포트 개요 설계"}
    try:
        outline = await _run_outline_pass(
            api_key=api_key, model=model, context=context,
            evidence=evidence, goal=goal, is_gemini=is_gemini,
        )
    except anthropic.APIStatusError as e:
        yield {"type": "error", "message": f"Claude API 오류(outline): {e.message}"}
        return
    except Exception as e:
        logger.exception("outline pass error")
        yield {"type": "error", "message": f"개요 생성 오류: {e}"}
        return

    if outline is None:
        # JSON 실패 시에도 writing pass 로 진행 (outline 없이)
        outline = {"report_title": context.get("title") or "분석 리포트", "sections": []}
        yield {
            "type": "stage", "stage": "outlined",
            "label": "개요 JSON 파싱 실패 — 일반 작성 모드로 폴백",
        }
    else:
        missing_after = _validate_outline_coverage(outline, evidence)
        label = f"섹션 {len(outline.get('sections', []))}개"
        if missing_after:
            label += f" · 차트 커버리지 부분({len(missing_after)}개 미할당)"
        yield {"type": "stage", "stage": "outlined", "label": label}

    # ── Pass 2: Writing ──────────────────────────────────────────────────
    writing_system = _build_writing_system_prompt()
    writing_user = _build_writing_user_prompt(context, evidence, goal, outline)
    stream_fn = _stream_gemini if is_gemini else _stream_claude

    yield {"type": "stage", "stage": "writing", "label": "리포트 작성 중"}
    buffer: list[str] = []
    try:
        async for delta in stream_fn(api_key, model, writing_system, writing_user, evidence):
            buffer.append(delta)
            yield {"type": "delta", "content": delta}
    except anthropic.APIStatusError as e:
        yield {"type": "error", "message": f"Claude API 오류: {e.message}"}
        return
    except Exception as e:
        logger.exception("report stream error")
        yield {"type": "error", "message": f"리포트 생성 오류: {e}"}
        return

    # ── Finalize: 차트 주입 + 검증 + 저장 ─────────────────────────────────
    yield {"type": "stage", "stage": "finalizing", "label": "차트 삽입 · 수치 검증 · 저장"}
    title = outline.get("report_title") if outline else None
    title = title or context.get("title") or "분석 리포트"
    created_at = datetime.now()
    report_id = _allocate_report_id(title, created_at)

    markdown_body = "".join(buffer)
    markdown_body, chart_notes = _inject_chart_images(
        markdown_body, evidence, report_id,
        target_dir=_report_folder(report_id, draft=True),
    )

    # 수치 검증
    ev_with_units, ev_bigs = _collect_evidence_numbers(evidence)
    suspicious = _validate_report_numbers(markdown_body, ev_with_units, ev_bigs)

    processing_notes = {
        "missing_charts": chart_notes["missing_charts"],
        "unreferenced_charts": chart_notes["unreferenced_charts"],
        "suspicious_numbers": suspicious[:50],  # 상한
        "suspicious_number_count": len(suspicious),
        "outline_sections": len((outline or {}).get("sections", []) or []),
    }

    try:
        saved = save_draft(
            markdown_body=markdown_body,
            title=title,
            source_notebook_id=notebook_id,
            source_cell_ids=cell_ids,
            goal=goal,
            model=model,
            report_id=report_id,
            created_at=created_at,
            processing_notes=processing_notes,
            outline=outline,
        )
    except Exception as e:
        logger.exception("report save error")
        yield {"type": "error", "message": f"리포트 임시 저장 실패: {e}"}
        return

    yield {"type": "meta", "processing_notes": processing_notes, "outline": outline}
    yield {"type": "complete", **saved}


# ─── 리스트 / 조회 / 삭제 ────────────────────────────────────────────────────

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm_block = m.group(1)
    rest = text[m.end():]
    meta: dict = {}
    for line in fm_block.splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k = k.strip()
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            inner = v[1:-1].strip()
            if not inner:
                meta[k] = []
            else:
                items = []
                for part in re.findall(r'"((?:[^"\\]|\\.)*)"', inner):
                    items.append(part.replace('\\"', '"').replace("\\\\", "\\"))
                meta[k] = items
        elif v.startswith('"') and v.endswith('"'):
            raw = v[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            # processing_notes / outline 은 JSON 역직렬화
            if k in ("processing_notes", "outline"):
                try:
                    meta[k] = json.loads(raw)
                    continue
                except json.JSONDecodeError:
                    pass
            meta[k] = raw
        else:
            meta[k] = v
    return meta, rest


def list_reports() -> list[dict]:
    """영구 저장된 리포트만 반환 (draft 제외). 신규 폴더 구조 + 레거시 평면 .md 동시 지원."""
    root = _reports_dir()
    md_paths: list[Path] = []

    # 1) 신규 구조: reports/{id}/{id}.md
    for sub in root.iterdir():
        if not sub.is_dir() or sub.name.startswith("_") or sub.name.startswith("."):
            continue
        md = sub / f"{sub.name}.md"
        if md.exists():
            md_paths.append(md)

    # 2) 레거시 구조: reports/{id}.md (루트 직계)
    md_paths.extend(p for p in root.glob("*.md") if p.parent == root)

    result = []
    for p in sorted(md_paths, key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            text = p.read_text(encoding="utf-8")
            meta, _ = _parse_frontmatter(text)
            stem = meta.get("id") or (p.parent.name if p.parent != root else p.stem)
            result.append({
                "id": stem,
                "title": meta.get("title", stem),
                "created_at": meta.get("created_at", datetime.fromtimestamp(p.stat().st_mtime).isoformat()),
                "model": meta.get("model", ""),
                "source_notebook_id": meta.get("source_notebook_id", ""),
                "goal": meta.get("goal", ""),
                "byte_size": p.stat().st_size,
            })
        except Exception as e:
            logger.warning("report parse failed for %s: %s", p.name, e)
    return result


def get_report(report_id: str) -> Optional[dict]:
    md_path, _imgs, is_draft = _resolve_report_paths(report_id)
    if md_path is None:
        return None
    text = md_path.read_text(encoding="utf-8")
    meta, body = _parse_frontmatter(text)
    return {
        "id": meta.get("id", report_id),
        "title": meta.get("title", report_id),
        "created_at": meta.get("created_at", ""),
        "model": meta.get("model", ""),
        "source_notebook_id": meta.get("source_notebook_id", ""),
        "source_cell_ids": meta.get("source_cell_ids", []),
        "goal": meta.get("goal", ""),
        "markdown": body,
        "processing_notes": meta.get("processing_notes") or None,
        "outline": meta.get("outline") or None,
        "is_draft": is_draft,
    }


def delete_report(report_id: str) -> bool:
    """영구 저장된 리포트 삭제 — 신규 폴더 구조와 레거시 평면 구조 모두 지원."""
    import shutil
    found = False
    # 신규: reports/{id}/
    folder = _report_folder(report_id, draft=False)
    if folder.exists() and folder.is_dir():
        shutil.rmtree(folder, ignore_errors=True)
        found = True
    # 레거시: reports/{id}.md + reports/{id}_images/
    legacy_md = _reports_dir() / f"{report_id}.md"
    legacy_imgs = _reports_dir() / f"{report_id}_images"
    if legacy_md.exists():
        legacy_md.unlink()
        found = True
    if legacy_imgs.exists() and legacy_imgs.is_dir():
        shutil.rmtree(legacy_imgs, ignore_errors=True)
        found = True
    return found


def get_asset_path(report_id: str, filename: str) -> Optional[Path]:
    """report 폴더 하위의 단일 PNG 만 허용. 신규 폴더 / draft / 레거시 순으로 탐색."""
    if "/" in filename or "\\" in filename or ".." in filename or filename.startswith("."):
        return None
    if not re.fullmatch(r"[A-Za-z0-9_\-]+\.png", filename):
        return None
    candidates: list[Path] = [
        _report_folder(report_id, draft=False),  # 신규 영구 폴더
        _report_folder(report_id, draft=True),   # draft 폴더
        _reports_dir() / f"{report_id}_images",  # 레거시 이미지 폴더
    ]
    for d in candidates:
        if not d.exists():
            continue
        p = (d / filename).resolve()
        try:
            p.relative_to(d.resolve())
        except ValueError:
            continue
        if p.exists() and p.is_file():
            return p
    return None
