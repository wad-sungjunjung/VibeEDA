import { useRef, useEffect, useState, useCallback } from 'react'
import { Play, Trash2, Code, BarChart3, Telescope, ArrowUp, FileText, Square, Columns2, Rows2, Loader2, ChevronDown } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useModelStore, VIBE_MODELS } from '@/store/modelStore'
import type { Cell, CellPanelTab } from '@/types'
import { cn, loadCellUi, saveCellUi, sanitizeCellNameInput, toSnakeCase } from '@/lib/utils'
import CellOutput from './CellOutput'
import CodeEditor from './CodeEditor'

interface Props {
  cell: Cell
}

const TYPE_CYCLE_ORDER = ['sql', 'python', 'markdown'] as const
const TYPE_STYLES: Record<string, string> = {
  sql: 'bg-[#e8e4d8] text-[#5c4a1e]',
  python: 'bg-[#e6ede0] text-[#3d5226]',
  markdown: 'bg-[#eae4df] text-[#4a3c2e]',
}

export default function CellContainer({ cell }: Props) {
  const {
    activeCellId,
    setActiveCellId,
    deleteCell,
    updateCellCode,
    updateCellName,
    setCellTab,
    setSplitTab,
    toggleCellSplitMode,
    setCellSplitDir,
    updateCellMemo,
    cycleCellTypeById,
    executeCell,
    executingCells,
    vibingCells,
    updateCellChatInput,
    submitVibe,
    cells,
    notebookAreaHeight,
  } = useAppStore()

  const { vibeModel, setVibeModel } = useModelStore()

  const isExecuting = executingCells.has(cell.id)
  const isVibing = vibingCells.has(cell.id)
  const isActive = activeCellId === cell.id
  const cellIndex = cells.findIndex((c) => c.id === cell.id) + 1

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const leftColRef = useRef<HTMLDivElement>(null)
  const [leftColHeight, setLeftColHeight] = useState<number | null>(null)

  useEffect(() => {
    const el = leftColRef.current
    if (!el) { setLeftColHeight(null); return }
    const ro = new ResizeObserver(() => setLeftColHeight(el.clientHeight))
    ro.observe(el)
    setLeftColHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [cell.splitMode, cell.splitDir, cell.leftTab, cell.rightTab])
  const [splitRatio, setSplitRatio] = useState(() => loadCellUi(cell.id).splitRatio ?? 50)
  const [vSplitRatio, setVSplitRatio] = useState(() => loadCellUi(cell.id).vSplitRatio ?? 50)

  useEffect(() => { saveCellUi(cell.id, { splitRatio }) }, [cell.id, splitRatio])
  useEffect(() => { saveCellUi(cell.id, { vSplitRatio }) }, [cell.id, vSplitRatio])
  useEffect(() => { saveCellUi(cell.id, { splitMode: cell.splitMode, splitDir: cell.splitDir }) }, [cell.id, cell.splitMode, cell.splitDir])
  const [elapsedSecs, setElapsedSecs] = useState(0)
  const [vibeElapsed, setVibeElapsed] = useState(0) // 0.1s 단위

  useEffect(() => {
    if (!isExecuting) { setElapsedSecs(0); return }
    setElapsedSecs(0)
    const interval = setInterval(() => setElapsedSecs((s) => s + 1), 1000)
    return () => clearInterval(interval)
  }, [isExecuting])

  useEffect(() => {
    if (!isVibing) { setVibeElapsed(0); return }
    setVibeElapsed(0)
    const interval = setInterval(() => setVibeElapsed((s) => s + 1), 100)
    return () => clearInterval(interval)
  }, [isVibing])

  const [execElapsed, setExecElapsed] = useState(0)
  useEffect(() => {
    if (!isExecuting) { setExecElapsed(0); return }
    setExecElapsed(0)
    const interval = setInterval(() => setExecElapsed((s) => s + 1), 100)
    return () => clearInterval(interval)
  }, [isExecuting])

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const container = splitContainerRef.current
    if (!container) return
    const startRect = container.getBoundingClientRect()

    const onMouseMove = (ev: MouseEvent) => {
      const ratio = ((ev.clientX - startRect.left) / startRect.width) * 100
      setSplitRatio(Math.min(Math.max(ratio, 20), 80))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const handleVDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const container = splitContainerRef.current
    if (!container) return
    const startRect = container.getBoundingClientRect()

    const onMouseMove = (ev: MouseEvent) => {
      const ratio = ((ev.clientY - startRect.top) / startRect.height) * 100
      setVSplitRatio(Math.min(Math.max(ratio, 20), 80))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const el = inputRef.current
    if (!el || !isActive) return
    el.style.height = '44px'
    el.style.height = el.scrollHeight + 'px'
    if (cell.chatInput) el.focus()
  }, [cell.chatInput, isActive])

  const badgeLabel = cell.type === 'markdown' ? 'MD' : cell.type === 'python' ? 'PY' : cell.type.toUpperCase()
  const cycleIndex = TYPE_CYCLE_ORDER.indexOf(cell.type as typeof TYPE_CYCLE_ORDER[number])
  const nextType = TYPE_CYCLE_ORDER[(cycleIndex + 1) % TYPE_CYCLE_ORDER.length]

  const renderTabBar = (activeTab: CellPanelTab, onTab: (t: CellPanelTab) => void) => (
    <div className="flex items-center border-b border-border-subtle mb-1.5">
      {(['input', 'output', 'memo'] as CellPanelTab[]).map((t) => (
        <button
          key={t}
          onClick={(e) => { e.stopPropagation(); onTab(t) }}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold border-b-2 -mb-px transition-colors"
          style={{
            borderColor: activeTab === t ? '#D95C3F' : 'transparent',
            color: activeTab === t ? '#D95C3F' : '#a8a29e',
          }}
        >
          {t === 'input' && <Code size={11} />}
          {t === 'output' && <BarChart3 size={11} />}
          {t === 'memo' && <FileText size={11} />}
          {t === 'input' ? '입력' : t === 'output' ? '출력' : '메모'}
          {t === 'output' && cell.executed && cell.type !== 'markdown' && (
            <span className="w-1.5 h-1.5 rounded-full ml-0.5" style={{ backgroundColor: '#65a30d' }} />
          )}
        </button>
      ))}
    </div>
  )

  const renderPanel = (tab: CellPanelTab, fixedHeight?: number, stretch?: boolean) => {
    if (tab === 'input') {
      const isMarkdown = cell.type === 'markdown'
      return (
        <div
          className={cn('relative rounded-md overflow-hidden', stretch && 'h-full flex flex-col [&_.cm-editor]:!h-full [&>*]:flex-1 [&>*]:min-h-0')}
          style={isMarkdown ? { backgroundColor: '#ffffff', border: '1px solid #ede9dd' } : undefined}
        >
          <CodeEditor
            type={cell.type}
            value={cell.code}
            onChange={(v) => updateCellCode(cell.id, v)}
            onRun={cell.type !== 'markdown' ? () => executeCell(cell.id) : undefined}
            fixedHeight={stretch ? undefined : fixedHeight}
            readOnly={isVibing}
          />
        </div>
      )
    }
    if (tab === 'output') {
      return (
        <div
          className={cn('relative rounded-md overflow-hidden', stretch && 'h-full')}
          style={isExecuting ? {
            border: '1.5px solid transparent',
            backgroundImage: 'linear-gradient(#faf8f2,#faf8f2), linear-gradient(90deg,#f59e0b,#fbbf24,#fde68a,#fbbf24,#f59e0b)',
            backgroundOrigin: 'border-box',
            backgroundClip: 'padding-box, border-box',
            backgroundSize: '300% 300%',
            animation: 'vibe-border-flow 2s linear infinite',
            boxShadow: '0 0 8px rgba(245,158,11,0.12)',
            minHeight: fixedHeight,
          } : {
            backgroundColor: cell.type === 'markdown' ? '#ffffff' : '#faf8f2',
            border: '1px solid #ede9dd',
            minHeight: fixedHeight,
          }}
        >
          <CellOutput cell={cell} />
          {isExecuting && (
            <>
              <div className="absolute inset-0 bg-[#faf8f2] z-[30] rounded-md" />
              <div className="absolute inset-0 z-[40] flex flex-col items-center justify-center gap-1 pointer-events-none">
                <div className="flex items-center gap-1.5" style={{ color: '#b45309' }}>
                  <Loader2 size={13} className="animate-spin" />
                  <span className="text-[12px] font-semibold">실행 중</span>
                </div>
                <span className="font-mono text-[11px]" style={{ color: '#b4530999' }}>
                  {(execElapsed / 10).toFixed(1)}s
                </span>
              </div>
            </>
          )}
        </div>
      )
    }
    return (
      <textarea
        className={cn(
          'w-full text-[12px] px-4 py-3 rounded-md outline-none leading-relaxed text-text-primary placeholder-text-tertiary hide-scrollbar',
          !fixedHeight && 'resize-y'
        )}
        style={{
          height: fixedHeight,
          minHeight: fixedHeight ? undefined : 200,
          backgroundColor: '#ffffff',
          border: '1px solid #ede9dd',
          fontFamily: 'inherit',
        }}
        spellCheck={false}
        value={cell.memo}
        onChange={(e) => updateCellMemo(cell.id, e.target.value)}
        onClick={(e) => e.stopPropagation()}
        placeholder="마크다운으로 메모를 남겨보세요..."
      />
    )
  }

  return (
    <div
      id={cell.id}
      className={cn(
        'border-b border-border-subtle transition-colors',
        isActive ? 'bg-primary-light/60' : 'hover:bg-[rgba(253,237,232,0.15)]',
      )}
      onClick={() => setActiveCellId(cell.id)}
    >
      {/* Cell header */}
      <div className="group flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-text-disabled shrink-0">[{cellIndex}]</span>
          <button
            title={`클릭하여 셀 타입 변경 (→ ${nextType.toUpperCase()})`}
            onClick={(e) => { e.stopPropagation(); cycleCellTypeById(cell.id) }}
            className={cn(
              'text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide hover:opacity-80 hover:scale-105 transition-all cursor-pointer shrink-0',
              TYPE_STYLES[cell.type]
            )}
          >
            {badgeLabel}
          </button>
          <input
            className="text-sm font-mono font-semibold bg-transparent border-none focus:outline-none focus:bg-white px-1 rounded text-text-primary"
            size={Math.max((cell.name?.length || 1) + 1, 4)}
            value={cell.name}
            onChange={(e) => updateCellName(cell.id, sanitizeCellNameInput(e.target.value))}
            onBlur={(e) => updateCellName(cell.id, toSnakeCase(e.target.value, cell.name || 'cell'))}
            onClick={(e) => e.stopPropagation()}
            title="영문 소문자 + 숫자 + 언더스코어(snake_case)만 허용"
            pattern="[a-z_][a-z0-9_]*"
          />
          {/* Execution status */}
          {isExecuting && (
            <span className="text-[10px] font-mono flex items-center gap-0.5 shrink-0" style={{ color: '#d97706' }}>
              <Loader2 size={10} className="animate-spin" />
              {elapsedSecs}s
            </span>
          )}
          {!isExecuting && cell.executedAt && (
            <span className="text-[10px] font-mono text-text-disabled shrink-0">{cell.executedAt}</span>
          )}
          {cell.agentGenerated && (
            <span className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0" style={{ backgroundColor: '#fdede8', color: '#8f3a22' }}>
              <Telescope size={10} />에이전트
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Hover actions */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {cell.type !== 'markdown' && (
              <button
                title={isExecuting ? '실행 중...' : 'Ctrl+Enter로도 실행'}
                disabled={isExecuting}
                onClick={(e) => { e.stopPropagation(); executeCell(cell.id) }}
                className="p-1.5 rounded text-text-secondary transition-colors disabled:cursor-not-allowed"
                onMouseEnter={(e) => { if (!isExecuting) { e.currentTarget.style.color = '#D95C3F'; e.currentTarget.style.backgroundColor = '#fdede8' } }}
                onMouseLeave={(e) => { e.currentTarget.style.color = ''; e.currentTarget.style.backgroundColor = 'transparent' }}
              >
                {isExecuting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              </button>
            )}
            <button
              title="삭제"
              onClick={(e) => { e.stopPropagation(); deleteCell(cell.id) }}
              className="p-1.5 rounded text-text-secondary hover:text-danger hover:bg-danger-bg transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>

          {/* Layout mode toggle */}
          <div className="flex items-center rounded overflow-hidden ml-1" style={{ border: '1px solid #ede9dd' }}>
            <button
              title="기본"
              onClick={(e) => { e.stopPropagation(); if (cell.splitMode) toggleCellSplitMode(cell.id) }}
              className="flex items-center justify-center w-6 h-6 transition-colors"
              style={{
                backgroundColor: !cell.splitMode ? '#D95C3F' : 'transparent',
                color: !cell.splitMode ? '#ffffff' : '#a8a29e',
              }}
            >
              <Square size={12} />
            </button>
            <button
              title="좌우 분할"
              onClick={(e) => { e.stopPropagation(); setCellSplitDir(cell.id, 'h') }}
              className="flex items-center justify-center w-6 h-6 transition-colors"
              style={{
                backgroundColor: cell.splitMode && cell.splitDir === 'h' ? '#D95C3F' : 'transparent',
                color: cell.splitMode && cell.splitDir === 'h' ? '#ffffff' : '#a8a29e',
              }}
            >
              <Columns2 size={12} />
            </button>
            <button
              title="위아래 분할"
              onClick={(e) => { e.stopPropagation(); setCellSplitDir(cell.id, 'v') }}
              className="flex items-center justify-center w-6 h-6 transition-colors"
              style={{
                backgroundColor: cell.splitMode && cell.splitDir === 'v' ? '#D95C3F' : 'transparent',
                color: cell.splitMode && cell.splitDir === 'v' ? '#ffffff' : '#a8a29e',
              }}
            >
              <Rows2 size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-2">
        {(() => {
          const CELL_HEADER = 40
          const CONTENT_PAD = 16
          const VIBE_CHAT = isActive ? 128 : 24
          const SAFETY = 24
          const V_TOTAL = Math.max(notebookAreaHeight - CELL_HEADER - CONTENT_PAD - VIBE_CHAT - SAFETY, 200)
          const TAB_BAR = 30
          const panelMaxHeight = Math.max(V_TOTAL - TAB_BAR, 200)
          if (cell.splitMode && cell.splitDir === 'v') {
            const DIVIDER = 10
            const topPx = Math.round((V_TOTAL - DIVIDER) * vSplitRatio / 100)
            const bottomPx = V_TOTAL - DIVIDER - topPx
            const topContent = Math.max(topPx - TAB_BAR, 60)
            const bottomContent = Math.max(bottomPx - TAB_BAR, 60)
            return (
              <div ref={splitContainerRef} style={{ height: V_TOTAL }}>
                <div style={{ height: topPx, overflow: 'hidden' }}>
                  {renderTabBar(cell.leftTab, (t) => setSplitTab(cell.id, 'left', t))}
                  {renderPanel(cell.leftTab, topContent)}
                </div>
                <div
                  className="flex items-center justify-center cursor-row-resize group/div"
                  style={{ height: DIVIDER }}
                  onMouseDown={handleVDividerMouseDown}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="h-px w-full rounded-full transition-colors group-hover/div:bg-primary" style={{ backgroundColor: '#ede9dd' }} />
                </div>
                <div style={{ height: bottomPx, overflow: 'hidden' }}>
                  {renderTabBar(cell.rightTab, (t) => setSplitTab(cell.id, 'right', t))}
                  {renderPanel(cell.rightTab, bottomContent)}
                </div>
              </div>
            )
          }
          if (cell.splitMode) {
            const rightHeight = leftColHeight ? Math.min(leftColHeight, V_TOTAL) : undefined
            return (
              <div
                ref={splitContainerRef}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `${splitRatio}% 10px calc(${100 - splitRatio}% - 18px)`,
                  columnGap: 4,
                  maxHeight: V_TOTAL,
                  alignItems: 'start',
                }}
              >
                <div ref={leftColRef} className="min-w-0 flex flex-col" style={{ maxHeight: V_TOTAL, overflow: 'hidden' }}>
                  {renderTabBar(cell.leftTab, (t) => setSplitTab(cell.id, 'left', t))}
                  <div className="flex-1 min-h-0 overflow-auto">
                    {renderPanel(cell.leftTab, 360, true)}
                  </div>
                </div>
                <div
                  className="flex items-center justify-center cursor-col-resize group/div"
                  style={{ height: rightHeight }}
                  onMouseDown={handleDividerMouseDown}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="w-px h-full rounded-full transition-colors group-hover/div:bg-primary" style={{ backgroundColor: '#ede9dd' }} />
                </div>
                <div className="min-w-0 flex flex-col" style={{ height: rightHeight, overflow: 'hidden' }}>
                  {renderTabBar(cell.rightTab, (t) => setSplitTab(cell.id, 'right', t))}
                  <div className="flex-1 min-h-0 overflow-auto">
                    {renderPanel(cell.rightTab, 360, true)}
                  </div>
                </div>
              </div>
            )
          }
          return (
            <>
              {renderTabBar(cell.activeTab, (t) => setCellTab(cell.id, t))}
              <div style={{ maxHeight: panelMaxHeight, overflow: 'auto' }}>
                {renderPanel(cell.activeTab)}
              </div>
            </>
          )
        })()}
      </div>

      {/* Insight */}
      {cell.insight && (
        <div className="mt-2 mx-4 px-3 py-2 rounded-md text-xs flex items-start gap-2" style={{ backgroundColor: '#fdede8', color: '#8f3a22' }}>
          <Telescope size={14} className="shrink-0 mt-0.5" />
          <span>{cell.insight}</span>
        </div>
      )}

      {/* Vibe chat (active cell only) */}
      {isActive && (
        <div
          className="relative mt-3 mx-4 mb-4 rounded-2xl"
          style={isVibing ? {
            border: '1.5px solid transparent',
            backgroundImage: 'linear-gradient(#fff,#fff), linear-gradient(90deg,#D95C3F,#f0883e,#fbbf24,#f0883e,#D95C3F)',
            backgroundOrigin: 'border-box',
            backgroundClip: 'padding-box, border-box',
            backgroundSize: '300% 300%',
            animation: 'vibe-border-flow 2s linear infinite',
            boxShadow: '0 0 8px rgba(217,92,63,0.12)',
          } : {
            backgroundColor: '#ffffff',
            border: '1px solid #ede9dd',
            boxShadow: '0 1px 2px rgba(45,42,38,0.03)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 뒤 텍스트 가리기 + 상태 표시 */}
          {isVibing && (
            <>
              <div className="absolute inset-0 rounded-2xl bg-white z-[30]" />
              <div className="absolute inset-0 z-[40] flex flex-col items-center justify-center gap-1 pointer-events-none">
                <div className="flex items-center gap-1.5" style={{ color: '#c94a2e' }}>
                  <Loader2 size={13} className="animate-spin" />
                  <span className="text-[12px] font-semibold">코드 생성 중</span>
                </div>
                <span className="font-mono text-[11px]" style={{ color: '#c94a2e99' }}>
                  {(vibeElapsed / 10).toFixed(1)}s
                </span>
              </div>
            </>
          )}

          {/* 입력 영역 */}
          <textarea
            ref={inputRef}
            data-vibe-chat-for={cell.id}
            className="w-full bg-transparent text-sm text-text-primary placeholder-text-tertiary focus:outline-none resize-none leading-relaxed overflow-hidden rounded-2xl"
            style={{ minHeight: '56px', height: '56px', padding: '10px 48px 28px 16px', position: 'relative', zIndex: 10 }}
            placeholder={
              cell.type === 'sql'
                ? '쿼리를 수정해보세요 (Ctrl+Enter 전송) — 예: 시도별로 group by 해줘'
                : cell.type === 'python'
                ? '코드를 수정해보세요 (Ctrl+Enter 전송) — 예: pie 차트로 바꿔줘'
                : '문서를 수정해보세요 (Ctrl+Enter 전송)'
            }
            disabled={isVibing}
            value={cell.chatInput}
            onChange={(e) => {
              updateCellChatInput(cell.id, e.target.value)
              e.target.style.height = '44px'
              e.target.style.height = e.target.scrollHeight + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                if (!isVibing && cell.chatInput.trim()) {
                  submitVibe(cell.id, cell.chatInput)
                  e.currentTarget.style.height = '44px'
                }
              }
            }}
          />
          <div className="absolute right-3 bottom-2 w-8 h-8 rounded-full flex items-center justify-center transition-all" style={{ zIndex: 10 }}>
            <button
              title="바이브 전송"
              disabled={isVibing || !cell.chatInput.trim()}
              onClick={() => submitVibe(cell.id, cell.chatInput)}
              className="w-8 h-8 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed"
              style={{ backgroundColor: cell.chatInput.trim() && !isVibing ? '#D95C3F' : '#ede9dd', color: '#ffffff' }}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
          <div className="absolute left-3 bottom-2.5 flex items-center gap-1" style={{ zIndex: 10 }}>
            <div className="relative flex items-center">
              <select
                value={vibeModel}
                onChange={(e) => setVibeModel(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                disabled={isVibing}
                className="appearance-none text-[10px] font-medium text-text-disabled bg-transparent border-none pl-0 pr-4 py-0 cursor-pointer hover:text-text-secondary outline-none transition-colors disabled:cursor-not-allowed"
              >
                {VIBE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <ChevronDown size={9} className="absolute right-0 pointer-events-none text-text-disabled" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
