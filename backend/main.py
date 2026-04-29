import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os
import psutil

from app.config import settings
from app.api.vibe import router as vibe_router
from app.api.snowflake import router as snowflake_router
from app.api.agent import router as agent_router
from app.api.notebooks import router as notebooks_router
from app.api.cells import router as cells_router
from app.api.folders import router as folders_router
from app.api.marts import router as marts_router
from app.api.execute import router as execute_router
from app.api.recommend import router as recommend_router
from app.api.report import router as report_router
from app.api.files import router as files_router
import app.services.notebook_store as notebook_store
from app.services.notebook_store import _ensure_dir

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── startup ──
    _ensure_dir()
    from app.services import category_cache as _cc

    async def _periodic_category_refresh():
        # 카테고리 캐시 주기적 갱신 — 30분 간격으로 Snowflake last_altered 체크 후
        # 변경된 마트만 재쿼리. Snowflake 미연결이면 즉시 패스.
        while True:
            try:
                await asyncio.sleep(30 * 60)   # 30분
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(None, _cc.prewarm_all_marts)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("periodic category refresh failed: %s", e)

    refresh_task = asyncio.create_task(_periodic_category_refresh())

    try:
        yield
    finally:
        # ── shutdown ──
        # 백그라운드 갱신 태스크 정리
        refresh_task.cancel()
        try:
            await refresh_task
        except (asyncio.CancelledError, Exception):
            pass

        # Snowflake 세션 정리 — 서버 종료 시 명시적으로 닫지 않으면
        # 서버 측에 orphan 세션이 남아 리소스 낭비.
        try:
            from app.services import snowflake_session
            snowflake_session.disconnect()
        except Exception as e:
            logger.warning("snowflake disconnect on shutdown failed: %s", e)


app = FastAPI(title="Vibe EDA API", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 요청 스코프 노트북 파일 캐시 — 한 요청 내에서 동일 .ipynb 를 여러 번 읽지 않도록.
# ContextVar 기반이라 async task 경계를 안전하게 넘고, 요청 종료 시 자동 해제된다.
#
# 장시간 SSE 스트리밍 엔드포인트는 캐시에서 제외 — 스트림이 수 분간 지속되는 동안
# 다른 요청(수동 셀 편집·실행 등)이 같은 .ipynb 를 써도 캐시가 stale 되어
# 스트림 쪽 write 가 그걸 덮어쓸 수 있기 때문.
_NO_CACHE_PATHS = {"/v1/agent/stream", "/v1/vibe", "/v1/reports/stream"}


@app.middleware("http")
async def _notebook_cache_scope(request, call_next):
    if request.url.path in _NO_CACHE_PATHS:
        return await call_next(request)
    with notebook_store.request_cache_scope():
        return await call_next(request)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/v1/system/open-folder")
def open_folder():
    import sys
    import os
    import subprocess
    from fastapi import HTTPException
    nd = str(notebook_store.NOTEBOOKS_DIR.resolve())
    try:
        if sys.platform == "win32":
            os.startfile(nd)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", nd])
        else:
            subprocess.Popen(["xdg-open", nd])
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "path": nd}


# /v1/system/info 는 사이드바 등에서 자주 호출되는데, 매 호출마다 nd.glob('*.ipynb')
# 디렉터리 스캔이 발생한다 (Windows 에서 특히 비싸다). 60초 TTL 메모리 캐시로
# 단순 카운트는 즉시 반환. notebooks_dir 변경 시 cache_clear() 로 무효화.
_SYSTEM_INFO_TTL = 60.0  # seconds
_system_info_cache: dict | None = None
_system_info_cache_ts: float = 0.0


def _invalidate_system_info_cache() -> None:
    global _system_info_cache
    _system_info_cache = None


@app.get("/v1/system/info")
def system_info():
    global _system_info_cache, _system_info_cache_ts
    import time as _time
    nd = notebook_store.NOTEBOOKS_DIR
    nd_str = str(nd)
    now = _time.monotonic()
    cached = _system_info_cache
    if (
        cached is not None
        and cached.get("notebooks_dir") == nd_str
        and (now - _system_info_cache_ts) < _SYSTEM_INFO_TTL
    ):
        return cached
    notebook_files = list(nd.glob("*.ipynb")) if nd.exists() else []
    payload = {
        "notebooks_dir": nd_str,
        "notebook_count": len(notebook_files),
        "backend_version": app.version,
    }
    _system_info_cache = payload
    _system_info_cache_ts = now
    return payload


@app.get("/v1/system/memory")
def system_memory():
    try:
        proc = psutil.Process(os.getpid())
        rss = proc.memory_info().rss
        vm = psutil.virtual_memory()
        return {
            "used_bytes": rss,
            "total_bytes": vm.total,
            "system_used_bytes": vm.used,
            "system_available_bytes": vm.available,
        }
    except Exception:
        from fastapi import HTTPException
        raise HTTPException(status_code=503, detail="memory info unavailable")


@app.post("/v1/system/notebooks-dir")
def update_notebooks_dir(body: dict):
    new_path = (body.get("path") or "").strip()
    if not new_path:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="path is required")
    try:
        resolved = notebook_store.set_notebooks_dir(new_path)
        _invalidate_system_info_cache()  # 디렉터리 변경됨 — 캐시 무효화
        nd = notebook_store.NOTEBOOKS_DIR
        notebook_files = list(nd.glob("*.ipynb")) if nd.exists() else []
        return {"ok": True, "notebooks_dir": str(resolved), "notebook_count": len(notebook_files)}
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=str(e))


app.include_router(vibe_router, prefix="/v1")
app.include_router(snowflake_router, prefix="/v1")
app.include_router(agent_router, prefix="/v1")
app.include_router(notebooks_router, prefix="/v1")
app.include_router(cells_router, prefix="/v1")
app.include_router(folders_router, prefix="/v1")
app.include_router(marts_router, prefix="/v1")
app.include_router(execute_router, prefix="/v1")
app.include_router(recommend_router, prefix="/v1")
app.include_router(report_router, prefix="/v1")
app.include_router(files_router, prefix="/v1")
