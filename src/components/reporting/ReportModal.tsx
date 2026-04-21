import { useState, useEffect } from 'react'
import { FileText, X, ChevronDown } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useModelStore, REPORT_MODELS } from '@/store/modelStore'
import { cn } from '@/lib/utils'

export default function ReportModal() {
  const { showReportModal, cells, analysisDescription, setShowReportModal, generateReport } = useAppStore()
  const { reportModel, setReportModel } = useModelStore()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [goal, setGoal] = useState('')

  useEffect(() => {
    if (showReportModal) {
      setSelectedIds(cells.filter((c) => c.type === 'markdown' || c.executed).map((c) => c.id))
      setGoal(analysisDescription ?? '')
    }
  }, [showReportModal, cells, analysisDescription])

  if (!showReportModal) return null

  function toggle(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  // 리포트에 포함 가능한 셀: 실행된 셀 + Markdown 셀 (실행 여부 무관)
  const isSelectable = (c: { type: string; executed: boolean }) => c.type === 'markdown' || c.executed
  const executableCells = cells.filter(isSelectable)
  const allSelected = executableCells.length > 0 && executableCells.every((c) => selectedIds.includes(c.id))
  const someSelected = executableCells.some((c) => selectedIds.includes(c.id))
  const toggleAll = () => {
    if (allSelected) setSelectedIds([])
    else setSelectedIds(executableCells.map((c) => c.id))
  }

  const TYPE_STYLES: Record<string, string> = {
    sql: 'bg-sql-bg text-sql-text',
    python: 'bg-python-bg text-python-text',
    markdown: 'bg-markdown-bg text-markdown-text',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-surface rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border-subtle">
          <FileText size={16} className="text-primary" />
          <div className="flex-1">
            <div className="text-[14px] font-semibold text-text-primary">리포트 생성</div>
            <div className="text-[11px] text-text-tertiary">분석 목표·모델·포함할 셀을 지정하세요</div>
          </div>
          <button onClick={() => setShowReportModal(false)} className="p-1 text-text-tertiary hover:text-text-secondary">
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="px-5 py-3 border-b border-border-subtle space-y-3">
          <div>
            <label className="block text-[11px] font-semibold text-text-secondary mb-1">
              분석 목표 <span className="text-text-disabled font-normal">(선택 — 비우면 노트북 제목/설명으로 추론)</span>
            </label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="예: 강남권 매장 쏠림 현상을 경영진에게 설명하기 위한 리포트"
              rows={2}
              className="w-full text-[12px] px-3 py-2 rounded-md outline-none border border-border-subtle focus:border-primary leading-relaxed resize-y bg-surface text-text-primary placeholder-text-tertiary"
              style={{ fontFamily: 'inherit' }}
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-text-secondary mb-1">모델</label>
            <div className="relative">
              <select
                value={reportModel}
                onChange={(e) => setReportModel(e.target.value)}
                className="w-full appearance-none text-[12px] font-medium text-text-primary bg-surface border border-border-subtle rounded-md pl-3 pr-8 py-2 cursor-pointer hover:border-primary outline-none"
              >
                {REPORT_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-text-disabled" />
            </div>
          </div>
        </div>

        {/* Cell list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] font-semibold text-text-secondary">
              포함할 셀 <span className="text-text-disabled font-normal">({selectedIds.length}개 선택)</span>
            </div>
            <button
              type="button"
              onClick={toggleAll}
              disabled={executableCells.length === 0}
              className={cn(
                'flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-md border transition-colors',
                executableCells.length === 0
                  ? 'text-text-disabled border-border-subtle cursor-not-allowed'
                  : 'text-text-secondary border-border hover:border-primary hover:text-primary'
              )}
            >
              <input
                type="checkbox"
                readOnly
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected }}
                className="accent-primary pointer-events-none"
              />
              {allSelected ? '모두 해제' : '모두 선택'}
            </button>
          </div>
          {cells.map((cell) => {
            const selectable = isSelectable(cell)
            return (
              <label
                key={cell.id}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                  !selectable && 'opacity-50 cursor-not-allowed',
                  selectedIds.includes(cell.id) ? 'border-primary-border bg-primary-light' : 'border-border hover:border-border-hover'
                )}
              >
                <input
                  type="checkbox"
                  disabled={!selectable}
                  checked={selectedIds.includes(cell.id)}
                  onChange={() => toggle(cell.id)}
                  className="accent-primary"
                />
                <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0', TYPE_STYLES[cell.type])}>
                  {cell.type === 'markdown' ? 'MD' : cell.type.toUpperCase()}
                </span>
                <span className="text-[13px] text-text-primary flex-1 truncate">{cell.name}</span>
                {!cell.executed && cell.type !== 'markdown' && (
                  <span className="text-[10px] text-warning shrink-0">⚠ 미실행</span>
                )}
              </label>
            )
          })}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border-subtle">
          <button
            onClick={() => setShowReportModal(false)}
            className="px-4 py-2 text-[13px] text-text-secondary bg-bg-sidebar hover:bg-border rounded-lg transition-colors"
          >
            취소
          </button>
          <button
            disabled={selectedIds.length === 0}
            onClick={() => generateReport({ cellIds: selectedIds, goal })}
            className={cn(
              'px-4 py-2 text-[13px] font-semibold rounded-lg transition-colors',
              selectedIds.length > 0
                ? 'bg-primary hover:bg-primary-hover text-white'
                : 'bg-bg-sidebar text-text-disabled cursor-not-allowed'
            )}
          >
            {selectedIds.length}개 셀로 생성
          </button>
        </div>
      </div>
    </div>
  )
}
