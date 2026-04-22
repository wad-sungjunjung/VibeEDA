"""신규 에이전트 도구/가드 QA.

Snowflake 미연결 상태에서 동작 가능한 부분만 검증:
  - todo_write: 입력 정규화, 다중 in_progress 거부, SSE 이벤트 생성
  - analyze_output: 커널 DataFrame 기반 통계 생성, 비정상 입력 처리
  - query_data: SELECT 전용·단일 문장·purpose 필수·whitelist 강제
  - list_available_marts: Snowflake 미연결 에러 메시지
  - explore-before-query pre-guard: SQL 셀 거부/통과 경로
  - 병렬 실행 안전성: gather 결과 일관성
  - 컨텍스트 압축: tool_result 절단
"""
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services import agent_skills
from app.services.claude_agent import (
    NotebookState, CellState, _execute_tool, _compact_messages_inplace,
    PARALLEL_SAFE_TOOLS, _extract_referenced_tables,
)


PASS = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"


async def run_scenario(name, fn):
    try:
        await fn()
        print(f"  {PASS} {name}")
        return True
    except AssertionError as e:
        print(f"  {FAIL} {name}: {e}")
        return False
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"  {FAIL} {name}: unexpected {type(e).__name__}: {e}")
        return False


def make_state(user_msg="상세한 분석 요청입니다 — 지역별 매장별 매출 원인 탐색"):
    s = NotebookState()
    agent_skills.init_skill_ctx(s, user_msg)
    return s


# ─── todo_write ──────────────────────────────────────────────────────────────

async def t_todo_write_basic():
    s = make_state()
    res, events = await _execute_tool("todo_write", {
        "todos": [
            {"content": "스키마 확인", "status": "completed"},
            {"content": "쿼리 작성", "status": "in_progress", "active_form": "쿼리 작성하는 중"},
            {"content": "차트 생성", "status": "pending"},
        ]
    }, s)
    assert res["success"], res
    assert res["total"] == 3
    assert res["completed"] == 1
    assert res["in_progress"] == 1
    assert s.todos == res["todos"]
    assert len(events) == 1 and events[0]["type"] == "todos_updated"


async def t_todo_write_multiple_in_progress_rejected():
    s = make_state()
    res, _ = await _execute_tool("todo_write", {
        "todos": [
            {"content": "A", "status": "in_progress"},
            {"content": "B", "status": "in_progress"},
        ]
    }, s)
    assert res.get("error") == "multiple_in_progress", res


async def t_todo_write_invalid_status_defaults_pending():
    s = make_state()
    res, _ = await _execute_tool("todo_write", {
        "todos": [
            {"content": "A", "status": "weird_status"},
        ]
    }, s)
    assert res["success"]
    assert res["todos"][0]["status"] == "pending"


async def t_todo_write_empty_content_skipped():
    s = make_state()
    res, _ = await _execute_tool("todo_write", {
        "todos": [
            {"content": "", "status": "pending"},
            {"content": "real", "status": "pending"},
        ]
    }, s)
    assert res["total"] == 1
    assert res["todos"][0]["content"] == "real"


# ─── query_data ──────────────────────────────────────────────────────────────

async def t_query_data_purpose_required():
    s = make_state()
    res, _ = await _execute_tool("query_data", {"sql": "SELECT 1"}, s)
    assert res.get("error") == "purpose_required", res


async def t_query_data_select_only():
    s = make_state()
    res, _ = await _execute_tool("query_data", {
        "sql": "INSERT INTO x VALUES (1)",
        "purpose": "bad",
    }, s)
    assert res.get("error") == "select_only", res


async def t_query_data_single_statement():
    s = make_state()
    res, _ = await _execute_tool("query_data", {
        "sql": "SELECT 1; SELECT 2",
        "purpose": "bad",
    }, s)
    assert res.get("error") == "single_statement_only", res


async def t_query_data_whitelist_enforced():
    s = make_state()
    s.selected_marts = ["mart_revenue"]
    res, _ = await _execute_tool("query_data", {
        "sql": "SELECT * FROM secret_mart LIMIT 5",
        "purpose": "bad",
    }, s)
    assert res.get("error") == "mart_not_selected_in_sql", res


# ─── analyze_output ──────────────────────────────────────────────────────────

async def t_analyze_output_missing_cell():
    s = make_state()
    res, _ = await _execute_tool("analyze_output", {"cell_id": "nope"}, s)
    assert res.get("error") == "cell_not_found"


async def t_analyze_output_not_executed():
    s = make_state()
    c = CellState(id="c1", name="x", type="sql", code="", executed=False)
    s.cells.append(c)
    res, _ = await _execute_tool("analyze_output", {"cell_id": "c1"}, s)
    assert res.get("error") == "not_executed"


async def t_analyze_output_not_a_table():
    s = make_state()
    c = CellState(id="c1", name="x", type="python", code="", executed=True,
                  output={"type": "chart", "chartMeta": {}})
    s.cells.append(c)
    res, _ = await _execute_tool("analyze_output", {"cell_id": "c1"}, s)
    assert res.get("error") == "not_a_table"


async def t_analyze_output_full_stats():
    """실제 DataFrame 을 kernel namespace 에 주입 후 통계 생성."""
    try:
        import pandas as pd
    except Exception:
        print("    (pandas 미설치 — 스킵)")
        return
    from app.services.kernel import get_namespace
    s = make_state()
    s.notebook_id = "test_nb_analyze"
    ns = get_namespace("test_nb_analyze")
    df = pd.DataFrame({
        "region": ["A", "B", "C", "A", "B"] * 10,
        "revenue": [100, 200, 50, 180, 210] * 10,
        "null_col": [None] * 50,
    })
    ns["sales_tbl"] = df
    c = CellState(id="c_analyze", name="sales_tbl", type="sql", code="", executed=True,
                  output={"type": "table", "rowCount": 50})
    s.cells.append(c)

    res, _ = await _execute_tool("analyze_output", {"cell_id": "c_analyze", "top_n": 3}, s)
    assert res["success"], res
    assert res["row_count"] == 50
    assert "revenue" in res["describe"]
    assert res["describe"]["revenue"]["mean"] is not None
    assert "null_col" in res["null_summary"]
    assert res["null_summary"]["null_col"]["ratio"] == 1.0
    assert res["cardinality"]["region"] == 3
    assert len(res["top_bottom"]["revenue"]["top"]) <= 3
    # categorical 컬럼 (region) — top-k
    assert "region" in res["categorical_top"]


# ─── list_available_marts ────────────────────────────────────────────────────

async def t_list_marts_not_connected():
    s = make_state()
    res, _ = await _execute_tool("list_available_marts", {}, s)
    # Snowflake 세션이 없을 때 에러 반환 (CI 환경 등)
    assert "error" in res, res
    assert res["error"] == "snowflake_not_connected"


# ─── explore-before-query pre-guard ──────────────────────────────────────────

async def t_explore_guard_blocks_unexplored_sql():
    s = make_state("세부 분석 — 지역별 매출 상세 검토 및 상위 매장 편중 분석")
    s.selected_marts = ["mart_revenue"]
    # plan 먼저 (planning 가드 통과)
    await _execute_tool("create_plan", {"hypotheses": [
        {"statement": "h1", "verification_method": "v1"},
        {"statement": "h2", "verification_method": "v2"},
        {"statement": "h3", "verification_method": "v3"},
    ]}, s)
    # 아직 mart_revenue 탐색 전
    res, _ = await _execute_tool("create_cell", {
        "cell_type": "sql",
        "code": "SELECT region FROM mart_revenue GROUP BY region"
    }, s)
    assert res.get("error") == "mart_not_explored", res
    assert "mart_revenue" in res.get("unexplored_marts", []), res


async def t_explore_guard_passes_after_profile():
    s = make_state("세부 분석 — 지역별 매출 상세 검토 및 상위 매장 편중 분석")
    s.selected_marts = ["mart_revenue"]
    await _execute_tool("create_plan", {"hypotheses": [
        {"statement": "h1", "verification_method": "v1"},
        {"statement": "h2", "verification_method": "v2"},
        {"statement": "h3", "verification_method": "v3"},
    ]}, s)
    # explored_marts 에 직접 주입 (실제로 profile_mart 가 세트에 추가했다고 가정)
    s.explored_marts.add("mart_revenue")
    res, _ = await _execute_tool("create_cell", {
        "cell_type": "sql",
        "code": "SELECT region FROM mart_revenue GROUP BY region"
    }, s)
    assert res.get("success") is True, res


async def t_explore_guard_cte_excluded():
    """CTE 이름은 탐색 대상이 아님 (ref 집합에서 제외)."""
    s = make_state("세부 분석 — 지역별 매출 상세 검토 및 상위 매장 편중 분석")
    s.selected_marts = ["mart_revenue"]
    await _execute_tool("create_plan", {"hypotheses": [
        {"statement": "h1", "verification_method": "v1"},
        {"statement": "h2", "verification_method": "v2"},
        {"statement": "h3", "verification_method": "v3"},
    ]}, s)
    s.explored_marts.add("mart_revenue")
    res, _ = await _execute_tool("create_cell", {
        "cell_type": "sql",
        "code": "WITH agg AS (SELECT region FROM mart_revenue) SELECT * FROM agg",
    }, s)
    assert res.get("success") is True, res


async def t_explore_guard_empty_selected_passes():
    """selected_marts 가 비어있으면 explore 가드 무효 (초기 상태)."""
    s = make_state("세부 분석 — 지역별 매출 상세 검토 및 상위 매장 편중 분석")
    # selected_marts 빈 상태
    await _execute_tool("create_plan", {"hypotheses": [
        {"statement": "h1", "verification_method": "v1"},
        {"statement": "h2", "verification_method": "v2"},
        {"statement": "h3", "verification_method": "v3"},
    ]}, s)
    res, _ = await _execute_tool("create_cell", {
        "cell_type": "sql",
        "code": "SELECT 1 FROM anything",
    }, s)
    assert res.get("success") is True, res


async def t_extract_refs_basic():
    refs = _extract_referenced_tables("SELECT * FROM a JOIN b ON a.x=b.x")
    assert refs == {"a", "b"}, refs
    refs = _extract_referenced_tables("WITH t AS (SELECT 1 FROM a) SELECT * FROM t")
    assert refs == {"a"}, refs  # t 는 CTE 라 제외


# ─── parallel tool set sanity ────────────────────────────────────────────────

async def t_parallel_set_contains_read_only():
    # 쓰기성 tool 이 PARALLEL_SAFE_TOOLS 에 섞이지 않았는지 확인
    must_be_exclusive = {
        "create_cell", "update_cell_code", "execute_cell", "write_cell_memo",
        "check_chart_quality", "create_sheet_cell", "update_sheet_cell",
        "ask_user", "create_plan", "update_plan", "request_marts", "todo_write",
    }
    overlap = must_be_exclusive & PARALLEL_SAFE_TOOLS
    assert not overlap, f"쓰기성 tool 이 parallel-safe 집합에 포함됨: {overlap}"
    # 읽기성 tool 이 포함되는지 확인
    assert "profile_mart" in PARALLEL_SAFE_TOOLS
    assert "analyze_output" in PARALLEL_SAFE_TOOLS


async def t_parallel_gather_preserves_input():
    """asyncio.gather 로 여러 tool 동시 실행 시 결과가 입력 순서대로 매칭."""
    # 간단한 simulation: todo_write 같은 상태성 tool 은 parallel 대상 아니지만
    # read_notebook_context 여러 번 호출해 일관성만 확인
    s = make_state()
    results = await asyncio.gather(
        _execute_tool("read_notebook_context", {}, s),
        _execute_tool("read_notebook_context", {}, s),
        _execute_tool("read_notebook_context", {}, s),
    )
    for r, _ in results:
        assert "cells" in r
        assert r["cells"] == []  # 빈 노트북


# ─── context compaction ─────────────────────────────────────────────────────

async def t_compact_noop_when_short():
    messages = []
    for i in range(5):
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"t{i}", "content": "x" * 1000}
        ]})
    compacted = _compact_messages_inplace(messages, keep_recent_turns=10)
    assert compacted == 0


async def t_compact_truncates_old_messages():
    messages = []
    # 12개 tool_result (keep_recent=10 이면 2개 대상)
    for i in range(12):
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"t{i}",
             "content": f"old_content_{i}_" + "x" * 1000}
        ]})
    compacted = _compact_messages_inplace(messages, keep_recent_turns=10)
    assert compacted == 2, f"expected 2 compactions, got {compacted}"
    assert "truncated" in messages[0]["content"][0]["content"]
    assert "truncated" in messages[1]["content"][0]["content"]
    # 뒤쪽 10개는 그대로 — 길이 1013~1015
    assert "truncated" not in messages[2]["content"][0]["content"]
    assert "truncated" not in messages[11]["content"][0]["content"]


async def t_compact_handles_list_content_with_image():
    """이미지 블록이 섞인 content 리스트도 텍스트 블록만 절단해야 함."""
    messages = []
    for i in range(11):
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"t{i}", "content": [
                {"type": "text", "text": f"long_text_{i}_" + "x" * 800},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
            ]}
        ]})
    compacted = _compact_messages_inplace(messages, keep_recent_turns=10)
    assert compacted == 1, compacted
    first = messages[0]["content"][0]["content"]
    assert first[0]["type"] == "text"
    assert "truncated" in first[0]["text"]
    assert first[1]["type"] == "image"  # 이미지 보존


async def t_compact_idempotent():
    """이미 절단된 메시지를 또 절단하지 않음."""
    messages = []
    for i in range(12):
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"t{i}", "content": "original_" + "x" * 1000}
        ]})
    _compact_messages_inplace(messages, keep_recent_turns=10)
    second = _compact_messages_inplace(messages, keep_recent_turns=10)
    assert second == 0, "두 번째 호출은 no-op 이어야 함"


# ─── explore tracking via profile path (mock) ────────────────────────────────

async def t_query_data_updates_explored_marts_on_parse():
    """query_data 는 실행 실패해도 refs 파싱은 성공하면 explored 에 기록되는지 확인.
    (whitelist 통과 + 실제 쿼리 실행 전에 explored 에 등록함)
    """
    s = make_state()
    s.selected_marts = ["mart_revenue"]
    # Snowflake 미연결이므로 실행은 실패하지만, whitelist 체크는 통과 후 refs 가 등록되어야.
    res, _ = await _execute_tool("query_data", {
        "sql": "SELECT region FROM mart_revenue LIMIT 5",
        "purpose": "check",
    }, s)
    # snowflake_not_connected 에러여도 explored_marts 는 이미 등록됨
    assert "mart_revenue" in s.explored_marts, (res, s.explored_marts)


# ─── runner ─────────────────────────────────────────────────────────────────

async def main():
    scenarios = [
        ("T01 todo_write 기본 정규화+이벤트", t_todo_write_basic),
        ("T02 todo_write 다중 in_progress 거부", t_todo_write_multiple_in_progress_rejected),
        ("T03 todo_write 잘못된 status 는 pending 기본", t_todo_write_invalid_status_defaults_pending),
        ("T04 todo_write 빈 content 스킵", t_todo_write_empty_content_skipped),
        ("T05 query_data purpose 필수", t_query_data_purpose_required),
        ("T06 query_data SELECT 전용", t_query_data_select_only),
        ("T07 query_data 단일 문장", t_query_data_single_statement),
        ("T08 query_data 마트 whitelist", t_query_data_whitelist_enforced),
        ("T09 analyze_output 셀 미존재", t_analyze_output_missing_cell),
        ("T10 analyze_output 실행 안 됨", t_analyze_output_not_executed),
        ("T11 analyze_output 테이블 아님", t_analyze_output_not_a_table),
        ("T12 analyze_output 풀 통계 경로", t_analyze_output_full_stats),
        ("T13 list_available_marts 미연결", t_list_marts_not_connected),
        ("T14 explore-guard 미탐색 마트 거부", t_explore_guard_blocks_unexplored_sql),
        ("T15 explore-guard profile 후 통과", t_explore_guard_passes_after_profile),
        ("T16 explore-guard CTE 이름 제외", t_explore_guard_cte_excluded),
        ("T17 explore-guard 빈 selected 통과", t_explore_guard_empty_selected_passes),
        ("T18 _extract_referenced_tables 기본", t_extract_refs_basic),
        ("T19 PARALLEL_SAFE_TOOLS 집합 정합", t_parallel_set_contains_read_only),
        ("T20 asyncio.gather 일관성", t_parallel_gather_preserves_input),
        ("T21 compact no-op 짧은 세션", t_compact_noop_when_short),
        ("T22 compact 오래된 메시지 절단", t_compact_truncates_old_messages),
        ("T23 compact 이미지 블록 보존", t_compact_handles_list_content_with_image),
        ("T24 compact idempotent", t_compact_idempotent),
        ("T25 query_data refs 는 explored 에 기록", t_query_data_updates_explored_marts_on_parse),
    ]
    print("\n── New Agent Tools QA ──")
    results = [await run_scenario(n, f) for n, f in scenarios]
    total, passed = len(results), sum(results)
    print(f"\n{'='*60}\nResult: {passed}/{total} passed\n")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
