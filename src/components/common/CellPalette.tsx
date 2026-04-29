import { useEffect, useMemo, useRef, useState } from 'react'
import { Database, FileCode, FileText, Sheet as SheetIcon, Search, X } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/utils'
import type { CellType } from '@/types'

interface Props {
  onClose: () => void
}

function cellIcon(type: CellType) {
  if (type === 'sql') return <Database size={13} className="text-sql-text shrink-0" />
  if (type === 'python') return <FileCode size={13} className="text-python-text shrink-0" />
  if (type === 'sheet') return <SheetIcon size={13} className="text-warning shrink-0" />
  return <FileText size={13} className="text-markdown-text shrink-0" />
}

export default function CellPalette({ onClose }: Props) {
  const { cells, setActiveCellId } = useAppStore(useShallow((s) => ({
    cells: s.cells,
    setActiveCellId: s.setActiveCellId,
  })))
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return cells
    return cells.filter((c) =>
      c.name.toLowerCase().includes(needle) ||
      c.type.toLowerCase().includes(needle) ||
      (c.memo ?? '').toLowerCase().includes(needle)
    )
  }, [cells, q])

  useEffect(() => {
    setIdx(0)
  }, [q])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-idx="${idx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  function jumpTo(cellId: string) {
    setActiveCellId(cellId)
    requestAnimationFrame(() => {
      document.getElementById(cellId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[idx]
      if (target) jumpTo(target.id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-start justify-center bg-black/30 backdrop-blur-sm pt-[15vh]" onClick={onClose}>
      <div
        className="bg-surface rounded-xl shadow-2xl w-[560px] max-w-[92vw] flex flex-col max-h-[60vh]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Search size={14} className="text-text-tertiary shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="셀 이름 · 메모 · 타입으로 검색"
            className="flex-1 bg-transparent outline-none text-[14px] text-text-primary placeholder-text-tertiary border-none focus:ring-0 p-0"
          />
          <button onClick={onClose} className="p-1 rounded hover:bg-chip text-text-tertiary transition-colors shrink-0" title="닫기 (Esc)">
            <X size={14} />
          </button>
        </div>
        <div ref={listRef} className="overflow-y-auto hide-scrollbar py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-text-disabled text-center">일치하는 셀이 없습니다</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                data-row-idx={i}
                onMouseEnter={() => setIdx(i)}
                onClick={() => jumpTo(c.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-4 py-2 text-left transition-colors',
                  i === idx ? 'bg-primary-pale text-primary-text' : 'hover:bg-chip text-text-primary'
                )}
              >
                {cellIcon(c.type)}
                <span className="font-mono text-[12px] truncate flex-1 min-w-0">{c.name}</span>
                <span className="text-[10px] uppercase font-semibold text-text-tertiary shrink-0">{c.type}</span>
                {c.memo && (
                  <span className="text-[10px] text-text-tertiary truncate max-w-[180px] shrink-0 italic">
                    {c.memo}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-border-subtle flex items-center gap-3 text-[10px] text-text-tertiary">
          <span><kbd className="px-1 rounded bg-chip">↑↓</kbd> 이동</span>
          <span><kbd className="px-1 rounded bg-chip">Enter</kbd> 점프</span>
          <span><kbd className="px-1 rounded bg-chip">Esc</kbd> 닫기</span>
        </div>
      </div>
    </div>
  )
}
