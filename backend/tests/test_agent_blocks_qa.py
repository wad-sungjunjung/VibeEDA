"""에이전트 blocks[] 저장 라운드트립 QA.

notebook_store.add_agent_message 가 blocks 를 보존하고
_fmt_agent_messages 응답에 그대로 실려 나오는지 + 레거시(blocks 없음) 호환 확인.
"""
import sys, tempfile, json, uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.services import notebook_store as ns


def assert_eq(a, b, label):
    status = "PASS" if a == b else "FAIL"
    print(f"[{status}] {label}: got={a!r} expected={b!r}")
    if a != b:
        raise AssertionError(label)


def assert_true(cond, label):
    print(f"[{'PASS' if cond else 'FAIL'}] {label}")
    if not cond:
        raise AssertionError(label)


tmp = tempfile.TemporaryDirectory()
orig = ns.NOTEBOOKS_DIR
ns.NOTEBOOKS_DIR = Path(tmp.name)

try:
    # 노트북 준비
    nb_id = "nb-" + uuid.uuid4().hex[:8]
    nb = {
        "nbformat": 4,
        "metadata": {"vibe": {"title": "t", "description": ""}},
        "cells": [],
    }
    (Path(tmp.name) / f"{nb_id}.ipynb").write_text(json.dumps(nb), encoding="utf-8")

    print("\n=== 1) blocks 있는 저장 ===")
    blocks = [
        {"type": "text", "text": "데이터베이스 연결 확인합니다."},
        {"type": "tool_use", "tool": "query_sql", "input": {"sql": "SELECT 1"}},
        {"type": "text", "text": "이제 실행합니다."},
        {"type": "cell_created", "cell_id": "c1", "cell_type": "sql", "cell_name": "q1", "code": "SELECT 1"},
        {"type": "cell_executed", "cell_id": "c1", "is_error": False, "error_message": ""},
        {"type": "cell_memo_updated", "cell_id": "c1", "memo": "첫 쿼리"},
        {"type": "text", "text": "완료했습니다."},
    ]
    ns.add_agent_message(nb_id, "user", "연결했어.")
    ns.add_agent_message(nb_id, "assistant", "데이터베이스 연결 확인합니다.이제 실행합니다.완료했습니다.",
                         created_cell_ids=["c1"], blocks=blocks)

    # 저장 파일을 직접 읽어 구조 검증
    nb_read = json.loads((Path(tmp.name) / f"{nb_id}.ipynb").read_text(encoding="utf-8"))
    history = nb_read["metadata"]["vibe"]["agent_history"]
    assert_eq(len(history), 2, "2 엔트리 저장됨")
    assert_true("blocks" not in history[0], "user 엔트리에는 blocks 없음")
    assert_true(history[1]["blocks"] == blocks, "assistant blocks 라운드트립")

    print("\n=== 2) 레거시(blocks 없는) 엔트리 응답 호환 ===")
    nb_raw = nb_read
    nb_raw["metadata"]["vibe"]["agent_history"].insert(0, {
        "role": "assistant", "content": "레거시 어시스턴트 메시지",
        "created_cell_ids": [], "ts": "2026-01-01T00:00:00",
        # blocks 필드 없음 (레거시)
    })
    (Path(tmp.name) / f"{nb_id}.ipynb").write_text(json.dumps(nb_raw), encoding="utf-8")

    fmt = ns._fmt_agent_messages(nb_raw["metadata"]["vibe"])
    assert_eq(len(fmt), 3, "응답 엔트리 수")
    assert_eq(fmt[0]["blocks"], [], "레거시는 blocks=[]")
    assert_true(len(fmt[2]["blocks"]) == 7, "신규 엔트리 blocks 보존")

    print("\n=== 3) get_notebook 통합 응답 ===")
    # get_notebook 경로가 _fmt_agent_messages 를 호출하는지 간접 검증
    detail = ns.get_notebook(nb_id)
    assert_true("agent_messages" in detail, "detail 에 agent_messages 필드")
    assert_true(any("blocks" in m for m in detail["agent_messages"]), "응답에 blocks 전달")

    print("\n✅ ALL BLOCKS QA PASSED")
finally:
    ns.NOTEBOOKS_DIR = orig
    tmp.cleanup()
