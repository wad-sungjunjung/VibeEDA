# Vibe EDA — 기능 명세서

**목적**: 각 화면 영역과 버튼 단위로 상세한 동작을 정의하여 개발자가 **의도와 엣지케이스를 명확히 이해**할 수 있도록 한다.

**표기법**:
- **[ID]**: 고유 식별자, QA/개발 참조용
- **State**: 컴포넌트가 가질 수 있는 상태
- **Trigger**: 사용자 액션
- **Behavior**: 결과 동작
- **Edge Cases**: 예외 상황 처리

---

## 0. 전역 레이아웃 (Global Layout)

### [LAYOUT-001] 전체 구조
```
┌────────────┬─────────────────────────────────────────┐
│  좌측      │  상단 메타 헤더 (h-14 고정)              │
│  사이드바   ├─────────────────────────────────────────┤
│  (w-56)    │  펼침 영역 (접었다 폈다)                  │
│  - 로고    ├───────────────────────┬─────────────────┤
│  - 설정    │  중앙 노트북 (스크롤)  │  우측 네비       │
│  - 히스토리│                       │  (w-64)          │
│  - 프로필  │                       │  - 사용 마트     │
│            │                       │  - 셀 네비게이션 │
│            ├───────────────────────┤  - 에이전트 이력  │
│            │  하단 셀 추가 바 (h-14)│                  │
└────────────┴───────────────────────┴─────────────────┘
                                            ↓
                                       [FAB] 에이전트
```

### [LAYOUT-002] 반응형
- 최소 폭: 1280px
- 미지원 해상도에서는 "화면이 너무 작습니다" 안내

---

## 1. 좌측 사이드바 (Left Sidebar)

### [LSB-001] 로고 & 서비스명 영역
- **위치**: 최상단 (h-14)
- **구성**: 코랄 배경 Sparkles 아이콘 + "Vibe EDA" + "분석가용 AI EDA"
- **동작**: 클릭 시 홈으로 이동 (랜딩 또는 새 분석)

### [LSB-002] 설정 섹션
- **섹션 헤더**: `Settings` 아이콘 + "설정"
- **메뉴 항목**:
  - **[LSB-002-1] "연결 관리"**: 클릭 시 DB/데이터 소스 설정 모달
  - **[LSB-002-2] "모델 설정"**: 클릭 시 LLM 모델/토큰 설정 모달

### [LSB-003] 히스토리 헤더
- **구성**: `History` 아이콘 + "히스토리" + 우측 `FolderPlus` 아이콘
- **[LSB-003-1] 폴더 추가 버튼**
  - **Trigger**: 클릭
  - **Behavior**: 히스토리 리스트 상단에 **인라인 입력창** 등장
    - 자동 포커스
    - Placeholder: "폴더 이름"
    - Enter: 폴더 생성 (빈 문자열이면 취소 처리)
    - Escape: 취소
    - 좌측 `Folder` 아이콘, 우측 "추가" 버튼 + `X` 취소 버튼
  - **Edge Cases**:
    - 동일 이름 폴더 허용 (식별자는 `id`)
    - 100자 이상 입력 방지

### [LSB-004] 폴더 아이템
- **상태**: 펼침(`isOpen: true`) / 접힘
- **[LSB-004-1] 폴더 토글**
  - **Trigger**: 폴더 이름 또는 화살표 클릭
  - **Behavior**:
    - 접힘 → 펼침: `ChevronRight` → `ChevronDown`, `Folder` → `FolderOpen`, 하위 목록 노출
    - 펼침 → 접힘: 역순
- **[LSB-004-2] 폴더 삭제 (호버 시 X)**
  - **Trigger**: 호버 → `X` 버튼 클릭
  - **Behavior**: 폴더 삭제, 하위 히스토리는 루트로 이동
  - **Confirmation**: MVP에서는 생략 (v1.1에서 confirm dialog 추가 고려)
- **빈 폴더 표시**: "비어있음" italic 텍스트

### [LSB-005] 히스토리 아이템
- **구성**: 제목 (truncate) + 날짜 + 호버 시 `⋯` 메뉴 버튼
- **활성 상태 (`isCurrent: true`)**: 흰 배경 + 코랄 테두리 + 텍스트 코랄 강조
- **[LSB-005-1] 히스토리 클릭**
  - **Trigger**: 제목 영역 클릭
  - **Behavior**: 해당 분석 노트북 로드 (MVP에서는 시각적 표시만)

### [LSB-006] 히스토리 컨텍스트 메뉴 (`⋯`)
- **Trigger**: `⋯` 버튼 클릭
- **2단계 메뉴 구조**:

#### [LSB-006-1] 메인 뷰 (기본)
- **항목 1: 이동 (`Folder` 아이콘 + `▸`)**
  - 클릭: 서브 뷰 "이동할 위치"로 전환
- **항목 2: 복제 (`Copy` 아이콘)**
  - **Behavior**:
    - 원본 바로 아래 위치에 새 히스토리 생성
    - 제목: `{원본 제목} (복제)`
    - 날짜: "방금 전"
    - `folderId`: 원본과 동일
    - `isCurrent`: false
- **구분선**
- **항목 3: 삭제 (`Trash2` 아이콘, 빨간색)**
  - **Behavior**: 즉시 삭제, 되돌릴 수 없음
  - **주의**: MVP는 확인 모달 없음, v1.1에서 undo 토스트 추가

#### [LSB-006-2] 이동 서브 뷰
- **헤더**: `◂` 화살표 + "이동할 위치" (클릭 시 메인 뷰 복귀)
- **구분선**
- **항목**:
  - "루트" (`History` 아이콘) — 폴더 없음
  - 각 폴더 (`Folder` 아이콘)
- **현재 위치 표시**: `✓` 체크마크 (코랄색)
- **선택 시**: 즉시 이동 + 메뉴 닫힘
- **Edge Cases**:
  - 폴더가 없고 루트에 있는 히스토리: "폴더를 먼저 만드세요" 힌트

### [LSB-007] 리포트 섹션 (히스토리와 설정 사이)
- **섹션 헤더**: `FileText` 아이콘 + "리포트" + 개수 배지
- **Trigger 로드**: 앱 기동 시 `fetchReports()` 가 `GET /v1/reports` 호출 → `useAppStore.reports` 에 저장
- **[LSB-007-1] 리포트 아이템**
  - 2줄 표시: 제목(truncate) + 생성 시각(`YYYY-MM-DD HH:MM`)
  - 클릭 시 `openReport(id)` → `ReportResult` 모달이 해당 `.md` 본문으로 열림
  - 현재 열려 있는 리포트는 흰 배경 + 코랄 테두리 + 제목 강조
- **[LSB-007-2] 삭제 버튼 (호버 시 `Trash2`)**
  - 확인 다이얼로그 후 `DELETE /v1/reports/{id}` 호출 → `.md` 및 `_images/` 폴더 함께 제거
- **빈 상태**: "생성된 리포트 없음" italic 텍스트

### [LSB-008] 프로필 영역 (최하단)
- **구성**: 원형 아바타 (코랄 그라데이션) + 사용자명
- **Behavior (MVP 외)**: 클릭 시 프로필/로그아웃 드롭다운

---

## 2. 상단 메타 헤더 (Top Meta Header)

### [TMH-001] 헤더 바 (h-14 고정)
- **왼쪽부터**: `▾`/`▸` 토글, `Pin` 아이콘, 분석 주제, 우측 리포팅 버튼

### [TMH-002] 접기/펼치기 토글
- **Trigger**: 좌측 화살표 클릭
- **Behavior**: 하단 "펼침 영역" 전체 show/hide
- **기본값**: 펼침 상태 (`metaCollapsed: false`)

### [TMH-003] 분석 주제 입력
- **펼친 상태**: `<input>` 편집 가능
- **접힌 상태**: `<button>` (읽기만), 클릭 시 자동 펼침
- **Placeholder**: "한 줄로 주제를 입력하세요"
- **제약**: 200자 이내

### [TMH-004] 리포팅 버튼
- **위치**: 헤더 우측 끝 (항상 표시)
- **Style**: Primary CTA (코랄 배경, 흰 텍스트)
- **아이콘**: `FileText`
- **라벨**: "리포팅"
- **Trigger**: 클릭
- **Behavior**: 리포팅 모달 오픈 ([MODAL-001] 참조)

### [TMH-005] 분석 내용 (펼침 영역, 좌측)
- **구성**: 라벨 (`FileSearch` + "분석 내용 · 상세할수록...") + Textarea
- **[TMH-005-1] Textarea**
  - `minHeight: 260px`, 세로 크기 고정 (resize 비활성)
  - Placeholder: "무엇을, 어떤 관점에서, 왜 분석하려고 하는지 구체적으로 적어주세요."
  - 포커스 시: 코랄 테두리 + 연한 glow
  - 입력값 변경 시: **마트 추천 점수 재계산** (실시간)

### [TMH-006] 사용 마트 (펼침 영역, 우측)
- **구성**: 2열 그리드 (좌: 풀, 우: 선택된 마트)

#### [TMH-006-1] 마트 검색창
- **위치**: 좌측 풀 상단
- **아이콘**: `Search` (좌측), `X` (입력 시 우측)
- **Placeholder**: "마트명, 컬럼 검색..."
- **동작**: 실시간 필터링
  - 검색 대상: `key`, `description`, `keywords`, `columns.name`, `columns.desc`
  - 대소문자 무시

#### [TMH-006-2] 마트 풀 (좌측)
- **정렬**:
  - 검색 없음 + 추천 있음: 점수 DESC 순 (추천 헤더 표시)
  - 검색 중: 추천 헤더 숨김, 점수 순 그대로
- **빈 상태**:
  - 검색어 있음: `"{query}"에 맞는 마트가 없어요`
  - 모두 선택됨: "모든 마트를 사용 중이에요"
- **[TMH-006-2-1] 마트 카드**
  - 구성: (1위 ⭐ 선택) + `Database` 아이콘 + 이름 + 점수 배지
  - **카드 클릭** (이름 영역): 즉시 "사용할 마트"로 추가
  - **`Info` 버튼**: 컬럼 리스트 + 비즈니스 규칙 인라인 펼치기
  - **`+` 버튼**: 추가 (이름 클릭과 동일)
  - 추천된 마트: 연한 베이지 배경 + 노란 테두리
  - 1위 추천: 금색 `Sparkles` 아이콘 표시

#### [TMH-006-3] 사용할 마트 (우측)
- **헤더**: `Check` 아이콘 + "사용할 마트" + 개수 배지
- **빈 상태**: `ArrowRight` 아이콘 + "좌측에서 사용할 마트를 추가하세요"
- **[TMH-006-3-1] 선택 마트 카드**
  - 구성: `Database` 아이콘 + 이름 + `X` 제거 버튼
  - **`X` 버튼 클릭**: 선택 해제, 풀로 되돌아감
- **[TMH-006-3-2] JOIN 표시** (2개 이상 선택 시)
  - 하단 고정 영역에 `mart1 ⋈ mart2 ⋈ mart3` 표시
  - 배경: 연한 피치

---

## 3. 중앙 노트북 영역 (Center Notebook)

### [CNB-001] 스크롤 컨테이너
- **좌우 패딩**: 16px
- **스크롤바 숨김**: `.hide-scrollbar` 클래스

### [CNB-002] 셀 컨테이너
- **구성**: 셀 헤더 + 탭 + 내용 + (활성 시) 인사이트 + (활성 시) 채팅창
- **활성 상태 시각 표현**:
  - 배경: `rgba(253, 237, 232, 0.25)` (연한 피치)
- **셀 간 구분**: `border-b #ede9dd`
- **Trigger**: 셀 영역 클릭 → 활성 셀로 설정

### [CNB-003] 셀 헤더
- **왼쪽**: `[번호]` + 타입 배지 + 셀 이름 input + (에이전트 생성 시) "에이전트" 배지
- **오른쪽** (호버 시 노출): 실행 버튼 ▶ + 삭제 버튼

#### [CNB-003-1] 타입 배지 (클릭 가능)
- **색상**: 타입별 (SQL/Python/Markdown) — 디자인 가이드 참조
- **라벨**: `SQL`, `PYTHON`, `MD`
- **Trigger**: 클릭 (셀 활성화와 별개 — `stopPropagation`)
- **Behavior**: 타입 순환 (SQL → Python → MD → SQL)
  - 코드, 활성 탭 **유지**
  - Markdown일 때만 `executed: true`로 설정 (미리보기 즉시 가능)
- **Tooltip**: "클릭하여 셀 타입 변경 (SQL → Python → MD)"

#### [CNB-003-2] 셀 이름 인라인 편집
- `<input>` 태그, 기본 transparent
- 포커스 시 흰 배경 + 가벼운 라운드
- **제약**: 영문/숫자/언더스코어 권장 (SQL 셀은 DataFrame 변수명으로 쓰임)

#### [CNB-003-3] 실행 버튼 ▶
- **표시 조건**: SQL/Python 타입만 (Markdown은 숨김)
- **호버**: 코랄 색 전환
- **Trigger**: 클릭
- **Behavior**:
  - 로딩 상태 (MVP 외)
  - 실행 후: `executed: true`, 출력 탭 자동 전환
  - **에이전트 모드 ON 시**: 인사이트 자동 생성 (600ms 딜레이)

#### [CNB-003-4] 삭제 버튼
- **호버 색상**: 빨강
- **Behavior**: 즉시 삭제 (MVP는 undo 없음)
- **Edge Cases**: 마지막 셀 삭제 시 빈 상태 플레이스홀더 (v1.1)

### [CNB-004] 탭 바
- **구성**: "입력" (Code 아이콘) / "출력" (BarChart3 아이콘)
- **활성 탭**: 하단 코랄 언더라인 + 코랄 텍스트
- **출력 탭 실행 표시**: Markdown이 아닌 경우, 실행 완료 시 초록 점

### [CNB-005] 입력 탭 (코드 편집기)

#### [CNB-005-1] SQL/Python 에디터
- **배경**: `#2d2a26` (다크)
- **텍스트**: `#f5f4ed` (크림)
- **폰트**: monospace, 12px
- **`minHeight: 240px`**, `resize: vertical` (사용자 조절 가능)
- **`spellCheck: false`**
- **MVP 후**: Monaco/CodeMirror로 교체 (하이라이트, 자동완성)

#### [CNB-005-2] Markdown 에디터
- **배경**: `#ffffff`, 테두리 `1px solid #ede9dd`
- **텍스트**: `#2d2a26`
- 나머지는 SQL/Python과 동일 사이즈

### [CNB-006] 출력 탭

#### [CNB-006-1] 테이블 출력 (SQL)
- **컨테이너**: `#faf8f2` 배경, `1px solid #ede9dd` 테두리, `rounded-md`
- **max-height**: 340px, 넘치면 스크롤 (바는 숨김)
- **Sticky 헤더/푸터**
- **셀 좌우 패딩**: 첫/마지막 컬럼 20px, 중간 16px
- **호버 행**: `bg-stone-50/60`
- **숫자 포맷**: `toLocaleString()` (천 단위 콤마)
- **푸터**: "N rows × M columns" (좌하단)

#### [CNB-006-2] 차트 출력 (Python)
- **컨테이너**: 테이블과 동일 스타일
- **차트 제목**: 좌상단, semibold 12px
- **SVG 기반** (MVP는 고정 예시, v1.1에 Plotly 실제 연동)

#### [CNB-006-3] 마크다운 출력
- 렌더링 지원:
  - `# ## ###` 헤딩 (각각 18/16/14px)
  - `- *` 불릿 리스트
  - `**bold**`
  - `` `inline code` ``
- **Placeholder**: "내용을 입력하세요" (빈 내용 시)

#### [CNB-006-4] 미실행 상태
- 텍스트: "실행 전 — 버튼을 누르거나 채팅으로 요청하세요"
- 회색 중앙 정렬

### [CNB-007] 인사이트 박스
- **표시 조건**: `cell.insight !== null` (에이전트 모드에서 자동 생성)
- **배경**: `#fdede8`, 텍스트 `#8f3a22`
- **아이콘**: `Bot` (왼쪽)

### [CNB-008] 바이브 채팅창 (셀 내부)
- **표시 조건**: `activeCellId === cell.id` (활성 셀만)
- **Style**: 흰 배경 + 연한 보더 + 미세 shadow, `rounded-2xl`
- **[CNB-008-1] Textarea**
  - 최소 1줄, 최대 120px (자동 확장)
  - Placeholder: 타입별
    - SQL: "바이브로 쿼리를 수정해보세요 — 예: 시도별로 group by 해줘"
    - Python: "바이브로 차트를 수정해보세요 — 예: pie 차트로 바꿔줘"
    - Markdown: "바이브로 문서를 수정해보세요"
  - **Enter**: 전송
  - **Shift+Enter**: 줄바꿈
- **[CNB-008-2] "대화 N" 버튼** (대화 이력 있을 시)
  - 좌하단, `MessageSquare` 아이콘 + 개수
  - 클릭 시 우측 네비게이션의 대화 이력 토글
- **[CNB-008-3] 전송 버튼 (원형)**
  - 활성 (텍스트 있음): 코랄 배경 + 흰 `ArrowUp` + shadow
  - 비활성: 베이지 배경 + 커서 not-allowed
  - 32×32px
- **[CNB-008-4] 자동 모드 토글 (AUTO)**
  - 위치: 좌하단 푸터 (모델 셀렉터 · 이미지 첨부 우측), `Zap` 아이콘 + "AUTO" 라벨
  - **OFF (기본)**: 새 코드는 `pendingCode` 상태로 머무르며 **수락/거절** 버튼을 눌러야 `cell.code` 로 반영됨
  - **ON**: `complete` 이벤트 도착 즉시 자동으로 수락(`acceptVibeChange`) → 채팅 히스토리 엔트리 생성 → 백엔드 저장 → 셀 실행
  - 상태는 `useModelStore.vibeAutoApply` 에 영속 저장 (localStorage), 모달 `모델 설정` 에서도 토글 가능
  - 적용 범위: SQL/Python/Markdown 셀에만. Sheet 셀은 별도 vibe 패치 경로(`vibeSheet`)를 사용해 항상 즉시 반영되므로 토글 미노출

### [CNB-009] 셀 추가 바 (하단 고정, h-14)
- **구성**: `Plus` 아이콘 + "셀 추가" 라벨 + 3개 버튼 (SQL / Python / Markdown)
- **[CNB-009-1] 타입 버튼 (공통)**
  - 호버: 코랄 텍스트 + 연한 피치 배경
  - **Trigger**: 클릭
  - **Behavior**:
    - 현재 활성 셀의 **바로 다음 위치**에 새 셀 삽입
    - 새 셀 자동 활성화
    - 해당 셀로 스크롤
  - **Edge Cases**:
    - 활성 셀 없음: 맨 끝에 추가
    - 새 셀 이름: `{type}_{N}` (자동 증가)

---

## 4. 우측 네비게이션 사이드바 (Right Navigation)

### [RNV-001] 사용 중인 마트 섹션 (상단)
- **표시 조건**: `selectedMarts.length > 0`
- **헤더**: `Layers` 아이콘 + "사용 중인 마트" + 개수
- **[RNV-001-1] 마트 칩**
  - 흰 배경, 코랄 보더, 코랄 `Database` 아이콘
  - 호버 tooltip: 마트 설명
- **구분선**: 섹션 끝 `border-t`

### [RNV-002] 셀 네비게이션 헤더
- **구성**: `Compass` 아이콘 + "셀 네비게이션" + 개수/실행됨 통계

### [RNV-003] 셀 목록 (상단 50%)
- **flex: 1 1 50%**, 자체 스크롤
- **[RNV-003-1] 셀 아이템**
  - `[번호]` + 타입 배지 + 이름 (truncate)
  - 우측: (에이전트 생성) `Bot` 아이콘 + (실행됨) 초록 점
  - 활성 상태: 피치 배경 + 코랄 보더
  - **Trigger**: 클릭 → 해당 셀로 스크롤 + 활성화

#### [RNV-003-2] 셀별 대화 이력 토글
- **표시 조건**: `chatHistory.length > 0`
- **헤더**: `▸`/`▾` + `MessageSquare` + "대화 이력 (N)"
- **Trigger**: 클릭 → 펼침/접힘
- **펼친 상태**: 왼쪽 세로 보더 + 각 대화 카드
- **[RNV-003-2-1] 대화 카드**
  - 상단: `#N` + 타임스탬프 + (현재 코드면) "현재" 배지
  - 사용자 메시지 (주황 아바타) + 어시스턴트 응답 (코랄 아바타)
  - **Trigger**: 카드 클릭 → 해당 시점 코드로 **롤백**
  - 호버: "되돌리기" 힌트 표시

### [RNV-004] 에이전트 이력 섹션 (하단 50%)
- **flex: 1 1 50%**, 자체 스크롤
- **헤더**: `Zap` 아이콘 (모드 ON 시 코랄, OFF 시 회색) + "에이전트 이력" + 쌍 개수
- **[RNV-004-1] 빈 상태**
  - "에이전트 모드를 켜고 대화를 시작해보세요" (중앙 정렬)

#### [RNV-004-2] 대화 카드 (사용자/에이전트)
- 역할별 배경 구분:
  - 사용자: 흰 배경
  - 에이전트: 베이지 배경
- 미니 아바타 + 이름 + 타임스탬프
- 본문: `line-clamp-3` (최대 3줄)
- **[RNV-004-3] "셀 N개 생성 · 보기" 링크** (에이전트 응답에 생성 셀 있을 시)
  - 클릭 → 첫 번째 생성 셀로 스크롤

---

## 5. 에이전트 모드 (Agent Mode)

### [AGT-001] FAB (Floating Action Button)
- **위치**: `fixed bottom-6 right-6`
- **크기**: 56×56px, 원형
- **아이콘**: OFF = `Wand2`, ON = `Zap` (흰색)
- **배경**: OFF = 흰색, ON = 코랄 (애니메이션 `pulse`)
- **활성 표시**: 우상단 초록 원 (4px border)
- **Trigger**: 클릭
- **Behavior**: `agentMode` 토글

### [AGT-002] 에이전트 채팅 패널
- **표시 조건**: `agentMode === true`
- **위치**: `fixed bottom-6, left: 240px, right: 268px`
- **max-height**: `calc(100vh - 180px)`
- **Style**: 흰 배경, `rounded-2xl`, `shadow-2xl`

### [AGT-003] 채팅 패널 헤더
- **왼쪽**: 원형 코랄 아바타 (`Zap` 아이콘) + "에이전트 모드" + 설명
- **오른쪽**: `X` 닫기 버튼 (에이전트 모드 OFF와 동일)

### [AGT-004] 대화 이력 영역
- **표시 조건**: `agentChatHistory.length > 0`
- **max-height**: 320px, 자체 스크롤
- **메시지 배치**: 사용자는 우측 정렬, 에이전트는 좌측 정렬
- **[AGT-004-1] 메시지 버블**
  - 사용자: 피치 배경 + 연한 보더
  - 에이전트: 크림 배경 + 연한 보더
  - `rounded-xl`, whitespace-pre-wrap
- **[AGT-004-2] 아바타**
  - 사용자: 베이지→코랄 그라데이션 + `User` 아이콘
  - 에이전트: 코랄 단색 + `Sparkles` 아이콘
- **[AGT-004-3] 생성 셀 링크**
  - 에이전트 응답에 `createdCellIds` 있으면 하단에 버튼
  - "셀 N개 생성됨 · 보러가기"
  - 클릭 → 첫 번째 생성 셀로 스크롤

### [AGT-005] 입력창

#### [AGT-005-1] 추천 프롬프트 칩 (빈 상태)
- 표시 조건: `agentChatHistory.length === 0`
- 기본 3개:
  - "강남구 세부 분석해줘"
  - "전체 인사이트 요약"
  - "상품별 효율 비교"
- **클릭**: 해당 텍스트를 입력창에 자동 삽입

#### [AGT-005-2] Textarea
- 배경: `#faf8f2`
- 포커스: 코랄 테두리
- Min 36px / Max 120px
- **Enter**: 전송
- **Shift+Enter**: 줄바꿈

#### [AGT-005-3] 전송 버튼
- 원형 36×36px
- [CNB-008-3]과 동일 로직

---

## 6. 모달 (Modals)

### [MODAL-001] 리포트 생성 모달
- **Trigger**: [TMH-004] 리포팅 버튼
- **구성**: 헤더 + 목표 입력 + 모델 드롭다운 + 셀 선택 리스트 + 액션 버튼
- **심층 가이드**: `docs/vibe-eda-reporting-pipeline.md`

#### [MODAL-001-1] 헤더
- 제목: `FileText` + "리포트 생성"
- 부제: "분석 목표·모델·포함할 셀을 지정하세요"
- 우측: `X` 닫기

#### [MODAL-001-2] 분석 목표 입력 (선택)
- `<textarea>`, 2줄, placeholder 예시 포함
- 비워 두면 백엔드가 노트북 제목/설명에서 추론

#### [MODAL-001-3] 모델 드롭다운
- `REPORT_MODELS` (Claude 4.x / Gemini 2.5·3.x 전체 목록)
- 선택 값은 `modelStore.reportModel` 에 persist → `X-Report-Model` 헤더로 전송

#### [MODAL-001-4] 셀 체크리스트
- 기본: `executed === true` 인 셀 전체 선택
- 미실행 셀은 `disabled` + "⚠ 미실행" 배지

#### [MODAL-001-2] 셀 선택 리스트
- 각 셀: 체크박스 + 타입 배지 + 이름
- 실행되지 않은 셀: 체크박스 `disabled` + "⚠ 실행되지 않음" 힌트
- **기본값**: 실행된 셀 모두 체크됨

#### [MODAL-001-3] 액션 버튼
- **취소**: 회색, 왼쪽
- **생성**: 코랄 Primary, 우측, "{N}개 셀로 생성"
- **비활성 조건**: 선택된 셀 0개

### [MODAL-002] (Deprecated — MODAL-003에 통합)
생성 중 오버레이는 별도 모달 대신 MODAL-003 내부의 상단 진행 단계 트래커로 표시된다.

### [MODAL-003] 리포트 결과 모달 (`ReportResult.tsx`)
- 전체 화면급 (max-w-3xl, 전체 높이)
- **헤더**: `FileText` + 리포트 제목 + `{report_id}.md` 서브라벨 + 경과 시간(초) + 복사 · 다운로드 · 닫기 버튼
- **진행 단계 트래커** (생성 중 또는 생성 중이었던 세션에 노출):
  - 3단계 체크리스트: `셀 데이터 수집` → `리포트 작성` → `차트 삽입·저장`
  - 대기(빈 원 회색) / 진행 중(스피너+강조) / 완료(녹색 체크)
  - 각 단계 라벨은 백엔드가 실제 수치를 포함해 전송 (예: "셀 7개 · 차트 3개 수집 완료")
- **에러 배너**: `reportError` 가 있으면 상단에 경고색 배너로 표시
- **본문**: `Markdown` 컴포넌트 — GFM 테이블 + 임베드 이미지 렌더링
- **복사 버튼**: `navigator.clipboard.writeText(reportContent)` — 저장된 원본 Markdown(상대 이미지 경로 포함)
- **다운로드 버튼**: `Blob` 으로 `.md` 파일 저장 (파일명은 `{report_id}.md`)
- **이미지 렌더링**: 본문의 `./{report_id}_images/xxx.png` 상대 경로를 `${API_BASE}/reports/{id}/assets/xxx.png` 로 실시간 치환해 `<img>` 가 로드됨. 다운로드용 원본은 상대 경로 유지 → `.md` 와 이미지 폴더를 함께 옮기면 이식 가능

---

## 7. 토스트 (Toast Notifications)

### [TOAST-001] 롤백 완료 토스트
- **Trigger**: 대화 이력 카드 클릭 → 롤백 성공 시
- **위치**: `fixed top-24 right-72`
- **구성**: `RotateCcw` 아이콘 + "{셀명} 롤백 완료" + "시각 시점의 코드로 복원했어요"
- **Style**: 코랄 배경, 흰 텍스트
- **자동 소멸**: 3초 후

---

## 8. 공통 동작 (Shared Behaviors)

### [COMMON-001] 키보드 단축키
- `Enter`: 채팅 전송 / 폴더 생성 / 입력 확정
- `Shift+Enter`: 채팅 줄바꿈
- `Escape`: 모달 닫기 / 폴더 생성 취소
- **v1.1 추가**: `Cmd/Ctrl+K` 커맨드 팔레트

### [COMMON-002] 스크롤 동작
- `scrollIntoView({ behavior: 'smooth', block: 'start' })`
- 모든 스크롤 컨테이너에 `.hide-scrollbar` (테이블 내부 제외)

### [COMMON-003] 호버 상태
- 모든 인터랙티브 요소는 호버 피드백 제공
- 액션 버튼(실행/삭제 등): `opacity-0 group-hover:opacity-100`

### [COMMON-004] 로딩 상태 (v1.1)
- LLM 호출 중: 채팅 입력 disable + 스피너
- 쿼리 실행 중: 셀 상단 프로그레스 바

### [COMMON-005] 에러 처리 (v1.1)
- 네트워크 오류: 토스트 + 재시도 버튼
- LLM 응답 실패: 채팅에 "응답을 받지 못했어요" 메시지
- 코드 실행 실패: 출력 탭에 빨간 에러 메시지

---

## 9. 상태 관리 (State Management)

### 9.1 전역 상태 (Zustand 권장)
```typescript
interface AppState {
  // 분석 메타
  analysisTheme: string;
  analysisDescription: string;
  metaCollapsed: boolean;
  
  // 마트
  selectedMarts: string[];
  martSearchQuery: string;
  martInfoExpanded: string | null;
  
  // 셀
  cells: Cell[];
  activeCellId: string | null;
  
  // 에이전트
  agentMode: boolean;
  agentChatInput: string;
  agentChatHistory: AgentMessage[];
  
  // 히스토리
  histories: HistoryItem[];
  folders: Folder[];
  
  // UI 상태
  rollbackToast: ToastData | null;
  showReportModal: boolean;
  showReport: boolean;
  reportContent: string;
  historyMenuOpen: string | null;
  historyMenuView: 'main' | 'move';
}
```

### 9.2 셀 타입 정의
```typescript
interface Cell {
  id: string;
  name: string;                 // DataFrame 참조명
  type: 'sql' | 'python' | 'markdown';
  code: string;
  activeTab: 'code' | 'output';
  executed: boolean;
  output: string | null;        // 'table_xxx' | 'chart_xxx' | 'markdown_render'
  chatInput: string;
  chatHistory: ChatEntry[];
  historyOpen: boolean;
  insight: string | null;       // 에이전트 모드 인사이트
  agentGenerated?: boolean;
}

interface ChatEntry {
  id: number;
  user: string;
  assistant: string;
  timestamp: string;
  codeSnapshot: string;         // 롤백용
}
```

---

## 10. 엣지 케이스 & QA 체크리스트

### 10.1 데이터 엣지
- [ ] 셀 0개 상태에서 리포팅 버튼
- [ ] 모든 셀이 미실행 상태일 때 리포팅
- [ ] 매우 긴 셀 이름 (100자+) truncate
- [ ] 중복된 셀 이름 허용 여부 (MVP는 허용, 경고만)
- [ ] 마트 0개 선택 상태에서 SQL 셀 생성
- [ ] 빈 채팅 입력 전송 시도 (disabled 확인)

### 10.2 인터랙션 엣지
- [ ] 연속 클릭 (더블클릭) 버그 없는지
- [ ] 메뉴 열린 채로 다른 영역 클릭 시 자동 닫힘
- [ ] 여러 드롭다운 동시 열림 방지
- [ ] 타입 전환 중 실행 버튼 누름
- [ ] 롤백 중 새 메시지 전송

### 10.3 시각 엣지
- [ ] 셀 50개+ 스크롤 성능
- [ ] 대화 이력 30개+ 펼침 레이아웃
- [ ] 폴더 10개+ 목록
- [ ] 긴 한글 마트명 (예: "일별광고매출집계마트") 레이아웃

### 10.4 접근성
- [ ] Tab 키로 모든 버튼 접근 가능
- [ ] 아이콘 only 버튼 모두 `title` 보유
- [ ] 포커스 시각화

---

## 11. 개발 우선순위 권장

| 우선순위 | 영역 | 근거 |
|---|---|---|
| P0 | 좌/중/우 3단 레이아웃 | 전체 뼈대 |
| P0 | 셀 CRUD + 타입 | 핵심 인터랙션 |
| P0 | 마트 선택 2열 UI | 도메인 지식 주입의 입구 |
| P1 | 바이브 채팅 (셀 단위) | 주요 기능, LLM 연결 |
| P1 | 에이전트 모드 | 차별화 기능 |
| P1 | 리포팅 생성 | 완결성 |
| P2 | 대화 이력 롤백 | Nice-to-have이지만 UX 완성도 ↑ |
| P2 | 히스토리 폴더 | 누적 사용 편의 |
| P3 | 토스트, 애니메이션 | 폴리시 |

---

*Last updated: 2026-04-18*
*Related: design-guide.md, prd.md, vibe-eda-prototype.tsx*
