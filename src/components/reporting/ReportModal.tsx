import { useState, useEffect, useMemo } from 'react'
import { FileText, X, ChevronDown, MessageSquare } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import { useModelStore, REPORT_MODELS } from '@/store/modelStore'
import { cn } from '@/lib/utils'

export default function ReportModal() {
  const {
    showReportModal, cells, analysisDescription, setShowReportModal, generateReport,
    agentSessions, agentChatHistory, agentSessionTitle, currentSessionId, currentSessionCreatedAtMs,
  } = useAppStore(
    useShallow((s) => ({
      showReportModal: s.showReportModal,
      cells: s.cells,
      analysisDescription: s.analysisDescription,
      setShowReportModal: s.setShowReportModal,
      generateReport: s.generateReport,
      agentSessions: s.agentSessions,
      agentChatHistory: s.agentChatHistory,
      agentSessionTitle: s.agentSessionTitle,
      currentSessionId: s.currentSessionId,
      currentSessionCreatedAtMs: s.currentSessionCreatedAtMs,
    }))
  )
  const { reportModel, setReportModel } = useModelStore()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [goal, setGoal] = useState('')
  const [extraComment, setExtraComment] = useState('')
  const [selectedAgentSessionIds, setSelectedAgentSessionIds] = useState<string[]>([])

  // 현재 + 아카이브 세션을 같은 형태로 일원화 — 메시지 수가 0인 세션은 노출 안 함.
  type SessionRow = { id: string; title: string; startedAt: string; msgCount: number; isCurrent: boolean }
  const sessionRows: SessionRow[] = useMemo(() => {
    const rows: SessionRow[] = []
    const currentMsgCount = agentChatHistory.filter((m) => (m.kind ?? 'message') === 'message' && m.content?.trim()).length
    if (currentSessionId && currentMsgCount > 0) {
      rows.push({
        id: currentSessionId,
        title: agentSessionTitle || '현재 대화',
        startedAt: currentSessionCreatedAtMs ? new Date(currentSessionCreatedAtMs).toLocaleString('ko-KR') : '',
        msgCount: currentMsgCount,
        isCurrent: true,
      })
    }
    for (const s of agentSessions) {
      const count = s.messages.filter((m) => (m.kind ?? 'message') === 'message' && m.content?.trim()).length
      if (count === 0) continue
      rows.push({
        id: s.id,
        title: s.title || '제목 없음',
        startedAt: s.startedAt ? new Date(s.startedAt).toLocaleString('ko-KR') : '',
        msgCount: count,
        isCurrent: false,
      })
    }
    return rows
  }, [agentSessions, agentChatHistory, agentSessionTitle, currentSessionId, currentSessionCreatedAtMs])

  useEffect(() => {
    if (showReportModal) {
      setSelectedIds(cells.filter((c) => c.type === 'markdown' || c.executed).map((c) => c.id))
      setGoal(analysisDescription ?? '')
      setExtraComment('')
      // 기본값: 현재 진행 중 세션만 체크 (아카이브는 사용자가 명시적으로 추가).
      const current = sessionRows.find((r) => r.isCurrent)
      setSelectedAgentSessionIds(current ? [current.id] : [])
    }
  }, [showReportModal, cells, analysisDescription, sessionRows])

  if (!showReportModal) return null

  function toggle(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  function toggleAgentSession(id: string) {
    setSelectedAgentSessionIds((prev) =>
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
            <label className="block text-[11px] font-semibold text-text-secondary mb-1">
              추가 코멘트 <span className="text-text-disabled font-normal">(선택 — 강조 사항·톤·해석 가이드)</span>
            </label>
            <textarea
              value={extraComment}
              onChange={(e) => setExtraComment(e.target.value)}
              placeholder="예: TL;DR 은 3줄 이내, 매장 등급별 격차는 강조하지 말고 시계열 흐름에 집중"
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

          {/* 에이전트 대화 세션 — 셀과 함께 리포트 컨텍스트로 사용 */}
          {sessionRows.length > 0 && (
            <div className="mt-4 pt-3 border-t border-border-subtle">
              <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold text-text-secondary">
                <MessageSquare size={11} className="text-primary" />
                포함할 에이전트 대화
                <span className="text-text-disabled font-normal">({selectedAgentSessionIds.length}/{sessionRows.length})</span>
              </div>
              <div className="space-y-1.5">
                {sessionRows.map((row) => {
                  const checked = selectedAgentSessionIds.includes(row.id)
                  return (
                    <label
                      key={row.id}
                      className={cn(
                        'flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors',
                        checked ? 'border-primary-border bg-primary-light' : 'border-border hover:border-border-hover'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAgentSession(row.id)}
                        className="accent-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] text-text-primary truncate">{row.title}</span>
                          {row.isCurrent && (
                            <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-primary-pale text-primary-text border border-primary-border shrink-0">
                              현재
                            </span>
                          )}
                        </div>
                        {row.startedAt && (
                          <div className="text-[10px] text-text-tertiary">{row.startedAt}</div>
                        )}
                      </div>
                      <span className="text-[10px] text-text-tertiary shrink-0">{row.msgCount}개 메시지</span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
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
            onClick={() => generateReport({ cellIds: selectedIds, goal, agentSessionIds: selectedAgentSessionIds, extraComment })}
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
