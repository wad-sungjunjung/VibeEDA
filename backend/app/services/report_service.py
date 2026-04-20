"""Report generation — 선택된 셀의 출력·메모를 바탕으로 시니어 분석가 수준 Markdown 리포트 생성.

저장 위치: ~/vibe-notebooks/reports/{YYYYMMDD_HHmm}_{slug}.md
파일 내부: YAML frontmatter + Markdown 본문 (차트 이미지는 data URI)
"""
from __future__ import annotations

import base64
import json
import re
import logging
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator, Optional

import anthropic
from google import genai
from google.genai import types as genai_types

from . import notebook_store

logger = logging.getLogger(__name__)


def _reports_dir() -> Path:
    d = notebook_store.NOTEBOOKS_DIR / "reports"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ─── Evidence building ───────────────────────────────────────────────────────

def _slug(text: str) -> str:
    s = re.sub(r"\s+", "_", text.strip())
    s = re.sub(r"[^0-9A-Za-z가-힣_\-]+", "", s)
    return s[:40] or "report"


def _fmt_table_evidence(output: dict, max_rows: int = 20) -> str:
    cols = [c.get("name", "") for c in output.get("columns", [])]
    rows = output.get("rows", [])[:max_rows]
    row_count = output.get("rowCount", len(rows))
    header = " | ".join(cols)
    sep = "-" * max(len(header), 4)
    body = "\n".join(" | ".join(str(v) if v is not None else "" for v in r) for r in rows)
    note = f"\n(전체 {row_count}행 중 상위 {len(rows)}행 표시)" if row_count > len(rows) else f"\n(전체 {row_count}행)"
    return f"{header}\n{sep}\n{body}{note}"


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
        trace_lines.append(" ".join(p for p in parts if p))
    return f"제목: {title}\n축: x={xt} / y={yt}\nTraces ({len(traces)}):\n" + "\n".join(trace_lines or ["(trace 없음)"])


def _fmt_output_for_llm(output: Optional[dict]) -> str:
    if not output:
        return "(출력 없음)"
    t = output.get("type", "")
    if t == "table":
        return "[테이블]\n" + _fmt_table_evidence(output)
    if t == "chart":
        return "[차트]\n" + _fmt_chart_evidence(output)
    if t == "stdout":
        content = (output.get("content") or "")[:2000]
        return "[stdout]\n" + (content if content.strip() else "(빈 출력)")
    if t == "error":
        return "[오류]\n" + (output.get("message") or "")[:2000]
    return str(output)[:2000]


def build_evidence(
    notebook_id: str,
    cell_ids: list[str],
) -> tuple[dict, list[dict]]:
    """
    Returns (context, evidence_cells).
    context: {title, description, selected_marts}
    evidence_cells: [{id, name, type, code, memo, insight, output_text, image_png_b64?}]
    """
    nb = notebook_store._read_nb(notebook_id)
    vibe = nb.get("metadata", {}).get("vibe", {})
    cell_lookup = {
        c.get("id"): c
        for c in nb.get("cells", [])
    }
    evidence: list[dict] = []
    for cid in cell_ids:
        c = cell_lookup.get(cid)
        if not c:
            continue
        m = c.get("metadata", {})
        output = notebook_store._parse_output(c.get("outputs", []))
        entry = {
            "id": cid,
            "name": m.get("vibe_name", cid),
            "type": m.get("vibe_type", "python"),
            "code": "".join(c.get("source", [])) if isinstance(c.get("source"), list) else c.get("source", ""),
            "memo": m.get("vibe_memo", "") or "",
            "insight": m.get("vibe_insight", "") or "",
            "output": output,
            "output_text": _fmt_output_for_llm(output),
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


# ─── Prompting ───────────────────────────────────────────────────────────────

def _build_system_prompt() -> str:
    return (
        "당신은 사내 광고 플랫폼의 시니어 데이터 분석가입니다. "
        "주어진 노트북 셀들의 코드·출력·메모를 바탕으로 **경영진이 바로 읽을 수 있는 Markdown 리포트**를 작성하세요.\n\n"
        "## 원칙\n"
        "- 숫자·통계는 반드시 제공된 셀 출력에서만 인용하라. 추측·가공 금지.\n"
        "- 메모에 기록된 인사이트를 적극 활용하되, 중복되지 않게 본문에서 자연스럽게 녹여 쓰라.\n"
        "- 차트 이미지가 첨부된 셀은 실제로 이미지를 보고 의미 있는 패턴을 서술하라. 차트 이미지는 본문에 플레이스홀더로 삽입한다(아래 규칙 참고).\n"
        "- 테이블은 핵심 지표만 추려 GFM 테이블로 인라인 삽입한다(너무 많으면 상위 5~10행).\n"
        "- 불필요한 일반론·미사여구 금지. 구체적 수치·비율·이상치 중심.\n"
        "- **근거 표시는 본문의 차트·표·수치로 충분하다. `[출처: 셀 …]` 같은 별도 인용 표기를 쓰지 말 것.**\n"
        "- **취소선(`~~text~~`) 절대 사용 금지.** 자체 편집·교정 흔적(줄 긋고 고쳐쓰기) 금지. 최종 문장만 남겨라.\n"
        "- 수식어 강조가 필요하면 `**굵게**` 또는 `_기울임_`만 쓰고, 그 외 텍스트 장식 문법은 쓰지 말라.\n\n"
        "## 출력 구조 (반드시 이 순서로)\n"
        "1. `# {제목}`\n"
        "2. `## TL;DR` — 핵심 발견 3~5개 불릿\n"
        "3. `## 배경 및 가설` — 분석 목표, 대상 데이터, 가설\n"
        "4. `## 데이터와 방법` — 사용한 마트·지표·집계 기준 (간결하게)\n"
        "5. `## 발견` — 셀별 근거를 차트·표·수치로 엮어 서술.\n"
        "   - **첨부된 모든 고유 차트는 발견 섹션 내 관련 단락에 반드시 한 번씩 `{{CHART:cell_name}}` 플레이스홀더로 삽입하라.** 서버가 저장된 PNG 링크로 치환한다. 동일한 figure가 여러 셀에 중복 존재하면 가장 대표 셀 한 번만 참조해도 된다. 차트를 생략하지 말 것.\n"
        "   - 플레이스홀더는 **단독 라인**으로 배치(앞뒤 빈 줄). `cell_name`은 사용자 프롬프트 **\"차트 이미지 첨부됨\"** 으로 표시된 셀 이름에 한한다. 그 외의 이름을 넣지 말 것.\n"
        "   - 테이블을 인용할 때는 핵심 행만 간추려 GFM 테이블로 직접 작성.\n"
        "6. `## 종합 인사이트` — 발견들을 엮어 비즈니스 시사점·행동 제안 2~4개\n"
        "7. `## 한계와 후속 과제` — 데이터·방법의 한계와 추가 검증 제안\n\n"
        "## 문체\n"
        "- 모든 문장은 한국어, 경어체 하지 말고 단정적 서술체(-다/-이다).\n"
        "- 문단은 짧게. 불필요한 연결어 금지.\n"
    )


def _build_user_prompt(context: dict, evidence: list[dict], goal: str) -> str:
    marts = ", ".join(context.get("selected_marts") or []) or "(지정 없음)"
    goal_line = goal.strip() or f"{context.get('title', '')} — {context.get('description', '')}".strip(" —")
    chart_cell_names = [e["name"] for e in evidence if e.get("image_png_b64")]
    if chart_cell_names:
        chart_block = (
            "## 사용 가능한 차트 (반드시 발견 섹션에 모두 참조)\n"
            + "\n".join(f"- `{{{{CHART:{n}}}}}`" for n in chart_cell_names)
            + "\n"
        )
    else:
        chart_block = "## 사용 가능한 차트\n(없음 — 표와 수치로만 서술)\n"
    lines = [
        f"## 분석 목표 (사용자 입력)\n{goal_line or '(미지정 — 분석 제목/설명을 기반으로 추론)'}\n",
        f"## 분석 맥락\n- 제목: {context.get('title', '')}\n- 설명: {context.get('description', '') or '(없음)'}\n- 사용 마트: {marts}\n",
        chart_block,
        "## 셀별 증거",
    ]
    for i, e in enumerate(evidence, 1):
        section = [
            f"\n### [{i}] 셀 `{e['name']}` ({e['type'].upper()})",
            f"**코드**:\n```{e['type']}\n{e['code']}\n```",
            f"**메모(분석가 노트)**:\n{e['memo'] or '(비어있음)'}",
        ]
        if e.get("insight"):
            section.append(f"**인사이트 필드**: {e['insight']}")
        section.append(f"**출력 요약**:\n{e['output_text']}")
        if e.get("image_png_b64"):
            section.append(f"(차트 이미지 첨부됨 — 플레이스홀더: `{{{{CHART:{e['name']}}}}}`)")
        lines.append("\n".join(section))
    lines.append(
        "\n---\n위 정보만을 근거로, 시스템 프롬프트의 구조를 따르는 Markdown 리포트를 작성하라. "
        "**리포트 본문만 출력**하라. 다른 설명·인사말 금지. ```markdown 펜스로 감싸지 말고 원시 마크다운만 출력."
    )
    return "\n".join(lines)


# ─── LLM streams ─────────────────────────────────────────────────────────────

async def _stream_claude(
    api_key: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    evidence: list[dict],
) -> AsyncGenerator[str, None]:
    client = anthropic.AsyncAnthropic(api_key=api_key)
    # user content: 텍스트 + 각 차트 이미지 블록
    content: list[dict] = [{"type": "text", "text": user_prompt}]
    for e in evidence:
        if e.get("image_png_b64"):
            content.append({
                "type": "text",
                "text": f"[차트 이미지 — 셀 `{e['name']}`]"
            })
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": e["image_png_b64"]},
            })
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
    for e in evidence:
        if e.get("image_png_b64"):
            try:
                img_bytes = base64.b64decode(e["image_png_b64"])
                parts.append(genai_types.Part.from_text(text=f"[차트 이미지 — 셀 `{e['name']}`]"))
                parts.append(genai_types.Part.from_bytes(data=img_bytes, mime_type="image/png"))
            except Exception:
                pass
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


# ─── Post-processing: CHART 플레이스홀더 → data URI ───────────────────────────

_CHART_PLACEHOLDER_RE = re.compile(r"\{\{CHART:([^}]+)\}\}")
# 단독 라인으로 남은 플레이스홀더를 지울 때 앞뒤 빈줄까지 제거하기 위한 패턴
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


def _inject_chart_images(markdown: str, evidence: list[dict], report_id: str) -> str:
    """플레이스홀더를 파일 경로 기반 이미지로 치환하고, 실제로 참조된 이미지만 디스크에 저장.

    저장 위치: reports/{report_id}_images/{safe_name}.png
    MD 본문에는 상대 경로 `./{report_id}_images/{safe_name}.png` 를 넣어 .md 다운로드시 함께 이동하기 쉽게 한다.
    """
    file_map: dict[str, tuple[str, str]] = {}  # cell_name -> (filename_stem, base64)
    used_files: set[str] = set()
    for e in evidence:
        if e.get("image_png_b64"):
            fname = _safe_image_filename(e["name"], used_files)
            file_map[e["name"]] = (fname, e["image_png_b64"])
    # 정규화 이름 → 원본 이름 매핑 (느슨 매칭)
    norm_to_orig = {_norm_cell_name(k): k for k in file_map}

    referenced: set[str] = set()

    def _replace(m: re.Match) -> str:
        name = m.group(1).strip()
        orig = name if name in file_map else norm_to_orig.get(_norm_cell_name(name))
        if not orig:
            return ""
        fname = file_map[orig][0]
        referenced.add(fname)
        return f"![{orig}](./{report_id}_images/{fname}.png)"

    result = _CHART_PLACEHOLDER_RE.sub(_replace, markdown)
    result = _CHART_PLACEHOLDER_LINE_RE.sub("", result)
    result = _STRIKETHROUGH_RE.sub(r"\1", result)
    # 한국어 본문에 자주 섞이는 범위 기호 ~ (예: "2~4만원") 가 GFM 취소선으로 오인되지 않도록
    # 이미 \~ 로 이스케이프된 경우를 제외하고 모두 \~ 로 바꾼다.
    result = re.sub(r"(?<!\\)~", r"\\~", result)
    result = re.sub(r"\n{3,}", "\n\n", result)

    # 참조된 이미지만 디스크에 기록
    if referenced:
        images_dir = _reports_dir() / f"{report_id}_images"
        images_dir.mkdir(parents=True, exist_ok=True)
        for _orig, (fname, b64) in file_map.items():
            if fname in referenced:
                try:
                    (images_dir / f"{fname}.png").write_bytes(base64.b64decode(b64))
                except Exception as e:
                    logger.warning("image save failed %s: %s", fname, e)
    return result


# ─── Frontmatter + 저장 ──────────────────────────────────────────────────────

def _yaml_escape(v: str) -> str:
    if v is None:
        return '""'
    s = str(v).replace('"', '\\"')
    return f'"{s}"'


def _build_frontmatter(meta: dict) -> str:
    lines = ["---"]
    for k, v in meta.items():
        if isinstance(v, list):
            items = ", ".join(_yaml_escape(x) for x in v)
            lines.append(f"{k}: [{items}]")
        else:
            lines.append(f"{k}: {_yaml_escape(v)}")
    lines.append("---\n")
    return "\n".join(lines)


def _allocate_report_id(title: str, now: datetime) -> str:
    """충돌 없는 report_id 를 결정. .md 파일 또는 이미지 폴더가 이미 존재하면 접미를 붙인다."""
    base = f"{now.strftime('%Y%m%d_%H%M%S')}_{_slug(title)}"
    d = _reports_dir()
    candidate = base
    n = 1
    while (d / f"{candidate}.md").exists() or (d / f"{candidate}_images").exists():
        n += 1
        candidate = f"{base}_{n}"
    return candidate


def save_report(
    markdown_body: str,
    title: str,
    source_notebook_id: str,
    source_cell_ids: list[str],
    goal: str,
    model: str,
    report_id: str,
    created_at: datetime,
) -> dict:
    now = created_at
    path = _reports_dir() / f"{report_id}.md"

    meta = {
        "id": report_id,
        "title": title,
        "source_notebook_id": source_notebook_id,
        "source_cell_ids": source_cell_ids,
        "goal": goal,
        "model": model,
        "created_at": now.isoformat(),
    }
    content = _build_frontmatter(meta) + markdown_body.strip() + "\n"
    path.write_text(content, encoding="utf-8")

    # 원본 노트북에 참조 append
    try:
        nb = notebook_store._read_nb(source_notebook_id)
        vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
        vibe.setdefault("reports", []).append({
            "report_id": report_id,
            "title": title,
            "created_at": now.isoformat(),
        })
        notebook_store._write_nb(source_notebook_id, nb)
    except Exception as e:
        logger.warning("source 노트북 reports[] append 실패: %s", e)

    return {
        "id": report_id,
        "title": title,
        "path": str(path),
        "created_at": now.isoformat(),
        "byte_size": path.stat().st_size,
        "model": model,
        "source_notebook_id": source_notebook_id,
    }


# ─── 파이프라인 ──────────────────────────────────────────────────────────────

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

    system_prompt = _build_system_prompt()
    user_prompt = _build_user_prompt(context, evidence, goal)

    is_gemini = model.startswith("gemini-")
    stream_fn = _stream_gemini if is_gemini else _stream_claude

    yield {"type": "stage", "stage": "writing", "label": "리포트 작성 중"}
    buffer: list[str] = []
    try:
        async for delta in stream_fn(api_key, model, system_prompt, user_prompt, evidence):
            buffer.append(delta)
            yield {"type": "delta", "content": delta}
    except anthropic.APIStatusError as e:
        yield {"type": "error", "message": f"Claude API 오류: {e.message}"}
        return
    except Exception as e:
        logger.exception("report stream error")
        yield {"type": "error", "message": f"리포트 생성 오류: {e}"}
        return

    yield {"type": "stage", "stage": "finalizing", "label": "차트 이미지 삽입·저장"}
    title = context.get("title") or "분석 리포트"
    created_at = datetime.now()
    report_id = _allocate_report_id(title, created_at)

    markdown_body = "".join(buffer)
    markdown_body = _inject_chart_images(markdown_body, evidence, report_id)

    try:
        saved = save_report(
            markdown_body=markdown_body,
            title=title,
            source_notebook_id=notebook_id,
            source_cell_ids=cell_ids,
            goal=goal,
            model=model,
            report_id=report_id,
            created_at=created_at,
        )
    except Exception as e:
        logger.exception("report save error")
        yield {"type": "error", "message": f"리포트 저장 실패: {e}"}
        return

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
                    items.append(part.replace('\\"', '"'))
                meta[k] = items
        elif v.startswith('"') and v.endswith('"'):
            meta[k] = v[1:-1].replace('\\"', '"')
        else:
            meta[k] = v
    return meta, rest


def list_reports() -> list[dict]:
    d = _reports_dir()
    result = []
    for p in sorted(d.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            text = p.read_text(encoding="utf-8")
            meta, _ = _parse_frontmatter(text)
            result.append({
                "id": meta.get("id", p.stem),
                "title": meta.get("title", p.stem),
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
    p = _reports_dir() / f"{report_id}.md"
    if not p.exists():
        return None
    text = p.read_text(encoding="utf-8")
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
    }


def delete_report(report_id: str) -> bool:
    p = _reports_dir() / f"{report_id}.md"
    images_dir = _reports_dir() / f"{report_id}_images"
    found = False
    if p.exists():
        p.unlink()
        found = True
    if images_dir.exists() and images_dir.is_dir():
        import shutil
        shutil.rmtree(images_dir, ignore_errors=True)
        found = True
    return found


def get_asset_path(report_id: str, filename: str) -> Optional[Path]:
    """보안 검증: report_id_images/ 하위의 단일 파일명만 허용. 상위 이탈·구분자 금지."""
    if "/" in filename or "\\" in filename or ".." in filename or filename.startswith("."):
        return None
    # 확장자 화이트리스트
    if not re.fullmatch(r"[A-Za-z0-9_\-]+\.png", filename):
        return None
    d = _reports_dir() / f"{report_id}_images"
    p = (d / filename).resolve()
    # 실제 경로가 images_dir 아래에 있는지 확인
    try:
        p.relative_to(d.resolve())
    except ValueError:
        return None
    if not p.exists() or not p.is_file():
        return None
    return p
