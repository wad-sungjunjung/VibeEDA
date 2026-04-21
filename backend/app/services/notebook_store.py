"""
.ipynb 파일 기반 노트북 저장소.
~/vibe-notebooks/{uuid}.ipynb 형태로 저장.
채팅 히스토리·에이전트 히스토리는 metadata.vibe 에 저장.
폴더 메타데이터는 ~/.vibe-notebooks/.vibe_config.json 에 저장.
"""
import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

_SETTINGS_FILE = Path.home() / ".vibe_eda_settings.json"


def _load_settings() -> dict:
    if _SETTINGS_FILE.exists():
        try:
            return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_settings(data: dict) -> None:
    try:
        _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


_settings = _load_settings()
NOTEBOOKS_DIR = Path(_settings.get("notebooks_dir", str(Path.home() / "vibe-notebooks"))).expanduser().resolve()
CONFIG_FILE = NOTEBOOKS_DIR / ".vibe_config.json"


# ── 초기화 ────────────────────────────────────────────────────────────────────

def _ensure_dir() -> None:
    NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)


def set_notebooks_dir(new_path: str) -> Path:
    """노트북 저장 경로를 변경하고 설정 파일에 저장합니다."""
    global NOTEBOOKS_DIR, CONFIG_FILE
    resolved = Path(new_path).expanduser().resolve()
    resolved.mkdir(parents=True, exist_ok=True)
    NOTEBOOKS_DIR = resolved
    CONFIG_FILE = NOTEBOOKS_DIR / ".vibe_config.json"
    _save_settings({**_load_settings(), "notebooks_dir": str(resolved)})
    return resolved


def _read_config() -> dict:
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    return {"folders": []}


def _write_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ── 파일명 관리 ───────────────────────────────────────────────────────────────

def _sanitize_title(title: str) -> str:
    """타이틀을 Windows 유효 파일명으로 변환."""
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title).strip('. ') or 'notebook'
    return sanitized


def _unique_filename(title: str, exclude_id: str | None = None) -> str:
    """title 기반 충돌 없는 파일명(확장자 제외) 반환."""
    base = _sanitize_title(title)
    cfg = _read_config()
    used = set(v for k, v in cfg.get("id_to_file", {}).items() if k != exclude_id)
    if base not in used:
        return base
    n = 1
    while f"{base} {n}" in used:
        n += 1
    return f"{base} {n}"


def _register_file(nb_id: str, fname: str) -> None:
    cfg = _read_config()
    cfg.setdefault("id_to_file", {})[nb_id] = fname
    _write_config(cfg)


def _unregister_file(nb_id: str) -> None:
    cfg = _read_config()
    cfg.setdefault("id_to_file", {}).pop(nb_id, None)
    _write_config(cfg)


# ── 파일 I/O ──────────────────────────────────────────────────────────────────

_EXCLUDED_DIR_NAMES = {"reports", "__pycache__"}


def _iter_notebook_paths() -> list[Path]:
    """NOTEBOOKS_DIR 아래 모든 .ipynb 파일 (reports/, hidden, __pycache__ 제외)."""
    results: list[Path] = []
    if not NOTEBOOKS_DIR.exists():
        return results
    for p in NOTEBOOKS_DIR.rglob("*.ipynb"):
        try:
            rel_parts = p.relative_to(NOTEBOOKS_DIR).parts
        except ValueError:
            continue
        # 상위 디렉터리 중 하나라도 hidden/제외 디렉터리면 skip
        parent_parts = rel_parts[:-1]
        if any(part.startswith(".") or part in _EXCLUDED_DIR_NAMES for part in parent_parts):
            continue
        results.append(p)
    return results


def _nb_path(nb_id: str) -> Path:
    cfg = _read_config()
    rel = cfg.get("id_to_file", {}).get(nb_id)
    if rel:
        p = NOTEBOOKS_DIR / f"{rel}.ipynb"
        if p.exists():
            return p
    # Fallback: 재귀 스캔으로 metadata.vibe.id 가 일치하는 파일 찾기
    for p in _iter_notebook_paths():
        try:
            nb = json.loads(p.read_text(encoding="utf-8"))
            if nb.get("metadata", {}).get("vibe", {}).get("id") == nb_id:
                # 매핑 갱신 (상대 경로, 확장자 제외)
                new_rel = str(p.relative_to(NOTEBOOKS_DIR).with_suffix(""))
                cfg = _read_config()
                cfg.setdefault("id_to_file", {})[nb_id] = new_rel
                _write_config(cfg)
                return p
        except Exception:
            continue
    # 하위 호환: 기존 UUID 파일명
    return NOTEBOOKS_DIR / f"{nb_id}.ipynb"


def _read_nb(nb_id: str) -> dict:
    return json.loads(_nb_path(nb_id).read_text(encoding="utf-8"))


def _write_nb(nb_id: str, nb: dict) -> None:
    _nb_path(nb_id).write_text(
        json.dumps(nb, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )


# ── 출력 직렬화 ───────────────────────────────────────────────────────────────

def _parse_output(outputs: list) -> Optional[dict]:
    if not outputs:
        return None
    for out in outputs:
        data = out.get("data", {})
        if "application/vnd.vibe+json" in data:
            val = data["application/vnd.vibe+json"]
            return json.loads(val) if isinstance(val, str) else val
        if out.get("output_type") == "error":
            return {
                "type": "error",
                "message": out.get("evalue", "") + "\n" + "".join(out.get("traceback", [])),
            }
        if "text/plain" in data:
            return {"type": "stdout", "content": "".join(data["text/plain"])}
    return None


def _make_output_block(output: dict) -> dict:
    return {
        "output_type": "display_data",
        "data": {"application/vnd.vibe+json": output},
        "metadata": {},
    }


# ── 채팅 히스토리 변환 ────────────────────────────────────────────────────────

def _get_cell_chat_entries(vibe: dict, cell_id: str) -> list[dict]:
    """flat message pairs → ChatEntryRow list"""
    for entry in vibe.get("chat_history", []):
        if entry.get("cell_id") != cell_id:
            continue
        messages = entry.get("messages", [])
        result = []
        i = 0
        while i < len(messages):
            user_msg = messages[i] if messages[i].get("role") == "user" else None
            asst_msg = messages[i + 1] if (i + 1 < len(messages) and messages[i + 1].get("role") == "assistant") else None
            if user_msg and asst_msg:
                result.append({
                    "id": f"{cell_id}-{i}",
                    "user_message": user_msg.get("content", ""),
                    "assistant_reply": asst_msg.get("content", ""),
                    "code_snapshot": user_msg.get("code_snapshot", ""),
                    "code_result": asst_msg.get("code_result", ""),
                    "created_at": user_msg.get("ts", datetime.now().isoformat()),
                })
                i += 2
            else:
                i += 1
        return result
    return []


def _fmt_cell(cell: dict, vibe: dict) -> dict:
    m = cell.get("metadata", {})
    src = cell.get("source", "")
    return {
        "id": cell.get("id", ""),
        "name": m.get("vibe_name", cell.get("id", "")),
        "type": m.get("vibe_type", "python"),
        "code": "".join(src) if isinstance(src, list) else src,
        "memo": m.get("vibe_memo", ""),
        "ordering": m.get("vibe_ordering", 0),
        "executed": bool(cell.get("outputs")),
        "output": _parse_output(cell.get("outputs", [])),
        "insight": m.get("vibe_insight"),
        "agent_generated": m.get("vibe_agent_generated", False),
        "onboarding": m.get("vibe_onboarding", False),
        "chat_entries": _get_cell_chat_entries(vibe, cell.get("id", "")),
    }


def _fmt_agent_messages(vibe: dict) -> list[dict]:
    return [
        {
            "id": f"agent-{i}",
            "role": m.get("role", "user"),
            "content": m.get("content", ""),
            "created_cell_ids": m.get("created_cell_ids", []),
            "created_at": m.get("ts", datetime.now().isoformat()),
        }
        for i, m in enumerate(vibe.get("agent_history", []))
    ]


# ── 노트북 CRUD ───────────────────────────────────────────────────────────────

def _migrate_legacy_notebook(p: Path) -> str:
    """Migrate old UUID-filename notebooks: assign id in metadata and register in id_to_file."""
    nb = json.loads(p.read_text(encoding="utf-8"))
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    nb_id = p.stem  # UUID was the filename
    title = vibe.get("title") or "새 분석"
    vibe["id"] = nb_id
    # Rename file to title-based name
    fname = _unique_filename(title)
    new_path = NOTEBOOKS_DIR / f"{fname}.ipynb"
    vibe["title"] = title
    p.write_text(json.dumps(nb, ensure_ascii=False, indent=2), encoding="utf-8")
    if p != new_path:
        p.rename(new_path)
    _register_file(nb_id, fname)
    return nb_id


def list_notebooks() -> list[dict]:
    _ensure_dir()
    paths = _iter_notebook_paths()
    # 분석이 하나도 없으면 온보딩 노트북을 한 번 시딩한다.
    if not paths:
        try:
            create_onboarding_notebook()
        except Exception:
            pass
        paths = _iter_notebook_paths()
    result = []
    for p in sorted(paths, key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            nb = json.loads(p.read_text(encoding="utf-8"))
            vibe = nb.get("metadata", {}).get("vibe", {})
            nb_id = vibe.get("id")
            # Migrate legacy notebooks that have no id in metadata
            if not nb_id:
                nb_id = _migrate_legacy_notebook(p)
                p = _nb_path(nb_id)
                nb = json.loads(p.read_text(encoding="utf-8"))
                vibe = nb.get("metadata", {}).get("vibe", {})
            # id_to_file 매핑을 실제 파일 위치와 동기화 (하위 폴더로 이동된 경우도 반영)
            try:
                rel = str(p.relative_to(NOTEBOOKS_DIR).with_suffix(""))
                cfg = _read_config()
                if cfg.setdefault("id_to_file", {}).get(nb_id) != rel:
                    cfg["id_to_file"][nb_id] = rel
                    _write_config(cfg)
            except Exception:
                pass
            stat = p.stat()
            result.append({
                "id": nb_id,
                "title": vibe.get("title", nb_id),
                "description": vibe.get("description", ""),
                "selected_marts": vibe.get("selected_marts", []),
                "folder_id": vibe.get("folder_id"),
                "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
        except Exception:
            pass
    return result


def create_notebook(title: str = "새 분석", folder_id: Optional[str] = None) -> dict:
    _ensure_dir()
    nb_id = str(uuid.uuid4())
    fname = _unique_filename(title)
    _register_file(nb_id, fname)
    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "vibe": {
                "id": nb_id,
                "title": title,
                "description": "",
                "selected_marts": [],
                "folder_id": folder_id,
                "chat_history": [],
                "agent_history": [],
            },
        },
        "cells": [],
    }
    _write_nb(nb_id, nb)
    p = _nb_path(nb_id)
    stat = p.stat()
    return {
        "id": nb_id,
        "title": title,
        "description": "",
        "selected_marts": [],
        "folder_id": folder_id,
        "cells": [],
        "agent_messages": [],
        "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
        "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


_ONBOARDING_TITLE = "Vibe EDA 시작하기"

_ONBOARDING_CELLS: list[dict] = [
    {
        "type": "markdown",
        "name": "welcome",
        "code": (
            "# 👋 Vibe EDA에 오신 것을 환영합니다\n"
            "\n"
            "**Vibe EDA**는 광고 플랫폼 데이터 분석가를 위한 **AI 네이티브 EDA 도구**입니다.  \n"
            "Jupyter 노트북의 상위 버전 — 자연어 채팅으로 SQL/Python 코드를 생성·수정하고 리포트를 자동 생성합니다.\n"
            "\n"
            "이 노트북은 **첫 실행용 가이드**입니다. 아래 셀을 위에서부터 훑어보며 기능을 익혀보세요.\n"
            "좌측 상단 **＋ 새 분석**으로 언제든 빈 노트북을 새로 시작할 수 있습니다."
        ),
    },
    {
        "type": "markdown",
        "name": "setup_connection",
        "code": (
            "## 🔌 연결 설정 (최초 1회)\n"
            "\n"
            "실제 분석을 시작하기 전에 아래 두 가지를 설정하세요.\n"
            "\n"
            "### 1. 모델 / API 키\n"
            "좌측 사이드바 하단 **설정 아이콘(⚙️)** → 모델 설정에서 API 키 입력:\n"
            "- **Gemini API 키** — `gemini-2.5-flash/pro` 등 구글 모델 사용 시 필요\n"
            "- **Anthropic API 키** — `claude-opus/sonnet/haiku` 등 Claude 모델 사용 시 필요\n"
            "\n"
            "두 키 모두 **Vibe Chat · Agent Mode · 리포트 생성** 어디에서든 공통으로 쓰입니다.\n"
            "각 기능의 모델은 실행 시점에 드롭다운에서 선택할 수 있고 (Gemini 선택 → Gemini 키, Claude 선택 → Anthropic 키 사용), 최소 하나만 입력돼 있어도 작동합니다.\n"
            "키는 `localStorage`에 저장됩니다.\n"
            "\n"
            "### 2. Snowflake 연결\n"
            "좌측 상단 **연결 관리** 버튼에서 계정·웨어하우스·데이터베이스 정보를 입력하고 **SSO 로그인(externalbrowser)** 으로 인증합니다.\n"
            "연결 성공 후 SQL 셀 실행이 가능해집니다.\n"
            "\n"
            "#### 계정 식별자 / Role 찾는 법\n"
            "Snowflake 웹 콘솔 좌측 하단 프로필 아이콘을 클릭 → 현재 계정 패널에서 **View account details** 를 열면 `Account identifier` 와 `Role` 을 확인할 수 있습니다.\n"
            "\n"
            "![Snowflake 계정 메뉴](/onboarding/snowflake-account-menu.png)\n"
            "\n"
            "![Account Details 모달](/onboarding/snowflake-account-details.png)\n"
            "\n"
            "- **Account identifier** (예: `BVJAEKO-LA86305`) → 연결 관리 모달의 `Account` 필드\n"
            "- **Role** (예: `HOWSRIO147__U_ROLE`) → `Role` 필드\n"
            "- **Login name** (이메일) → `User` 필드\n"
            "\n"
            "> 💡 연결 정보는 localStorage + 백엔드 세션에 저장되어 재기동 시에도 유지됩니다."
        ),
    },
    {
        "type": "markdown",
        "name": "quick_start",
        "code": (
            "## 1. 세 가지 셀 타입\n"
            "\n"
            "- **SQL 셀** — Snowflake에 쿼리. 결과는 테이블로 표시되고 셀 이름(예: `daily_sales`)으로 DataFrame namespace에 저장됨.\n"
            "- **Python 셀** — in-process 커널에서 실행. Plotly 차트, 통계 분석 등.\n"
            "- **Markdown 셀** — 분석 메모와 인사이트 기록.\n"
            "\n"
            "셀 좌측 타입 배지를 클릭하면 `SQL → Python → Markdown` 순으로 순환 전환됩니다.\n"
            "\n"
            "## 2. 바이브 채팅 (셀 단위)\n"
            "\n"
            "활성 셀 하단 채팅창에 **자연어로 요청**하면 코드가 자동 수정·실행됩니다.\n"
            "\n"
            "> 예: *\"시도별로 group by 해줘\"*, *\"최근 7일 필터 추가\"*, *\"pie 차트로 시각화\"*\n"
            "\n"
            "- `Enter` 전송 · `Shift+Enter` 줄바꿈\n"
            "- 대화 이력을 클릭해 이전 코드 시점으로 **롤백** 가능\n"
            "\n"
            "## 3. 에이전트 모드 (노트북 전체)\n"
            "\n"
            "우측 하단 **FAB 버튼** 또는 `Cmd/Ctrl + G`로 토글. 노트북 전체 맥락을 보고 **여러 셀을 자동 생성·실행**합니다.\n"
            "\n"
            "> 예: *\"강남구 세부 분석해줘\"*, *\"전체 인사이트 요약\"*"
        ),
    },
    {
        "type": "markdown",
        "name": "top_bar_guide",
        "code": (
            "## 🧭 상단 메타 헤더\n"
            "\n"
            "노트북 상단에는 분석 맥락과 전역 액션이 모여 있습니다. 화살표(∨)로 펼치면 상세 영역이 나타납니다.\n"
            "\n"
            "| 영역 | 설명 |\n"
            "|---|---|\n"
            "| **📝 분석 내용** | 이 분석의 목적·가설을 자연어로 기록. **상세할수록 AI 마트 추천 품질이 올라갑니다.** |\n"
            "| **🗂 사용 마트** | 분석에 사용할 마트를 좌측 패널에서 골라 우측으로 추가. `fact / dim / rpt / obt / 선택됨 / 전체` 필터와 **✨ AI 마트 추천**. |\n"
            "| **📊 마트 정보** | 선택한 마트의 컬럼/grain/설명. 좌측 목록에서 마트명을 클릭하면 여기에 표시됩니다. |\n"
            "| **▶ 모두 실행** | 모든 셀을 순차 실행. 셀 간 변수 공유(SQL 결과 → Python 참조)를 살리려면 위에서부터 순서대로 실행되어야 합니다. |\n"
            "| **📄 리포팅** | 노트북 전체를 Markdown 리포트로 변환. 제목/설명/각 셀의 코드·출력·메모·인사이트가 한 문서로 묶입니다. |\n"
            "\n"
            "> 💡 \"사용 마트\"를 먼저 설정하면 Vibe Chat / Agent가 해당 마트 스키마를 컨텍스트로 받아 **훨씬 정확한 SQL**을 생성합니다."
        ),
    },
    {
        "type": "markdown",
        "name": "right_sidebar_guide",
        "code": (
            "## 🧩 우측 사이드바\n"
            "\n"
            "오른쪽 사이드바는 **현재 노트북의 맥락 탐색용** 패널입니다.\n"
            "\n"
            "### 📦 데이터\n"
            "- 선택한 마트의 컬럼 목록과 SQL 셀 실행 결과의 **스키마·샘플**을 탐색.\n"
            "- 검색창으로 컬럼명을 빠르게 필터링.\n"
            "- 마트 미선택 + 셀 미실행 상태에서는 안내 메시지만 표시됩니다.\n"
            "\n"
            "### 🔖 셀 네비게이션\n"
            "- 노트북 내 **모든 셀의 요약 목록**. 실행 여부가 배지로 표시됩니다.\n"
            "- 항목 클릭 → 해당 셀로 **즉시 스크롤 이동**.\n"
            "- 대규모 노트북에서 목차처럼 활용하세요.\n"
            "\n"
            "### 🤖 에이전트 이력\n"
            "- Agent Mode 세션별 메시지 히스토리.\n"
            "- 이전 세션을 클릭하면 해당 맥락을 이어서 대화할 수 있습니다.\n"
            "\n"
            "> 💡 세 영역 사이 구분선을 드래그해 높이 비율을 조절할 수 있습니다."
        ),
    },
    {
        "type": "sql",
        "name": "example_query",
        "code": (
            "-- 예시 SQL 셀\n"
            "-- 1) 좌측 사이드바에서 Snowflake 연결을 먼저 설정하세요.\n"
            "-- 2) 우측 상단 \"사용할 마트\"에 분석 대상 마트를 추가한 뒤, 아래 채팅창에\n"
            "--    \"최근 7일 매출을 시도별로 집계\" 같은 자연어 요청을 입력해 보세요.\n"
            "\n"
            "SELECT 1 AS hello, 'vibe-eda' AS tool;"
        ),
    },
    {
        "type": "python",
        "name": "example_chart",
        "code": (
            "# 예시 Python 셀 — Plotly로 간단한 막대 그래프를 그려봅니다.\n"
            "# 위 SQL 셀을 실행한 뒤 `example_query` DataFrame을 바로 참조할 수 있어요.\n"
            "\n"
            "import pandas as pd\n"
            "import plotly.express as px\n"
            "\n"
            "df = pd.DataFrame({\n"
            "    'category': ['서울', '경기', '부산', '대구'],\n"
            "    'revenue': [145, 98, 42, 31],\n"
            "})\n"
            "\n"
            "fig_region_bar = px.bar(df, x='category', y='revenue', title='지역별 매출 (예시)')\n"
            "fig_region_bar"
        ),
    },
    {
        "type": "markdown",
        "name": "next_steps",
        "code": (
            "## 다음 단계\n"
            "\n"
            "1. **실제 분석 시작** — 좌측 상단 `＋` 버튼으로 **새 분석**을 생성하세요.\n"
            "2. **마트 지정** — 상단 헤더의 *사용 마트*에서 분석 대상 마트를 추가합니다.\n"
            "3. **Vibe Chat / Agent 활용** — 셀 하단 채팅으로 코드를 생성하거나, `Cmd/Ctrl+G`로 Agent Mode를 켜 전체 흐름을 자동화하세요.\n"
            "4. **Claude Code 연동 (선택)** — `python -m app.api.mcp_server`로 MCP 서버를 실행하면 Claude Code가 이 노트북에 직접 접근할 수 있습니다.\n"
            "   - 💬 설정이 잘 안 되면 **Claude Code한테 직접 물어보세요** — MCP 등록 경로/명령어를 현재 환경에 맞게 알려줍니다.\n"
            "\n"
            "---\n"
            "\n"
            "📚 자세한 문서: `docs/vibe-eda-prd.md`, `docs/vibe-eda-functional-spec.md`, `docs/vibe-eda-agent-spec.md`\n"
            "\n"
            "이 노트북은 언제든 삭제할 수 있으며, 모든 노트북을 지우면 다시 생성됩니다."
        ),
    },
]


def create_onboarding_notebook() -> dict:
    """첫 실행 시 사용자가 기능을 빠르게 익힐 수 있도록 예시 셀이 채워진
    '온보딩' 노트북을 생성한다. 분석이 하나도 없을 때 한 번 시딩된다."""
    _ensure_dir()
    nb_id = str(uuid.uuid4())
    fname = _unique_filename(_ONBOARDING_TITLE)
    _register_file(nb_id, fname)

    description = (
        "Vibe EDA를 처음 사용하는 분들을 위한 가이드 노트북입니다. "
        "셀 타입, 바이브 채팅, 에이전트 모드 사용법을 담고 있어요."
    )

    cells: list[dict] = []
    for i, spec in enumerate(_ONBOARDING_CELLS):
        cells.append({
            "id": str(uuid.uuid4()),
            "cell_type": "code" if spec["type"] in ("sql", "python") else "markdown",
            "source": spec["code"],
            "metadata": {
                "vibe_type": spec["type"],
                "vibe_name": spec["name"],
                "vibe_memo": "",
                "vibe_ordering": float(i + 1) * 1000.0,
                "vibe_agent_generated": False,
                "vibe_onboarding": True,
            },
            "outputs": [],
            "execution_count": None,
        })

    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "vibe": {
                "id": nb_id,
                "title": _ONBOARDING_TITLE,
                "description": description,
                "selected_marts": [],
                "folder_id": None,
                "chat_history": [],
                "agent_history": [],
                "onboarding": True,
            },
        },
        "cells": cells,
    }
    _write_nb(nb_id, nb)
    return get_notebook(nb_id)


def get_notebook(nb_id: str) -> dict:
    nb = _read_nb(nb_id)
    vibe = nb.get("metadata", {}).get("vibe", {})

    # 과거 중복 persistence 버그로 동일 id 셀이 쌓인 .ipynb 자동 복구 —
    # 첫 등장 셀만 유지하고 나머지는 버린 뒤 파일을 재기록.
    raw_cells = nb.get("cells", [])
    seen: set[str] = set()
    deduped: list[dict] = []
    for c in raw_cells:
        cid = c.get("id")
        if cid and cid in seen:
            continue
        if cid:
            seen.add(cid)
        deduped.append(c)
    if len(deduped) != len(raw_cells):
        nb["cells"] = deduped
        _write_nb(nb_id, nb)

    cells = [_fmt_cell(c, vibe) for c in deduped]
    p = _nb_path(nb_id)
    stat = p.stat()
    return {
        "id": nb_id,
        "title": vibe.get("title", nb_id),
        "description": vibe.get("description", ""),
        "selected_marts": vibe.get("selected_marts", []),
        "folder_id": vibe.get("folder_id"),
        "cells": cells,
        "agent_messages": _fmt_agent_messages(vibe),
        "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
        "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }


def update_notebook_meta(nb_id: str, **kwargs) -> dict:
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})

    new_title = kwargs.get("title")
    if new_title is not None and new_title != vibe.get("title"):
        old_path = _nb_path(nb_id)
        new_fname = _unique_filename(new_title, exclude_id=nb_id)
        new_path = NOTEBOOKS_DIR / f"{new_fname}.ipynb"
        if old_path.exists() and old_path != new_path:
            old_path.rename(new_path)
        _register_file(nb_id, new_fname)

    for k, v in kwargs.items():
        if v is not None or k == "folder_id":
            vibe[k] = v
    _write_nb(nb_id, nb)
    return get_notebook(nb_id)


def delete_notebook(nb_id: str) -> None:
    p = _nb_path(nb_id)
    if p.exists():
        p.unlink()
    _unregister_file(nb_id)


# ── 셀 CRUD ───────────────────────────────────────────────────────────────────

def create_cell(
    nb_id: str,
    cell_type: str,
    name: str,
    code: str = "",
    memo: str = "",
    ordering: float = None,
    cell_id: str = None,
    after_id: str = None,
    agent_generated: bool = False,
) -> dict:
    nb = _read_nb(nb_id)
    cells = nb.setdefault("cells", [])

    # Idempotency: 동일 cell_id가 이미 존재하면 새로 추가하지 않고 기존 셀을 반환.
    # 에이전트 스트림(frontend POST)과 백엔드 persistence가 중복 호출되는 경우를 방어한다.
    if cell_id:
        existing = next((c for c in cells if c.get("id") == cell_id), None)
        if existing:
            return _fmt_cell(existing, nb.get("metadata", {}).get("vibe", {}))

    if ordering is None:
        ordering = float(len(cells) + 1) * 1000.0
    new_id = cell_id or str(uuid.uuid4())
    cell = {
        "id": new_id,
        "cell_type": "code" if cell_type in ("sql", "python") else "markdown",
        "source": code,
        "metadata": {
            "vibe_type": cell_type,
            "vibe_name": name,
            "vibe_memo": memo,
            "vibe_ordering": ordering,
            "vibe_agent_generated": agent_generated,
        },
        "outputs": [],
        "execution_count": None,
    }
    if after_id:
        idx = next((i for i, c in enumerate(cells) if c.get("id") == after_id), len(cells) - 1)
        cells.insert(idx + 1, cell)
    else:
        cells.append(cell)
    _write_nb(nb_id, nb)
    return {
        "id": new_id, "name": name, "type": cell_type, "code": code,
        "memo": memo, "ordering": ordering, "executed": False,
        "output": None, "insight": None, "agent_generated": agent_generated,
        "chat_entries": [],
    }


def update_cell(nb_id: str, cell_id: str, **kwargs) -> dict:
    nb = _read_nb(nb_id)
    cell = next((c for c in nb.get("cells", []) if c.get("id") == cell_id), None)
    if not cell:
        raise ValueError(f"Cell {cell_id} not found in {nb_id}")
    m = cell.setdefault("metadata", {})
    field_map = {
        "code": lambda v: cell.__setitem__("source", v),
        "name": lambda v: m.__setitem__("vibe_name", v),
        "type": lambda v: (m.__setitem__("vibe_type", v), cell.__setitem__("cell_type", "code" if v in ("sql","python") else "markdown")),
        "memo": lambda v: m.__setitem__("vibe_memo", v),
        "ordering": lambda v: m.__setitem__("vibe_ordering", v),
        "insight": lambda v: m.__setitem__("vibe_insight", v),
        "output": lambda v: cell.__setitem__("outputs", [] if v is None else [_make_output_block(v)]),
        "executed": lambda v: None,  # derived from outputs
    }
    for k, v in kwargs.items():
        if k in field_map:
            field_map[k](v)
    _write_nb(nb_id, nb)
    return _fmt_cell(cell, nb.get("metadata", {}).get("vibe", {}))


def delete_cell(nb_id: str, cell_id: str) -> None:
    nb = _read_nb(nb_id)
    nb["cells"] = [c for c in nb.get("cells", []) if c.get("id") != cell_id]
    _write_nb(nb_id, nb)


def get_cell_above_name(nb_id: str, cell_id: str) -> Optional[str]:
    """Return vibe_name of the nearest SQL/Python cell directly above cell_id."""
    nb = _read_nb(nb_id)
    cells = nb.get("cells", [])
    target_ordering = None
    for c in cells:
        if c.get("id") == cell_id:
            target_ordering = c.get("metadata", {}).get("vibe_ordering", 0)
            break
    if target_ordering is None:
        return None
    best = None
    best_ordering = float("-inf")
    for c in cells:
        if c.get("id") == cell_id:
            continue
        m = c.get("metadata", {})
        o = m.get("vibe_ordering", 0)
        vtype = m.get("vibe_type", "python")
        if o < target_ordering and o > best_ordering and vtype in ("sql", "python"):
            best_ordering = o
            best = m.get("vibe_name")
    return best


# ── 채팅 저장 ─────────────────────────────────────────────────────────────────

def add_chat_entry(nb_id: str, cell_id: str, user_msg: str, assistant_reply: str, code_snapshot: str, code_result: str = "") -> None:
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    chat_history = vibe.setdefault("chat_history", [])
    entry = next((e for e in chat_history if e.get("cell_id") == cell_id), None)
    if not entry:
        entry = {"cell_id": cell_id, "messages": []}
        chat_history.append(entry)
    ts = datetime.now().isoformat()
    entry["messages"].append({"role": "user", "content": user_msg, "code_snapshot": code_snapshot, "ts": ts})
    entry["messages"].append({"role": "assistant", "content": assistant_reply, "code_result": code_result, "ts": ts})
    _write_nb(nb_id, nb)


def delete_chat_entry(nb_id: str, cell_id: str, index: int) -> None:
    """Delete the (user, assistant) pair at pair-index `index` for a cell."""
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    chat_history = vibe.setdefault("chat_history", [])
    entry = next((e for e in chat_history if e.get("cell_id") == cell_id), None)
    if not entry:
        return
    messages = entry.get("messages", [])
    start = index * 2
    if 0 <= start < len(messages):
        del messages[start:start + 2]
    _write_nb(nb_id, nb)


def truncate_chat_history(nb_id: str, cell_id: str, keep: int) -> None:
    """Keep only the first `keep` (user, assistant) pairs for a cell."""
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    chat_history = vibe.setdefault("chat_history", [])
    entry = next((e for e in chat_history if e.get("cell_id") == cell_id), None)
    if not entry:
        return
    entry["messages"] = entry.get("messages", [])[: max(keep, 0) * 2]
    _write_nb(nb_id, nb)


def add_agent_message(nb_id: str, role: str, content: str, created_cell_ids: list = None) -> None:
    nb = _read_nb(nb_id)
    vibe = nb.setdefault("metadata", {}).setdefault("vibe", {})
    vibe.setdefault("agent_history", []).append({
        "role": role, "content": content,
        "created_cell_ids": created_cell_ids or [],
        "ts": datetime.now().isoformat(),
    })
    _write_nb(nb_id, nb)


# ── 폴더 ──────────────────────────────────────────────────────────────────────

def list_folders() -> list[dict]:
    _ensure_dir()
    return _read_config().get("folders", [])


def create_folder(name: str) -> dict:
    _ensure_dir()
    cfg = _read_config()
    folder = {"id": str(uuid.uuid4()), "name": name, "is_open": True, "ordering": len(cfg.get("folders", [])) * 1000.0}
    cfg.setdefault("folders", []).append(folder)
    _write_config(cfg)
    return folder


def update_folder(folder_id: str, **kwargs) -> dict:
    cfg = _read_config()
    folder = next((f for f in cfg.get("folders", []) if f["id"] == folder_id), None)
    if not folder:
        raise ValueError(f"Folder {folder_id} not found")
    folder.update({k: v for k, v in kwargs.items() if v is not None})
    _write_config(cfg)
    return folder


def delete_folder(folder_id: str) -> None:
    cfg = _read_config()
    cfg["folders"] = [f for f in cfg.get("folders", []) if f["id"] != folder_id]
    _write_config(cfg)
    # Unlink notebooks from this folder
    for p in NOTEBOOKS_DIR.glob("*.ipynb"):
        try:
            nb = json.loads(p.read_text(encoding="utf-8"))
            vibe = nb.get("metadata", {}).get("vibe", {})
            if vibe.get("folder_id") == folder_id:
                vibe["folder_id"] = None
                p.write_text(json.dumps(nb, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
