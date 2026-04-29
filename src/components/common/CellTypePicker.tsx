import { useEffect, useRef, useState } from 'react'
import { Database, Code2, FileText, Table2 } from 'lucide-react'
import type { CellType } from '@/types'
import { cn } from '@/lib/utils'

interface Option {
  type: CellType
  label: string
  hint: string
  Icon: typeof Database
}

const OPTIONS: Option[] = [
  { type: 'sql', label: 'SQL', hint: '쿼리 셀', Icon: Database },
  { type: 'python', label: 'Python', hint: '분석 · 시각화', Icon: Code2 },
  { type: 'markdown', label: 'Markdown', hint: '메모 · 문서', Icon: FileText },
  { type: 'sheet', label: 'Sheet', hint: '스프레드시트', Icon: Table2 },
]

interface Props {
  onSelect: (type: CellType) => void
  onClose: () => void
}

export default function CellTypePicker({ onSelect, onClose }: Props) {
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (i + 1) % OPTIONS.length)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onSelect(OPTIONS[index].type)
    } else if (e.key === 'Escape') {
      // fullscreen 셀의 document-level Esc 핸들러까지 같이 발화하면
      // 팝업과 fullscreen 이 한 번에 닫혀버린다. native 전파를 끊어 단계적으로 닫히게 한다.
      e.preventDefault()
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      onClose()
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault()
      onSelect(OPTIONS[Number(e.key) - 1].type)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={ref}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="bg-surface rounded-xl shadow-2xl p-4 outline-none"
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary mb-3 px-1">
          셀 추가
        </div>
        <div className="flex gap-2">
          {OPTIONS.map(({ type, label, hint, Icon }, i) => (
            <button
              key={type}
              onClick={() => onSelect(type)}
              onMouseEnter={() => setIndex(i)}
              className={cn(
                'w-[104px] h-[104px] flex flex-col items-center justify-center gap-2 rounded-lg border transition-colors',
                i === index
                  ? 'bg-primary-light border-primary text-primary'
                  : 'bg-bg-page border-border text-text-secondary hover:border-border-hover'
              )}
            >
              <Icon size={24} strokeWidth={1.5} />
              <div className="flex flex-col items-center">
                <span className="text-[13px] font-semibold">{label}</span>
                <span className="text-[10px] text-text-tertiary">{hint}</span>
              </div>
              <span className="text-[9px] text-text-disabled">{i + 1}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 px-1 text-[10px] text-text-tertiary">
          ← → 선택 · Enter 확인 · Esc 닫기
        </div>
      </div>
    </div>
  )
}
