# Vibe EDA — 리포팅 파이프라인 가이드

> 선택된 셀의 출력·메모를 증거로 삼아 시니어 데이터 분석가 수준의 Markdown 리포트를 LLM 으로 스트리밍 생성하고, `.md` + `_images/` 로 디스크에 저장하는 파이프라인.

**관련 파일**
- API: `backend/app/api/report.py`
- 서비스: `backend/app/services/report_service.py`
- 프론트 API 클라이언트: `src/lib/api.ts::streamReport / getReport / listReports / deleteReport`
- 프론트 상태: `src/store/useAppStore.ts::generateReport / fetchReports / openReport / removeReport`
- 프론트 UI: `src/components/reporting/ReportModal.tsx`, `ReportResult.tsx`
- 사이드바 리스트: `src/components/layout/LeftSidebar.tsx` — "리포트" 섹션

---

## 1. 전체 흐름

```
[ReportModal 셀 선택 + 목표 + 모델]
        │ POST /v1/reports/stream (SSE)
        │ headers: X-Report-Model, X-Anthropic-Key, X-Gemini-Key
        ▼
[1] stage: collecting
    build_evidence(nb_id, cell_ids)
     └─ .ipynb 로드 → 각 셀의 code/memo/insight/output(text+PNG) 추출
        ▼
[2] stage: collected (셀 N · 차트 M)
[3] stage: writing
    _stream_claude  또는  _stream_gemini
     ├─ system prompt (시니어 분석가 + 구조 강제)
     ├─ user prompt (증거 + 사용 가능한 차트 리스트)
     └─ 차트 PNG 를 텍스트와 함께 이미지 블록으로 주입
        ▼ delta 이벤트 반복
[4] stage: finalizing
    _allocate_report_id → report_id 고정 (충돌 방지)
    _inject_chart_images
     ├─ {{CHART:cell_name}} → ![alt](./{id}_images/xxx.png)
     ├─ 매칭 실패 플레이스홀더 조용히 제거
     ├─ 취소선(~~) 쌍 제거
     ├─ 단일 ~ 를 \~ 로 이스케이프
     └─ 참조된 이미지만 디스크 기록
    save_report
     ├─ reports/{id}.md 에 frontmatter + 본문 저장
     └─ 원본 노트북 metadata.vibe.reports[] 에 참조 append
        ▼
[5] complete 이벤트 → 프론트가 GET /v1/reports/{id} 로 후처리 본문 재수신
```

---

## 2. Evidence 빌더

`report_service.py::build_evidence(nb_id, cell_ids)` 가 반환하는 구조:

```python
(
  context = {"title": "...", "description": "...", "selected_marts": [...]},
  evidence = [
    {
      "id": "cell-uuid",
      "name": "region_sales",
      "type": "sql",
      "code": "SELECT ...",
      "memo": "...",
      "insight": "...",
      "output": {...},           # 원본 output dict
      "output_text": "[테이블]\nregion | revenue\n...",
      "image_png_b64": "iVBO..." # chart 셀에만
    },
    ...
  ]
)
```

### 2.1 출력 타입별 텍스트 요약

| 타입 | 요약 방식 |
|---|---|
| table | 컬럼 헤더 + 상위 20행 + "전체 N행 중 상위 20행 표시" 주석 |
| chart | `chartMeta` (제목, 축, trace 이름·n_points) + PNG 이미지 별도 첨부 |
| stdout | 앞 2000자 |
| error | 앞 2000자 |

### 2.2 증거 수집 원칙

- **head(20)** 만 추출 — 토큰 비용/품질 trade-off
- 이미지는 저해상도 600×400 PNG (`kernel.py::_render_figure_png_base64` 가 셀 실행 시 이미 생성해 `.ipynb` 에 저장해 둠)
- 메모가 비어 있으면 `(비어있음)` 으로 표시 — 에이전트 가드가 메모를 강제하므로 실제로는 거의 없음

---

## 3. 프롬프트 설계

### 3.1 시스템 프롬프트 (`_build_system_prompt`)

역할: **"사내 광고 플랫폼 시니어 데이터 분석가, 경영진 열람 가능한 수준"**

핵심 규칙:
1. 숫자·통계는 **반드시 제공된 셀 출력에서만** 인용 (추측 금지)
2. 메모를 적극 활용하되 본문에 자연스럽게 녹여 서술
3. 차트 이미지가 첨부된 셀은 실제로 이미지를 보고 의미 있는 패턴 서술
4. 테이블은 핵심 행만 추려 GFM 테이블로 인라인
5. `[출처: 셀 …]` 같은 별도 인용 표기 금지 — 근거는 차트·표·수치로 표현
6. 취소선(`~~text~~`) 절대 사용 금지 — 자체 편집 흔적 금지
7. 강조는 `**굵게**` / `_기울임_` 만 허용

### 3.2 출력 구조 (7단)

```
# {제목}
## TL;DR              핵심 발견 3~5개 불릿
## 배경 및 가설         목표·대상·가설
## 데이터와 방법        마트·지표·집계 기준
## 발견                셀별 근거를 차트·표·수치로 엮어 서술
  - {{CHART:cell_name}}  ← 첨부 차트는 반드시 한 번씩 삽입, 단독 라인
## 종합 인사이트        비즈니스 시사점·행동 제안 2~4개
## 한계와 후속 과제      한계 + 추가 검증 제안
```

문체: 한국어 단정적 서술체(-다/-이다), 경어체 금지.

### 3.3 사용자 프롬프트 (`_build_user_prompt`)

사용자 입력 목표 + 분석 맥락(제목·설명·마트) + **"사용 가능한 차트" 섹션을 상단에 명시적으로 배치**해 모델이 플레이스홀더를 놓치지 않도록 유도 + 셀별 증거 블록.

```
## 사용 가능한 차트 (반드시 발견 섹션에 모두 참조)
- `{{CHART:fig_region_bar}}`
- `{{CHART:fig_time_line}}`

## 셀별 증거
### [1] 셀 `region_sales` (SQL)
**코드**: ...
**메모(분석가 노트)**: ...
**출력 요약**: [테이블] ...
(차트 이미지 첨부됨 — 플레이스홀더: `{{CHART:region_sales}}`)
```

마지막에 "리포트 본문만 출력. ```markdown 펜스 금지" 같은 포맷 지시.

---

## 4. LLM 스트림 (프로바이더별)

**프로바이더별로 파이프라인을 의도적으로 분리**. 에이전트 파이프라인과 동일한 이유 (`docs/vibe-eda-agent-pipeline.md` §2 참고).

### 4.1 Claude (`_stream_claude`)

```python
content = [{"type": "text", "text": user_prompt}]
for e in evidence:
    if e.get("image_png_b64"):
        content.append({"type": "text", "text": f"[차트 이미지 — 셀 `{e['name']}`]"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": e["image_png_b64"]},
        })

client.messages.stream(
    model=model,
    max_tokens=32000,
    system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
    messages=[{"role": "user", "content": content}],
)
```

- `max_tokens=32000` — 긴 리포트 대응
- 시스템 프롬프트는 ephemeral 캐시 마킹 (재생성 시 캐시 히트로 비용 절감)
- `text_delta` 만 스트림으로 yield

### 4.2 Gemini (`_stream_gemini`)

```python
parts = [Part.from_text(text=user_prompt)]
for e in evidence:
    if e.get("image_png_b64"):
        parts.append(Part.from_text(text=f"[차트 이미지 — 셀 `{e['name']}`]"))
        parts.append(Part.from_bytes(data=b64decode(e["image_png_b64"]), mime_type="image/png"))

client.aio.models.generate_content_stream(
    model=model,
    contents=[Content(role="user", parts=parts)],
    config=GenerateContentConfig(
        system_instruction=system_prompt,
        temperature=0.3,
        max_output_tokens=32000,
    ),
)
```

---

## 5. 후처리 (`_inject_chart_images`)

스트리밍이 끝난 뒤 버퍼에 누적된 Markdown 에 아래를 순서대로 적용:

1. **차트 플레이스홀더 치환**
   - `{{CHART:name}}` 발견 시 evidence 에서 매칭되는 이미지를 찾아 `![alt](./{report_id}_images/{safe_name}.png)` 로 교체
   - 느슨 매칭: 대소문자·특수문자 무시한 정규화 이름(`_norm_cell_name`)로 폴백
   - 매칭 실패 시 **조용히 삭제** (경고 텍스트 남기지 않음)
2. **잔여 플레이스홀더 라인 제거**: 한 줄 전체가 플레이스홀더면 그 줄까지 삭제 — 빈 줄이 남지 않도록
3. **취소선 제거**: `~~foo~~` → `foo` (안쪽 텍스트만 보존)
4. **`~` 이스케이프**: 단일 `~` (앞에 `\` 가 없는 경우) 를 `\~` 로 치환 → 한국어 범위 표현(`2~4만원`)이 GFM 에서 취소선으로 오인되는 것을 완벽히 차단
5. **연속 빈 줄 축소**: 3개 이상 연속 빈 줄을 2개로

### 5.1 이미지 파일 저장 규칙

- `_safe_image_filename(cell_name, used)` — slug 변환 + 동일 리포트 내 충돌 시 `_2`, `_3` 접미
- **실제로 참조된 차트만** `{report_id}_images/{name}.png` 로 기록 → 사용 안 하는 이미지가 디스크에 남지 않음
- 디렉터리는 실제 저장 직전에 `mkdir(parents=True, exist_ok=True)`

---

## 6. 저장 (`save_report`)

### 6.1 report_id 충돌 방지 (`_allocate_report_id`)

```python
base = f"{now.strftime('%Y%m%d_%H%M%S')}_{slug(title)}"
# base.md 또는 base_images 폴더가 이미 있으면 _2, _3 ... 로 증가
```

### 6.2 파일 포맷

```markdown
---
id: "20260420_212613_우선입장_분석"
title: "우선입장 분석"
source_notebook_id: "..."
source_cell_ids: ["cell1", "cell2"]
goal: "..."
model: "claude-opus-4-7"
created_at: "2026-04-20T21:26:13"
---

# 우선입장 매장 특징 분석

## TL;DR
- ...
```

frontmatter 는 간단한 "key: value" 형식만 지원(멀티라인 제외). `list_reports` 에서 파싱해 목록 API 응답의 메타로 활용.

### 6.3 원본 노트북에 참조 추가

```python
vibe.setdefault("reports", []).append({
    "report_id": "...",
    "title": "...",
    "created_at": "...",
})
```

노트북에서 "이 분석이 낳은 리포트들" 을 역조회할 수 있도록.

---

## 7. 자산 서빙 & 경로 리라이트

### 7.1 백엔드: `GET /v1/reports/{id}/assets/{filename}`

```python
def get_asset_path(report_id, filename) -> Optional[Path]:
    if "/" in filename or "\\" in filename or ".." in filename or filename.startswith("."):
        return None
    if not re.fullmatch(r"[A-Za-z0-9_\-]+\.png", filename):
        return None
    p = (_reports_dir() / f"{report_id}_images" / filename).resolve()
    p.relative_to((_reports_dir() / f"{report_id}_images").resolve())
    return p if p.is_file() else None
```

**보안**:
- `..`, 슬래시, 점으로 시작하는 이름 거부
- 확장자 화이트리스트 `.png` 만
- `Path.resolve().relative_to(...)` 로 디렉터리 이탈 탐지

### 7.2 프론트: 표시용 절대 URL 리라이트

`ReportResult.tsx` 에서 `useMemo` 로 렌더링 직전 변환:

```ts
const displayContent = useMemo(() => {
  if (!currentReportId) return reportContent
  const pattern = new RegExp(
    `\\./${currentReportId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_images/`,
    'g',
  )
  return reportContent.replace(pattern, `${API_BASE_URL}/reports/${currentReportId}/assets/`)
}, [reportContent, currentReportId])
```

- 화면 렌더: 절대 URL 로 변환된 `displayContent` 사용
- 복사·다운로드: 상대 경로 원본 `reportContent` 그대로 사용 → `.md` 와 `_images/` 폴더를 함께 옮기면 어디서든 이미지가 보임

---

## 8. 진행 단계 트래커 (`stage` 이벤트)

백엔드가 보내는 stage 이벤트는 3단계 + 중간 collected 알림:

| stage | label 예시 |
|---|---|
| `collecting` | "셀 데이터 수집" |
| `collected` | "셀 7개 · 차트 3개 수집 완료" |
| `writing` | "리포트 작성 중" |
| `finalizing` | "차트 이미지 삽입·저장" |

프론트 `ReportResult` 의 트래커 UI:
- 3칸 체크리스트 (수집 · 작성 · 삽입·저장)
- 대기: 빈 원 (`Circle`)
- 진행 중: 스피너 (`Loader2`, 코랄)
- 완료: 녹색 체크 (`CheckCircle2`)
- 헤더에 경과 시간 (0.1초 단위) 실시간 표시

---

## 9. 프론트엔드 상태 (`useAppStore`)

| 키 | 용도 |
|---|---|
| `showReportModal` | `ReportModal` 표시 여부 |
| `showReport` | `ReportResult` 표시 여부 |
| `generatingReport` | 스트리밍 중 플래그 |
| `reportContent` | 스트림 누적 → 완료 시 서버 후처리본으로 교체 |
| `reportTitle` | 헤더 제목 |
| `currentReportId` | 저장 완료 후 할당, 상대→절대 URL 리라이트 키 |
| `reportStages` | `{stage, label, at}[]` 배열, 타임라인 재현 |
| `reportStartedAt` | 경과 시간 계산 기준 |
| `reports` | 사이드바 목록 (`listReports`) |
| `reportError` | 에러 메시지 (헤더 배너) |

**주요 액션**:
- `generateReport({cellIds, goal})` — SSE 스트림 수신 + complete 시 `getReport(id)` 로 후처리본 재수신
- `fetchReports()` — 사이드바 리스트 갱신 (앱 기동 + 리포트 생성 완료 후)
- `openReport(id)` — 기존 리포트 로드 → `ReportResult` 오픈
- `removeReport(id)` — DELETE 호출 + 사이드바에서 제거

---

## 10. 운영 체크리스트

- [ ] `DEFAULT_REPORT_MODEL` env (기본 `claude-opus-4-7`)
- [ ] `ANTHROPIC_API_KEY` 또는 `GEMINI_API_KEY`
- [ ] **kaleido 설치** — 차트 이미지 주입·임베드의 전제. 미설치 시 리포트에 이미지 0장 (텍스트 리포트만 생성)
- [ ] 리포트 관련 셀은 kaleido 설치 이후에 재실행되어 있어야 함 (설치 이전 실행 셀에는 `imagePngBase64` 가 없음)
- [ ] `~/vibe-notebooks/reports/` 쓰기 권한 확인

---

## 11. 자주 만나는 이슈

| 증상 | 원인 | 대처 |
|---|---|---|
| 리포트에 이미지가 전혀 안 들어감 | 선택한 셀에 `imagePngBase64` 가 없음 | kaleido 설치 후 차트 셀 재실행 → 새 리포트 생성 |
| 본문에 `{{CHART:name}}` 이 남아있음 | 스트리밍 중 뷰를 본 경우 (후처리 이전 상태) | complete 이벤트 후 프론트가 자동으로 후처리본 재수신해 교체 |
| 취소선(`~~text~~`) 이 남아있음 | LLM 이 스트림에 포함 → 프론트 실시간 표시 단계에서 보일 수 있음 | 완료 후 후처리본으로 교체되며 사라짐 |
| 한국어 `2~4만원` 이 취소선으로 렌더 | `~` 이스케이프 이전 상태 | 저장 파일은 `2\~4만원` 으로 기록, 표시는 `2~4만원` |
| 이미지가 모달에 404 | 프론트 리라이트와 백엔드 경로 불일치 | report_id · 파일명 로그 확인 (`get_asset_path` 는 화이트리스트만 허용) |
| 사이드바에 리포트가 안 보임 | 앱 기동 시 `fetchReports` 실패 | 네트워크 탭 확인, 필요 시 새로고침 |

---

## 12. 향후 개선 아이디어

- **리포트 버전 관리**: 같은 노트북에서 재생성 시 `v2`, `v3` 으로 축적 + diff 뷰
- **HTML/PDF 출력**: 현재 Markdown 만. puppeteer 또는 WeasyPrint 로 확장
- **Confluence/Notion 퍼블리싱**: `.md` 를 직접 업로드
- **리포트 → 노트북 역링크**: 리포트에서 "원본 셀 열기" 버튼 (source_cell_ids 활용)
- **재생성 프리셋**: goal/audience/tone 템플릿 저장
- **다국어**: 현재 한국어만. 모델/프롬프트 locale 파라미터 추가
- **비용 추적**: Claude/Gemini 별 토큰 사용량 집계
