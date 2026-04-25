import { useState, useRef, useCallback, useEffect } from 'react'
import { Layers, Compass, Telescope, Database, MessageSquare, RotateCcw, User, GripVertical, Search, X, Check, Copy, Trash2, ChevronDown, ChevronRight, SquarePen, Pencil } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/utils'

const MIN_SECTION_PCT = 10
const MIN_WIDTH = 180
const MAX_WIDTH = 520

type DragTarget = 'width' | 'h1' | 'h2' | null

type DataItem =
  | { kind: 'mart'; key: string; description: string }
  | { kind: 'cell'; id: string; name: string; type: 'sql' | 'python' }

export default function RightNav() {
  const {
    cells,
    activeCellId,
    selectedMarts,
    martCatalog,
    agentMode,
    agentChatHistory,
    agentSessions,
    agentSessionTitle,
    currentSessionCreatedAtMs,
    currentSessionId,
    collapsedSessionIds,
    toggleSessionCollapsed,
    newAgentSession,
    resumeAgentSession,
    deleteAgentSession,
    setActiveCellId,
    rollbackCell,
    deleteChatEntry,
    toggleCellHistory,
    toggleAllCellHistory,
    toggleAllSessionsCollapsed,
    reorderCells,
    updateCellChatInput,
    setCellEditOrigin,
    deleteCell,
    cellActiveEntryId,
  } = useAppStore(useShallow((s) => ({
    cells: s.cells,
    activeCellId: s.activeCellId,
    selectedMarts: s.selectedMarts,
    martCatalog: s.martCatalog,
    agentMode: s.agentMode,
    agentChatHistory: s.agentChatHistory,
    agentSessions: s.agentSessions,
    agentSessionTitle: s.agentSessionTitle,
    currentSessionCreatedAtMs: s.currentSessionCreatedAtMs,
    currentSessionId: s.currentSessionId,
    collapsedSessionIds: s.collapsedSessionIds,
    toggleSessionCollapsed: s.toggleSessionCollapsed,
    newAgentSession: s.newAgentSession,
    resumeAgentSession: s.resumeAgentSession,
    deleteAgentSession: s.deleteAgentSession,
    setActiveCellId: s.setActiveCellId,
    rollbackCell: s.rollbackCell,
    deleteChatEntry: s.deleteChatEntry,
    toggleCellHistory: s.toggleCellHistory,
    toggleAllCellHistory: s.toggleAllCellHistory,
    toggleAllSessionsCollapsed: s.toggleAllSessionsCollapsed,
    reorderCells: s.reorderCells,
    updateCellChatInput: s.updateCellChatInput,
    setCellEditOrigin: s.setCellEditOrigin,
    deleteCell: s.deleteCell,
    cellActiveEntryId: s.cellActiveEntryId,
  })))


  type SessionMenu = { kind: 'session'; id: string; x: number; y: number }
  type CellMenu = { kind: 'cell'; id: string; x: number; y: number }
  const [contextMenu, setContextMenu] = useState<SessionMenu | CellMenu | null>(null)
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [contextMenu])

  const selectedMartObjects = martCatalog.filter((m) => selectedMarts.includes(m.key))
  const executedCount = cells.filter((c) => c.executed).length

  const [dataSearch, setDataSearch] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const dataItems: DataItem[] = [
    ...selectedMartObjects.map((m) => ({ kind: 'mart' as const, key: m.key, description: m.description })),
    ...cells
      .filter((c) => c.executed && (c.type === 'sql' || (c.type === 'python' && (c.output as { type?: string } | null)?.type === 'table')))
      .map((c) => ({ kind: 'cell' as const, id: c.id, name: c.name, type: c.type as 'sql' | 'python' })),
  ]

  const filteredData = dataSearch
    ? dataItems.filter((item) =>
        item.kind === 'mart'
          ? item.key.toLowerCase().includes(dataSearch.toLowerCase())
          : item.name.toLowerCase().includes(dataSearch.toLowerCase())
      )
    : dataItems

  function copyItem(text: string, id: string) {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  // Cell nav drag state (HTML5 DnD — separate from section resize)
  const [navDragId, setNavDragId] = useState<string | null>(null)
  const [navDrop, setNavDrop] = useState<{ id: string; before: boolean } | null>(null)
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null)

  function handleNavDragOver(e: React.DragEvent, cellId: string) {
    if (!navDragId || navDragId === cellId) return
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setNavDrop({ id: cellId, before: e.clientY < rect.top + rect.height / 2 })
  }

  function handleNavDrop(e: React.DragEvent, cellId: string) {
    e.preventDefault()
    e.stopPropagation()
    if (navDragId && navDragId !== cellId && navDrop) {
      reorderCells(navDragId, cellId, navDrop.before)
    }
    setNavDragId(null)
    setNavDrop(null)
  }

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return Number(localStorage.getItem('vibe_rnav_width')) || 256 } catch { return 256 }
  })
  // CSS 변수는 매 변경마다 즉시 반영(시각 동기화), localStorage 쓰기는 디바운스.
  // 드래그 중 한 프레임마다 setState 가 호출되며, sync localStorage write 가 누적되면
  // 메인 스레드를 점유해 드래그가 끊겨 보임. 300ms 디바운스로 안정 시점에만 영속.
  useEffect(() => {
    document.documentElement.style.setProperty('--right-nav-width', `${sidebarWidth}px`)
    const t = window.setTimeout(() => {
      try { localStorage.setItem('vibe_rnav_width', String(sidebarWidth)) } catch {}
    }, 300)
    return () => {
      window.clearTimeout(t)
      document.documentElement.style.setProperty('--right-nav-width', '256px')
    }
  }, [sidebarWidth])
  // heights[0]=data%, heights[1]=nav%, heights[2]=agent%
  const [sections, setSections] = useState<number[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('vibe_rnav_sections') || 'null')
      if (Array.isArray(saved) && saved.length === 3) return saved
    } catch {}
    return [20, 42, 38]
  })
  useEffect(() => {
    const t = window.setTimeout(() => {
      try { localStorage.setItem('vibe_rnav_sections', JSON.stringify(sections)) } catch {}
    }, 300)
    return () => window.clearTimeout(t)
  }, [sections])

  const asideRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<DragTarget>(null)

  const startDrag = useCallback((target: DragTarget) => (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = target
  }, [])

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const target = dragging.current
      if (!target) return

      if (target === 'width') {
        const aside = asideRef.current as HTMLElement | null
        if (!aside) return
        const right = aside.getBoundingClientRect().right
        setSidebarWidth(Math.min(Math.max(right - e.clientX, MIN_WIDTH), MAX_WIDTH))
        return
      }

      const body = bodyRef.current
      if (!body) return
      const rect = body.getBoundingClientRect()
      const pct = ((e.clientY - rect.top) / rect.height) * 100

      setSections((prev) => {
        const next = [...prev]
        if (target === 'h1') {
          // between data(0) and nav(1)
          const maxData = 100 - next[2] - MIN_SECTION_PCT
          const newData = Math.min(Math.max(pct, MIN_SECTION_PCT), maxData)
          next[1] = next[1] + (next[0] - newData)
          next[0] = newData
        } else {
          // between nav(1) and agent(2)
          const newNav = Math.min(
            Math.max(pct - next[0], MIN_SECTION_PCT),
            100 - next[0] - MIN_SECTION_PCT
          )
          next[2] = next[2] + (next[1] - newNav)
          next[1] = newNav
        }
        return next
      })
    }

    function onMouseUp() { dragging.current = null }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const navPct = sections[1]
  const agentPct = sections[2]

  return (
    <aside
      ref={asideRef}
      className="h-full flex flex-col bg-bg-pane shrink-0 overflow-hidden relative z-[110]"
      style={{ width: sidebarWidth, paddingLeft: '16px' }}
    >
      {/* Width drag handle — left edge */}
      <div
        onMouseDown={startDrag('width')}
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 group"
        title="드래그하여 폭 조절"
      >
        <div className="absolute inset-y-0 left-0 w-px bg-border-subtle group-hover:bg-primary/40 group-hover:w-[3px] transition-all" />
      </div>

      {/* Body */}
      <div ref={bodyRef} className="flex flex-col flex-1 overflow-hidden min-h-0">

        {/* Data section */}
        <div
          className="flex flex-col overflow-hidden min-h-0"
          style={{ height: `${sections[0]}%` }}
        >
          {/* Header */}
          <div className="pr-3 pt-2 pb-1 shrink-0 flex items-center gap-1.5">
            <Layers size={12} className="text-text-tertiary shrink-0" />
            <span className="text-[11px] text-text-tertiary font-semibold shrink-0">데이터</span>
            {dataItems.length > 0 && (
              <span className="bg-primary-light text-primary-text px-1 py-0.5 rounded text-[9px] shrink-0">
                {dataItems.length}
              </span>
            )}
            {/* Search — inline */}
            <div className="relative flex-1 min-w-0">
              <Search size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
              <input
                className="w-full pl-5 pr-5 py-0.5 text-[10px] bg-surface border border-border rounded focus:outline-none focus:border-primary"
                placeholder="검색..."
                value={dataSearch}
                onChange={(e) => setDataSearch(e.target.value)}
              />
              {dataSearch && (
                <button onClick={() => setDataSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                  <X size={9} />
                </button>
              )}
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto hide-scrollbar pr-3 pb-2 min-h-0">
            {filteredData.length === 0 ? (
              <div className="text-[10px] text-text-disabled text-center py-4 leading-relaxed">
                {dataSearch ? '검색 결과 없음' : '마트를 선택하거나\n셀을 실행하면 표시됩니다'}
              </div>
            ) : (
              <div className="space-y-0.5">
                {filteredData.map((item) => {
                  const id = item.kind === 'mart' ? `mart-${item.key}` : `cell-${item.id}`
                  const name = item.kind === 'mart' ? item.key : item.name
                  const isCopied = copiedId === id
                  return (
                    <button
                      key={id}
                      title={`클릭하여 이름 복사: ${name}`}
                      onClick={() => copyItem(name, id)}
                      className={cn(
                        'group w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left border transition-all hover:border-primary/30 hover:bg-primary-light/30',
                        isCopied ? 'border-primary bg-primary-light' : 'border-border bg-surface'
                      )}
                    >
                      {/* Type badge */}
                      {item.kind === 'mart' ? (
                        <Database size={10} className="shrink-0 text-primary" />
                      ) : item.type === 'sql' ? (
                        <span className="text-[8px] font-bold px-1 py-0.5 rounded shrink-0 bg-sql-bg text-sql-text">SQL</span>
                      ) : (
                        <span className="text-[8px] font-bold px-1 py-0.5 rounded shrink-0 bg-python-bg text-python-text">PY</span>
                      )}
                      {/* Name */}
                      <span className={cn(
                        'flex-1 min-w-0 text-[10px] font-mono font-semibold truncate',
                        isCopied ? 'text-primary' : 'text-text-primary'
                      )}>
                        {name}
                      </span>
                      {/* Copy indicator */}
                      <span className="shrink-0 ml-auto">
                        {isCopied
                          ? <Check size={10} className="text-primary" />
                          : <Copy size={9} className="text-text-disabled opacity-0 group-hover:opacity-100 transition-opacity" />
                        }
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Handle: data ↔ nav */}
        <DragHandle onMouseDown={startDrag('h1')} />

        {/* Cell navigation section */}
        <div
          className="flex flex-col overflow-hidden min-h-0"
          style={{ height: `${navPct}%` }}
        >
          <div className="overflow-y-auto hide-scrollbar pr-3 pt-4 pb-3 flex-1 min-h-0">
            <div className="mb-2">
              {(() => {
                const withHistory = cells.filter((c) => c.chatHistory.length > 0)
                const hasHistory = withHistory.length > 0
                const anyOpen = withHistory.some((c) => c.historyOpen)
                return (
                  <button
                    type="button"
                    onClick={toggleAllCellHistory}
                    disabled={!hasHistory}
                    title={hasHistory ? (anyOpen ? '모든 대화 이력 접기' : '모든 대화 이력 펼치기') : '대화 이력 없음'}
                    className={cn(
                      'flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide leading-tight transition-colors -mx-1 px-1 py-0.5 rounded',
                      hasHistory
                        ? 'text-text-tertiary hover:text-primary hover:bg-chip cursor-pointer'
                        : 'text-text-tertiary cursor-default'
                    )}
                  >
                    <Compass size={12} strokeWidth={2} />
                    셀 네비게이션
                    {hasHistory && (
                      anyOpen
                        ? <ChevronDown size={10} className="ml-0.5 opacity-70" />
                        : <ChevronRight size={10} className="ml-0.5 opacity-70" />
                    )}
                  </button>
                )
              })()}
              <div className="text-[10px] text-text-disabled mt-0.5 leading-tight">
                {cells.length}개 셀 / {executedCount}개 실행됨
              </div>
            </div>
            <div className="space-y-0.5">
              {cells.map((cell, idx) => (
                <div
                  key={cell.id}
                  className="relative"
                  draggable
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setNavDragId(cell.id) }}
                  onDragEnd={() => { setNavDragId(null); setNavDrop(null) }}
                  onDragOver={(e) => handleNavDragOver(e, cell.id)}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setNavDrop(null) }}
                  onDrop={(e) => handleNavDrop(e, cell.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setContextMenu({ kind: 'cell', id: cell.id, x: e.clientX, y: e.clientY })
                  }}
                >
                  {navDrop?.id === cell.id && navDrop.before && (
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary z-10 pointer-events-none rounded" />
                  )}
                  <div
                    className={cn(
                      'group/cell flex items-center gap-1 w-full text-left px-2 py-1.5 rounded transition-colors border',
                      navDragId === cell.id ? 'opacity-40' :
                      activeCellId === cell.id
                        ? 'border-primary-border bg-primary-light'
                        : 'border-border bg-surface hover:border-primary/30 hover:bg-primary-light/20'
                    )}
                    onClick={() => {
                      if (activeCellId === cell.id && cell.chatHistory.length > 0) {
                        toggleCellHistory(cell.id)
                      } else {
                        setActiveCellId(cell.id)
                        document.getElementById(cell.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                    }}
                  >
                    <GripVertical
                      size={12}
                      className="shrink-0 text-text-disabled opacity-0 group-hover/cell:opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
                    />
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <span className="text-[10px] text-text-disabled font-mono shrink-0">[{idx + 1}]</span>
                      <span
                        className={cn(
                          'text-[9px] font-bold px-1 py-0.5 rounded uppercase tracking-wide shrink-0',
                          cell.type === 'sql' ? 'bg-sql-bg text-sql-text' :
                          cell.type === 'python' ? 'bg-python-bg text-python-text' :
                          cell.type === 'sheet' ? '' :
                          'bg-markdown-bg text-markdown-text'
                        )}
                        style={cell.type === 'sheet' ? {
                          backgroundColor: 'rgb(var(--color-sheet-bg))',
                          color: 'rgb(var(--color-sheet-text))',
                        } : undefined}
                      >
                        {cell.type === 'markdown' ? 'MD' : cell.type === 'python' ? 'PY' : cell.type === 'sheet' ? 'SHEET' : cell.type.toUpperCase()}
                      </span>
                      <span className="text-[12px] font-mono font-semibold text-text-primary truncate flex-1">{cell.name}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {cell.agentGenerated && <Telescope size={10} className="text-primary" />}
                        {cell.executed && <div className="w-1.5 h-1.5 rounded-full bg-success" />}
                        {cell.chatHistory.length > 0 && (
                          <button
                            title="대화 이력 토글"
                            onClick={(e) => { e.stopPropagation(); toggleCellHistory(cell.id) }}
                            className={cn(
                              'flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium transition-colors hover:bg-primary-light',
                              cell.historyOpen ? 'text-primary' : 'text-text-disabled'
                            )}
                          >
                            <MessageSquare size={9} />
                            {cell.chatHistory.length}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {cell.chatHistory.length > 0 && cell.historyOpen && (() => {
                    // "현재" 배지: 활성 셀일 때만 표시.
                    // 명시적 activeEntryId가 있으면 그 항목, 없으면 마지막 항목.
                    // 비활성 셀에서는 어떤 항목도 강조하지 않는다.
                    const isActiveCell = cell.id === activeCellId
                    const activeId = cellActiveEntryId[cell.id] ?? null
                    const activeIdx = isActiveCell
                      ? (activeId !== null
                          ? cell.chatHistory.findIndex((e) => e.id === activeId)
                          : cell.chatHistory.length - 1)
                      : -1
                    return (
                    <div className="ml-3 pl-2 border-l-2 border-border-subtle mt-1 space-y-1.5 pb-2">
                          {cell.chatHistory.map((entry, hIdx) => {
                            const isCurrent = hIdx === activeIdx
                            return (
                              <div
                                key={entry.id}
                                className={cn(
                                  'group relative rounded-md border cursor-pointer transition-all',
                                  isCurrent ? 'bg-primary-light border-primary-border' : 'border-transparent hover:bg-chip'
                                )}
                                onClick={() => setExpandedEntry(expandedEntry === `${cell.id}-${entry.id}` ? null : `${cell.id}-${entry.id}`)}
                              >
                                <div className="flex items-center gap-1.5 px-2 py-1">
                                  <span className="text-[9px] font-mono text-text-disabled shrink-0">#{hIdx + 1}</span>
                                  {entry.agentCreated && (
                                    <span
                                      title="에이전트가 만든 셀"
                                      className="shrink-0 flex items-center justify-center w-4 h-4 rounded bg-primary/10 text-primary border border-primary/20"
                                    >
                                      <Telescope size={9} strokeWidth={2} />
                                    </span>
                                  )}
                                  <div className={cn('text-[10px] text-text-primary font-medium flex-1', expandedEntry === `${cell.id}-${entry.id}` ? 'whitespace-normal break-words' : 'truncate')}>{entry.user}</div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {!entry.agentCreated && (
                                      <button
                                        className="p-1 rounded text-text-disabled opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-secondary hover:bg-chip"
                                        title="이 메시지를 채팅 입력창에 불러오기"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setActiveCellId(cell.id)
                                          setCellEditOrigin(cell.id, hIdx)
                                          updateCellChatInput(cell.id, entry.user)
                                          setTimeout(() => {
                                            document.getElementById(cell.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                          }, 50)
                                        }}
                                      >
                                        <Pencil size={10} />
                                      </button>
                                    )}
                                    {isCurrent ? (
                                      <span className="text-[8px] font-semibold px-1 py-0.5 rounded border text-primary border-primary-border bg-surface">현재</span>
                                    ) : (
                                      <button
                                        className="p-1 rounded text-text-disabled opacity-0 group-hover:opacity-100 transition-opacity hover:text-primary hover:bg-primary-light/40"
                                        title="이 시점 코드로 되돌리기"
                                        onClick={(e) => { e.stopPropagation(); rollbackCell(cell.id, entry.id) }}
                                      >
                                        <RotateCcw size={10} />
                                      </button>
                                    )}
                                    <button
                                      className="text-text-disabled opacity-0 group-hover:opacity-100 transition-opacity hover:text-danger"
                                      title="이력 삭제"
                                      onClick={(e) => { e.stopPropagation(); deleteChatEntry(cell.id, hIdx) }}
                                    >
                                      <Trash2 size={9} />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                    </div>
                    )
                  })()}
                  {navDrop?.id === cell.id && !navDrop.before && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary z-10 pointer-events-none rounded" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Handle: nav ↔ agent */}
        <DragHandle onMouseDown={startDrag('h2')} />

        {/* Agent history section */}
        <div
          className="flex flex-col overflow-hidden min-h-0"
          style={{ height: `${agentPct}%` }}
        >
          <div className="pr-3 pt-3 pb-2 shrink-0 flex items-center gap-1.5">
            <div className={cn('w-4 h-4 rounded-full flex items-center justify-center', agentMode ? 'bg-primary' : 'bg-border')}>
              <Telescope size={10} className="text-white" strokeWidth={2} />
            </div>
            {(() => {
              const sessionIds = [
                ...agentSessions.map((s) => s.id),
                ...(agentChatHistory.length > 0 && currentSessionId ? [currentSessionId] : []),
              ]
              const hasAny = sessionIds.length > 0
              const anyExpanded = sessionIds.some((id) => !collapsedSessionIds[id])
              return (
                <button
                  type="button"
                  onClick={() => toggleAllSessionsCollapsed(sessionIds)}
                  disabled={!hasAny}
                  title={hasAny ? (anyExpanded ? '모든 세션 접기' : '모든 세션 펼치기') : '세션 없음'}
                  className={cn(
                    'flex items-center gap-1.5 -mx-1 px-1 py-0.5 rounded transition-colors',
                    hasAny
                      ? 'text-text-tertiary hover:text-primary hover:bg-chip cursor-pointer'
                      : 'text-text-tertiary cursor-default'
                  )}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wide leading-tight">에이전트 이력</span>
                  {hasAny && (
                    anyExpanded
                      ? <ChevronDown size={10} className="opacity-70" />
                      : <ChevronRight size={10} className="opacity-70" />
                  )}
                </button>
              )
            })()}
            {(agentSessions.length + (agentChatHistory.length ? 1 : 0)) > 0 && (
              <span className="text-[9px] text-text-disabled">{agentSessions.length + (agentChatHistory.length ? 1 : 0)}개 대화</span>
            )}
            <button
              title={agentChatHistory.length > 0 ? '현재 대화를 세션으로 저장하고 새 대화 시작' : '대화가 없습니다'}
              onClick={newAgentSession}
              disabled={agentChatHistory.length === 0}
              className={cn(
                'ml-auto p-0.5 rounded transition-colors',
                agentChatHistory.length > 0
                  ? 'text-text-tertiary hover:text-primary hover:bg-chip'
                  : 'text-text-disabled cursor-not-allowed'
              )}
            >
              <SquarePen size={11} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto hide-scrollbar pr-3 pb-3 min-h-0">
            {agentSessions.length === 0 && agentChatHistory.length === 0 ? (
              <div className="text-[10px] text-text-disabled text-center px-3 py-6 leading-relaxed">
                에이전트 모드를 켜고<br />대화를 시작해보세요
              </div>
            ) : (
              <div className="space-y-2">
                {/* 아카이브 세션 + 현재 대화를 하나의 리스트로 merge.
                    - 모든 항목이 안정적 ID 를 갖는다 (현재 = currentSessionId, 아카이브 = session.id).
                    - 접힘 상태는 store 의 collapsedSessionIds[id] 로 ID 기준 추적 → resume/archive 사이클 거쳐도 일관.
                    - createdAtMs 오름차순으로 고정 정렬 → 바 순서가 상호작용으로 움직이지 않음. */}
                {(() => {
                  type Row = {
                    id: string
                    at: number
                    title: string
                    startedAt: string
                    turns: number
                    messages: typeof agentChatHistory
                    isCurrent: boolean
                  }
                  const rows: Row[] = agentSessions.map((s) => ({
                    id: s.id,
                    at: s.createdAtMs ?? 0,
                    title: s.title || '대화',
                    startedAt: s.startedAt,
                    turns: s.messages.filter((m) => m.role === 'user').length,
                    messages: s.messages,
                    isCurrent: false,
                  }))
                  if (agentChatHistory.length > 0 && currentSessionId) {
                    rows.push({
                      id: currentSessionId,
                      at: currentSessionCreatedAtMs ?? Number.MAX_SAFE_INTEGER,
                      title: agentSessionTitle ?? '현재 대화',
                      startedAt: agentChatHistory[0]?.timestamp ?? '',
                      turns: agentChatHistory.filter((m) => m.role === 'user').length,
                      messages: agentChatHistory,
                      isCurrent: true,
                    })
                  }
                  rows.sort((a, b) => a.at - b.at)

                  return rows.map((row) => {
                    // 기본값 접힘. store 에 `true` 가 기록된 세션만 펼침.
                    const collapsed = !collapsedSessionIds[row.id]
                    const titleColor = row.isCurrent ? 'text-primary' : 'text-text-secondary'
                    return (
                      <div
                        key={row.id}
                        className={cn(
                          'group/session rounded-md border overflow-hidden',
                          row.isCurrent ? 'border-primary-border' : 'border-border'
                        )}
                        onContextMenu={row.isCurrent ? undefined : (e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setContextMenu({ kind: 'session', id: row.id, x: e.clientX, y: e.clientY })
                        }}
                      >
                        <div
                          className={cn(
                            'w-full flex items-center gap-1.5 px-2 py-1.5',
                            row.isCurrent ? 'bg-primary-light' : 'bg-bg-sidebar'
                          )}
                        >
                          <button
                            title={collapsed ? '펼치기' : '접기'}
                            onClick={() => toggleSessionCollapsed(row.id)}
                            className={cn(
                              'shrink-0 p-0.5 -ml-0.5 rounded hover:bg-chip-hover',
                              row.isCurrent ? 'text-primary' : 'text-text-disabled',
                            )}
                          >
                            {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                          </button>
                          {row.isCurrent && (
                            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
                          )}
                          <span
                            className={cn('text-[10px] font-semibold flex-1 truncate cursor-default', titleColor)}
                            onDoubleClick={row.isCurrent ? undefined : () => resumeAgentSession(row.id)}
                            title={row.isCurrent
                              ? row.title
                              : `더블클릭: 이 대화 이어가기 · 우클릭: 메뉴 · "${row.title}"`}
                          >
                            {row.title}
                          </span>
                          <span className="text-[9px] text-text-disabled shrink-0">
                            {row.startedAt ? `${row.startedAt} · ` : ''}{row.turns}턴
                          </span>
                          {!row.isCurrent && (
                            <button
                              title="이력 삭제"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (confirm('이 에이전트 이력을 삭제할까요?')) {
                                  deleteAgentSession(row.id)
                                }
                              }}
                              className="shrink-0 p-0.5 rounded text-text-disabled hover:bg-danger-bg hover:text-danger opacity-0 group-hover/session:opacity-100 transition-opacity"
                            >
                              <Trash2 size={10} strokeWidth={2.5} />
                            </button>
                          )}
                        </div>
                        {!collapsed && (
                          <div className="space-y-1 p-1.5 pt-1">
                            <AgentTurnList messages={row.messages} scope={row.id} />
                          </div>
                        )}
                      </div>
                    )
                  })
                })()}
              </div>
            )}
          </div>
        </div>
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 min-w-[180px] bg-surface border border-border rounded-md shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.kind === 'session' && (
            <>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] text-text-primary hover:bg-primary-light hover:text-primary transition-colors"
                onClick={() => {
                  resumeAgentSession(contextMenu.id)
                  setContextMenu(null)
                }}
              >
                <Telescope size={11} strokeWidth={2} />
                에이전트 모드에서 보기
              </button>
              <div className="h-px my-1 bg-border-subtle" />
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] text-danger hover:bg-danger-bg transition-colors"
                onClick={() => {
                  if (confirm('이 에이전트 이력을 삭제할까요?')) {
                    deleteAgentSession(contextMenu.id)
                  }
                  setContextMenu(null)
                }}
              >
                <Trash2 size={11} strokeWidth={2.5} />
                이력 삭제
              </button>
            </>
          )}
          {contextMenu.kind === 'cell' && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] text-danger hover:bg-danger-bg transition-colors"
              onClick={() => {
                if (confirm('이 셀을 삭제할까요?')) {
                  deleteCell(contextMenu.id)
                }
                setContextMenu(null)
              }}
            >
              <Trash2 size={11} strokeWidth={2.5} />
              셀 삭제
            </button>
          )}
        </div>
      )}
    </aside>
  )
}

import type { AgentMessage } from '@/types'

function AgentMsgCard({ msg }: { msg: AgentMessage }) {
  if (msg.kind === 'step') {
    return (
      <div className="px-1.5 py-1 rounded text-[9px] flex items-center gap-1 border bg-bg-output border-border-subtle text-text-secondary">
        <span className={cn('w-1 h-1 rounded-full shrink-0', msg.stepType === 'error' ? 'bg-danger' : 'bg-text-tertiary')} />
        <span className="truncate flex-1">{msg.stepLabel ?? '작업'}</span>
        <span className="text-[8px] text-text-disabled shrink-0">{msg.timestamp}</span>
      </div>
    )
  }
  return (
    <div
      className={cn(
        'rounded p-1.5 border',
        msg.role === 'user' ? 'border-border' : 'border-border-subtle'
      )}
      style={{
        backgroundColor: msg.role === 'user'
          ? 'rgb(var(--color-surface))'
          : 'rgb(var(--color-bg-sidebar))',
      }}
    >
      <div className="flex items-center gap-1 mb-0.5">
        <div
          className={cn(
            'w-3 h-3 rounded-full flex items-center justify-center shrink-0',
            msg.role === 'user' ? 'bg-gradient-to-br from-primary-border to-primary' : 'bg-primary'
          )}
        >
          {msg.role === 'user'
            ? <User size={6} className="text-white" strokeWidth={2.5} />
            : <Telescope size={6} className="text-white" strokeWidth={2} />}
        </div>
        <span className="text-[9px] font-semibold text-text-secondary">
          {msg.role === 'user' ? '나' : '에이전트'}
        </span>
        <span className="text-[8px] text-text-disabled ml-auto">{msg.timestamp}</span>
      </div>
      <div className="text-[10px] text-text-secondary leading-snug line-clamp-2">{msg.content}</div>
      {msg.createdCellIds && msg.createdCellIds.length > 0 && (
        <button
          className="mt-1 text-[9px] font-semibold flex items-center gap-0.5 text-primary hover:underline"
          onClick={() => document.getElementById(msg.createdCellIds![0])?.scrollIntoView({ behavior: 'smooth' })}
        >
          셀 {msg.createdCellIds.length}개 생성 · 보기
        </button>
      )}
    </div>
  )
}

function AgentTurnList({ messages, scope }: { messages: AgentMessage[]; scope: string }) {
  const visible = messages.filter((m) => m.kind !== 'step' && m.content)
  type Turn = { id: string; user: AgentMessage | null; replies: AgentMessage[] }
  const turns: Turn[] = []
  for (const m of visible) {
    if (m.role === 'user') {
      turns.push({ id: m.id, user: m, replies: [] })
    } else {
      if (turns.length === 0) {
        turns.push({ id: m.id, user: null, replies: [m] })
      } else {
        turns[turns.length - 1].replies.push(m)
      }
    }
  }

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  return (
    <div className="space-y-1.5">
      {turns.map((turn) => {
        const key = `${scope}-${turn.id}`
        const isCollapsed = collapsed.has(key)
        const hasReplies = turn.replies.length > 0
        return (
          <div key={turn.id} className="space-y-1">
            {turn.user && (
              <button
                type="button"
                onClick={() => hasReplies && toggle(key)}
                className={cn(
                  'w-full rounded p-1.5 border text-left transition-colors border-border',
                  hasReplies ? 'cursor-pointer' : 'cursor-default'
                )}
                style={{ backgroundColor: 'rgb(var(--color-surface))' }}
              >
                <div className="flex items-center gap-1 mb-0.5">
                  <div className="w-3 h-3 rounded-full flex items-center justify-center shrink-0 bg-gradient-to-br from-primary-border to-primary">
                    <User size={6} className="text-white" strokeWidth={2.5} />
                  </div>
                  <span className="text-[9px] font-semibold text-text-secondary">나</span>
                  {hasReplies && (
                    isCollapsed
                      ? <ChevronRight size={9} className="text-text-disabled" />
                      : <ChevronDown size={9} className="text-text-disabled" />
                  )}
                  <span className="text-[8px] text-text-disabled ml-auto">{turn.user.timestamp}</span>
                </div>
                <div className={cn('text-[10px] text-text-secondary leading-snug', isCollapsed ? 'line-clamp-1' : 'line-clamp-2')}>
                  {turn.user.content}
                </div>
              </button>
            )}
            {!isCollapsed && turn.replies.map((r) => <AgentMsgCard key={r.id} msg={r} />)}
          </div>
        )
      })}
      {turns.length === 0 && (
        <div className="text-[9px] text-text-disabled text-center py-2">대화 내용 없음</div>
      )}
    </div>
  )
}

function DragHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="group shrink-0 flex items-center justify-center h-3 cursor-row-resize select-none border-t border-border-subtle hover:border-primary/40 transition-colors"
      title="드래그하여 크기 조절"
    >
      <div className="w-8 h-1 rounded-full bg-border group-hover:bg-primary/40 transition-colors" />
    </div>
  )
}
