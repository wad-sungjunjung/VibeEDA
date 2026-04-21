"""Quality-focused report_service 단위 QA — LLM 호출 없이 검증 가능한 부분만."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.services import report_service as rs


def section(title: str) -> None:
    print(f"\n{'='*10} {title} {'='*10}")


def assert_eq(a, b, label: str) -> None:
    status = "PASS" if a == b else "FAIL"
    print(f"[{status}] {label}: got={a!r} expected={b!r}")
    if a != b:
        raise AssertionError(label)


def assert_true(cond: bool, label: str) -> None:
    print(f"[{'PASS' if cond else 'FAIL'}] {label}")
    if not cond:
        raise AssertionError(label)


# ─── 1) 테이블 프로파일 ─────────────────────────────────────────────
section("테이블 통계 프로파일")
table_output = {
    "type": "table",
    "columns": [{"name": "region"}, {"name": "revenue"}, {"name": "orders"}],
    "rows": [
        ["강남", 1200000, 450],
        ["서초", 950000, 320],
        ["마포", 780000, 280],
        ["용산", 620000, 210],
        ["송파", 1100000, 410],
        ["강서", None, 180],
    ],
    "rowCount": 6,
}
stats = rs._compute_table_stats(table_output)
print(stats)
assert_true("수치" in stats, "수치 컬럼 라벨 존재")
assert_true("min=" in stats and "p25=" in stats and "max=" in stats, "통계 키 존재")
assert_true("범주" in stats, "범주 컬럼 라벨")
assert_true("강남" in stats, "top 범주 표시")

evidence_text = rs._fmt_table_evidence(table_output)
assert_true("컬럼 프로파일" in evidence_text, "evidence 텍스트에 프로파일 포함")

# 대용량 테이블 → head+tail 형식
big_rows = [[i, i * 10] for i in range(100)]
big_table = {
    "type": "table",
    "columns": [{"name": "x"}, {"name": "y"}],
    "rows": big_rows,
    "rowCount": 100,
}
big_text = rs._fmt_table_evidence(big_table, head=15, tail=5)
assert_true("중간 80행 생략" in big_text, "중간 생략 마커")
assert_true("99 | 990" in big_text, "tail 값 포함")


# ─── 2) depends_on 추출 ────────────────────────────────────────────
section("depends_on 추출")
deps = rs._extract_depends_on(
    "import plotly.express as px\nfig = px.bar(query_1, x='region', y='revenue')",
    {"query_1", "unused_cell", "query_2"},
)
assert_eq(deps, ["query_1"], "쿼리 이름 매칭")

deps2 = rs._extract_depends_on("df = pd.DataFrame()", {"query_1"})
assert_eq(deps2, [], "매칭 없음")


# ─── 3) 수치 추출 / 검증 ───────────────────────────────────────────
section("수치 추출·검증")
units = rs._extract_numbers_with_units("매출은 1,234,567원 증가(8.4%)했고 건수는 3,400건.")
assert_true((1234567.0, "원") in units, "단위 원 매칭")
assert_true((8.4, "%") in units, "퍼센트 매칭")
assert_true((3400.0, "건") in units, "건 매칭")

bigs = rs._extract_big_numbers("값은 12345, 9999, 그리고 1,234,567 이다.")
assert_true(12345.0 in bigs, "4자리 이상 숫자")
assert_true(1234567.0 in bigs, "쉼표 포함 숫자")

# evidence 수집 + 매칭
fake_evidence = [
    {
        "output_text": "revenue=1,234,567원, growth=8.4%",
        "memo": "총 3,400건",
        "insight": "",
        "output": {
            "type": "table",
            "columns": [{"name": "v"}],
            "rows": [[1234567], [3400]],
        },
    }
]
ev_with_units, ev_bigs = rs._collect_evidence_numbers(fake_evidence)
assert_true((1234567.0, "원") in ev_with_units, "evidence 단위 수집")
assert_true(1234567.0 in ev_bigs, "evidence big 수집")

# 정상 매칭 (동일 숫자)
ok_md = "매출 1,234,567원, 성장 8.4%, 건수 3400건."
susp_ok = rs._validate_report_numbers(ok_md, ev_with_units, ev_bigs)
print(f"정상 본문 의심 수치: {len(susp_ok)}개 — {susp_ok}")
assert_true(len(susp_ok) == 0, "정상 매칭 시 의심 없음")

# 환각 매칭 (evidence 에 없는 숫자)
bad_md = "매출 9,999,999원 증가했고 성장률은 42.7% 이다."
susp_bad = rs._validate_report_numbers(bad_md, ev_with_units, ev_bigs)
print(f"환각 본문 의심 수치: {len(susp_bad)}개 — {[s['raw'] for s in susp_bad]}")
assert_true(len(susp_bad) >= 2, "환각 2건 이상 플래그")
assert_true(any("42.7" in s["raw"] for s in susp_bad), "퍼센트 환각 잡힘")

# tolerance 검증 — 1234567 vs 1234600 (0.003%)
tol_md = "매출은 1,234,600원이다."
susp_tol = rs._validate_report_numbers(tol_md, ev_with_units, ev_bigs)
assert_true(len(susp_tol) == 0, "±0.5% 오차 허용")


# ─── 4) Outline JSON 파싱 ──────────────────────────────────────────
section("Outline JSON 파싱")
raw1 = '{"report_title": "X", "sections": [{"heading": "## A", "cite_charts": ["c1"]}]}'
p1 = rs._parse_outline_json(raw1)
assert_eq(p1["report_title"], "X", "기본 파싱")

raw2 = "설명 없이 바로 ```json\n" + raw1 + "\n```\n추가 설명"
p2 = rs._parse_outline_json(raw2)
assert_eq(p2["report_title"], "X", "코드 펜스 내부 파싱")

raw3 = "깨진 JSON {{{"
p3 = rs._parse_outline_json(raw3)
assert_true(p3 is None, "깨진 JSON → None")


# ─── 5) Outline coverage 검증 ──────────────────────────────────────
section("Outline coverage")
ev = [
    {"name": "chartA", "image_png_b64": "xxx"},
    {"name": "chartB", "image_png_b64": "yyy"},
    {"name": "tableC"},
]
ok_outline = {"sections": [{"cite_charts": ["chartA", "chartB"]}]}
assert_eq(rs._validate_outline_coverage(ok_outline, ev), [], "모든 차트 할당됨")

partial = {"sections": [{"cite_charts": ["chartA"]}]}
assert_eq(rs._validate_outline_coverage(partial, ev), ["chartB"], "누락 감지")


# ─── 6) 차트 주입 / 미매칭 경고 / 부록 ─────────────────────────────
section("차트 주입 로직")
# 1x1 PNG
import base64, io
PNG_1X1 = base64.b64encode(
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
).decode()

ev2 = [
    {"name": "fig_a", "image_png_b64": PNG_1X1},
    {"name": "fig_b", "image_png_b64": PNG_1X1},  # 본문 참조 안됨 → 부록
]
md_in = "본문\n\n{{CHART:fig_a}}\n\n다음은 없는 {{CHART:fig_ghost}} 그리고 끝.\n"
report_id = "test_qa_" + str(id(ev2))
import tempfile
tmp = tempfile.TemporaryDirectory()
from app.services import notebook_store as ns
orig_dir = ns.NOTEBOOKS_DIR
ns.NOTEBOOKS_DIR = Path(tmp.name)
try:
    target = rs._report_folder(report_id, draft=True)
    new_md, notes = rs._inject_chart_images(md_in, ev2, report_id, target_dir=target)
    print("--- injected markdown ---")
    print(new_md)
    print("--- notes ---", notes)
    assert_true("./fig_a.png" in new_md, "fig_a 상대 경로 삽입")
    assert_true("_images/" not in new_md, "레거시 _images 경로 없음")
    assert_true("차트 미삽입" in new_md, "미매칭 경고 블록")
    assert_true("부록" in new_md, "부록 섹션 생성")
    assert_true("./fig_b.png" in new_md, "부록에 fig_b")
    assert_eq(notes["missing_charts"], ["fig_ghost"], "missing_charts 기록")
    assert_eq(notes["unreferenced_charts"], ["fig_b"], "unreferenced 기록")
    # 리포트 폴더에 md 와 이미지가 같이 저장됐는지
    assert_true((target / "fig_a.png").exists(), "fig_a 같은 폴더 저장")
    assert_true((target / "fig_b.png").exists(), "fig_b 같은 폴더 저장")
finally:
    ns.NOTEBOOKS_DIR = orig_dir
    tmp.cleanup()


# ─── 6b) save_draft + promote_draft + delete_draft ─────────────────
section("저장 흐름 — draft → promote → delete")
tmp2 = tempfile.TemporaryDirectory()
ns.NOTEBOOKS_DIR = Path(tmp2.name)
try:
    from datetime import datetime
    rid = "20260421_999999_test_promote"
    # 노트북 하나 만들어두고 promote 시 참조 append 검증
    (Path(tmp2.name)).mkdir(parents=True, exist_ok=True)
    import uuid, json as _json
    nb_id = "nb-" + uuid.uuid4().hex[:8]
    nb = {
        "nbformat": 4,
        "metadata": {"vibe": {"title": "테스트", "description": ""}},
        "cells": [],
    }
    (Path(tmp2.name) / f"{nb_id}.ipynb").write_text(_json.dumps(nb), encoding="utf-8")

    draft = rs.save_draft(
        markdown_body="본문\n\n![fig](./fig.png)\n",
        title="테스트", source_notebook_id=nb_id, source_cell_ids=[],
        goal="g", model="claude-opus-4-7", report_id=rid,
        created_at=datetime.now(),
    )
    assert_true(draft["is_draft"] is True, "save_draft is_draft=True")
    draft_folder = Path(tmp2.name) / "reports" / "_drafts" / rid
    assert_true((draft_folder / f"{rid}.md").exists(), "draft md 저장 위치")

    # draft 상태에서 list_reports 는 비어있어야 함
    lst = rs.list_reports()
    assert_true(all(r["id"] != rid for r in lst), "draft 는 리스트 미포함")

    # get_report 는 draft 를 읽을 수 있음
    got = rs.get_report(rid)
    assert_true(got is not None and got["is_draft"] is True, "get_report draft 인식")

    # promote
    promoted = rs.promote_draft(rid)
    assert_true(promoted is not None and promoted["is_draft"] is False, "promote 성공")
    final_folder = Path(tmp2.name) / "reports" / rid
    assert_true((final_folder / f"{rid}.md").exists(), "영구 폴더 이동")
    assert_true(not draft_folder.exists(), "draft 폴더 제거")

    # 노트북 reports[] 에 추가됐는지
    nb_after = _json.loads((Path(tmp2.name) / f"{nb_id}.ipynb").read_text(encoding="utf-8"))
    reports_arr = nb_after.get("metadata", {}).get("vibe", {}).get("reports", [])
    assert_true(any(r["report_id"] == rid for r in reports_arr), "노트북에 참조 append")

    # list_reports 에 포함
    lst2 = rs.list_reports()
    assert_true(any(r["id"] == rid for r in lst2), "promote 후 list 에 등장")

    # 두 번째 promote 는 no-op (이미 영구)
    again = rs.promote_draft(rid)
    assert_true(again is not None and again["is_draft"] is False, "re-promote 안전")

    # 존재하지 않는 draft 는 None
    assert_true(rs.promote_draft("does_not_exist") is None, "없는 draft → None")

    # delete_draft
    rid2 = "20260421_888888_discard_test"
    rs.save_draft(
        markdown_body="본문", title="t2", source_notebook_id=nb_id, source_cell_ids=[],
        goal="", model="claude-opus-4-7", report_id=rid2, created_at=datetime.now(),
    )
    assert_true(rs.delete_draft(rid2) is True, "delete_draft ok")
    assert_true(rs.delete_draft(rid2) is False, "없는 draft → False")
finally:
    ns.NOTEBOOKS_DIR = orig_dir
    tmp2.cleanup()


# ─── 7) Frontmatter dict 직렬화 / 역직렬화 ─────────────────────────
section("Frontmatter JSON round-trip")
meta = {
    "id": "abc",
    "title": "테스트 리포트",
    "source_cell_ids": ["c1", "c2"],
    "processing_notes": {"missing_charts": ["x"], "suspicious_number_count": 3},
    "outline": {"report_title": "T", "sections": [{"heading": "## H"}]},
}
fm = rs._build_frontmatter(meta)
print(fm)
parsed, _ = rs._parse_frontmatter(fm + "body\n")
assert_eq(parsed["id"], "abc", "id 라운드트립")
assert_eq(parsed["source_cell_ids"], ["c1", "c2"], "list 라운드트립")
assert_eq(parsed["processing_notes"]["suspicious_number_count"], 3, "processing_notes JSON 역직렬화")
assert_eq(parsed["outline"]["report_title"], "T", "outline JSON 역직렬화")


# ─── 8) Big number tolerance edge case ─────────────────────────────
section("수치 허용 오차 엣지")
# 0 매칭
assert_true(rs._match_number(0, {0, 100}), "0 매칭")
assert_true(not rs._match_number(0, {100}), "0 pool 에 없음")
# 큰 오차
assert_true(not rs._match_number(100, {200}), "2배 차이 — 불일치")
# 허용 오차 경계
assert_true(rs._match_number(1000, {1004}), "0.4% — 통과")
assert_true(not rs._match_number(1000, {1010}), "1% — 불통과")


print("\n✅ ALL QA PASSED")
