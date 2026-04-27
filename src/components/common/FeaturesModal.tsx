import { useState } from 'react'
import { X, Sparkles, Maximize2, Columns2, Table as TableIcon, Telescope, FileText, MessagesSquare, Wand2, Copy, Moon, FolderTree, Code2, Plug, Share2, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
  onClose: () => void
}

interface Feature {
  icon: ReactNode
  title: string
  desc: string
  how?: string
  detail?: string
}

interface Section {
  title: string
  items: Feature[]
}

const SECTIONS: Section[] = [
  {
    title: '셀 편집 & 보기',
    items: [
      {
        icon: <Maximize2 size={14} className="text-primary" />,
        title: '셀 전체화면',
        desc: '특정 셀에 집중해서 넓게 보기. 네비게이션으로 셀을 바꾸면 상하 슬라이드로 전환',
        how: '셀 본문 더블클릭 · 헤더의 Maximize 버튼 · 해제는 Esc',
        detail:
          '좌측 분석 목록과 우측 셀 네비게이션은 그대로 유지된 채, 노트북 중앙 영역만 꽉 채워 확대됩니다. 전체화면 상태에서도 우측 "셀 네비게이션"을 클릭하면 셀이 상하 슬라이드(순서 기준)로 전환되어 여러 셀을 빠르게 검토할 수 있습니다. 표 출력이나 차트를 크게 볼 때 특히 유용.',
      },
      {
        icon: <Columns2 size={14} className="text-primary" />,
        title: '패널 분할 (좌우 / 상하)',
        desc: '한 셀 안에서 입력·출력·메모를 동시에 보기',
        how: '셀 헤더 오른쪽의 □ / ▬ / ≡ 버튼, 또는 Alt + ←/→ 단축키',
        detail:
          '기본 모드(□)는 탭으로 입력/출력/메모를 전환합니다. 좌우 분할(▬)·상하 분할(≡)로 두 탭을 동시에 펼쳐 놓을 수 있어요. 분할 비율은 가운데 구분선을 드래그해 조정 가능. SQL 쿼리 작성 중 결과 표를 계속 확인하거나, Python 차트를 보면서 코드를 다듬을 때 편리합니다.',
      },
      {
        icon: <Wand2 size={14} className="text-primary" />,
        title: '셀 패널 높이 조절',
        desc: '셀 아래 얇은 바를 드래그해 출력 영역 높이를 자유롭게 맞춤',
        detail:
          '차트 셀은 Plotly layout.height 에 맞춰 자동 확장되지만, 수동으로 더 크게(또는 작게) 조절한 값은 셀별로 localStorage 에 저장됩니다. 한 번 맞춰두면 다음 방문에도 유지돼요.',
      },
    ],
  },
  {
    title: 'AI 기능',
    items: [
      {
        icon: <MessagesSquare size={14} className="text-primary" />,
        title: '바이브 챗',
        desc: '자연어로 셀 코드 수정 요청 — "시도별로 group by 해줘" 처럼',
        how: '활성 셀 하단 채팅 박스 · Ctrl+Enter 전송',
        detail:
          '현재 셀의 코드를 수정·재작성합니다(셀 하나 단위). 기본 모델은 Gemini 2.5 Flash 지만, 채팅 박스 왼쪽 아래에서 즉시 모델을 바꿀 수 있어요. SQL 셀은 선택된 마트 스키마와 컬럼 허용값을 시스템 프롬프트에 주입해 유효한 쿼리를 만들고, Python 셀은 이전 SQL 결과 DataFrame 요약을 참고합니다. 히스토리는 노트북 .ipynb 의 metadata.vibe.chat_history 에 보존.',
      },
      {
        icon: <Telescope size={14} className="text-primary" />,
        title: '에이전트 모드',
        desc: '여러 셀에 걸친 작업을 한 번에 — 데이터 탐색, 분석 자동화',
        how: '우측 하단 에이전트 버튼(FAB) · 단축키 Ctrl+G',
        detail:
          '바이브 챗이 "한 셀 수정"이라면, 에이전트 모드는 "노트북 전체에서 분석 과제 수행"입니다. 10가지 tool(셀 생성/수정/실행, 마트 프로필링, 이전 셀 결과 읽기, 메모 작성, ask_user 되묻기, 차트 이미지 tool_result 주입 등)을 순차적으로 호출하며 진행 상황을 실시간 스트리밍. 기본 모델은 Claude Opus 4.7(정확도 우선)이며 Gemini 3.1 Pro 로도 전환 가능. 메모 강제 가드·반복 호출 가드가 내장되어 있어 과도한 루프를 방지합니다. 예: "최근 한 달 시도별 매출 변화 보여줘" → 에이전트가 마트 조사 → SQL 셀 → Python 차트 셀을 순차 생성·실행.',
      },
      {
        icon: <Sparkles size={14} className="text-primary" />,
        title: '셀 이름 자동 추천',
        desc: '코드 내용을 읽고 snake_case 이름을 제안. 가장 저렴한 모델 사용',
        how: '셀 이름 옆의 ✨ 버튼',
        detail:
          'Gemini 키가 설정되어 있으면 gemini-2.5-flash-lite, 아니면 claude-haiku-4-5 를 사용합니다. 이름은 셀 간 변수 공유에 쓰이므로(SQL 결과 DataFrame 이 셀 이름으로 노출), 의미 있는 이름을 빠르게 붙이는 데 유용. 원치 않으면 직접 입력해도 됨 — snake_case 형식 자동 검증.',
      },
      {
        icon: <FileText size={14} className="text-primary" />,
        title: '리포트 자동 생성',
        desc: '선택한 셀의 코드·출력·차트를 기반으로 Markdown 리포트 작성 · 저장',
        how: '상단의 "리포팅" 버튼',
        detail:
          '셀 여러 개를 선택하고 리포트 목표(예: "캠페인 A/B 효과 요약")를 쓰면, LLM 이 각 셀의 쿼리·결과 표·차트를 근거(evidence)로 읽어 Markdown 분석 리포트를 스트리밍으로 작성합니다. 차트는 PNG 로 저장되어 {report_id}_images/ 폴더에 배치되고 상대 경로로 임베드. 결과는 ~/vibe-notebooks/reports/*.md 에 YAML frontmatter 와 함께 저장되어 나중에 좌측 사이드바 reports 섹션에서 다시 열람 가능.',
      },
      {
        icon: <Share2 size={14} className="text-primary" />,
        title: '마트 추천',
        desc: '분석 주제를 입력하면 관련 마트를 LLM 이 추천',
        how: '새 분석 생성 시 · 상단 메타 헤더의 마트 선택 영역',
        detail:
          'Vibe EDA 는 사전에 등록된 데이터 마트(dim_*, fact_*, mart_* 등) 카탈로그를 갖고 있고, 분석 주제를 주면 LLM 이 가장 관련성 높은 마트를 3–5개 추천합니다. 선택된 마트만 바이브 챗·에이전트의 SQL 생성 컨텍스트에 들어가서, 프롬프트가 짧고 정확해져요. 나중에 마트를 더하거나 빼고 싶으면 상단 메타 헤더에서 언제든 조정 가능.',
      },
    ],
  },
  {
    title: '데이터 & 결과',
    items: [
      {
        icon: <TableIcon size={14} className="text-primary" />,
        title: '표 고정 열',
        desc: 'Google Sheets 처럼 좌측 열을 고정해 가로 스크롤 해도 보이게',
        how: '표 좌측의 세로 바를 드래그 — 원하는 경계까지 끌어 두면 스냅',
        detail:
          '컬럼이 많은 표에서 식별 컬럼(예: 날짜·지역)을 고정해 두면 우측으로 스크롤해도 기준이 계속 보입니다. 바를 맨 왼쪽까지 끌면 고정 해제, 오른쪽으로 더 끌면 여러 컬럼을 묶어서 고정. 스크롤 중에도 sticky 경계선이 정확히 유지됩니다.',
      },
      {
        icon: <Code2 size={14} className="text-primary" />,
        title: '셀 간 변수 공유',
        desc: 'SQL 결과가 셀 이름 변수로 커널에 저장됨. Python 셀에서 바로 사용',
        how: '예: SQL 셀 이름 query_1 → Python 에서 px.bar(query_1, ...)',
        detail:
          '노트북마다 독립된 Python 커널 네임스페이스가 유지됩니다. SQL 셀을 실행하면 결과 DataFrame 이 `{셀이름}` 변수로 자동 주입되어, 아래 Python 셀에서 변수명으로 바로 접근할 수 있어요. 같은 셀을 재실행하면 변수도 최신값으로 갱신. 커널을 초기화하려면 DELETE /kernel/{notebook_id}.',
      },
      {
        icon: <Copy size={14} className="text-primary" />,
        title: '표 / 차트 복사',
        desc: '표는 TSV 로 (엑셀·시트 그대로 붙여넣기), 차트는 PNG 로 클립보드',
        how: '출력 영역 우상단의 복사 버튼',
        detail:
          '표 복사는 TSV(탭 구분) 형식이라 Google Sheets·Excel 에 바로 붙여 넣으면 셀 분리가 유지됩니다. 차트는 2x 해상도 PNG 로 클립보드에 들어가 Slack/문서 등에 바로 붙여넣기 가능. Plotly modebar 는 숨겨져 있어 깔끔합니다.',
      },
    ],
  },
  {
    title: '프로젝트 관리',
    items: [
      {
        icon: <FolderTree size={14} className="text-primary" />,
        title: '폴더로 분석 정리',
        desc: '좌측 히스토리에서 폴더를 만들어 노트북을 계층적으로 분류',
        detail:
          '폴더 메타데이터는 ~/vibe-notebooks/.vibe_config.json 에 저장되며, reports 하위 폴더도 인식합니다. 분석이 늘어나면 "예약", "광고", "운영 메트릭" 같은 주제별 폴더를 만들어 두세요.',
      },
      {
        icon: <Moon size={14} className="text-primary" />,
        title: '다크 모드',
        desc: '전체 UI 테마를 다크로 전환. 설정은 자동 저장',
        how: '좌측 사이드바 하단 프로필 영역의 Sun/Moon 버튼',
        detail:
          'Tailwind darkMode:class 기반으로 구동되며, <html>.dark 클래스 토글로 즉시 전환됩니다. Plotly 차트는 plotly_dark 템플릿으로 재렌더되고, Monaco 마크다운 에디터도 라이트/다크 를 자동 따릅니다. 저장된 차트 PNG 는 흰 배경이지만 재실행 시 현재 테마에 맞춰 다시 렌더링돼요.',
      },
      {
        icon: <Plug size={14} className="text-primary" />,
        title: 'Claude Code MCP 연동',
        desc: 'Claude Code CLI 에서 MCP 프로토콜로 노트북을 직접 조작 가능',
        how: 'backend/app/api/mcp_server.py · 자세한 설정은 CLAUDE.md 참고',
        detail:
          'Claude Code 에서 "이 노트북 리포트 만들어줘" 같은 요청을 처리할 수 있도록 MCP 서버를 제공합니다. 별도 프로세스로 실행되며(python -m app.api.mcp_server), ~/.claude/claude_desktop_config.json 에 등록해서 사용. 기존 노트북 파일을 읽고·셀을 추가하고·실행을 트리거하는 툴 셋이 공개되어 있습니다.',
      },
    ],
  },
]

function FeatureCard({ feature }: { feature: Feature }) {
  const [open, setOpen] = useState(false)
  const hasDetail = !!feature.detail
  return (
    <div
      className={`rounded-lg border transition-colors ${
        open ? 'border-primary/40 bg-primary-light/30' : 'border-border-subtle hover:border-primary/40 hover:bg-primary-light/20'
      }`}
    >
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className="w-full flex items-start gap-3 py-2 px-3 text-left"
        disabled={!hasDetail}
      >
        <div className="mt-0.5 shrink-0 w-6 h-6 rounded-md bg-primary-light/60 flex items-center justify-center">
          {feature.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-text-primary">{feature.title}</span>
            {hasDetail && (
              <ChevronRight
                size={12}
                className={`text-text-tertiary transition-transform ${open ? 'rotate-90' : ''}`}
              />
            )}
          </div>
          <div className="text-[12px] text-text-secondary mt-0.5 leading-relaxed">{feature.desc}</div>
          {feature.how && (
            <div className="text-[11px] text-text-tertiary mt-1">
              <span className="font-semibold">사용:</span> {feature.how}
            </div>
          )}
        </div>
      </button>
      {open && feature.detail && (
        <div className="px-3 pb-3 pt-1 ml-9 text-[12px] text-text-secondary leading-relaxed border-t border-border-subtle/60">
          {feature.detail}
        </div>
      )}
    </div>
  )
}

export default function FeaturesModal({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface rounded-xl shadow-2xl w-[600px] max-w-[95vw] flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-primary" />
            <span className="font-semibold text-text-primary">편의 기능</span>
            <span className="text-[11px] text-text-tertiary">— 각 카드를 클릭하면 자세한 설명이 펼쳐집니다</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-chip text-text-tertiary transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto hide-scrollbar px-5 py-4 space-y-5">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-2">
                {section.title}
              </div>
              <div className="space-y-1.5">
                {section.items.map((f, i) => (
                  <FeatureCard key={i} feature={f} />
                ))}
              </div>
            </div>
          ))}
          <div className="text-[11px] text-text-tertiary pt-2 border-t border-border-subtle/60">
            더 자세한 워크플로 가이드는 <span className="font-mono text-[10.5px] px-1 py-0.5 rounded bg-chip">docs/vibe-eda-user-guide.md</span> 참고.
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg text-[13px] font-semibold transition-colors bg-bg-sidebar text-sql-text hover:bg-chip"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
