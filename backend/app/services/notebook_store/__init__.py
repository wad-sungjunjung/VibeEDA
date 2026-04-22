"""notebook_store — .ipynb 파일 기반 노트북 저장소.

리팩터링 후 여러 서브모듈로 분리되어 있지만 외부에선 이전처럼
``from app.services import notebook_store`` + ``notebook_store.<name>()`` 로 접근한다.
"""
from . import _core  # re-exported via __getattr__ for mutable globals (NOTEBOOKS_DIR 등)

# ── 노트북 CRUD ──────────────────────────────────────────────────────────────
from ._notebooks import (
    list_notebooks,
    create_notebook,
    get_notebook,
    update_notebook_meta,
    delete_notebook,
    create_onboarding_notebook,
)

# ── 셀 CRUD ─────────────────────────────────────────────────────────────────
from ._cells import (
    create_cell,
    update_cell,
    delete_cell,
    get_cell_above_name,
)

# ── 채팅/에이전트 히스토리 ───────────────────────────────────────────────────
from ._history import (
    add_chat_entry,
    delete_chat_entry,
    truncate_chat_history,
    add_agent_message,
)

# ── 폴더 ────────────────────────────────────────────────────────────────────
from ._folders import (
    list_folders,
    create_folder,
    update_folder,
    delete_folder,
)

# ── 파일 I/O + 캐시 (외부에서도 쓰임) ────────────────────────────────────────
from ._core import (
    set_notebooks_dir,
    _ensure_dir,
    _read_nb,
    _write_nb,
    _read_config,
    request_cache_scope,
)

# ── 포맷 변환 (외부에서 _parse_output 사용) ─────────────────────────────────
from ._formatters import _parse_output


# NOTEBOOKS_DIR / CONFIG_FILE 은 set_notebooks_dir() 로 재할당되므로 ``from`` import
# 로 고정 바인딩하지 않고 동적 조회한다.
def __getattr__(name: str):
    if hasattr(_core, name):
        return getattr(_core, name)
    raise AttributeError(f"module 'notebook_store' has no attribute {name!r}")
