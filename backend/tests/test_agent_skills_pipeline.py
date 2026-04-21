"""Agent skills 파이프라인 시뮬레이션 테스트.

실제 LLM API 호출 없이 `_execute_tool` + `collect_post_hook_reminders` +
`get_end_guard_reminder` 를 직접 호출해 9개 스킬이 의도대로 동작하는지 검증한다.
kernel / Snowflake 는 `notebook_id=""` 로 우회 (auto-execute 스킵).
"""
import asyncio
import sys
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services import agent_skills
from app.services.claude_agent import NotebookState, CellState, _execute_tool


PASS = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"


def _hdr(name):
    print(f"\n── {name} ──")


async def run_scenario(name, fn):
    try:
        await fn()
        print(f"  {PASS} {name}")
        return True
    except AssertionError as e:
        print(f"  {FAIL} {name}: {e}")
        return False
    except Exception as e:
        print(f"  {FAIL} {name}: unexpected {type(e).__name__}: {e}")
        return False


def make_state(user_msg="강남구 매장 매출 구조 분석해줘 지역별 원인도"):
    s = NotebookState()
    agent_skills.init_skill_ctx(s, user_msg)
    return s


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 1: planning — pre-guard blocks create_cell(sql) without plan
# ─────────────────────────────────────────────────────────────────────────────

async def s1_planning_gate():
    s = make_state()
    result, events = await _execute_tool(
        "create_cell",
        {"cell_type": "sql", "code": "select 1 from mart_revenue"},
        s,
    )
    assert result.get("error") == "plan_required_before_cells", f"expected plan gate, got {result}"
    assert events == []
    assert len(s.cells) == 0


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 2: create_plan → unblocks sql cell creation
# ─────────────────────────────────────────────────────────────────────────────

async def s2_create_plan_unblocks():
    s = make_state()
    plan_res, plan_events = await _execute_tool(
        "create_plan",
        {
            "scope": "강남구 매장별 매출 구조",
            "hypotheses": [
                {"statement": "강남역 상권 매장이 상위 매출", "verification_method": "매장별 매출 막대"},
                {"statement": "점심시간대 매출 편중", "verification_method": "시간대별 라인차트"},
                {"statement": "CTR 높은 매장이 매출도 높음", "verification_method": "scatter"},
            ],
            "out_of_scope": ["경쟁사 비교"],
        },
        s,
    )
    assert plan_res["success"], plan_res
    assert len(s.cells) == 1
    assert s.cells[0].type == "markdown"
    assert agent_skills.PLAN_MARKER in s.cells[0].code
    assert s.skill_ctx["plan_cell_id"] == s.cells[0].id
    assert plan_events[0]["type"] == "cell_created"
    assert plan_events[0]["cell_name"] == "analysis_plan"

    # 이제 sql 셀 생성은 통과해야 함 (notebook_id 빈 문자열이라 auto-exec 스킵)
    res2, events2 = await _execute_tool(
        "create_cell",
        {"cell_type": "sql", "code": "select region, sum(revenue) from mart_revenue group by 1"},
        s,
    )
    assert res2.get("success") is True, res2
    assert len(s.cells) == 2


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 3: insufficient hypotheses rejected
# ─────────────────────────────────────────────────────────────────────────────

async def s3_insufficient_hypotheses():
    s = make_state()
    res, _ = await _execute_tool(
        "create_plan",
        {"hypotheses": [
            {"statement": "h1", "verification_method": "v1"},
            {"statement": "h2", "verification_method": "v2"},
        ]},
        s,
    )
    assert res.get("error") == "insufficient_hypotheses"


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 4: update_plan without existing plan
# ─────────────────────────────────────────────────────────────────────────────

async def s4_update_plan_without_plan():
    s = make_state()
    res, _ = await _execute_tool(
        "update_plan",
        {"new_plan_markdown": "# plan", "reason": "test"},
        s,
    )
    assert res.get("error") == "no_plan_exists"


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 5: update_plan replaces content, preserves cell id
# ─────────────────────────────────────────────────────────────────────────────

async def s5_update_plan_replaces():
    s = make_state()
    await _execute_tool("create_plan", {"hypotheses":[
        {"statement":"h1","verification_method":"v1"},
        {"statement":"h2","verification_method":"v2"},
        {"statement":"h3","verification_method":"v3"},
    ]}, s)
    plan_id = s.skill_ctx["plan_cell_id"]
    new_md = "# 개정된 플랜\n- [x] H1 검증 완료\n- [ ] H2 진행 중"
    res, events = await _execute_tool(
        "update_plan",
        {"new_plan_markdown": new_md, "reason": "H1 검증 완료"},
        s,
    )
    assert res["success"]
    assert s.skill_ctx["plan_cell_id"] == plan_id
    updated = next(c for c in s.cells if c.id == plan_id)
    assert "개정된 플랜" in updated.code
    assert agent_skills.PLAN_MARKER in updated.code  # 자동 prepend
    assert events[0]["type"] == "cell_code_updated"


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 6: request_marts → ask_user SSE event with request_type
# ─────────────────────────────────────────────────────────────────────────────

async def s6_request_marts():
    s = make_state()
    res, events = await _execute_tool(
        "request_marts",
        {
            "reason": "현재 마트에 예약 사실 테이블 부재",
            "suggested_mart_keywords": ["fact_reservation"],
            "missing_dimensions": ["예약일자"],
        },
        s,
    )
    assert res["posted"] is True
    assert res["type"] == "mart_request"
    assert len(events) == 1
    ev = events[0]
    assert ev["type"] == "ask_user"
    assert ev["request_type"] == "mart_request"
    assert "fact_reservation" in ev["suggested_keywords"]
    assert "예약일자" in ev["missing_dimensions"]


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 7: error_recovery classification + 2-strike escalation
# ─────────────────────────────────────────────────────────────────────────────

async def s7_error_recovery():
    s = make_state()
    # 플랜 먼저 만들어 guard 통과
    await _execute_tool("create_plan", {"hypotheses":[
        {"statement":"h1","verification_method":"v1"},
        {"statement":"h2","verification_method":"v2"},
        {"statement":"h3","verification_method":"v3"},
    ]}, s)

    # Fake error cell
    cell = CellState(id="c_err", name="bad_sql", type="sql", code="select foo from mart_x",
                     executed=True,
                     output={"type": "error", "message": "Column \"foo\" does not exist"})
    s.cells.append(cell)

    # 1차 에러 post-hook
    rems1 = agent_skills.collect_post_hook_reminders(
        "create_cell", {"cell_type":"sql","code":"..."},
        {"cell_id": "c_err", "success": True, "auto_executed": True},
        s,
    )
    assert rems1, "expected reminder"
    assert "column_not_found" in rems1[0], rems1
    assert "2회" not in rems1[0]  # 1회차엔 escalation 없음

    # 2차 에러 → escalation
    rems2 = agent_skills.collect_post_hook_reminders(
        "update_cell_code", {"cell_id":"c_err","code":"..."},
        {"cell_id":"c_err","success":True,"auto_executed":True}, s,
    )
    assert rems2
    assert "2회" in rems2[0] or "반복" in rems2[0], rems2


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 8: sanity_check hint on GROUP BY SQL (once per cell)
# ─────────────────────────────────────────────────────────────────────────────

async def s8_sanity_check_hint():
    s = make_state()
    cell = CellState(id="c_agg", name="agg", type="sql",
                     code="SELECT region, SUM(revenue) FROM mart_revenue GROUP BY region",
                     executed=True,
                     output={"type":"table","columns":[{"name":"region"}],"rows":[["A",1]],"rowCount":1})
    s.cells.append(cell)
    rems = agent_skills.collect_post_hook_reminders(
        "create_cell", {"cell_type":"sql","code":cell.code},
        {"cell_id":"c_agg","success":True}, s,
    )
    assert any("GROUP BY" in r for r in rems), rems
    # 두 번째 호출 땐 힌트 생략 (sanity_hinted_cells)
    rems2 = agent_skills.collect_post_hook_reminders(
        "update_cell_code", {"cell_id":"c_agg"},
        {"cell_id":"c_agg","success":True}, s,
    )
    assert not any("GROUP BY" in r for r in rems2), "should only hint once"


async def s8b_sanity_skips_non_aggregation():
    s = make_state()
    cell = CellState(id="c_plain", name="plain", type="sql",
                     code="SELECT * FROM mart_revenue LIMIT 10",
                     executed=True, output={"type":"table","rows":[],"rowCount":0,"columns":[]})
    s.cells.append(cell)
    rems = agent_skills.collect_post_hook_reminders(
        "create_cell", {}, {"cell_id":"c_plain","success":True}, s,
    )
    assert not rems, rems


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 9: memo drift keyword detection
# ─────────────────────────────────────────────────────────────────────────────

async def s9_memo_drift():
    s = make_state()
    await _execute_tool("create_plan", {"hypotheses":[
        {"statement":"h1","verification_method":"v1"},
        {"statement":"h2","verification_method":"v2"},
        {"statement":"h3","verification_method":"v3"},
    ]}, s)
    rems = agent_skills.collect_post_hook_reminders(
        "write_cell_memo",
        {"cell_id":"x","memo":"결과가 예상 밖이다. 특정 매장 1개가 극단적 이상치로 보임."},
        {"success":True}, s,
    )
    assert any("update_plan" in r for r in rems), rems


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 10: baseline comparison missing vs present
# ─────────────────────────────────────────────────────────────────────────────

async def s10_baseline():
    s = make_state()
    bad_memo = "강남구 매출 총 100억 확인. 매장 수 250개로 집계됨 절대값만 기록."
    rems_bad = agent_skills.collect_post_hook_reminders(
        "write_cell_memo", {"cell_id":"x","memo":bad_memo}, {"success":True}, s,
    )
    assert any("상대 비교" in r for r in rems_bad), rems_bad

    good_memo = "강남구 매출 100억 — 전국 평균 대비 18% 상회, 매장 1개가 서울 매출의 38% 차지 이상치."
    rems_good = agent_skills.collect_post_hook_reminders(
        "write_cell_memo", {"cell_id":"x","memo":good_memo}, {"success":True}, s,
    )
    assert not any("상대 비교" in r for r in rems_good), rems_good


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 11: end-guard — unchecked hypotheses
# ─────────────────────────────────────────────────────────────────────────────

async def s11_end_guard_unchecked():
    s = make_state()
    await _execute_tool("create_plan", {"hypotheses":[
        {"statement":"h1","verification_method":"v1"},
        {"statement":"h2","verification_method":"v2"},
        {"statement":"h3","verification_method":"v3"},
    ]}, s)
    s.cells.extend([
        CellState(id="c1", name="a", type="sql", code="select 1", executed=True, output={"type":"table","rows":[[1]],"rowCount":1,"columns":[{"name":"c"}]}),
        CellState(id="c2", name="b", type="python", code="x=1", executed=True, output={"type":"stdout","content":"ok"}),
    ])
    rem = agent_skills.get_end_guard_reminder(s)
    assert rem and "미검증 가설" in rem, rem
    # 2회차는 None (end_guard_fired)
    rem2 = agent_skills.get_end_guard_reminder(s)
    assert rem2 is None


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 12: end-guard — segmentation exploration when all hypotheses checked
# ─────────────────────────────────────────────────────────────────────────────

async def s12_end_guard_segmentation():
    s = make_state()
    await _execute_tool("create_plan", {"hypotheses":[
        {"statement":"h1","verification_method":"v1"},
        {"statement":"h2","verification_method":"v2"},
        {"statement":"h3","verification_method":"v3"},
    ]}, s)
    # 전체 가설 체크 완료로 덮어쓰기
    await _execute_tool("update_plan", {
        "new_plan_markdown": "# 완료\n- [x] H1\n- [x] H2\n- [x] H3",
        "reason":"all verified",
    }, s)
    # 3개 분석 셀
    for i in range(3):
        s.cells.append(CellState(id=f"cc{i}", name=f"a{i}", type="sql", code="select 1",
                                 executed=True, output={"type":"table","rows":[[1]],"rowCount":1,"columns":[{"name":"c"}]}))
    rem = agent_skills.get_end_guard_reminder(s)
    assert rem and ("세그먼트" in rem or "분해하지 않은 축" in rem), rem


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 13: trivial request bypass
# ─────────────────────────────────────────────────────────────────────────────

async def s13_trivial_skip():
    s = make_state(user_msg="총 매출")
    res, _ = await _execute_tool(
        "create_cell",
        {"cell_type":"sql","code":"select sum(revenue) from mart_revenue"},
        s,
    )
    assert res.get("success") is True, res
    assert s.skill_ctx.get("plan_cell_id") is None


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 14: existing plan cell auto-detected across sessions
# ─────────────────────────────────────────────────────────────────────────────

async def s14_existing_plan_autodetect():
    s = NotebookState()
    # 프론트에서 로드된 기존 노트북에 이미 플랜 셀이 있음
    s.cells.append(CellState(
        id="pre_plan", name="analysis_plan", type="markdown",
        code=f"{agent_skills.PLAN_MARKER}\n# 기존 플랜\n- [x] H1\n- [ ] H2",
    ))
    agent_skills.init_skill_ctx(s, "강남구 매출 분석 심화")
    assert s.skill_ctx["plan_cell_id"] == "pre_plan"
    # pre-guard 는 통과
    res, _ = await _execute_tool("create_cell",{"cell_type":"sql","code":"select 1"}, s)
    assert res.get("success") is True


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 15: Gemini tool declaration sanity (shape check)
# ─────────────────────────────────────────────────────────────────────────────

async def s15_gemini_declarations():
    from app.services import gemini_agent_service
    from google.genai import types
    # Tool 인스턴스가 정상 생성되는지 (declaration 스펙 호환)
    tool = gemini_agent_service._GEMINI_TOOL
    assert tool is not None
    names = {fd["name"] if isinstance(fd, dict) else fd.name
             for fd in (gemini_agent_service._FUNC_DECLARATIONS + agent_skills.SKILL_TOOLS_GEMINI)}
    assert {"create_plan", "update_plan", "request_marts"}.issubset(names)


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 16: Claude TOOLS includes skill tools, schemas valid
# ─────────────────────────────────────────────────────────────────────────────

async def s16_claude_tools():
    from app.services.claude_agent import TOOLS
    names = {t["name"] for t in TOOLS}
    assert {"create_plan", "update_plan", "request_marts"}.issubset(names)
    for tool_name in ("create_plan","update_plan","request_marts"):
        t = next(t for t in TOOLS if t["name"] == tool_name)
        assert "input_schema" in t
        assert t["input_schema"]["type"] == "object"


# ─────────────────────────────────────────────────────────────────────────────
# Scenario 17: full narrative — plan → sql → error → recover → memo → update_plan → end
# ─────────────────────────────────────────────────────────────────────────────

async def s17_full_narrative():
    s = make_state("강남구 매장별 매출 구조 심층 분석 원인 탐색")
    log = []

    # 1. plan
    r, _ = await _execute_tool("create_plan", {"hypotheses":[
        {"statement":"강남역 상권 편중","verification_method":"매장별 막대"},
        {"statement":"점심대 쏠림","verification_method":"시간대 라인"},
        {"statement":"CTR ↔ 매출 상관","verification_method":"scatter"},
    ]}, s)
    log.append(("plan", r.get("success")))
    assert r["success"]

    # 2. first sql cell (manually no auto-exec; simulate error output)
    r2, _ = await _execute_tool("create_cell", {"cell_type":"sql","code":"SELECT regin FROM mart_revenue GROUP BY regin"}, s)
    assert r2.get("success")
    # 수동으로 에러 출력 부여
    new_cell = s.cells[-1]
    new_cell.executed = True
    new_cell.output = {"type":"error","message":"Column \"regin\" invalid identifier"}
    rems = agent_skills.collect_post_hook_reminders(
        "create_cell", {"cell_type":"sql","code":new_cell.code}, {"cell_id":new_cell.id,"success":True}, s,
    )
    assert any("column_not_found" in r for r in rems), rems
    log.append(("error_classified", True))

    # 3. update_cell_code → 성공
    new_cell.code = "SELECT region, SUM(revenue) r FROM mart_revenue GROUP BY region"
    new_cell.output = {"type":"table","columns":[{"name":"region"},{"name":"r"}],
                       "rows":[["강남", 10_000_000_000]], "rowCount":1}
    rems2 = agent_skills.collect_post_hook_reminders(
        "update_cell_code", {"cell_id":new_cell.id,"code":new_cell.code},
        {"cell_id":new_cell.id,"success":True}, s,
    )
    assert any("GROUP BY" in r for r in rems2), f"sanity hint missing: {rems2}"
    log.append(("sanity_hinted", True))

    # 4. memo with baseline → no baseline reminder, but drift if keyword
    memo = "강남이 전국 평균 대비 210% 상회로 극단 이상치. 새 가설: 단일 대형 매장 영향 가능"
    rems3 = agent_skills.collect_post_hook_reminders(
        "write_cell_memo", {"cell_id":new_cell.id,"memo":memo}, {"success":True}, s,
    )
    assert not any("상대 비교" in r for r in rems3)
    assert any("update_plan" in r for r in rems3), rems3
    log.append(("drift_triggered", True))

    # 5. update_plan — 가설 체크 + 신규 가설 추가
    await _execute_tool("update_plan", {
        "new_plan_markdown":"# 재정의\n- [x] H1 강남 편중\n- [ ] H2 점심대\n- [ ] H3 CTR\n- [ ] H4 단일 대형 매장 영향",
        "reason":"이상치 기반 파생 가설 추가",
    }, s)

    # 6. 추가 분석 셀 2개
    for i in range(2):
        c = CellState(id=f"more{i}", name=f"m{i}", type="python", code="x=1",
                      executed=True, output={"type":"stdout","content":"ok"})
        s.cells.append(c)

    # 7. end-guard — 미검증 3개 남음
    rem_end = agent_skills.get_end_guard_reminder(s)
    assert rem_end and "미검증 가설" in rem_end, rem_end
    log.append(("end_guard_fired", True))

    # 8. 2차 end-guard call → None
    assert agent_skills.get_end_guard_reminder(s) is None

    print("    narrative log:", log)


# ─────────────────────────────────────────────────────────────────────────────
# Runner
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    scenarios = [
        ("S1  planning pre-guard blocks sql without plan", s1_planning_gate),
        ("S2  create_plan unblocks cell creation", s2_create_plan_unblocks),
        ("S3  insufficient hypotheses rejected", s3_insufficient_hypotheses),
        ("S4  update_plan without plan errors", s4_update_plan_without_plan),
        ("S5  update_plan replaces keeping cell id", s5_update_plan_replaces),
        ("S6  request_marts emits structured ask_user", s6_request_marts),
        ("S7  error_recovery classify + 2-strike escalation", s7_error_recovery),
        ("S8  sanity_check hint on GROUP BY (once)", s8_sanity_check_hint),
        ("S8b sanity hint skips simple SELECT", s8b_sanity_skips_non_aggregation),
        ("S9  memo drift keyword triggers update_plan reminder", s9_memo_drift),
        ("S10 baseline comparison missing vs present", s10_baseline),
        ("S11 end-guard unchecked hypotheses + once-only", s11_end_guard_unchecked),
        ("S12 end-guard segmentation exploration", s12_end_guard_segmentation),
        ("S13 trivial request bypasses plan guard", s13_trivial_skip),
        ("S14 existing plan cell auto-detected", s14_existing_plan_autodetect),
        ("S15 Gemini tool declarations registered", s15_gemini_declarations),
        ("S16 Claude TOOLS includes skill tools", s16_claude_tools),
        ("S17 full narrative: plan→err→recover→memo→update→end", s17_full_narrative),
    ]
    _hdr("Agent skills pipeline test")
    results = []
    for name, fn in scenarios:
        results.append(await run_scenario(name, fn))
    total, passed = len(results), sum(results)
    print(f"\n{'='*60}\nResult: {passed}/{total} passed\n")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
