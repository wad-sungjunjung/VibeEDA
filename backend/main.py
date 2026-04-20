from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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
import app.services.notebook_store as notebook_store
from app.services.notebook_store import _ensure_dir

app = FastAPI(title="Vibe EDA API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    _ensure_dir()


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/v1/system/info")
def system_info():
    nd = notebook_store.NOTEBOOKS_DIR
    notebook_files = list(nd.glob("*.ipynb")) if nd.exists() else []
    return {
        "notebooks_dir": str(nd),
        "notebook_count": len(notebook_files),
        "backend_version": app.version,
    }


@app.post("/v1/system/notebooks-dir")
def update_notebooks_dir(body: dict):
    new_path = (body.get("path") or "").strip()
    if not new_path:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="path is required")
    try:
        resolved = notebook_store.set_notebooks_dir(new_path)
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
