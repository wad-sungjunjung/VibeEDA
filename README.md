# Vibe EDA

사내 광고 플랫폼 데이터 분석가를 위한 AI 네이티브 EDA 도구.
SQL/Python 셀을 자연어로 생성·수정하고, AI 에이전트가 분석 전체를 자동으로 실행한다.

---

## 요구 사항

| 항목 | 버전 |
|---|---|
| Node.js | 18 이상 |
| Python | 3.10 이상 |
| npm | 9 이상 |

API 키 (최소 하나 이상):
- **Gemini API 키** — Vibe Chat (셀 단위 코드 생성)
- **Anthropic API 키** — Agent Mode (노트북 전체 자동 분석)

---

## 빠른 시작

### 1. 저장소 클론

```bash
git clone <repo-url>
cd vibeeda
```

### 2. 백엔드 설정

```bash
cd backend

# 가상환경 생성 (권장)
python -m venv .venv

# 활성화
# macOS/Linux:
source .venv/bin/activate
# Windows:
.venv\Scripts\activate

# 의존성 설치
pip install -r requirements.txt

# 환경변수 파일 생성
cp .env.example .env
```

`.env` 파일을 열고 API 키를 입력한다:

```env
GEMINI_API_KEY=your-gemini-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
```

Snowflake SQL 실행이 필요하면 아래도 입력:

```env
SNOWFLAKE_ACCOUNT=your-account.region
SNOWFLAKE_USER=your-username
SNOWFLAKE_PASSWORD=your-password
SNOWFLAKE_DATABASE=your-database
SNOWFLAKE_WAREHOUSE=your-warehouse
SNOWFLAKE_SCHEMA=PUBLIC
```

백엔드 실행:

```bash
uvicorn main:app --reload --port 8000
```

> 첫 실행 시 `~/vibe-notebooks/` 폴더가 자동 생성된다. 노트북 파일(`.ipynb`)이 여기 저장된다.

### 3. 프론트엔드 설정

새 터미널을 열고:

```bash
cd vibeeda   # 루트 디렉터리

npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 접속.

---

## 실행 요약

두 터미널을 동시에 켜두어야 한다.

```
터미널 1 (백엔드)          터미널 2 (프론트엔드)
─────────────────────      ──────────────────────
cd vibeeda/backend         cd vibeeda
source .venv/bin/activate  npm run dev
uvicorn main:app --reload --port 8000
```

---

## API 키 발급

### Gemini API (Vibe Chat)
1. [Google AI Studio](https://aistudio.google.com/app/apikey) 접속
2. **Create API key** 클릭
3. 발급된 키를 `.env`의 `GEMINI_API_KEY`에 입력

### Anthropic API (Agent Mode)
1. [Anthropic Console](https://console.anthropic.com/) 접속
2. **API Keys** 메뉴에서 새 키 생성
3. 발급된 키를 `.env`의 `ANTHROPIC_API_KEY`에 입력

> API 키는 앱 내 우상단 설정(⚙️)에서도 입력 가능하다. `.env` 없이 UI에서만 설정해도 동작한다.

---

## 주요 기능

| 기능 | 설명 |
|---|---|
| **Vibe Chat** | 셀 우측 채팅창에서 자연어로 SQL/Python 코드 생성·수정 |
| **Agent Mode** | 하단 FAB(마법봉) 클릭 → 노트북 전체를 AI가 자동 분석 |
| **SQL 셀** | Snowflake 쿼리 실행, 결과 테이블 표시 |
| **Python 셀** | Plotly 차트 생성, SQL 결과 DataFrame 직접 사용 가능 |
| **Markdown 셀** | 분석 인사이트 작성, 렌더링 미리보기 |
| **분할 뷰** | 코드↔출력 좌우/상하 분할 (Ctrl+Enter로 실행) |

---

## 폴더 구조

```
vibeeda/
├── src/                    # React 프론트엔드
│   ├── components/
│   │   ├── agent/          # AgentFAB, AgentChatPanel
│   │   ├── cells/          # NotebookArea, CellContainer, CellOutput
│   │   ├── layout/         # LeftSidebar, TopMetaHeader, RightNav
│   │   └── common/         # 공통 컴포넌트
│   ├── store/useAppStore.ts # 전역 상태 (Zustand)
│   ├── lib/api.ts          # 백엔드 API 클라이언트
│   └── types/index.ts      # 공통 타입
│
└── backend/
    ├── main.py
    ├── requirements.txt
    ├── .env.example        # 환경변수 템플릿
    └── app/
        ├── config.py
        ├── api/            # FastAPI 라우터
        └── services/
            ├── notebook_store.py   # .ipynb 파일 I/O
            ├── kernel.py           # Python 실행 커널
            ├── gemini_service.py   # Vibe Chat (Gemini)
            └── claude_agent.py     # Agent Mode (Claude)
```

---

## 데이터 저장 위치

| 데이터 | 위치 |
|---|---|
| 노트북 파일 | `~/vibe-notebooks/*.ipynb` |
| 폴더 메타데이터 | `~/vibe-notebooks/.vibe_config.json` |
| 셀 UI 상태 | 브라우저 localStorage |
| 에이전트 대화 세션 | 브라우저 localStorage |

> 다른 컴퓨터로 이전할 때는 `~/vibe-notebooks/` 폴더를 복사하면 노트북이 유지된다.

---

## Claude Code MCP 연동 (선택사항)

Claude Code CLI에서 Vibe EDA 노트북 도구를 직접 사용하려면:

```bash
# 백엔드와 별도 터미널에서
cd vibeeda/backend
source .venv/bin/activate
python -m app.api.mcp_server
```

`~/.claude/claude_desktop_config.json`에 추가:

```json
{
  "mcpServers": {
    "vibe-eda": {
      "command": "python",
      "args": ["-m", "app.api.mcp_server"],
      "cwd": "/path/to/vibeeda/backend"
    }
  }
}
```

---

## 트러블슈팅

**백엔드 포트 충돌**
```bash
uvicorn main:app --reload --port 8001
```
프론트엔드 `src/lib/api.ts`의 `BASE_URL`도 맞게 변경.

**Snowflake 연결 안 됨**
- SQL 셀 실행 없이 Python/Markdown만 사용할 경우 Snowflake 설정 불필요.
- `.env`에서 Snowflake 항목을 주석 처리하면 된다.

**`ModuleNotFoundError`**
- 가상환경이 활성화되어 있는지 확인 (`which python` 또는 `where python`).
- `pip install -r requirements.txt` 재실행.

**포트 5173 이미 사용 중**
- Vite가 자동으로 5174로 올라간다. 백엔드 `.env`의 `ALLOWED_ORIGINS`에 해당 포트 추가:
  ```env
  ALLOWED_ORIGINS=["http://localhost:5173","http://localhost:5174"]
  ```
