---
name: SQL 쿼리 스타일
description: 사용자의 Snowflake SQL 작성 스타일 — Vibe Chat 프롬프트에 반영됨
type: user
---

## 핵심 스타일

- **키워드**: 전부 소문자 (`select`, `from`, `left join`, `case when end`)
- **구조**: CTE 기반, 마지막은 항상 `select * from final_cte`
- **날짜**: `_date`(DATE) + `_dt`(DATETIME) 쌍으로 항상 분리
- **요일**: `dayofweek()` → 한국어 요일명 CASE WHEN (`일/월/화/수/목/금/토`)
- **상태 코드**: 영어 코드 → 한국어 레이블 CASE WHEN 변환
- **컬럼 그룹**: id → 날짜 → 상태/분류 → 매장 → 고객 순, 그룹 사이 빈 줄
- **JOIN 주석**: 조인 목적을 인라인 주석으로 설명 (`-- 테스트 매장 제외`)
- **테이블 별칭**: 짧은 약어 (`cw`, `cr`, `du`, `ds`)
- **GROUP BY**: 반드시 GROUPING SETS, 소계 레이블 `'0. 전체'`, `order by all`
- **집계 별칭**: 한국어 큰따옴표 (`"매장수"`, `"입장건수"`)
- **들여쓰기**: 4칸 스페이스

## 스타일 가이드 위치
`backend/app/services/gemini_service.py` → `_SQL_STYLE_GUIDE` 상수
