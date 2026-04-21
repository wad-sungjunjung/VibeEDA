# Vibe EDA
캐치테이블 데이터 분석가를 위한 AI 네이티브 EDA 도구.
SQL/Python 셀을 자연어로 생성·수정하고, AI 에이전트가 분석 전체를 자동으로 실행한다.

---

## 요구 사항

| 항목 | 버전 |
|---|---|
| Node.js | 18 이상 |
| Python | 3.10 이상 |
| npm | 9 이상 |

API 키는 앱 내 설정에서 입력해도 되므로 **선택 사항**이지만, 최소 하나 있으면 편리함:
- **Gemini API 키** — Vibe Chat (셀 단위 코드 생성) 기본값
- **Anthropic API 키** — Agent Mode (노트북 전체 자동 분석) 기본값

---

## 빠른 시작 (두 줄)

```bash
git clone https://github.com/wad-sungjunjung/VibeEDA.git && cd vibeeda
npm run setup   # 최초 1회: venv, pip, npm, .env 생성
npm run dev     # 백엔드 + 프론트엔드 동시 실행
```

브라우저에서 `http://localhost:9700` 접속.

> `npm run setup` 이 하는 일:
> 1. `backend/.venv` 가상환경 생성
> 2. `pip install -r backend/requirements.txt`
> 3. `backend/.env` 자동 생성 (`.env.example` 복사)
> 4. `npm install`
>
> `npm run dev` 는 `concurrently`로 백엔드(4750) + 프론트엔드(9700)를 한 터미널에서 같이 띄운다. `Ctrl+C` 한 번이면 둘 다 종료.
> 포트를 바꿔야 하면 `BACKEND_PORT=xxxx FRONTEND_PORT=yyyy npm run dev` 로 오버라이드 가능.

---

## API 키 입력 방법 (두 가지 중 택1)

### 방법 A — 앱 UI에서 입력 (권장)
앱 우측 상단의 모델 설정 버튼에서 Gemini / Anthropic API 키를 입력하면 `localStorage`에 저장된다. `.env` 편집 불필요.

### 방법 B — `.env` 파일에 입력
`backend/.env` 를 열어 아래 값을 채운다:

```env
GEMINI_API_KEY=your-gemini-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
```

Snowflake SQL 실행이 필요하면 앱 내 "연결 관리" UI에서 입력하거나, 아래를 `.env`에 추가:

```env
SNOWFLAKE_ACCOUNT=your-account.region
SNOWFLAKE_USER=your-username
SNOWFLAKE_DATABASE=your-database
SNOWFLAKE_WAREHOUSE=your-warehouse
SNOWFLAKE_SCHEMA=PUBLIC
```

### API 키 발급 링크
- Gemini: https://aistudio.google.com/app/apikey
- Anthropic: https://console.anthropic.com/

---

## 사용 가능한 npm 스크립트

| 명령 | 설명 |
|---|---|
| `npm run setup` | 최초 1회 설치 (venv + pip + npm + .env) |
| `npm run dev` | 백엔드 + 프론트엔드 동시 실행 (개발용) |
| `npm run dev:backend` | 백엔드만 (venv의 uvicorn 자동 사용) |
| `npm run dev:frontend` | 프론트엔드만 (vite) |
| `npm run build` | 프론트엔드 프로덕션 빌드 |
| `npm run lint` | ESLint |
| `npm run preview` | 빌드된 프론트엔드 미리보기 |

---

## 주요 기능

| 기능 | 설명 |
|---|---|
| **온보딩 노트북** | 첫 실행 시 "Vibe EDA 시작하기" 가이드 노트북이 자동 생성됨 |
| **Vibe Chat** | 셀 우측 채팅창에서 자연어로 SQL/Python 코드 생성·수정 |
| **Agent Mode** | 하단 FAB 클릭 (또는 `Cmd/Ctrl+G`) → 노트북 전체를 AI가 자동 분석 |
| **SQL 셀** | Snowflake 쿼리 실행, 결과 테이블 표시 |
| **Python 셀** | Plotly 차트 생성, SQL 결과 DataFrame 직접 사용 가능 |
| **Markdown 셀** | 분석 인사이트 작성, 렌더링 미리보기 |
| **분할 뷰** | 코드↔출력 좌우/상하 분할 (`Ctrl+Enter`로 실행) |

---

## 폴더 구조

```
vibeeda/
├── scripts/                   # setup, dev-backend (Node 스크립트)
├── src/                       # React 프론트엔드
│   ├── components/            # agent/cells/layout/common/reporting
│   ├── store/                 # Zustand (useAppStore, modelStore, connectionStore)
│   ├── lib/api.ts             # 백엔드 API 클라이언트
│   └── types/index.ts
│
└── backend/
    ├── main.py
    ├── requirements.txt
    ├── .env.example
    ├── .venv/                 # (setup이 생성)
    └── app/
        ├── api/               # FastAPI 라우터 (notebooks/cells/vibe/agent/...)
        └── services/
            ├── notebook_store.py   # .ipynb I/O + 온보딩 시딩
            ├── kernel.py           # Python 실행 커널
            ├── snowflake_session.py
            ├── claude_agent.py / claude_vibe_service.py
            └── gemini_agent_service.py / gemini_service.py
```

---

## 데이터 저장 위치

| 데이터 | 위치 |
|---|---|
| 노트북 파일 | `~/vibe-notebooks/*.ipynb` |
| 폴더 메타데이터 | `~/vibe-notebooks/.vibe_config.json` |
| 셀 UI 상태 / API 키 / 모델 선택 | 브라우저 localStorage |
| 에이전트 대화 세션 | 브라우저 localStorage |

> 다른 컴퓨터로 이전할 때는 `~/vibe-notebooks/` 폴더를 복사하면 노트북이 유지된다.

---

## Claude Code MCP 연동 (선택)

Claude Code CLI에서 Vibe EDA 노트북 도구를 직접 사용하려면 별도 터미널에서:

```bash
# macOS/Linux
backend/.venv/bin/python -m app.api.mcp_server

# Windows
backend\.venv\Scripts\python -m app.api.mcp_server
```

(위 명령은 `backend/` 디렉터리에서 실행)

`~/.claude/claude_desktop_config.json` 에 추가:

```json
{
  "mcpServers": {
    "vibe-eda": {
      "command": "python",
      "args": ["-m", "app.api.mcp_server"],
      "cwd": "/absolute/path/to/vibeeda/backend"
    }
  }
}
```

---

## 트러블슈팅

**`npm run setup` 이 python을 못 찾음**
- `python3 --version` 혹은 `python --version` 으로 3.10+ 가 설치돼 있는지 확인.
- Windows: 공식 설치 시 "Add Python to PATH" 옵션 체크.

**포트 4750 / 9700 이미 사용 중**
- 한 번만: `BACKEND_PORT=xxxx FRONTEND_PORT=yyyy npm run dev` 로 실행 시 오버라이드.
- 영구 변경: `scripts/dev-backend.mjs` 의 `BACKEND_PORT` 기본값, `vite.config.ts` 의 `server.port` 를 수정. `backend/.env` 의 `ALLOWED_ORIGINS` 와 루트 `.env.local` 의 `VITE_API_BASE_URL` 도 같이 맞춰야 CORS·API 호출이 깨지지 않는다.

**`ModuleNotFoundError` (백엔드 시작 실패)**
- `npm run setup` 을 다시 실행해서 `backend/.venv` 를 재생성.

**Snowflake 연결 안 됨**
- SQL 셀 없이 Python/Markdown만 쓰면 Snowflake 설정 불필요.
- 앱 내 "연결 관리"에서 externalbrowser SSO로 연결 가능.

**`concurrently` 출력이 뒤섞임**
- `npm run dev:backend` / `npm run dev:frontend` 로 분리해서 각각 별 터미널에서 실행해도 됨.
