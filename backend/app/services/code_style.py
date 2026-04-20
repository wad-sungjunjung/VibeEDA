"""Vibe Chat · Agent Mode 공용 코드 스타일 가이드.

Vibe Chat (gemini_service / claude_vibe_service) 과 Agent Mode (claude_agent / gemini_agent_service) 가
동일한 SQL/Python 작성 규칙을 따르도록 단일 소스로 관리한다.
"""

SQL_STYLE_GUIDE = """
## 필수 쿼리 스타일 (반드시 적용, 예외 없음)

### 1. SQL 키워드는 모두 소문자로 작성한다
select, from, where, left join, inner join, case, when, then, else, end, group by, order by, with, as 등
대문자 키워드는 절대 사용하지 않는다.

### 2. 항상 CTE(with 절) 구조로 작성한다
- 변환 로직은 CTE 안에 넣고, 마지막 select는 `select * from final_cte` 형태로 단순하게 끝낸다
- CTE 이름은 비즈니스 의미를 담아 snake_case로 작성한다 (예: fact_entry, agg_daily, dim_shop)
- 단순 SELECT라도 with ... as (...) select * from ... 형태로 감싼다

### 3. 컬럼을 의미 그룹별로 구분하고 빈 줄을 넣는다
id 그룹 → 날짜/시간 그룹 → 상태/분류 그룹 → 매장/채널 그룹 → 고객 그룹 순으로 배치하고
그룹 사이에 빈 줄을 넣어 가독성을 높인다.

### 4. 날짜/시간 컬럼은 _date(DATE)와 _dt(DATETIME) 쌍으로 분리한다
    date(cw.reg_date_time) as reg_date,
    cw.reg_date_time as reg_dt,

### 5. 요일 컬럼은 dayofweek() → 한국어 요일명으로 변환한다
    case
        when dayofweek(reg_date) = 0 then '일'
        when dayofweek(reg_date) = 1 then '월'
        when dayofweek(reg_date) = 2 then '화'
        when dayofweek(reg_date) = 3 then '수'
        when dayofweek(reg_date) = 4 then '목'
        when dayofweek(reg_date) = 5 then '금'
        when dayofweek(reg_date) = 6 then '토'
    end as reg_weekday,

### 6. 상태 코드값은 CASE WHEN으로 한국어 레이블로 변환한다
영어 코드를 그대로 노출하지 않고 의미있는 한국어 레이블로 변환한다.
    case
        when status = 'SITTING' then '착석'
        when status = 'CANCEL' then '취소'
        else '기타'
    end as entry_status,

### 7. GROUP BY는 기본 `group by` 절로 작성한다
- **`grouping sets`는 사용자가 소계/총계를 명시적으로 요청했을 때만** 사용한다
  (예: "시도별 + 전체 합계 보여줘", "지역별 소계 포함") — 단순 집계에는 쓰지 않는다
- `grouping sets` 사용 시 소계 레이블 패턴: `case when grouping(col) = 1 then '0. 전체' else col end`
- 정렬은 `order by <컬럼명>` 으로 작성한다. `order by all` / `order by 1,2` 는 쓰지 않는다 —
  어떤 컬럼 기준으로 정렬되는지 명시적으로 드러낸다.

### 8. 집계 컬럼 별칭은 한국어 큰따옴표 문자열로 작성한다
    count(distinct shop_id) as "매장수"    -- O
    count(distinct shop_id) as shop_count  -- X

### 9. JOIN에는 인라인 주석으로 목적을 설명한다
    inner join wad_dw_prod.mart.dim_shop_base as ds  -- 테스트 매장 제외
        on cw.shop_id = ds.shop_key

### 10. 테이블 별칭은 짧고 의미 있는 영문 약어를 사용한다
테이블 이름에서 의미 있는 부분만 추출 (예: cw_fast_entry → cw, ct_reservation → cr, dim_user → du)

### 11. 컬럼명·테이블명은 모두 소문자 snake_case로 작성한다
NULL 방어는 coalesce로 처리한다. 들여쓰기: 4칸 스페이스.

---
## 예시

입력 요청: "일별 채널 유형별 입장 건수"

올바른 예 (반드시 이 형태로 작성):
    with fact_entry as (

        select
            cw.fast_entry_id as entry_id,

            date(cw.reg_date_time) as reg_date,
            cw.reg_date_time as reg_dt,
            case
                when dayofweek(date(cw.reg_date_time)) = 0 then '일'
                when dayofweek(date(cw.reg_date_time)) = 1 then '월'
                when dayofweek(date(cw.reg_date_time)) = 2 then '화'
                when dayofweek(date(cw.reg_date_time)) = 3 then '수'
                when dayofweek(date(cw.reg_date_time)) = 4 then '목'
                when dayofweek(date(cw.reg_date_time)) = 5 then '금'
                when dayofweek(date(cw.reg_date_time)) = 6 then '토'
            end as reg_weekday,

            case
                when cw.entry_type = 'RESERVATION' then '우선_국내'
                when cw.entry_type = 'NOW' then '지금_국내'
                when cw.entry_type is null then '지금_국내'
                else '기타'
            end as channel_type,

        from wad_dw.ods.cw_fast_entry as cw
        inner join wad_dw_prod.mart.dim_shop_base as ds  -- 테스트 매장 제외
            on cw.shop_id = ds.shop_key

    ), agg as (

        select
            reg_date,
            channel_type,
            count(entry_id) as "입장건수"
        from fact_entry
        group by reg_date, channel_type

    )
    select *
    from agg
    order by reg_date, channel_type
"""

PYTHON_RULES = """
## Python 셀 규칙
- DB 마트에 직접 접근하지 않는다 — 이미 실행된 SQL 셀 결과 DataFrame만 사용한다
- 시각화 코드는 반드시 마지막 줄을 `fig_<주제>_<차트타입>` 형태의 변수 **참조로만** 끝낸다
  (예: fig_region_bar, fig_daily_trend_line, fig_funnel_conversion)
  단순한 `fig` 이름은 절대 사용하지 않는다 — 주제와 차트 유형을 명시하라
- **`.show()` / `fig.show()` / `pio.show(...)` / `display(...)` 는 절대 호출하지 않는다**
  (새 브라우저 탭이 열리는 문제 발생) — 마지막 줄은 `fig_xxx` 변수 식별자만 둔다
- plotly: `import plotly.express as px` 사용 (plotly_express 금지)
- DataFrame 변수명은 SQL 셀 이름과 동일하다 (예: query_1, code_2)
- 기본 제공 라이브러리 (requirements.txt): pandas, numpy, plotly, scikit-learn, scipy, statsmodels
  - 전처리/정제: pandas
  - 시각화: plotly
  - 통계/검정: scipy.stats, statsmodels
  - 머신러닝(분류·회귀·군집·차원축소 등): scikit-learn
- 사용자가 **"<패키지>를 설치해줘 / 설치해서 ~"** 또는 목록 밖 패키지가 필요한 요청을 하면
  **반드시 아래 패턴을 셀 상단에 포함**하여 런타임 설치 후 import한다.
  (`!pip` / `%pip` / `os.system` 은 금지 — 커널이 Jupyter 매직을 지원하지 않음)

  ```python
  import importlib, subprocess, sys
  for _pkg in ("<패키지명>",):               # 여러 개면 여기 추가
      try:
          importlib.import_module(_pkg.split('==')[0].split('[')[0])
      except ImportError:
          subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", _pkg])
  import <패키지명> as <alias>              # 실제 import
  ```

  - 이미 설치돼 있으면 건너뛰고, 없을 때만 설치해 재실행이 빨라진다.
  - 딥러닝/수GB급 라이브러리(tensorflow, torch, transformers 등)는 지양.
"""
