import { X, Keyboard } from 'lucide-react'

interface Props {
  onClose: () => void
}

const SECTIONS = [
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

export default function ShortcutsModal({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface rounded-xl shadow-2xl w-[500px] max-w-[95vw] flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <Keyboard size={16} className="text-primary" />
            <span className="font-semibold text-text-primary">단축키</span>
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
