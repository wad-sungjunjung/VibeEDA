import { X, BookOpen, ExternalLink } from 'lucide-react'
import Markdown from './Markdown'
import userGuide from '../../../docs/vibe-eda-user-guide.md?raw'

interface Props {
  onClose: () => void
}

export default function UserGuideModal({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface rounded-xl shadow-2xl w-[760px] max-w-[95vw] flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-primary" />
            <span className="font-semibold text-text-primary">사용 가이드</span>
            <span className="text-[11px] text-text-tertiary">— 에이전트 · 마트 · 리포트 워크플로</span>
          </div>
          <div className="flex items-center gap-1">
            <a
              href="https://github.com/wad-sungjunjung/VibeEDA/blob/main/docs/vibe-eda-user-guide.md"
              target="_blank"
              rel="noreferrer"
              title="새 탭에서 열기"
              className="p-1 rounded hover:bg-chip text-text-tertiary transition-colors"
            >
              <ExternalLink size={14} />
            </a>
            <button onClick={onClose} className="p-1 rounded hover:bg-chip text-text-tertiary transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto hide-scrollbar px-6 py-5">
          <Markdown content={userGuide} />
        </div>

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
