import { Plus } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import type { CellType } from '@/types'

const CELL_TYPES: { type: CellType; label: string }[] = [
  { type: 'sql', label: 'SQL' },
  { type: 'python', label: 'Python' },
  { type: 'markdown', label: 'Markdown' },
]

export default function CellAddBar() {
  const { addCell, activeCellId } = useAppStore()

  return (
    <div className="h-cell-bar border-t border-border-subtle bg-bg-pane flex items-center justify-center gap-4 px-4 shrink-0 font-sans">
      <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <Plus size={14} />
        <span>셀 추가</span>
      </div>
      <div className="flex items-center gap-1.5">
        {CELL_TYPES.map(({ type, label }) => (
          <button
            key={type}
            onClick={() => addCell(type, activeCellId)}
            className="px-3 py-1 text-xs text-text-secondary hover:text-primary hover:bg-primary-light rounded-md transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
