"""Vibe Chat · Agent Mode 공용 코드 스타일 가이드.

Vibe Chat (gemini_service / claude_vibe_service) 과 Agent Mode (claude_agent / gemini_agent_service) 가
동일한 SQL/Python 작성 규칙을 따르도록 단일 소스로 관리한다.
"""

SQL_STYLE_GUIDE = """
## SQL 작성 원칙 (일반 규칙)

### 0. 🎯 사용자 질문 범위만 다룬다 (가장 중요)
- 사용자가 요청하지 않은 **차원(시간 단위 · 세그먼트 · 컬럼) 을 추가하지 말 것**
  - 예: "월별" → 월 단위 집계만. 일/요일/시간대 브레이크다운 금지
  - 예: "전체" → 세그먼트 분리 금지
- **최종 SELECT 에서 안 쓸 컬럼을 CTE 에서 미리 끌어오지 말 것** — 쿼리 비용만 커짐
- **의미 없는 JOIN 금지**: 필터 목적의 join 이면 실제 WHERE 조건도 함께 넣기. 필터 없는 join 은 제거
- 파생 컬럼(요일·상태 레이블 등) 은 **사용자가 명시적으로 요청한 경우**에만 생성. 마트에 이미 동일 의미 컬럼이 있으면 재계산하지 말고 그 컬럼을 그대로 사용

### 0-A. 🔒 모르는 카테고리 값은 추측 금지
WHERE / CASE WHEN 의 문자열 리터럴은 **시스템 프롬프트 "카테고리 컬럼 허용 값" 목록에 있는 값만** 사용.
- 목록에 없거나 사용자 의도와 어떤 코드값이 매칭되는지 불확실하면:
  - **Agent 모드**: `get_category_values` tool 로 먼저 확인 → 그래도 불확실하면 `ask_user`
  - **Vibe Chat 모드**: 추측하지 말고 **해당 필터를 제거**하거나, 주석으로 `-- ⚠️ 값 확인 필요` 를 남기고 결과에 원본 컬럼을 포함해 사용자가 눈으로 확인할 수 있게 함

### 0-B. 🗂 테이블 참조는 기본 스키마(`wad_dw_prod.mart`)로 완전 수식
- 시스템에 제공된 "Available marts" 의 테이블은 **반드시 `wad_dw_prod.mart.<table>` 형태**로 완전 수식하여 사용 (FROM / JOIN 모두)
  - 예: `from wad_dw_prod.mart.fact_reservation as fr`
- 목록에 없는 **다른 스키마/DB(`raw`, `common`, `prod`, `analytics` 등) 는 절대 참조 금지** — 추측해서 외부 스키마 테이블을 호출하지 말 것. 필요한 데이터가 없으면 주석으로 `-- ⚠️ 이 분석에 필요한 마트가 선택되지 않음` 을 남기고 중단
- 쿼리 내부 CTE(`with xxx as ...`) 는 스키마 prefix 없이 이름 그대로 참조 (CTE 는 테이블이 아님)

### 1. SQL 키워드는 소문자
select, from, where, join, case, when, group by, order by, with, as 등 모두 소문자.

### 2. CTE(with 절) 기반 구조
- 변환 로직은 CTE 안에 배치하고, 마지막은 `select * from final_cte` 형태로 단순하게 마무리
- CTE 이름은 비즈니스 의미가 드러나는 snake_case (예: `fact_xxx`, `agg_xxx`, `dim_xxx`)
- 단순 SELECT 라도 `with ... as (...) select * from ...` 구조를 유지

### 3. 컬럼 그룹별로 빈 줄로 구분
의미 그룹(식별자 → 날짜/시간 → 분류/상태 → 수치/지표) 사이에 빈 줄을 넣어 가독성 확보.

### 4. 집계 컬럼 별칭은 의도가 드러나는 이름
- 한국어 큰따옴표 별칭을 선호: `count(distinct user_id) as "방문자수"`
- 영어 별칭을 쓸 거면 의미가 분명해야 함 (`n`, `cnt` 같은 축약 금지)

### 5. GROUP BY / ORDER BY
- 기본은 `group by <컬럼명>` — 컬럼 번호(`group by 1,2`) 지양
- `grouping sets` 는 사용자가 소계/총계를 명시적으로 요청했을 때만
- `order by` 도 컬럼명으로. `order by all` 금지

### 6. NULL / 타입
- NULL 방어는 `coalesce(col, default)` 로
- 0 분모 방어: `nullif(denominator, 0)`
- 타입 변환은 명시적 `cast(col as ...)`

### 7. 네이밍 · 들여쓰기
- 컬럼·테이블·별칭 모두 소문자 snake_case
- 테이블 별칭은 짧고 의미 있는 영문 (예: `fact_reservation as fr`)
- 들여쓰기는 4칸 스페이스, `,` 는 줄 끝에
"""

PYTHON_RULES = """
## Python 셀 작성 원칙

### 1. 데이터 소스
- DB 에 직접 접근하지 않는다 — 이미 실행된 SQL 셀 결과 DataFrame 을 사용
- DataFrame 변수명은 상위 SQL 셀 이름과 동일 (예: SQL 셀 `query_1` → Python 에서 `query_1` 그대로 참조)

### 2. 시각화 (Plotly)
- `import plotly.express as px` 사용
- Figure 변수명은 `fig_<주제>_<차트타입>` 형태 — 주제와 차트 유형이 드러나야 함
  (예: `fig_region_bar`, `fig_daily_trend_line`, `fig_funnel_conversion`)
- 단순한 `fig` 이름은 쓰지 말 것 — 여러 차트가 같은 네임스페이스에 있을 때 덮어쓰기 방지
- **마지막 줄은 반드시 `fig_xxx` 변수 식별자만** (자동 표시용)
- `.show()` / `pio.show(...)` / `display(...)` 는 호출하지 말 것

### 3. 기본 라이브러리
기본 제공: pandas, numpy, plotly, scikit-learn, scipy, statsmodels.
- 전처리/정제: pandas
- 시각화: plotly
- 통계/검정: scipy.stats, statsmodels
- 머신러닝: scikit-learn

### 4. 외부 패키지 런타임 설치
목록 외 패키지가 필요하면 아래 둘 중 하나를 사용:

**A) `!pip install` (Jupyter 스타일, 지원됨)** — 커널이 자동으로 `subprocess` 호출로 변환한다.
```python
!pip install xgboost --quiet
import xgboost as xgb
```
`%pip install ...` 도 동일하게 동작.

**B) 안전한 guard 패턴** — 이미 설치됐으면 스킵하고 싶을 때:
```python
import importlib, subprocess, sys
for _pkg in ("<패키지명>",):
    try:
        importlib.import_module(_pkg.split('==')[0].split('[')[0])
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", _pkg])
import <패키지명> as <alias>
```

딥러닝/수GB 라이브러리(tensorflow, torch, transformers 등) 는 지양.

### 5. 사용자 질문 범위 (SQL 과 동일)
- 요청하지 않은 차원 추가 금지
- 요청하지 않은 통계/전처리 단계 추가 금지
"""


MARKDOWN_RULES = """
## Markdown 작성 원칙 (렌더링 안정성)

프론트는 `react-markdown + remark-gfm` 으로 렌더링한다. 아래 규칙은 레이아웃 깨짐 방지를 위해 반드시 준수.

### 1. 특수문자 이스케이프
Markdown 특수 리터럴 (`_ * ` # > [ ] ( ) | \\ ! ~`) 을 본문에 그대로 쓰면 해석되므로 이스케이프 또는 전각 대체.
- 파이프 `|` → `\\|` 또는 전각 `｜`
- 대괄호 `[...]` → `\\[...\\]` 또는 전각 `［...］`

### 2. italic 안에 code/체크박스/링크를 섞지 말 것
`_..._` 또는 `*...*` 내부에 inline code / task-list 마커를 섞으면 한국어 italic 글자가 오버플로한다.
- 강조가 필요하면 짧은 `**굵게**` 로 통일
- italic 은 필수적인 경우에만 단독 사용

### 3. GFM task-list 는 "할 일 목록" 용도로만
`- [ ]` / `- [x]` 는 체크박스로 렌더된다. 본문에 `[x]` 를 체크 표시 같은 기호로 쓰지 말 것 — `✓` 또는 "완료" 텍스트로 대체.

### 4. inline code 안에 backtick 넣지 않기
이중 백틱 구간에 다시 `-` 나 `|` 를 넣으면 파서가 혼란. 필요하면 일반 텍스트 + `**굵게**` 로 대체.

### 5. 헤더 계층
H1(`#`) → H2(`##`) → H3(`###`) 순서. 한 셀에서 H1 은 최대 1회.

### 6. 표는 파이프 정합 + 헤더 구분선 필수
| 컬럼 | 값 |
|---|---|
| a | b |

컬럼 수가 어긋나면 일반 본문으로 렌더된다.

### 7. 숫자 · 날짜 포맷
- 퍼센트: `62%` 처럼 붙여 쓰기 (공백 넣지 않기)
- 마이너스: ASCII 하이픈(-) 사용. 유니코드 마이너스(−) 피하기
- 날짜: `YYYY-MM-DD`

### 8. 긴 대문자 토큰 / URL
`REVIEW_TOTAL_AVG_SCORE` 같은 토큰은 자동 줄바꿈이 안 되므로 inline code 로 감싸기.

### 9. 메모 / 플랜 본문
- 불릿 위주, 아이템 앞에 italic/code/체크박스 복합 표기는 금지
- 강조는 `**굵게**` 한 가지로 통일
- 2~5줄, 각 줄 80자 이내 권장
"""
