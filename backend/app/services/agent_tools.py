"""Agent Mode 공용 tool 스펙 — Claude/Gemini 단일 정의.

설계 메모:
- Claude의 `input_schema` (JSON Schema) 를 정식 소스로 둔다.
- Gemini의 `function_declarations` 는 `_to_gemini_declaration()` 으로 변환 생성한다.
- `gemini_exclude` 리스트는 Gemini에서 제외할 tool 이름 (과거 비대칭 보존).
"""
from __future__ import annotations
from typing import Iterable


# JSON Schema 타입 → Gemini 타입 변환 (Gemini는 대문자 사용).
_TYPE_MAP = {
    "object": "OBJECT",
    "string": "STRING",
    "integer": "INTEGER",
    "number": "NUMBER",
    "boolean": "BOOLEAN",
    "array": "ARRAY",
}


# Gemini Schema 가 받지 않는 JSON Schema 메타 키 — 변환 시 제거.
# (예: 외부 MCP 도구 스키마는 Pydantic 산출물이라 additionalProperties/$defs 등을 포함)
_DROP_KEYS = {
    "additionalProperties", "additional_properties",
    "$schema", "$defs", "$id", "$ref", "title", "examples",
    "default",  # 일부 Gemini 버전 미지원
}


def _convert_schema(schema: dict) -> dict:
    """JSON Schema → Gemini parameters 스키마.

    - JSON Schema 타입을 Gemini 대문자 타입으로 변환
    - Gemini 가 거부하는 메타 키(additionalProperties 등) 제거
    - `anyOf: [X, {type: null}]` (Pydantic Optional 표현) → X + nullable 로 평탄화
    """
    if not isinstance(schema, dict):
        return schema

    # anyOf 처리 — Optional/Union 표현.
    any_of = schema.get("anyOf") or schema.get("any_of")
    if isinstance(any_of, list) and any_of:
        non_null = [v for v in any_of if not (isinstance(v, dict) and v.get("type") == "null")]
        has_null = len(non_null) != len(any_of)
        if len(non_null) == 1:
            merged = _convert_schema(non_null[0])
            if has_null:
                merged["nullable"] = True
            # 형제 키(description 등)를 병합 (anyOf/null/드롭 키 제외)
            for k, v in schema.items():
                if k in ("anyOf", "any_of") or k in _DROP_KEYS:
                    continue
                merged.setdefault(k, _convert_schema(v) if isinstance(v, dict) else v)
            return merged
        out: dict = {"anyOf": [_convert_schema(v) for v in non_null]}
        if has_null:
            out["nullable"] = True
        for k, v in schema.items():
            if k in ("anyOf", "any_of") or k in _DROP_KEYS:
                continue
            out.setdefault(k, _convert_schema(v) if isinstance(v, dict) else v)
        return out

    out = {}
    for k, v in schema.items():
        if k in _DROP_KEYS:
            continue
        if k == "type" and isinstance(v, str):
            out[k] = _TYPE_MAP.get(v.lower(), v.upper())
        elif k == "properties" and isinstance(v, dict):
            out[k] = {pk: _convert_schema(pv) for pk, pv in v.items()}
        elif k == "items" and isinstance(v, dict):
            out[k] = _convert_schema(v)
        else:
            out[k] = v
    return out


def _to_gemini_declaration(tool: dict) -> dict:
    return {
        "name": tool["name"],
        "description": tool["description"],
        "parameters": _convert_schema(tool["input_schema"]),
    }


# ─── Tool 정의 (Claude 포맷 단일 소스) ─────────────────────────────────────

CORE_TOOLS: list[dict] = [
    {
        "name": "read_notebook_context",
        "description": "Read the current state of all cells in the notebook, including code, execution status, and output summary.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "create_cell",
        "description": "Create a new cell in the notebook with initial code.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_type": {
                    "type": "string",
                    "enum": ["sql", "python", "markdown"],
                    "description": "Type of cell to create",
                },
                "name": {"type": "string", "description": "Cell name (optional)"},
                "code": {"type": "string", "description": "Initial code for the cell"},
                "after_cell_id": {
                    "type": "string",
                    "description": "ID of the cell to insert after (optional, defaults to end)",
                },
            },
            "required": ["cell_type", "code"],
        },
    },
    {
        "name": "update_cell_code",
        "description": "Update the code of an existing cell.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string", "description": "ID of the cell to update"},
                "code": {"type": "string", "description": "New code content"},
            },
            "required": ["cell_id", "code"],
        },
    },
    {
        "name": "execute_cell",
        "description": "Execute a cell against the real Snowflake DB or Python kernel and get its actual output.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string", "description": "ID of the cell to execute"}
            },
            "required": ["cell_id"],
        },
    },
    {
        "name": "read_cell_output",
        "description": "Read the output of an already-executed cell.",
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string", "description": "ID of the cell"}
            },
            "required": ["cell_id"],
        },
    },
    {
        "name": "get_mart_schema",
        "description": (
            "Get column schema (name, type, description) of a selected mart. "
            "MUST be called before writing SQL against a mart to avoid column-not-found errors."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "mart_key": {"type": "string", "description": "Mart key (table name, e.g. 'mart_revenue')"}
            },
            "required": ["mart_key"],
        },
    },
    {
        "name": "preview_mart",
        "description": (
            "Fetch top N rows from a mart WITHOUT creating a notebook cell. "
            "Use this to sanity-check data shape before writing real analysis cells."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "mart_key": {"type": "string"},
                "limit": {"type": "integer", "default": 5, "description": "Row limit (1~50)"},
            },
            "required": ["mart_key"],
        },
    },
    {
        "name": "profile_mart",
        "description": (
            "Profile a mart: total row count, per-column NULL ratio, distinct count, "
            "and min/max/avg for numeric columns. Samples up to 100k rows for large tables."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"mart_key": {"type": "string"}},
            "required": ["mart_key"],
        },
    },
    {
        "name": "get_category_values",
        "description": (
            "Fetch distinct values of a **category-like column** (예: `_status`, `_type` 접미, "
            "또는 `category`, `channel`, `mode` 같은 구분자 컬럼). 최대 100개까지 반환. "
            "`*_status` / `*_type` 컬럼은 이미 시스템 프롬프트에 주입되어 있으므로 **그 외 컬럼** 에만 호출. "
            "WHERE 절 값을 추측하지 말고 이 도구로 확인하라."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "mart_key": {"type": "string"},
                "column": {"type": "string", "description": "컬럼명 (원본 대소문자 유지)"},
            },
            "required": ["mart_key", "column"],
        },
    },
    {
        "name": "write_cell_memo",
        "description": (
            "Write or update a cell's memo (노트). Use this to record INSIGHTS derived from the cell's output "
            "— key findings, anomalies, numbers worth remembering, next-step hypotheses. "
            "Call after observing a cell's output. Short bullet points preferred (2~5줄)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string"},
                "memo": {"type": "string", "description": "Korean plain-text insight memo. 2~5 줄 불릿. **절대** `**볼드**`, `__강조__`, `# 헤더`, `- **관찰:**`·`- **인사이트:**` 같은 라벨 머리말을 쓰지 말 것. 평문(`- `)과 일반 문장만 허용."},
            },
            "required": ["cell_id", "memo"],
        },
    },
    {
        "name": "check_chart_quality",
        "description": (
            "Record the chart quality verdict for a chart cell. Call this AFTER looking at the rendered PNG "
            "of a chart cell, evaluating it against the reporting-grade checklist (title/axes/labels/ordering/"
            "legend/colors/data-fidelity/margins/chart-type/extra-context). "
            "Call it EXACTLY ONCE per chart render attempt. If `passed` is false, immediately follow up with "
            "`update_cell_code` to fix the same cell; if true, proceed to `write_cell_memo`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string", "description": "Chart cell id being evaluated"},
                "passed": {"type": "boolean", "description": "True if the chart meets reporting-grade quality"},
                "issues": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Concrete issues to fix when passed=false (한국어 짧은 문장). passed=true 인 경우 빈 배열.",
                },
                "summary": {
                    "type": "string",
                    "description": "One-line Korean verdict summary (e.g. '차트 퀄리티 OK: 리포팅 사용 가능' / '축 라벨 누락 — 재렌더 필요')",
                },
            },
            "required": ["cell_id", "passed", "summary"],
        },
    },
    {
        "name": "create_sheet_cell",
        "description": (
            "Create a new SPREADSHEET (sheet) cell and fill it with values/formulas. "
            "Use when the user wants a quick tabular summary, a reference matrix, a checklist table, "
            "or any ad-hoc data entry surface that's NOT a SQL query or Python DataFrame. "
            "Cells are addressed in A1 notation. Strings starting with '=' are treated as spreadsheet formulas "
            "(e.g. '=SUM(B2:B9)', '=AVERAGE(A1:A10)'). "
            "Sheet cells are non-executable — they persist as-is and are good for the analyst's own notes/matrices."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Cell name in snake_case (optional)"},
                "after_cell_id": {"type": "string", "description": "Insert after this cell (optional)"},
                "patches": {
                    "type": "array",
                    "description": "List of single-cell writes. Each: {range: 'A1', value: str|number|bool}. Formulas start with '='.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "range": {"type": "string", "description": "A1 notation of a single cell, e.g. 'B3'"},
                            "value": {"description": "String, number, or boolean. Strings starting with '=' are formulas."},
                        },
                        "required": ["range", "value"],
                    },
                },
            },
            "required": ["patches"],
        },
    },
    {
        "name": "update_sheet_cell",
        "description": (
            "Apply patches to an existing sheet cell — overwrites the targeted A1 cells, leaves others intact. "
            "Use to incrementally fill in or correct a previously created sheet."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {"type": "string"},
                "patches": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "range": {"type": "string"},
                            "value": {},
                        },
                        "required": ["range", "value"],
                    },
                },
            },
            "required": ["cell_id", "patches"],
        },
    },
    {
        "name": "ask_user",
        "description": (
            "Ask the user a clarification question when the request is ambiguous or missing "
            "required context (target period, region, metric, etc.). "
            "After calling this tool, respond with a short acknowledgement text and STOP calling tools — "
            "the agent session will end and wait for the user's reply."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question to ask the user"},
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional suggested answer choices",
                },
            },
            "required": ["question"],
        },
    },
    {
        "name": "query_data",
        "description": (
            "Run an ad-hoc SELECT query against Snowflake WITHOUT creating a notebook cell. "
            "Use this to quickly verify assumptions, check value distributions, test join conditions, "
            "or sanity-check data before writing a real analysis cell. "
            "All tables referenced MUST be in the selected marts whitelist. "
            "Max 100 rows — attach `LIMIT` to your SQL. "
            "This is your 'scratch pad' — prefer it over creating throwaway cells."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": (
                        "SELECT-only SQL. Must reference only selected marts. Keep it short and targeted. "
                        "Results are capped at 100 rows — always include LIMIT."
                    ),
                },
                "purpose": {
                    "type": "string",
                    "description": "One-line Korean note on WHY you are running this (logged in agent history).",
                },
            },
            "required": ["sql", "purpose"],
        },
    },
    {
        "name": "analyze_output",
        "description": (
            "Run automatic statistical analysis on an already-executed SQL or Python cell's DataFrame output. "
            "Returns describe() stats, top/bottom N by each numeric column, NULL counts, high-cardinality columns, "
            "and outlier flags (IQR-based). Use this to extract insights from large tables without manually "
            "eyeballing rows — much more reliable than reading the first 10 rows. "
            "Prefer this over writing manual describe/value_counts Python cells for simple inspection."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "cell_id": {
                    "type": "string",
                    "description": "ID of a cell whose output is a table/DataFrame",
                },
                "focus_column": {
                    "type": "string",
                    "description": "Optional — numeric column to focus top/bottom/outlier analysis on (default: all numeric).",
                },
                "top_n": {
                    "type": "integer",
                    "description": "Number of top/bottom rows to return per numeric column (default 5, max 20).",
                },
            },
            "required": ["cell_id"],
        },
    },
    {
        "name": "list_available_marts",
        "description": (
            "List ALL data marts available in the warehouse (not just currently selected). "
            "Returns keys + one-line descriptions so you can intelligently suggest which marts to add "
            "when the currently selected marts are insufficient. "
            "Use this BEFORE calling `request_marts` so your suggested_mart_keywords are accurate and specific. "
            "Does NOT grant access — user must still add marts via the UI."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filter_keyword": {
                    "type": "string",
                    "description": "Optional — filter marts whose key or description contains this keyword (case-insensitive).",
                },
            },
            "required": [],
        },
    },
    {
        "name": "todo_write",
        "description": (
            "Manage a lightweight TODO list for the current analysis session. "
            "Call this when the task has 3+ sub-steps so the user can see progress transparently. "
            "Replace the entire list each call — include ALL items (pending + in-progress + completed) to keep state consistent. "
            "Mark one item as `in_progress` at a time, flip to `completed` right after finishing it. "
            "Do NOT use for trivial single-step requests."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "Complete replacement list of analysis steps.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "Imperative Korean description of the step (e.g. '매장별 매출 집계 SQL 작성').",
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                            },
                            "active_form": {
                                "type": "string",
                                "description": "Present-continuous Korean label for in_progress state (e.g. '매장별 매출 집계하는 중').",
                            },
                        },
                        "required": ["content", "status"],
                    },
                },
            },
            "required": ["todos"],
        },
    },
]


# Gemini에서 의도적으로 제외되는 tool.
_GEMINI_EXCLUDE: set[str] = set()


def claude_tools(skill_tools: Iterable[dict], method_tools: Iterable[dict] = ()) -> list[dict]:
    """Claude용 최종 tool 리스트 (CORE + skill tools + method routing tools).

    method_tools 는 Phase 0 의 select_methods (S2) 와 향후 메서드별 도구 (S4~S6) 가
    들어갈 자리. 호출자가 명시적으로 넘겨 의존성을 분리한다.
    """
    return [*CORE_TOOLS, *skill_tools, *method_tools]


def gemini_function_declarations(
    skill_tools_gemini: Iterable[dict],
    method_tools_gemini: Iterable[dict] = (),
) -> list[dict]:
    """Gemini용 최종 function declaration 리스트."""
    core = [_to_gemini_declaration(t) for t in CORE_TOOLS if t["name"] not in _GEMINI_EXCLUDE]
    return [*core, *skill_tools_gemini, *method_tools_gemini]


def to_gemini_declarations(claude_specs: Iterable[dict]) -> list[dict]:
    """Claude 포맷 tool 스펙 리스트 → Gemini function declaration 리스트.

    런타임에 동적으로 추가되는 도구(예: 외부 MCP 도구)를 Gemini 에 노출할 때 사용.
    """
    return [_to_gemini_declaration(t) for t in claude_specs]
