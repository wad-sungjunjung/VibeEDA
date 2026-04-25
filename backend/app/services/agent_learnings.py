"""세션 간 학습 누적 — 노트북별 `learnings.md` 영속화.

목적: 한 노트북에서 여러 세션을 거치며 발견한 안정적인 사실들을 누적해, 다음 세션의
시스템 프롬프트에 자동 주입함으로써 "이미 검증한 사실을 또 묻지 않는" 시니어다움을 만든다.

저장 위치: `~/vibe-notebooks/.vibe/learnings/{notebook_id}.md`

기록 시점:
  - synthesize_report 호출 시점에 state.findings 중 confidence='high' 인 것만 append.
  - 같은 claim 이 이미 있으면 dedup (간단한 lower-cased prefix 비교).

읽기 시점:
  - run_agent_stream 진입 시 _build_system_prompt 가 prefix 로 주입.
  - 길이 상한: 1500자 (그 이상이면 가장 최근 N 개만).

주의: 시간이 지나며 사실이 바뀔 수 있으므로 (정책 변경, 데이터 갱신) 각 entry 에 timestamp 부착.
사용자가 명시적으로 "옛 데이터" 라고 부정하면 해당 entry 가 stale 임을 모델이 인지.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


def _learnings_dir() -> Path:
    base = Path.home() / "vibe-notebooks" / ".vibe" / "learnings"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _learnings_path(notebook_id: str) -> Path:
    safe = "".join(c for c in (notebook_id or "default") if c.isalnum() or c in ("-", "_")) or "default"
    return _learnings_dir() / f"{safe}.md"


_MAX_PROMPT_BYTES = 1500   # 시스템 프롬프트에 주입되는 상한
_MAX_FILE_BYTES = 8000     # 파일 자체 상한 — 그 이상이면 앞에서 자름 (FIFO)


def append_findings(
    notebook_id: str,
    findings: list[dict],
    *,
    session_summary: str = "",
    timestamp_iso: str = "",
) -> int:
    """state.findings 중 high 등급만 누적. 반환: 새로 추가된 entry 수."""
    if not notebook_id or not findings:
        return 0
    high = [f for f in findings if (f.get("confidence") or "").lower() == "high"]
    if not high:
        return 0

    p = _learnings_path(notebook_id)
    existing = p.read_text(encoding="utf-8") if p.exists() else ""
    existing_low = existing.lower()

    new_entries: list[str] = []
    for f in high:
        claim = (f.get("claim") or "").strip()
        if not claim:
            continue
        # 간단 dedup — 청구문 첫 60자 prefix 가 이미 있으면 skip
        key = claim[:60].lower()
        if key in existing_low:
            continue
        caveats = (f.get("caveats") or "").strip()
        line = f"- [{timestamp_iso or 'unknown'}] {claim}"
        if caveats:
            line += f"  *(caveat: {caveats})*"
        new_entries.append(line)

    if not new_entries:
        return 0

    if not existing:
        body = "# 누적 learnings\n\n*이 노트북에서 검증된 high-confidence 결론이 자동 누적됩니다.*\n\n"
    else:
        body = existing
    if session_summary:
        body += f"\n## {timestamp_iso or 'session'}: {session_summary}\n"
    body += "\n".join(new_entries) + "\n"

    # 파일 크기 cap — 너무 커지면 앞부분 잘라냄 (헤더 보존)
    if len(body) > _MAX_FILE_BYTES:
        # 헤더 + 마지막 _MAX_FILE_BYTES * 0.6 만 남김
        header_end = body.find("\n\n", body.find("# 누적 learnings"))
        if header_end > 0:
            header = body[: header_end + 2]
            tail = body[-int(_MAX_FILE_BYTES * 0.6):]
            tail = tail[tail.find("\n") + 1:] if "\n" in tail else tail
            body = header + "*(이전 항목 일부 잘림 — 파일 크기 cap)*\n\n" + tail

    p.write_text(body, encoding="utf-8")
    return len(new_entries)


def load_for_prompt(notebook_id: str) -> str:
    """run_agent_stream 진입 시 시스템 프롬프트 prefix 로 주입할 텍스트 반환.

    빈 문자열이면 주입할 게 없음.
    """
    if not notebook_id:
        return ""
    p = _learnings_path(notebook_id)
    if not p.exists():
        return ""
    try:
        body = p.read_text(encoding="utf-8")
    except Exception:
        return ""
    if not body.strip():
        return ""
    # 길이 cap — 마지막 _MAX_PROMPT_BYTES 만 사용 (최신 우선)
    if len(body) > _MAX_PROMPT_BYTES:
        body = "*(앞부분 일부 생략)*\n\n" + body[-_MAX_PROMPT_BYTES:]
    return (
        "\n## 📚 이전 세션의 누적 발견 (high-confidence)\n"
        "이 노트북에서 이전에 검증된 사실들 — 같은 분석을 처음부터 다시 하지 말고 참조하세요.\n"
        "단, 시간이 지나 데이터가 갱신됐을 수 있으니 사용자가 '최신' 을 강조하면 재검증 권장.\n\n"
        + body + "\n"
    )
