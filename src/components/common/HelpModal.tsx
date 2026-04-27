import { useState } from 'react'
import { X, Keyboard, Sparkles, BookOpen, ExternalLink, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import Markdown from './Markdown'
import userGuide from '../../../docs/vibe-eda-user-guide.md?raw'

interface Props {
  onClose: () => void
  initialTab?: Tab
}

type Tab = 'shortcuts' | 'features' | 'guide'

// ─── 단축키 데이터 ────────────────────────────────────────────────────────────

const SHORTCUT_SECTIONS = [
  {
    title: '코드 편집기',
    shortcuts: [
      { keys: ['Ctrl', 'Enter'], desc: '셀 실행' },
      { keys: ['Tab'], desc: '들여쓰기' },
      { keys: ['Shift', 'Tab'], desc: '내어쓰기' },
      { keys: ['Ctrl', 'Z'], desc: '실행 취소' },
      { keys: ['Ctrl', 'Shift', 'Z'], desc: '다시 실행' },
      { keys: ['Ctrl', '/'], desc: '라인 주석 토글' },
      { keys: ['Ctrl', 'D'], desc: '단어 선택 확장' },
      { keys: ['Ctrl', 'A'], desc: '전체 선택' },
    ],
  },
  {
    title: '바이브 챗',
    shortcuts: [
      { keys: ['Ctrl', 'L'], desc: '활성 셀의 바이브 챗으로 포커스 이동' },
      { keys: ['Enter'], desc: '메시지 전송' },
      { keys: ['Shift', 'Enter'], desc: '줄바꿈' },
    ],
  },
  {
    title: '셀 편집',
    shortcuts: [
      { keys: ['Ctrl', 'B'], desc: '활성 셀 아래에 새 셀 추가 (동일 타입)' },
      { keys: ['Ctrl', 'G'], desc: '에이전트 모드 토글' },
    ],
  },
  {
    title: '셀 실행',
    shortcuts: [
      { keys: ['▶ 버튼'], desc: '현재 셀 실행 (헤더 호버 시)' },
      { keys: ['모두 실행 버튼'], desc: '모든 SQL/Python 셀 순서대로 실행' },
    ],
  },
  {
    title: '레이아웃',
    shortcuts: [
      { keys: ['□'], desc: '단일 패널' },
      { keys: ['▬'], desc: '좌우 분할 (코드 | 출력 동시 보기)' },
      { keys: ['≡'], desc: '상하 분할 (코드 | 출력 동시 보기)' },
      { keys: ['Alt', '←/→'], desc: '분할 모드 순환 (단일 → 좌우 → 상하)' },
    ],
  },
]

function Kbd({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-bg-sidebar border border-border-hover text-sql-text"
      style={{ minWidth: 22 }}
    >
      {label}
    </span>
  )
}

function ShortcutsTab() {
  return (
    <div className="space-y-5">
      {SHORTCUT_SECTIONS.map((section) => (
        <div key={section.title}>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-2">
            {section.title}
          </div>
          <div className="space-y-1.5">
            {section.shortcuts.map((s, i) => (
              <div key={i} className="flex items-center justify-between py-1 px-2 rounded hover:bg-chip">
                <span className="text-[12px] text-text-secondary">{s.desc}</span>
                <div className="flex items-center gap-1 shrink-0 ml-4">
                  {s.keys.map((k, ki) => (
                    <span key={ki} className="flex items-center gap-1">
                      {ki > 0 && <span className="text-[10px] text-text-disabled">+</span>}
                      <Kbd label={k} />
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── 편의 기능 데이터 ─────────────────────────────────────────────────────────

import {
  Maximize2, Columns2, Table as TableIcon, Telescope, FileText,
  MessagesSquare, Wand2, Copy, Moon, FolderTree, Code2, Plug, Share2,
} from 'lucide-react'

interface Feature {
  icon: ReactNode
  title: string
  desc: string
  how?: string
  detail?: string
}

interface FeatureSection {
  title: string
  items: Feature[]
}

const FEATURE_SECTIONS: FeatureSection[] = [
  {
    title: '셀 편집 & 보기',
    items: [
      {
        icon: <Maximize2 size={14} className="text-primary" />,
        title: '셀 전체화면',
        desc: '특정 셀에 집중해서 넓게 보기. 네비게이션으로 셀을 바꾸면 상하 슬라이드로 전환',
        how: '셀 본문 더블클릭 · 헤더의 Maximize 버튼 · 해제는 Esc',
        detail:
          '좌측 분석 목록과 우측 셀 네비게이션은 그대로 유지된 채, 노트북 중앙 영역만 꽉 채워 확대됩니다. 전체화면 상태에서도 우측 "셀 네비게이션"을 클릭하면 셀이 상하 슬라이드(순서 기준)로 전환되어 여러 셀을 빠르게 검토할 수 있습니다.',
      },
      {
        icon: <Columns2 size={14} className="text-primary" />,
        title: '패널 분할 (좌우 / 상하)',
        desc: '한 셀 안에서 입력·출력·메모를 동시에 보기',
        how: '셀 헤더 오른쪽의 □ / ▬ / ≡ 버튼',
        detail:
          '기본 모드(□)는 탭으로 입력/출력/메모를 전환합니다. 좌우 분할(▬)·상하 분할(≡)로 두 탭을 동시에 펼쳐 놓을 수 있어요.',
      },
      {
        icon: <Wand2 size={14} className="text-primary" />,
        title: '셀 패널 높이 조절',
        desc: '셀 아래 얇은 바를 드래그해 출력 영역 높이를 자유롭게 맞춤',
        detail:
          '차트 셀은 Plotly layout.height 에 맞춰 자동 확장되지만, 수동으로 더 크게(또는 작게) 조절한 값은 셀별로 localStorage 에 저장됩니다.',
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
          '현재 셀의 코드를 수정·재작성합니다. 기본 모델은 Gemini 2.5 Flash 지만 채팅 박스에서 즉시 변경 가능. SQL 셀은 마트 스키마를, Python 셀은 이전 SQL 결과 DataFrame 요약을 컨텍스트로 참고합니다.',
      },
      {
        icon: <Telescope size={14} className="text-primary" />,
        title: '에이전트 모드',
        desc: '여러 셀에 걸친 작업을 한 번에 — 데이터 탐색, 분석 자동화',
        how: '우측 하단 에이전트 버튼(FAB) · 단축키 Ctrl+G',
        detail:
          '10가지 tool(셀 생성/수정/실행, 마트 프로파일링, 이전 셀 결과 읽기, 메모 작성, ask_user 되묻기, 차트 이미지 주입 등)을 순차 호출하며 실시간 스트리밍. 기본 모델은 Claude Opus 4.7.',
      },
      {
        icon: <Sparkles size={14} className="text-primary" />,
        title: '셀 이름 자동 추천',
        desc: '코드 내용을 읽고 snake_case 이름을 제안',
        how: '셀 이름 옆의 ✨ 버튼',
        detail:
          'Gemini 키가 있으면 gemini-2.5-flash-lite, 없으면 claude-haiku-4-5 사용. 이름은 셀 간 변수 공유에 쓰이므로 의미 있게 붙이면 좋습니다.',
      },
      {
        icon: <FileText size={14} className="text-primary" />,
        title: '리포트 자동 생성',
        desc: '선택한 셀의 코드·출력·차트를 기반으로 Markdown 리포트 작성 · 저장',
        how: '상단의 "리포팅" 버튼',
        detail:
          '셀 여러 개를 선택하고 리포트 목표를 쓰면 LLM 이 Markdown 분석 리포트를 스트리밍으로 작성합니다. 차트는 PNG 로 저장되어 reports/{id}_images/ 에 배치되고 상대 경로로 임베드.',
      },
      {
        icon: <Share2 size={14} className="text-primary" />,
        title: '마트 추천',
        desc: '분석 주제를 입력하면 관련 마트를 LLM 이 추천',
        how: '새 분석 생성 시 · 상단 메타 헤더의 마트 선택 영역',
        detail:
          '분석 주제를 주면 LLM 이 가장 관련성 높은 마트를 3–5개 추천합니다. 선택된 마트만 바이브 챗·에이전트의 SQL 컨텍스트에 들어갑니다.',
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
          '컬럼이 많은 표에서 식별 컬럼(예: 날짜·지역)을 고정해 두면 우측으로 스크롤해도 기준이 계속 보입니다.',
      },
      {
        icon: <Code2 size={14} className="text-primary" />,
        title: '셀 간 변수 공유',
        desc: 'SQL 결과가 셀 이름 변수로 커널에 저장됨. Python 셀에서 바로 사용',
        how: '예: SQL 셀 이름 query_1 → Python 에서 px.bar(query_1, ...)',
        detail:
          '노트북마다 독립된 Python 커널 네임스페이스가 유지됩니다. SQL 셀을 실행하면 결과 DataFrame 이 {셀이름} 변수로 자동 주입됩니다.',
      },
      {
        icon: <Copy size={14} className="text-primary" />,
        title: '표 / 차트 복사',
        desc: '표는 TSV 로 (엑셀·시트 그대로 붙여넣기), 차트는 PNG 로 클립보드',
        how: '출력 영역 우상단의 복사 버튼',
        detail:
          '표 복사는 TSV 형식이라 Google Sheets·Excel 에 바로 붙여 넣으면 셀 분리가 유지됩니다. 차트는 2x 해상도 PNG 로 클립보드에 들어갑니다.',
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
          '폴더 메타데이터는 ~/vibe-notebooks/.vibe_config.json 에 저장. "예약", "광고", "운영 메트릭" 같은 주제별 폴더를 만들어 두세요.',
      },
      {
        icon: <Moon size={14} className="text-primary" />,
        title: '다크 모드',
        desc: '전체 UI 테마를 다크로 전환. 설정은 자동 저장',
        how: '좌측 사이드바 하단 프로필 영역의 Sun/Moon 버튼',
        detail:
          'Tailwind darkMode:class 기반으로 구동. Plotly 차트는 plotly_dark 템플릿으로 재렌더되고, Monaco 에디터도 자동 따릅니다.',
      },
      {
        icon: <Plug size={14} className="text-primary" />,
        title: 'Claude Code MCP 연동',
        desc: 'Claude Code CLI 에서 MCP 프로토콜로 노트북을 직접 조작 가능',
        how: 'backend/app/api/mcp_server.py · 자세한 설정은 CLAUDE.md 참고',
        detail:
          'Claude Code 에서 노트북을 읽고·셀을 추가하고·실행을 트리거하는 MCP 툴 셋이 공개되어 있습니다. ~/.claude/claude_desktop_config.json 에 등록해서 사용.',
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

function FeaturesTab() {
  return (
    <div className="space-y-5">
      {FEATURE_SECTIONS.map((section) => (
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
        더 자세한 워크플로 가이드는{' '}
        <span className="font-mono text-[10.5px] px-1 py-0.5 rounded bg-chip">사용 가이드</span> 탭 참고.
      </div>
    </div>
  )
}

// ─── 메인 모달 ────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'shortcuts', label: '단축키', icon: <Keyboard size={13} /> },
  { id: 'features', label: '편의 기능', icon: <Sparkles size={13} /> },
  { id: 'guide', label: '사용 가이드', icon: <BookOpen size={13} /> },
]

export default function HelpModal({ onClose, initialTab = 'shortcuts' }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface rounded-xl shadow-2xl w-[680px] max-w-[95vw] flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
          <span className="font-semibold text-text-primary">도움말</span>
          <div className="flex items-center gap-1">
            {activeTab === 'guide' && (
              <a
                href="https://github.com/wad-sungjunjung/VibeEDA/blob/main/docs/vibe-eda-user-guide.md"
                target="_blank"
                rel="noreferrer"
                title="새 탭에서 열기"
                className="p-1 rounded hover:bg-chip text-text-tertiary transition-colors"
              >
                <ExternalLink size={14} />
              </a>
            )}
            <button onClick={onClose} className="p-1 rounded hover:bg-chip text-text-tertiary transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 px-5 border-b border-border-subtle shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-[12px] font-medium border-b-2 transition-colors -mb-px ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto hide-scrollbar px-5 py-4 flex-1 min-h-0">
          {activeTab === 'shortcuts' && <ShortcutsTab />}
          {activeTab === 'features' && <FeaturesTab />}
          {activeTab === 'guide' && <Markdown content={userGuide} />}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-subtle shrink-0">
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
