import { useRef, useEffect, useState, useCallback } from 'react'
import { Play, Trash2, Code, BarChart3, Telescope, ArrowUp, FileText, Square, Columns2, Rows2, Loader2, ChevronDown, StopCircle } from 'lucide-react'
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
  sql: 'bg-sql-bg text-sql-text',
  python: 'bg-python-bg text-python-text',
  markdown: 'bg-markdown-bg text-markdown-text',
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
    cancelVibe,
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
  const [splitRatio, setSplitRatio] = useState(() => loadCellUi(cell.id).splitRatio ?? 50)
  const [vSplitRatio, setVSplitRatio] = useState(() => loadCellUi(cell.id).vSplitRatio ?? 50)
  // 사용자가 직접 드래그로 조정한 패널 높이. 기본값은 360px.
  const [panelHeight, setPanelHeight] = useState(() => loadCellUi(cell.id).panelHeight ?? 360)
  const hasSavedPanelHeight = loadCellUi(cell.id).panelHeight != null
  const userResizedRef = useRef(hasSavedPanelHeight)

  useEffect(() => { saveCellUi(cell.id, { splitRatio }) }, [cell.id, splitRatio])
  useEffect(() => { saveCellUi(cell.id, { vSplitRatio }) }, [cell.id, vSplitRatio])
  useEffect(() => { saveCellUi(cell.id, { panelHeight }) }, [cell.id, panelHeight])
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

  // 셀 패널 세로 리사이즈 — 시작 높이에서 드래그 만큼 증감, [160, 1200] 범위로 클램프
  const handlePanelResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    // 드래그 시작 시점의 실제 화면상 높이(차트 자동확장분 포함)를 기준으로.
    const currentEl = (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement | null
    const startH = currentEl?.getBoundingClientRect().height ?? panelHeight
    userResizedRef.current = true
    const onMouseMove = (ev: MouseEvent) => {
      const next = startH + (ev.clientY - startY)
      setPanelHeight(Math.min(Math.max(next, 160), 1600))
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
  }, [panelHeight])

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
          className={cn(
            'flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold border-b-2 -mb-px transition-colors',
            activeTab === t ? 'border-primary text-primary' : 'border-transparent text-text-disabled'
          )}
        >
          {t === 'input' && <Code size={11} />}
          {t === 'output' && <BarChart3 size={11} />}
          {t === 'memo' && <FileText size={11} />}
          {t === 'input' ? '입력' : t === 'output' ? '출력' : '메모'}
          {t === 'output' && cell.executed && cell.type !== 'markdown' && (
            <span className="w-1.5 h-1.5 rounded-full ml-0.5 bg-success" />
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
          className={cn(
            'relative rounded-md overflow-hidden',
            isMarkdown && 'bg-surface border border-border-subtle',
            stretch && 'h-full flex flex-col [&_.cm-editor]:!h-full [&>*]:flex-1 [&>*]:min-h-0'
          )}
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
          className={cn(
            'relative rounded-md overflow-hidden',
            stretch && 'h-full',
            !isExecuting && 'border border-border-subtle',
            !isExecuting && ((cell.type === 'markdown' || cell.output?.type === 'table') ? 'bg-surface' : 'bg-bg-output'),
          )}
          style={isExecuting ? {
            border: '1.5px solid transparent',
            backgroundImage: 'linear-gradient(rgb(var(--color-bg-output)),rgb(var(--color-bg-output))), linear-gradient(90deg,#f59e0b,#fbbf24,#fde68a,#fbbf24,#f59e0b)',
            backgroundOrigin: 'border-box',
            backgroundClip: 'padding-box, border-box',
            backgroundSize: '300% 300%',
            animation: 'vibe-border-flow 2s linear infinite',
            boxShadow: '0 0 8px rgba(245,158,11,0.12)',
          } : undefined}
        >
          <CellOutput cell={cell} />
          {isExecuting && (
            <>
              <div className="absolute inset-0 bg-bg-output z-[30] rounded-md" />
              <div className="absolute inset-0 z-[40] flex flex-col items-center justify-center gap-1 pointer-events-none">
                <div className="flex items-center gap-1.5 text-warning-text">
                  <Loader2 size={13} className="animate-spin" />
                  <span className="text-[12px] font-semibold">실행 중</span>
                </div>
                <span className="font-mono text-[11px] text-warning-text/60">
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
          'w-full text-[12px] px-4 py-3 rounded-md outline-none leading-relaxed text-text-primary placeholder-text-tertiary hide-scrollbar bg-surface border border-border-subtle',
          !fixedHeight && 'resize-y'
        )}
        style={{
          height: fixedHeight,
          minHeight: fixedHeight ? undefined : 200,
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
        isActive
          ? 'bg-primary-light/60 dark:bg-primary-light/30'
          : 'hover:bg-primary-light/15 dark:hover:bg-primary-light/10',
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
            className="text-sm font-mono font-semibold bg-transparent border-none focus:outline-none focus:bg-surface px-1 rounded text-text-primary"
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
            <span className="text-[10px] font-mono flex items-center gap-0.5 shrink-0 text-warning">
              <Loader2 size={10} className="animate-spin" />
              {elapsedSecs}s
            </span>
          )}
          {!isExecuting && cell.executedAt && (
            <span className="text-[10px] font-mono text-text-disabled shrink-0">{cell.executedAt}</span>
          )}
          {cell.agentGenerated && (
            <span className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0 bg-primary-light text-primary-text">
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
                className="p-1.5 rounded text-text-secondary transition-colors disabled:cursor-not-allowed enabled:hover:text-primary enabled:hover:bg-primary-light"
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
          <div className="flex items-center rounded overflow-hidden ml-1 border border-border-subtle">
            <button
              title="기본"
              onClick={(e) => { e.stopPropagation(); if (cell.splitMode) toggleCellSplitMode(cell.id) }}
              className={cn(
                'flex items-center justify-center w-6 h-6 transition-colors',
                !cell.splitMode ? 'bg-primary text-white' : 'bg-transparent text-text-disabled'
              )}
            >
              <Square size={12} />
            </button>
            <button
              title="좌우 분할"
              onClick={(e) => { e.stopPropagation(); setCellSplitDir(cell.id, 'h') }}
              className={cn(
                'flex items-center justify-center w-6 h-6 transition-colors',
                cell.splitMode && cell.splitDir === 'h' ? 'bg-primary text-white' : 'bg-transparent text-text-disabled'
              )}
            >
              <Columns2 size={12} />
            </button>
            <button
              title="위아래 분할"
              onClick={(e) => { e.stopPropagation(); setCellSplitDir(cell.id, 'v') }}
              className={cn(
                'flex items-center justify-center w-6 h-6 transition-colors',
                cell.splitMode && cell.splitDir === 'v' ? 'bg-primary text-white' : 'bg-transparent text-text-disabled'
              )}
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
          // 차트 출력 셀은 Plotly layout.height(없으면 400)에 크롬 여백을 더해 자동 확장.
          // 사용자가 직접 드래그로 더 크게 늘렸으면 그 값을 존중.
          const CHART_CHROME = 24 // 테두리 + 상하 padding
          const chartPreferredHeight = (() => {
            if (cell.output?.type !== 'chart') return null
            const layoutH = (cell.output.plotlyJson as any)?.layout?.height
            const h = typeof layoutH === 'number' && layoutH > 0 ? layoutH : 400
            return Math.min(h + CHART_CHROME, 1600)
          })()
          // 사용자가 드래그로 직접 조정한 적이 있으면 그 값을 그대로 씀.
          // 아직 조정한 적이 없으면 차트 자연 높이로 초기 확장.
          const effectiveHeight = userResizedRef.current
            ? panelHeight
            : (chartPreferredHeight ?? panelHeight)
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
                  <div className="h-px w-full rounded-full transition-colors bg-border-subtle group-hover/div:bg-primary" />
                </div>
                <div style={{ height: bottomPx, overflow: 'hidden' }}>
                  {renderTabBar(cell.rightTab, (t) => setSplitTab(cell.id, 'right', t))}
                  {renderPanel(cell.rightTab, bottomContent)}
                </div>
              </div>
            )
          }
          if (cell.splitMode) {
            const leftIsOutput = cell.leftTab === 'output'
            const rightIsOutput = cell.rightTab === 'output'
            return (
              <>
                <div
                  ref={splitContainerRef}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `${splitRatio}% 10px calc(${100 - splitRatio}% - 18px)`,
                    columnGap: 4,
                    height: effectiveHeight,
                    alignItems: 'stretch',
                  }}
                >
                  <div ref={leftColRef} className="min-w-0 flex flex-col" style={{ height: effectiveHeight, overflow: 'hidden' }}>
                    {renderTabBar(cell.leftTab, (t) => setSplitTab(cell.id, 'left', t))}
                    <div className={cn('flex-1 min-h-0', leftIsOutput ? 'overflow-hidden' : 'overflow-auto')}>
                      {renderPanel(cell.leftTab, effectiveHeight, true)}
                    </div>
                  </div>
                  <div
                    className="flex items-center justify-center cursor-col-resize group/div"
                    onMouseDown={handleDividerMouseDown}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="w-px h-full rounded-full transition-colors bg-border-subtle group-hover/div:bg-primary" />
                  </div>
                  <div className="min-w-0 flex flex-col" style={{ height: effectiveHeight, overflow: 'hidden' }}>
                    {renderTabBar(cell.rightTab, (t) => setSplitTab(cell.id, 'right', t))}
                    <div className={cn('flex-1 min-h-0', rightIsOutput ? 'overflow-hidden' : 'overflow-auto')}>
                      {renderPanel(cell.rightTab, effectiveHeight, true)}
                    </div>
                  </div>
                </div>
                <PanelResizeHandle onMouseDown={handlePanelResizeMouseDown} />
              </>
            )
          }
          // 단일 패널 모드: 출력 탭은 기본 셀 크기(panelHeight)로 고정 스크롤, 입력/메모는 내용 크기 허용.
          if (cell.activeTab === 'output') {
            return (
              <>
                {renderTabBar(cell.activeTab, (t) => setCellTab(cell.id, t))}
                <div style={{ height: effectiveHeight, overflow: 'hidden' }}>
                  {renderPanel(cell.activeTab, effectiveHeight, true)}
                </div>
                <PanelResizeHandle onMouseDown={handlePanelResizeMouseDown} />
              </>
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
        <div className="mt-2 mx-4 px-3 py-2 rounded-md text-xs flex items-start gap-2 bg-primary-light text-primary-text">
          <Telescope size={14} className="shrink-0 mt-0.5" />
          <span>{cell.insight}</span>
        </div>
      )}

      {/* Vibe chat (active cell only) */}
      {isActive && (
        <div
          className={cn(
            'relative mt-3 mx-4 mb-4 rounded-2xl',
            !isVibing && 'bg-surface border border-border-subtle shadow-sm'
          )}
          style={isVibing ? {
            border: '1.5px solid transparent',
            backgroundImage: 'linear-gradient(rgb(var(--color-surface)),rgb(var(--color-surface))), linear-gradient(90deg,#D95C3F,#f0883e,#fbbf24,#f0883e,#D95C3F)',
            backgroundOrigin: 'border-box',
            backgroundClip: 'padding-box, border-box',
            backgroundSize: '300% 300%',
            animation: 'vibe-border-flow 2s linear infinite',
            boxShadow: '0 0 8px rgba(217,92,63,0.12)',
          } : undefined}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 뒤 텍스트 가리기 + 상태 표시 */}
          {isVibing && (
            <>
              <div className="absolute inset-0 rounded-2xl bg-surface z-[30]" />
              <div className="absolute inset-0 z-[40] flex flex-col items-center justify-center gap-1 pointer-events-none">
                <div className="flex items-center gap-1.5 text-primary-hover">
                  <Loader2 size={13} className="animate-spin" />
                  <span className="text-[12px] font-semibold">코드 생성 중</span>
                </div>
                <span className="font-mono text-[11px] text-primary-hover/60">
                  {(vibeElapsed / 10).toFixed(1)}s
                </span>
              </div>
              <button
                title="생성 중지"
                onClick={(e) => { e.stopPropagation(); cancelVibe(cell.id) }}
                className="absolute top-1/2 right-3 -translate-y-1/2 z-[50] flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors bg-primary-light text-primary-hover border border-primary-border"
              >
                <StopCircle size={12} />중지
              </button>
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
              className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed text-white',
                cell.chatInput.trim() && !isVibing ? 'bg-primary' : 'bg-border-subtle'
              )}
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

function PanelResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="group/resize flex items-center justify-center cursor-row-resize select-none"
      style={{ height: 8 }}
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      title="드래그해 셀 높이 조절"
    >
      <div
        className="rounded-full transition-colors bg-border-subtle group-hover/resize:bg-primary"
        style={{ width: 40, height: 3 }}
      />
    </div>
  )
}
