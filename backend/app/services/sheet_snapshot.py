"""Univer 스프레드시트 스냅샷 헬퍼 (에이전트/MCP 도구가 사용).

프론트 `SheetEditor` 와 호환되는 IWorkbookData JSON 을 파이썬에서 생성·수정하기 위한 유틸.
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any, Optional


def empty_workbook(sheet_name: str = "Sheet1") -> dict:
    """SheetEditor.tsx 의 emptyWorkbook() 과 동일한 구조 — 반드시 동기화 유지."""
    sheet_id = "sheet-01"
    return {
        "id": f"wb_{uuid.uuid4().hex[:8]}",
        "locale": "koKR",
        "name": "VibeEDA Sheet",
        "sheetOrder": [sheet_id],
        "appVersion": "3.0.0-alpha",
        "styles": {},
        "sheets": {
            sheet_id: {
                "id": sheet_id,
                "name": sheet_name,
                "tabColor": "",
                "hidden": 0,
                "rowCount": 100,
                "columnCount": 26,
                "zoomRatio": 1,
                "scrollTop": 0,
                "scrollLeft": 0,
                "defaultColumnWidth": 88,
                "defaultRowHeight": 24,
                "mergeData": [],
                "cellData": {},
                "rowData": {},
                "columnData": {},
                "rowHeader": {"width": 46, "hidden": 0},
                "columnHeader": {"height": 20, "hidden": 0},
                "showGridlines": 1,
                "rightToLeft": 0,
                "freeze": {"startRow": -1, "startColumn": -1, "ySplit": 0, "xSplit": 0},
            },
        },
    }


_A1_RE = re.compile(r"^([A-Z]+)(\d+)$", re.IGNORECASE)


def parse_a1(a1: str) -> Optional[tuple[int, int]]:
    """A1 표기 → (row, col) 0-indexed. 범위/유효하지 않으면 None."""
    m = _A1_RE.match((a1 or "").strip())
    if not m:
        return None
    letters = m.group(1).upper()
    col = 0
    for ch in letters:
        col = col * 26 + (ord(ch) - 64)
    return int(m.group(2)) - 1, col - 1


def col_to_letters(col: int) -> str:
    n = col + 1
    s = ""
    while n > 0:
        r = (n - 1) % 26
        s = chr(65 + r) + s
        n = (n - 1) // 26
    return s


def _ensure_active_sheet(snapshot: dict) -> dict:
    """첫 번째 시트 data 블록 반환. 없으면 빈 워크북으로 초기화."""
    order = snapshot.get("sheetOrder") or []
    sheets = snapshot.get("sheets") or {}
    if not order or order[0] not in sheets:
        fresh = empty_workbook()
        snapshot.clear()
        snapshot.update(fresh)
        order = snapshot["sheetOrder"]
        sheets = snapshot["sheets"]
    return sheets[order[0]]


def _coerce_value(val: Any) -> dict:
    """Univer cellData 단일 셀 포맷.
    - 문자열이 '=' 로 시작하면 수식(`f`) + 값은 빈 문자열
    - 숫자/불리언은 `v` 로
    - 그 외 문자열은 `v` 로 (`t: 1` = string)
    """
    if isinstance(val, str) and val.startswith("="):
        return {"f": val, "v": ""}
    if isinstance(val, bool):
        return {"v": val, "t": 4}  # boolean
    if isinstance(val, (int, float)):
        return {"v": val, "t": 2}  # number
    # fallback: string
    return {"v": str(val), "t": 1}


def apply_patches(snapshot: dict, patches: list[dict]) -> tuple[dict, list[str]]:
    """패치 배열을 스냅샷에 in-place 적용.

    patches: [{"range": "A1", "value": "..."}] — 단일 셀 range 만 허용.
    반환: (수정된 snapshot, skipped_ranges) — 잘못된 range 는 skip.
    """
    sheet = _ensure_active_sheet(snapshot)
    cell_data = sheet.setdefault("cellData", {})
    skipped: list[str] = []

    # 필요 시 시트 차원 자동 확장
    max_row = sheet.get("rowCount", 100)
    max_col = sheet.get("columnCount", 26)

    for p in patches or []:
        if not isinstance(p, dict):
            continue
        rng = p.get("range")
        val = p.get("value")
        if val is None or not isinstance(rng, str):
            skipped.append(str(rng))
            continue
        pos = parse_a1(rng)
        if pos is None:
            skipped.append(rng)
            continue
        row, col = pos
        row_key = str(row)
        col_key = str(col)
        cell_data.setdefault(row_key, {})[col_key] = _coerce_value(val)
        if row + 1 > max_row:
            max_row = row + 1
        if col + 1 > max_col:
            max_col = col + 1

    sheet["rowCount"] = max_row
    sheet["columnCount"] = max_col
    return snapshot, skipped


def build_snapshot(patches: list[dict], sheet_name: str = "Sheet1") -> tuple[str, list[str]]:
    """빈 워크북 + patches 로 새 스냅샷 JSON 문자열 생성."""
    wb = empty_workbook(sheet_name=sheet_name)
    _, skipped = apply_patches(wb, patches)
    return json.dumps(wb, ensure_ascii=False), skipped


def patch_existing(code: str, patches: list[dict]) -> tuple[str, list[str]]:
    """기존 cell.code(JSON) 를 로드해 패치 적용 후 다시 직렬화."""
    try:
        snap = json.loads(code) if code else empty_workbook()
        if not isinstance(snap, dict) or "sheets" not in snap:
            snap = empty_workbook()
    except Exception:
        snap = empty_workbook()
    snap, skipped = apply_patches(snap, patches)
    return json.dumps(snap, ensure_ascii=False), skipped
