# Vibe EDA — 디자인 가이드 v1.0

> 분석가를 위한 AI 기반 EDA 도구. "바이브 코딩"을 넘어 "바이브 EDA"를 목표로 함.

---

## 1. 디자인 철학

### 1.1 핵심 원칙
- **차분한 작업 공간 (Calm Workspace)**: 장시간 분석 작업에 피로가 적은 따뜻한 톤
- **내러티브 중심 (Narrative-First)**: 코드 덩어리가 아닌 "분석 일지"처럼 흐르는 문서형 UX
- **컨텍스트 명시성 (Explicit Context)**: 분석 주제, 사용 마트, 도메인 규칙을 항상 노출
- **AI 보조 자연스러움 (Ambient AI)**: AI 기능이 튀지 않고 작업 흐름 안에 녹아들게

### 1.2 디자인 레퍼런스
- **톤**: Claude 앱(Anthropic) — 따뜻한 오프화이트 + 코랄 액센트
- **레이아웃**: Notion / Linear — 카드 대신 섹션 구분선, 연속된 문서 흐름
- **컨텍스트 메뉴**: VSCode / Figma — 2단계 중첩 메뉴, 키보드 친화적
- **상단 프레임**: Jupyter Lab — 노트북 메타데이터가 상단 고정

---

## 2. 색상 팔레트

> **구현 메모**: 모든 색 토큰은 `src/styles/globals.css` 의 CSS 변수로 정의되며,
> `tailwind.config.ts` 가 `rgb(var(--color-*) / <alpha-value>)` 패턴으로 참조한다.
> **라이트 값은 `:root`, 다크 값은 `.dark` 블록**에서 관리 → `<html>.dark` 클래스 토글로 전환.
> 아래 표는 **라이트 팔레트 기준**. 다크 팔레트와 대응 토큰은 §12 참조.

### 2.1 배경 (Backgrounds)
| 이름 | HEX | 용도 |
|---|---|---|
| Page BG | `#faf9f5` | 전체 페이지 기본 배경 (크림 오프화이트) |
| Sidebar BG | `#f5f4ed` | 좌측 사이드바 (살짝 진한 크림) |
| Pane BG | `#fdfcf8` | 중앙+우측 통합 작업 영역 |
| Card BG | `#ffffff` | 카드, 모달, 드롭다운 |
| Output BG | `#faf8f2` | 테이블/차트 컨테이너 (연한 크림) |
| Code BG Dark | `#2d2a26` | SQL/Python 코드 편집기 (따뜻한 다크) |
| Code BG Light | `#ffffff` | Markdown 편집기 |

### 2.2 액센트 (Accents)
| 이름 | HEX | 용도 |
|---|---|---|
| Primary | `#D95C3F` | 주 액센트 (CTA 버튼, 활성 상태, 포커스) |
| Primary Hover | `#C24E34` | 호버 시 진한 코랄 |
| Primary Light | `#fdede8` | 활성 셀 배경, 연한 하이라이트 |
| Primary Pale | `#f8e5dd` | 매우 연한 배경 (조인 표시 등) |
| Primary Border | `#ebc2b5` | 테두리 (활성 카드, 태그) |
| Primary Text | `#8f3a22` | 진한 브라운 텍스트 (액센트 영역용) |

### 2.3 중성 (Neutrals)
| 이름 | HEX | 용도 |
|---|---|---|
| Text Primary | `#2d2a26` | 본문 텍스트 (stone-800) |
| Text Secondary | `#57534e` | 보조 텍스트 (stone-600) |
| Text Tertiary | `#78716c` | 힌트 텍스트 (stone-500) |
| Text Disabled | `#a8a29e` | 비활성 텍스트 (stone-400) |
| Border Default | `#e7e5e0` | 기본 테두리 (stone-200) |
| Border Subtle | `#ede9dd` | 연한 구분선 |
| Border Hover | `#d6d3c7` | 호버 테두리 |

### 2.4 상태 색상 (Status)
| 이름 | HEX | 용도 |
|---|---|---|
| Success | `#65a30d` | 실행 완료 표시(점), 성공 메시지 |
| Success Indicator | `#84cc16` | FAB 활성 표시점 |
| Danger | `#dc2626` | 삭제 버튼 텍스트 |
| Danger BG | `#fef2f2` | 삭제 호버 배경 |
| Warning Amber | `#d97706` | 추천 1위 별표 |
| Warning BG | `#fef3c7` | 추천 점수 배지 |
| Warning Text | `#92400e` | 추천 점수 텍스트 |

### 2.5 셀 타입 색상 (Cell Type Badges)
| 타입 | 배경 | 텍스트 |
|---|---|---|
| SQL | `#e8e4d8` | `#5c4a1e` (머스터드) |
| Python | `#e6ede0` | `#3d5226` (올리브) |
| Markdown | `#eae4df` | `#4a3c2e` (브라운) |

### 2.6 Elevated Surface · Chip (Phase 2 신규 시맨틱 토큰)
| 이름 | 라이트 | 다크 | 용도 |
|---|---|---|---|
| `surface` | `#ffffff` | `#1C1D22` | 카드·모달·인풋 배경 (라이트는 순백, 다크는 약간 올라온 뉴트럴) |
| `surface-hover` | `#faf9f5` | `#24252C` | 카드 호버 |
| `chip` | `#f5f4f1` | `#202128` | 중립 호버 배경 (기존 `stone-100` 대체) |
| `chip-hover` | `#ede9dd` | `#2A2B32` | chip 위 추가 강조 |

Tailwind 클래스는 `bg-surface`, `bg-chip`, `bg-surface-hover`, `bg-chip-hover` 로 사용.

### 2.7 차트 색상 (Chart Palette)
순서대로 사용 (1→5위):
1. `#D95C3F` (코랄)
2. `#E08A4F` (라이트 오렌지)
3. `#B87333` (카퍼)
4. `#8B5A3C` (브라운)
5. `#6b4423` (딥 브라운)

---

## 3. 타이포그래피

### 3.1 폰트 패밀리
```css
font-family: 'Pretendard', -apple-system, 'Malgun Gothic', sans-serif;
/* 한글 최우선: Pretendard → Malgun Gothic */
```

**코드/모노스페이스**: 브라우저 기본 `monospace` 또는 `'SF Mono', Menlo, Consolas`

### 3.2 사이즈 스케일
| 용도 | 크기 | Tailwind | 예시 |
|---|---|---|---|
| Heading 1 | 18px | `text-lg` | 마크다운 `#` |
| Heading 2 | 16px | `text-base` | 마크다운 `##` |
| Body | 14px | `text-sm` | 본문, 입력 |
| Small | 12px | `text-xs` | 셀 코드, 테이블 데이터 |
| Caption | 11px | `text-[11px]` | 라벨, 태그 |
| Micro | 10px | `text-[10px]` | 메타데이터, 타임스탬프 |
| Nano | 9px | `text-[9px]` | 배지 숫자 |
| Pico | 8px | `text-[8px]` | 미니 배지 |

### 3.3 웨이트
- **Regular (400)**: 본문
- **Medium (500)**: 강조 텍스트
- **Semibold (600)**: 섹션 라벨, 버튼
- **Bold (700)**: 셀 타입 배지, 제목

### 3.4 레터 스페이싱
- **Uppercase labels**: `tracking-wide` (`letter-spacing: 0.025em`)
- **일반 텍스트**: `tracking-normal`

---

## 4. 간격 (Spacing)

### 4.1 기본 단위
**4px 그리드 기반** (Tailwind 기본값)

### 4.2 주요 간격
| 용도 | 값 | 
|---|---|
| 아이콘 ↔ 텍스트 | 4px (`gap-1`) ~ 6px (`gap-1.5`) |
| 컴포넌트 내부 여백 | 8px (`gap-2`) ~ 12px (`gap-3`) |
| 섹션 간 | 16px (`gap-4`) ~ 24px (`gap-6`) |
| 카드 패딩 (작음) | 6px ~ 8px |
| 카드 패딩 (보통) | 12px ~ 16px |
| 카드 패딩 (큼) | 20px ~ 24px |

### 4.3 레이아웃 폭
| 영역 | 폭 |
|---|---|
| 좌측 사이드바 | `w-56` (224px) |
| 우측 네비게이션 | `w-64` (256px) |
| 상단 헤더 높이 | `h-14` (56px) |
| 하단 셀 추가 바 높이 | `h-14` (56px) |
| 에이전트 채팅창 | `left: 240px, right: 268px` (중앙 확장) |

---

## 5. 보더 & 라운딩

### 5.1 보더 너비
- 기본: `1px`
- 강조: `2px` (활성 탭 언더라인)

### 5.2 Border Radius
| 용도 | 값 |
|---|---|
| 버튼 (작음) | `rounded` (4px) |
| 버튼 (보통) | `rounded-md` (6px) |
| 카드, 모달 | `rounded-lg` (8px) ~ `rounded-xl` (12px) |
| 채팅창 | `rounded-2xl` (16px) |
| FAB, 아바타 | `rounded-full` |

---

## 6. 그림자 (Shadows)

### 6.1 Elevation 레벨
| 레벨 | 값 | 용도 |
|---|---|---|
| None | — | 기본 상태 |
| Subtle | `0 1px 2px rgba(45, 42, 38, 0.03)` | 채팅창 |
| Soft | `0 1px 3px rgba(0,0,0,0.05)` | 호버 카드 |
| Medium | `0 2px 6px rgba(217, 92, 63, 0.3)` | 활성 전송 버튼 |
| Large | `shadow-xl` | FAB |
| Modal | `shadow-2xl` | 모달, 에이전트 채팅창 |

---

## 7. 아이콘

### 7.1 라이브러리
**Lucide React** 전용. 컬러 이모지 사용 금지.

### 7.2 사이즈
| 용도 | 크기 |
|---|---|
| Micro | `w-2 h-2` (8px) |
| Tiny | `w-2.5 h-2.5` (10px) |
| Small | `w-3 h-3` (12px) |
| Default | `w-3.5 h-3.5` (14px) |
| Medium | `w-4 h-4` (16px) |
| Large | `w-5 h-5` (20px) |
| XLarge | `w-6 h-6` (24px) |

### 7.3 Stroke
- 기본: `strokeWidth={2}` (Lucide 기본)
- 강조: `strokeWidth={2.25}` ~ `2.5` (활성 FAB, 전송 버튼)
- 얇게: `strokeWidth={1.75}` (비활성 Wand2 등)

### 7.4 주요 아이콘 매핑
| 용도 | 아이콘 |
|---|---|
| 분석 주제 | `Pin` |
| 분석 내용 | `FileSearch` |
| 사용 마트 | `Layers` / `Database` |
| 셀 네비게이션 | `Compass` |
| 에이전트 (비활성) | `Wand2` |
| 에이전트 (활성) | `Zap` |
| 바이브 AI | `Sparkles` |
| 에이전트 응답 아바타 | `Sparkles` |
| 사용자 아바타 | `User` |
| 폴더 | `Folder` / `FolderOpen` |
| 폴더 추가 | `FolderPlus` |
| 메뉴 | `MoreHorizontal` |
| 실행 | `Play` |
| 전송 | `ArrowUp` |
| 입력 탭 | `Code` |
| 출력 탭 | `BarChart3` |
| 롤백 | `RotateCcw` |
| 리포팅 | `FileText` |
| 정보 | `Info` |
| 검색 | `Search` |
| 닫기 | `X` |
| 삭제 | `Trash2` |
| 추가 | `Plus` |
| 복제 | `Copy` |

---

## 8. 컴포넌트 패턴

### 8.1 버튼 계층

**Primary (CTA)**
```
배경: #D95C3F
호버: #C24E34
텍스트: #ffffff
그림자: 0 2px 4px rgba(217, 92, 63, 0.25)
라운딩: rounded-lg (8px)
```
예: 리포팅 버튼, 전송 버튼

**Secondary (Ghost)**
```
배경: transparent
호버 배경: #fdede8
텍스트: #78716c → #D95C3F (호버)
```
예: 셀 추가 버튼 (SQL/Python/Markdown)

**Icon Button**
```
배경: transparent
호버 배경: #fdede8 또는 #f5f4ed
패딩: p-1 ~ p-1.5
```
예: 실행/삭제, 메뉴 더보기

**Destructive**
```
텍스트: #dc2626
호버 배경: #fef2f2
```
예: 삭제 메뉴 항목

### 8.2 입력 요소

**Text Input / Textarea**
```
배경: #ffffff 또는 #faf8f2
테두리: 1px solid #e7e5e0
포커스 테두리: #D95C3F
포커스 shadow: 0 0 0 2px #f8e5dd
패딩: px-3 py-2
라운딩: rounded (4px)
```

### 8.3 카드

**Default Card**
```
배경: #ffffff
테두리: 1px solid #e7e5e0
라운딩: rounded-lg
```

**Active Card (히스토리 현재 선택 등)**
```
배경: #ffffff
테두리: 1px solid #ebc2b5
텍스트 색: #8f3a22
```

**Recommendation Card (마트 추천)**
```
배경: #fdf6ed
테두리: 1px solid #f0d9b5
```

### 8.4 배지 (Badge)

**Type Badge**: 2.5색 타입 컬러 (섹션 2.5 참조)

**Count Badge**:
```
배경: #fef3c7 (점수) 또는 #fdede8 (개수)
텍스트: #92400e / #8f3a22
크기: text-[8px] ~ text-[10px]
패딩: px-1 py-0.5
```

### 8.5 드롭다운 메뉴

**Container**
```
배경: #ffffff
테두리: 1px solid #e7e5e0
라운딩: rounded-md
그림자: shadow-lg
패딩: py-1
min-width: 140px
```

**Menu Item**
```
패딩: px-3 py-1.5
텍스트: text-[11px]
호버: bg-stone-100
아이콘: w-3 h-3
```

**Divider**
```
border-top: 1px solid #f5f4ed
margin: my-0.5
```

---

## 9. 모션 & 트랜지션

### 9.1 Duration
- **Fast (100-150ms)**: 호버, 포커스 상태 (색상 변경)
- **Normal (200-300ms)**: 토글, 펼침/접힘
- **Slow (400-600ms)**: 스크롤 이동, 드라마틱한 전환

### 9.2 Easing
- 기본: `ease` (브라우저 기본)
- 스크롤: `behavior: 'smooth'`

### 9.3 주요 애니메이션
- **호버 스케일**: `hover:scale-105` (타입 배지 클릭 가능 힌트)
- **호버 쉐도우**: `hover:shadow-md` (버튼)
- **opacity 트랜지션**: `opacity-0 group-hover:opacity-100` (액션 버튼 노출)
- **펄스**: 에이전트 FAB 활성 시 `animation: pulse 2s infinite`

---

## 10. 접근성 (Accessibility)

### 10.1 명도 대비
- 본문 텍스트 대 배경: **WCAG AA 이상** (4.5:1) 준수
- `#2d2a26` on `#faf9f5`: 14.8:1 ✅

### 10.2 포커스 링
- 모든 인터랙티브 요소는 포커스 시각화 제공
- `focus:outline-none` 사용 시 반드시 `focus:ring` 또는 `focus:border` 대체

### 10.3 키보드 네비게이션
- Tab 순서: 좌측 사이드바 → 상단 메타 → 셀 → 우측 네비게이션
- Enter: 주요 액션 (전송, 폴더 생성)
- Escape: 취소 (폴더 생성, 모달 닫기)
- Shift+Enter: 채팅창 줄바꿈

### 10.4 스크린 리더
- 모든 아이콘-only 버튼에 `title` 속성 필수
- 예: `<button title="바이브 전송">`

---

## 11. 반응형 고려

### 11.1 MVP 범위
- **데스크톱 전용** (min-width: 1280px)
- 태블릿/모바일은 v2에서 대응

### 11.2 최소 해상도
- Width: **1280px** (좌 사이드바 224 + 중앙 최소 600 + 네비 256 + 여백 200)
- Height: **720px**

### 11.3 확장성
- 상단 메타 접힘 기능으로 세로 공간 확보
- 좌/우 사이드바는 고정, 중앙 영역만 유동

---

## 12. 다크모드

**지원됨** (베타). `<html>.dark` 클래스 + CSS 변수로 런타임 전환.

### 활성화
- 좌측 사이드바 최하단 프로필 행의 **Sun/Moon 아이콘** 클릭 → 즉시 전환
- `modelStore.theme` 에 영속 저장 (`'light' | 'dark'`)
- 첫 마운트 시 `onRehydrateStorage` 훅이 `<html>.dark` 를 동기화 — 초기 화면 깜빡임 방지

### 팔레트 설계 원칙
- 배경: 쿨 뉴트럴 차콜 계열 (`#111216` ~ `#1C1D22`, Linear/Raycast 느낌). 라이트의 웜 크림을 그대로 반전하지 않음
- 텍스트: 뉴트럴 화이트 (`#E6E6EA`) — 너무 따뜻하면 배경과 충돌
- Primary (코랄): **버튼/CTA 는 라이트와 동일** (`#D95C3F` → 다크에선 살짝 밝힌 `#E86C50`). tint 계열 (`primary-light`/`pale`) 은 어두운 번트 오렌지로 변환
- 셀 타입 배경: 채도 낮춘 다크 올리브(SQL)/포레스트(Python)/웜그레이(MD)
- Status(success/danger/warning): 채도 유지, 배경만 어둡게 (`danger-bg`, `warning-bg` 등)

### 외부 위젯 분기
- **Plotly** (`CellOutput.tsx`): 테마에 따라 `plotly_white` ↔ `plotly_dark` 템플릿 + `paper_bgcolor` / `plot_bgcolor` / `font.color` 를 `useModelStore((s) => s.theme)` 로 동적 주입
- **Monaco** (`CodeEditor.tsx`): 마크다운 모드에서만 `'light' ↔ 'dark'` 전환. SQL/Python 은 `snowflakeTheme` 로 항상 다크
- 저장된 차트 PNG 는 흰 배경 고정 — 재실행 시 Plotly 메타로부터 현재 테마로 자동 재렌더

### 새 컴포넌트 다크 대응 체크리스트
1. 하드코딩 금지: `bg-[#xxx]` 또는 인라인 `style={{ color: '#xxx' }}` 사용 금지
2. 기본 배경: `bg-bg-page` / `bg-bg-pane` / `bg-surface` 중 의미에 맞는 것 선택
3. 모달·카드·인풋: `bg-surface`
4. 호버/토스트 neutral bg: `bg-chip`
5. 텍스트: `text-text-primary` / `-secondary` / `-tertiary` / `-disabled`
6. 외부 라이브러리가 테마를 받지 않으면 `useModelStore((s) => s.theme)` 로 옵션 분기
7. 특이 케이스(애니메이션 그라데이션 등): `rgb(var(--color-x))` 를 inline style 로 참조

---

## 13. 디자인 토큰 (JSON)

개발 편의를 위한 토큰 형식 예시:

```json
{
  "color": {
    "bg": {
      "page": "#faf9f5",
      "sidebar": "#f5f4ed",
      "pane": "#fdfcf8",
      "card": "#ffffff",
      "output": "#faf8f2",
      "codeDark": "#2d2a26"
    },
    "primary": {
      "default": "#D95C3F",
      "hover": "#C24E34",
      "light": "#fdede8",
      "pale": "#f8e5dd",
      "border": "#ebc2b5",
      "text": "#8f3a22"
    },
    "text": {
      "primary": "#2d2a26",
      "secondary": "#57534e",
      "tertiary": "#78716c",
      "disabled": "#a8a29e"
    },
    "cellType": {
      "sql": { "bg": "#e8e4d8", "text": "#5c4a1e" },
      "python": { "bg": "#e6ede0", "text": "#3d5226" },
      "markdown": { "bg": "#eae4df", "text": "#4a3c2e" }
    }
  },
  "spacing": {
    "sidebarLeft": "224px",
    "sidebarRight": "256px",
    "headerHeight": "56px"
  },
  "radius": {
    "sm": "4px",
    "md": "6px",
    "lg": "8px",
    "xl": "12px",
    "2xl": "16px"
  }
}
```

---

## 14. 체크리스트

신규 UI 추가 시 확인:

- [ ] 컬러가 팔레트 내에 있는가?
- [ ] 폰트 크기가 스케일 내에 있는가?
- [ ] 간격이 4px 그리드에 맞는가?
- [ ] 아이콘이 Lucide React인가?
- [ ] 이모지를 UI 장식으로 쓰고 있지 않은가?
- [ ] 호버/포커스/비활성 상태가 있는가?
- [ ] 아이콘-only 버튼에 title이 있는가?
- [ ] 테이블/스크롤 영역에 `.hide-scrollbar` 적용이 필요한가?

---

*Last updated: 2026-04-18*
*Owner: 하우 / 디자인 협의: [TBD]*
