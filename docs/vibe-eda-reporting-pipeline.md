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

## 1. 전체 흐름 (품질 우선 2-pass 파이프라인)

```
[ReportModal 셀 선택 + 목표 + 모델]
        │ POST /v1/reports/stream (SSE)
        │ headers: X-Report-Model, X-Anthropic-Key, X-Gemini-Key
        ▼
[1] stage: collecting
    build_evidence(nb_id, cell_ids)
     └─ .ipynb 로드 → code/memo/insight/output(text+PNG) + depends_on 추적
        ▼
[2] stage: collected (셀 N · 차트 M)
[3] stage: outlining     ← Pass 1
    _run_outline_pass
     ├─ LLM 호출 (Claude: _call_claude_text / Gemini: _call_gemini_text, response_mime_type=json)
     ├─ _parse_outline_json 방어적 파싱
     ├─ _validate_outline_coverage: 첨부 차트 중 미할당 → 1회 재시도 (누락 목록 힌트 주입)
     └─ 실패 시 빈 outline 으로 폴백 (writing 은 계속 진행)
        ▼
[4] stage: outlined (섹션 K개 [· 차트 미할당 n])
[5] stage: writing        ← Pass 2
    _stream_claude / _stream_gemini
     ├─ system prompt (시니어 분석가 + outline 엄수 지시)
     ├─ user prompt (맥락 + outline JSON + 셀별 증거)
     └─ 차트 PNG 이미지 블록 첨부
        ▼ delta 이벤트 반복
[6] stage: finalizing
    _allocate_report_id
    _inject_chart_images  →  (new_markdown, chart_notes)
     ├─ {{CHART:cell_name}} → ![alt](./{id}_images/xxx.png)
     ├─ 매칭 실패 → `> ⚠ 차트 미삽입` 경고 블록 + missing_charts 기록
     ├─ 첨부됐지만 미참조 차트 → "## 부록: 본문 미참조 차트" 자동 추가 + unreferenced_charts 기록
     ├─ 취소선(~~) 쌍 제거 / 단일 ~ 이스케이프
     └─ 참조된 이미지만 디스크 기록
    _collect_evidence_numbers + _validate_report_numbers
     └─ 본문 수치(단위 포함) 중 evidence 에 ±0.5% 매칭 안 되는 것 = suspicious_numbers
    save_report (processing_notes + outline 을 frontmatter 에 기록)
        ▼
[7] meta 이벤트 → 프론트 경고 배너 갱신 (missing/unreferenced/suspicious)
[8] complete 이벤트 → GET /v1/reports/{id} 로 최종 본문 재수신
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
| table | 헤더 + head(15) + tail(5) + **컬럼 프로파일** (수치: min/p25/median/p75/max/mean/null%; 범주: top-5 · unique · null%) |
| chart | `chartMeta` (제목, 축, trace type/name/n_points/x_range/y_range) + PNG 이미지 별도 첨부 |
| stdout | 앞 4000자 |
| error | 앞 2000자 |

### 2.2 증거 수집 원칙 (품질 우선)

- 테이블은 **head+tail+통계 프로파일** 삼중 제공 — LLM 이 분포/이상치/tail 패턴을 놓치지 않게 함
- 선택 셀 간 **`depends_on`** 자동 추적 — 셀 코드에서 다른 선택 셀 이름 토큰을 찾아 파이프라인 맥락 제공
- 이미지는 저해상도 600×400 PNG (`kernel.py::_render_figure_png_base64` 가 셀 실행 시 이미 생성해 `.ipynb` 에 저장해 둠)
- 메모가 비어 있으면 `(비어있음)` 으로 표시 — 에이전트 가드가 메모를 강제하므로 실제로는 거의 없음

### 2.3 수치 집합 수집 (환각 검증용)

`_collect_evidence_numbers(evidence)` 가 반환하는 두 집합:

- `with_units`: 단위 붙은 수치 `{(value, "%"), (value, "원"), ...}` — 본문 매칭의 1차 기준
- `bigs`: 테이블 cell / chart meta 스칼라 / stdout / 메모에서 추출한 모든 4자리↑ 수치
- 문자열 경로 손실을 피해 **테이블 row 원본 값과 chart meta 를 직접 walk** 해 숫자를 모은다

---

## 3. 프롬프트 설계 (2-pass)

구조적 일관성과 차트 커버리지를 코드로 강제하기 위해 **Outline(Pass 1) → Writing(Pass 2)** 로 분리했다.

### 3.0 공통 원칙 (`_COMMON_PRINCIPLES`)

양 pass 가 공유하는 원칙 텍스트:
1. 숫자·통계는 **반드시 제공된 셀 출력에서만** 인용 (추측 금지)
2. 메모/인사이트 필드를 적극 활용
3. 차트 이미지 첨부 셀은 이미지를 보고 패턴을 서술
4. 테이블 통계(p25/p75/median/top-5) 로 분포·이상치를 구체적으로 지적
5. `[출처: 셀 …]` 금지 / 취소선 금지 / 강조는 `**` `_` 만

### 3.1 Outline Pass — `_build_outline_system_prompt` + `_build_outline_user_prompt`

- **유효한 JSON** 만 출력하도록 강제. Claude 는 자유 출력 후 `_parse_outline_json` 로 파싱, Gemini 는 `response_mime_type="application/json"` 옵션으로 강제.
- 출력 스키마:
  ```json
  {
    "report_title": "…",
    "tldr": ["…", "…"],
    "sections": [
      {
        "heading": "## 섹션 제목",
        "thesis": "…",
        "cite_cells": ["cell_a", "cell_b"],
        "cite_charts": ["chart_cell_name"],
        "key_numbers": ["8.4%", "1,234건"]
      }
    ],
    "insights": ["…"],
    "limitations": ["…"]
  }
  ```
- 사용자 프롬프트는 **목표·맥락·첨부 차트 목록·셀별 증거 요약(의존 셀 포함)** 을 담는다.

#### Coverage 검증 + 1회 재시도

- `_validate_outline_coverage(outline, evidence)` 가 첨부 차트 중 어떤 `sections[*].cite_charts` 에도 없는 이름을 반환.
- 누락 있으면 `missing_charts_hint` 를 주입해 **1회 재시도**. 여전히 실패하면 마지막 outline 으로 진행 (writing 에서 미참조 차트는 후처리가 부록에 추가함).

### 3.2 Writing Pass — `_build_writing_system_prompt` + `_build_writing_user_prompt`

- 시스템 프롬프트가 **"Outline 을 엄수"** 하도록 지시. 각 섹션의 `cite_charts` 전부를 `{{CHART:name}}` 단독 라인으로 삽입.
- 사용자 프롬프트에 **Outline JSON 을 코드블록으로 그대로** 넣고, 뒤이어 셀별 상세 증거(코드·메모·인사이트·의존·출력) + 첨부 차트 이미지.
- 출력 구조: `# report_title` → `## TL;DR` → `## 배경/가설` → `## 데이터와 방법` → Outline.sections → `## 종합 인사이트` → `## 한계와 후속 과제`.

### 3.3 Fallback

- Outline 파싱 실패(JSON 깨짐) 시 빈 outline 으로 진행 → Writing Pass 는 구조 가이드만으로 작성. 이 경우 `processing_notes.outline_sections = 0` 이 되어 UI 에서 식별 가능.

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

## 5. 저장 흐름 — Draft → 저장하기 (사용자 명시적 승격)

리포트 생성 직후에는 자동으로 영구 저장되지 않는다. 사용자가 **저장하기** 를 눌러야 `reports/` 에 등록된다.

### 폴더 구조

각 리포트는 **1 리포트 = 1 폴더** 로 통합 저장된다. `.md` 와 차트 PNG 가 같은 폴더에 평면으로 놓인다.

```
~/vibe-notebooks/reports/
├── {report_id}/                   ← 영구 저장 리포트 (list 에 노출)
│   ├── {report_id}.md
│   ├── fig_region.png
│   └── fig_time.png
├── _drafts/
│   └── {report_id}/               ← 미저장 draft (list 미노출)
│       ├── {report_id}.md
│       └── fig_xxx.png
├── 20260420_...md                 ← (레거시) 평면 .md — 읽기 전용 폴백
└── 20260420_..._images/            ← (레거시) 이미지 폴더
    └── fig_xxx.png
```

### 흐름

```
[생성 스트림]
   └─ _inject_chart_images(target_dir=_report_folder(id, draft=True))
      → reports/_drafts/{id}/{id}.md + reports/_drafts/{id}/*.png
      markdown 내 이미지 참조: ![alt](./fig_xxx.png)  ← 같은 폴더 상대 경로

사용자 액션:
  [저장하기] → POST /v1/reports/{id}/save
    → promote_draft: _drafts/{id}/ 폴더를 reports/{id}/ 로 rename
    → 노트북 metadata.vibe.reports[] 에 참조 append
    → list_reports 에 등장 + 사이드바 갱신

  [닫기 X] (미저장 상태) → DELETE /v1/reports/drafts/{id}
    → _drafts/{id}/ 폴더 삭제 (복구 불가)
```

**자산 서빙**: `get_asset_path(id, filename)` 은 신규 구조(`reports/{id}/`) → draft(`_drafts/{id}/`) → 레거시(`reports/{id}_images/`) 순으로 탐색.

**URL 리라이트 (프론트)**: markdown 에 있는 `](./fig_xxx.png)` 는 `ReportResult.tsx` 에서 `](${API_BASE}/reports/${id}/assets/fig_xxx.png)` 로 치환해 렌더. 원본 문자열은 다운로드·복사를 위해 보존 — `.md` 와 이미지 폴더를 함께 옮기면 어디서든 상대 경로로 이미지가 보임.

**draft 식별**: 스트림 완료 시 `complete` 이벤트가 `is_draft: true` 를 포함, `get_report` 응답도 `is_draft` 필드를 반환. UI 는 임시 배지·저장 버튼 활성화에 사용.

---

## 6. 후처리 (`_inject_chart_images` + `_validate_report_numbers`)

스트리밍이 끝난 뒤 버퍼에 누적된 Markdown 에 아래를 순서대로 적용:

1. **차트 플레이스홀더 치환**
   - `{{CHART:name}}` → `![alt](./{report_id}_images/{safe_name}.png)`
   - 느슨 매칭: `_norm_cell_name` 으로 대소문자·특수문자 무시 폴백
   - **매칭 실패 시** → `> ⚠ 차트 미삽입: \`name\` (증거에 없음)` 경고 블록으로 치환 + `processing_notes.missing_charts` 에 기록 (투명성)
2. **미참조 첨부 차트 부록화**
   - evidence 에 첨부됐지만 본문에 참조되지 않은 차트 → 문서 끝에 `## 부록: 본문 미참조 차트` 섹션으로 자동 추가
   - `processing_notes.unreferenced_charts` 에 목록 기록
3. **취소선 제거**: `~~foo~~` → `foo`
4. **`~` 이스케이프**: 단일 `~` → `\~`
5. **연속 빈 줄 축소**: 3개 이상 → 2개

### 5.1 수치 환각 검증

- `_collect_evidence_numbers(evidence)` → evidence 전체 수치 집합 (with_units + bigs)
- `_validate_report_numbers(markdown, ...)` — 본문 수치 중 evidence 에 **±0.5% 허용**으로도 매칭 안 되는 것들을 반환
- 결과는 `processing_notes.suspicious_numbers` (최대 50개 샘플) + `suspicious_number_count` 전체 개수
- **UI 는 배너로 "검증 불가 수치 N개" 표시** → 사용자가 원본 확인 유도

### 5.1 이미지 파일 저장 규칙

- `_safe_image_filename(cell_name, used)` — slug 변환 + 동일 리포트 내 충돌 시 `_2`, `_3` 접미
- **실제로 참조된 차트만** `{report_id}_images/{name}.png` 로 기록 → 사용 안 하는 이미지가 디스크에 남지 않음
- 디렉터리는 실제 저장 직전에 `mkdir(parents=True, exist_ok=True)`

---

## 7. 저장 (`save_draft` / `promote_draft`)

- `save_draft` — 스트림 완료 시 `reports/_drafts/{id}.md` 에 기록 (노트북 append 없음)
- `promote_draft` — 사용자 저장 액션 시 `_drafts/` → `reports/` 로 이동 + 노트북 `metadata.vibe.reports[]` append
- `delete_draft` — 모달 닫기 시 호출 (복구 불가)

### 7.1 report_id 충돌 방지 (`_allocate_report_id`)

```python
base = f"{now.strftime('%Y%m%d_%H%M%S')}_{slug(title)}"
# reports/base.md, reports/base_images, _drafts/base.md, _drafts/base_images
# 넷 중 하나라도 존재하면 _2, _3 ... 로 증가
```

### 7.2 파일 포맷

```markdown
---
id: "20260420_212613_우선입장_분석"
title: "우선입장 분석"
source_notebook_id: "..."
source_cell_ids: ["cell1", "cell2"]
goal: "..."
model: "claude-opus-4-7"
created_at: "2026-04-20T21:26:13"
processing_notes: "{\"missing_charts\":[],\"unreferenced_charts\":[\"fig_xyz\"],\"suspicious_numbers\":[...],\"suspicious_number_count\":2,\"outline_sections\":5}"
outline: "{\"report_title\":\"...\",\"sections\":[...]}"
---

# 우선입장 매장 특징 분석

## TL;DR
- ...
```

frontmatter 는 "key: value" 라인 형식. `processing_notes` / `outline` 은 JSON 을 compact 문자열로 직렬화해 싣고, `_parse_frontmatter` 가 이 두 키는 `json.loads` 로 역직렬화. `get_report` / `list_reports` 응답에도 그대로 포함된다 — UI 가 이후 경고 배너를 렌더한다.

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

백엔드가 보내는 stage 이벤트 (+ meta 이벤트):

| stage | label 예시 |
|---|---|
| `collecting` | "셀 데이터 수집" |
| `collected` | "셀 7개 · 차트 3개 수집 완료" |
| `outlining` | "리포트 개요 설계" |
| `outlined` | "섹션 5개 · 차트 커버리지 부분(1개 미할당)" |
| `writing` | "리포트 작성 중" |
| `finalizing` | "차트 삽입 · 수치 검증 · 저장" |

추가 이벤트:
- `meta` — `{processing_notes, outline}` 송신 (complete 직전). UI 경고 배너 데이터 소스.
- `complete` — 저장 완료 메타.

프론트 `ReportResult` 의 트래커 UI:
- 4칸 체크리스트 (수집 · 개요 · 작성 · 삽입·저장)
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
| `reportProcessingNotes` | meta 이벤트 / `getReport` 응답의 `processing_notes` — 상단 경고 배너 |
| `reportOutline` | meta 이벤트 / `getReport` 응답의 outline JSON |

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
