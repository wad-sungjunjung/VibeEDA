import { useRef, useEffect, useState, useCallback, lazy, Suspense, memo } from 'react'
import { Play, Trash2, Code, BarChart3, Telescope, ArrowUp, FileText, Square, Columns2, Rows2, Loader2, ChevronDown, StopCircle, Maximize2, Minimize2, Sparkles, Grid3x3, Paperclip, X as XIcon } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import { useModelStore, VIBE_MODELS } from '@/store/modelStore'
import type { Cell, CellPanelTab, ImageAttachment } from '@/types'
import { cn, loadCellUi, saveCellUi, sanitizeCellNameInput, toSnakeCase } from '@/lib/utils'
import CellOutput from './CellOutput'
import CodeEditor from './CodeEditor'
import type { SheetEditorHandle } from './SheetEditor'
const SheetEditor = lazy(() => import('./SheetEditor'))
import { vibeSheet } from '@/lib/api'
import { suggestCellName } from '@/lib/api'

interface Props {
  cell: Cell
  index: number
}

const TYPE_CYCLE_ORDER = ['sql', 'python', 'markdown'] as const
const TYPE_STYLES: Record<string, string> = {
  sql: 'bg-sql-bg text-sql-text',
  python: 'bg-python-bg text-python-text',
  markdown: 'bg-markdown-bg text-markdown-text',
  sheet: 'bg-sheet-bg text-sheet-text',
}
const isNonExecutable = (t: string) => t === 'markdown' || t === 'sheet'

function CellContainer({ cell, index }: Props) {
  // cells 전체를 구독하지 않는다 — 다른 셀이 바뀔 때마다 모든 CellContainer 가
  // 재렌더링되는 것을 막기 위함. cellIndex 는 NotebookArea 가 prop 으로 주입.
  // 풀스크린 애니메이션은 fullscreenCellId 가 바뀐 그 시점의 cells 만 필요하므로
  // effect 안에서 useAppStore.getState() 로 lazy 조회.
  const {
    activeCellId,
    setActiveCellId,
    cellFocusMode,
    selectedPanelKey,
    setSelectedPanelKey,
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
    updateCellChatImages,
    submitVibe,
    cancelVibe,
    notebookAreaHeight,
    fullscreenCellId,
    setFullscreenCellId,
  } = useAppStore(useShallow((s) => ({
    activeCellId: s.activeCellId,
    setActiveCellId: s.setActiveCellId,
    cellFocusMode: s.cellFocusMode,
    selectedPanelKey: s.selectedPanelKey,
    setSelectedPanelKey: s.setSelectedPanelKey,
    deleteCell: s.deleteCell,
    updateCellCode: s.updateCellCode,
    updateCellName: s.updateCellName,
    setCellTab: s.setCellTab,
    setSplitTab: s.setSplitTab,
    toggleCellSplitMode: s.toggleCellSplitMode,
    setCellSplitDir: s.setCellSplitDir,
    updateCellMemo: s.updateCellMemo,
    cycleCellTypeById: s.cycleCellTypeById,
    executeCell: s.executeCell,
    executingCells: s.executingCells,
    vibingCells: s.vibingCells,
    updateCellChatInput: s.updateCellChatInput,
    updateCellChatImages: s.updateCellChatImages,
    submitVibe: s.submitVibe,
    cancelVibe: s.cancelVibe,
    notebookAreaHeight: s.notebookAreaHeight,
    fullscreenCellId: s.fullscreenCellId,
    setFullscreenCellId: s.setFullscreenCellId,
  })))

  const { vibeModel, setVibeModel } = useModelStore()

  const isExecuting = executingCells.has(cell.id)
  const isVibing = vibingCells.has(cell.id)
  const isActive = activeCellId === cell.id
  const cellIndex = index

  const panelKeyFor = (slot: 'content' | 'left' | 'right' | 'vibe') => `${cell.id}::${slot}`
  const panelAttrs = (slot: 'content' | 'left' | 'right' | 'vibe') => {
    const key = panelKeyFor(slot)
    return {
      'data-cell-panel-key': key,
      'data-panel-selected': (cellFocusMode === 'command' && selectedPanelKey === key) ? 'true' : undefined,
      onClickCapture: () => {
        // capture 단계에서 먼저 선택 상태만 업데이트 — 실제 클릭 동작은 그대로 진행되게 stopPropagation 하지 않음
        if (activeCellId !== cell.id) setActiveCellId(cell.id)
        if (selectedPanelKey !== key) setSelectedPanelKey(key)
      },
    } as const
  }

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const leftColRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<SheetEditorHandle>(null)
  const [sheetVibing, setSheetVibing] = useState(false)
  const [gridlinesHidden, setGridlinesHidden] = useState(false)
  // 저장된 스냅샷의 격자선 상태를 UI 상태와 동기화 (마운트/전환 직후)
  useEffect(() => {
    if (cell.type !== 'sheet') return
    const t = window.setTimeout(() => {
      setGridlinesHidden(sheetRef.current?.areGridlinesHidden() ?? false)
    }, 200)
    return () => window.clearTimeout(t)
  }, [cell.type, cell.id])

  // 커맨드 모드에서 Enter 로 시트 패널 진입 시 — App.tsx 가 이벤트로 focusGrid 요청
  useEffect(() => {
    if (cell.type !== 'sheet') return
    function onFocusSheetGrid(e: Event) {
      const detail = (e as CustomEvent<{ cellId: string }>).detail
      if (detail?.cellId !== cell.id) return
      sheetRef.current?.focusGrid()
    }
    window.addEventListener('vibe:focus-sheet-grid', onFocusSheetGrid as EventListener)
    return () => window.removeEventListener('vibe:focus-sheet-grid', onFocusSheetGrid as EventListener)
  }, [cell.type, cell.id])
  const [splitRatio, setSplitRatio] = useState(() => loadCellUi(cell.id).splitRatio ?? 50)
  const [vSplitRatio, setVSplitRatio] = useState(() => loadCellUi(cell.id).vSplitRatio ?? 50)
  // 사용자가 직접 드래그로 조정한 패널 높이. 기본값은 540px.
  const [panelHeight, setPanelHeight] = useState(() => loadCellUi(cell.id).panelHeight ?? 540)
  const hasSavedPanelHeight = loadCellUi(cell.id).panelHeight != null
  const userResizedRef = useRef(hasSavedPanelHeight)

  useEffect(() => { saveCellUi(cell.id, { splitRatio }) }, [cell.id, splitRatio])
  useEffect(() => { saveCellUi(cell.id, { vSplitRatio }) }, [cell.id, vSplitRatio])
  useEffect(() => { saveCellUi(cell.id, { panelHeight }) }, [cell.id, panelHeight])
  useEffect(() => { saveCellUi(cell.id, { splitMode: cell.splitMode, splitDir: cell.splitDir }) }, [cell.id, cell.splitMode, cell.splitDir])
  useEffect(() => { saveCellUi(cell.id, { activeTab: cell.activeTab, leftTab: cell.leftTab, rightTab: cell.rightTab }) }, [cell.id, cell.activeTab, cell.leftTab, cell.rightTab])
  const [elapsedSecs, setElapsedSecs] = useState(0)
  const [vibeElapsed, setVibeElapsed] = useState(0) // 0.1s 단위
  const fullscreen = fullscreenCellId === cell.id
  // 애니메이션을 위해 `fullscreen` 해제 시에도 잠시 DOM을 유지 (exit 애니메이션용)
  const [fsVisible, setFsVisible] = useState(fullscreen)
  // 애니메이션 종류: null = 없음, grow-in/out = 진입·완전해제, slide-* = 셀간 전환
  const [fsAnim, setFsAnim] = useState<null | 'grow-in' | 'grow-out' | 'slide-in-up' | 'slide-in-down' | 'slide-out-up' | 'slide-out-down'>(
    fullscreen ? 'grow-in' : null
  )
  // 직전 fullscreenCellId 를 추적해 전환 방향 계산
  const prevFullscreenIdRef = useRef<string | null>(fullscreenCellId)

  useEffect(() => {
    const prev = prevFullscreenIdRef.current
    const curr = fullscreenCellId
    const myId = cell.id
    prevFullscreenIdRef.current = curr

    if (curr === myId && prev !== myId) {
      // 내가 fullscreen 이 됨
      setFsVisible(true)
      if (prev && prev !== myId) {
        // 다른 셀에서 전환: 인덱스 방향에 따라 상/하 슬라이드
        // cells 배열은 effect 트리거 시점의 스냅샷만 필요 (slide 방향만 결정).
        const cellsNow = useAppStore.getState().cells
        const prevIdx = cellsNow.findIndex((c) => c.id === prev)
        const myIdx = cellsNow.findIndex((c) => c.id === myId)
        setFsAnim(myIdx > prevIdx ? 'slide-in-down' : 'slide-in-up')
      } else {
        // 최초 진입: grow
        setFsAnim('grow-in')
      }
      return
    }

    if (curr !== myId && prev === myId) {
      // 내가 fullscreen 에서 벗어남
      if (curr) {
        // 다른 셀에 넘어감 → 반대 방향으로 빠짐
        const cellsNow = useAppStore.getState().cells
        const currIdx = cellsNow.findIndex((c) => c.id === curr)
        const myIdx = cellsNow.findIndex((c) => c.id === myId)
        setFsAnim(currIdx > myIdx ? 'slide-out-up' : 'slide-out-down')
      } else {
        // 완전 해제 → grow-out
        setFsAnim('grow-out')
      }
      // 퇴장 애니메이션 지속시간과 맞춤 (grow-out 200ms / slide-out 240ms)
      const exitDuration = curr ? 240 : 200
      const t = window.setTimeout(() => {
        setFsVisible(false)
        setFsAnim(null)
      }, exitDuration)
      return () => window.clearTimeout(t)
    }
  }, [fullscreenCellId, cell.id])

  const fsRenderActive = fullscreen || fsVisible // DOM 에 fullscreen 스타일로 렌더할지
  const fsAnimClass = fsAnim ? `cell-fs-${fsAnim}` : ''
  const isExitingPhase = fsAnim === 'grow-out' || fsAnim === 'slide-out-up' || fsAnim === 'slide-out-down'
  const setFullscreen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const resolved = typeof next === 'function' ? next(fullscreen) : next
      setFullscreenCellId(resolved ? cell.id : null)
    },
    [cell.id, fullscreen, setFullscreenCellId]
  )
  const [viewportH, setViewportH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800))

  useEffect(() => {
    if (!fullscreen) return
    setViewportH(window.innerHeight)
    const onResize = () => setViewportH(window.innerHeight)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 편집 가능한 요소에 포커스가 있으면 그 쪽 기본 동작(편집 취소 등)에 양보
        const active = document.activeElement as HTMLElement | null
        const tag = (active?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea') return
        if (active?.getAttribute?.('contenteditable') === 'true') return
        if (active?.closest?.('[contenteditable="true"]')) return
        e.stopPropagation()
        setFullscreenCellId(null)
      }
    }
    window.addEventListener('resize', onResize)
    // capture:false (bubble) — SheetEditor 가 먼저 capture 에서 Esc 를 처리할 기회
    document.addEventListener('keydown', onKey, false)
    return () => {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('keydown', onKey, false)
    }
  }, [fullscreen, setFullscreenCellId])

  const [naming, setNaming] = useState(false)
  const handleSuggestName = useCallback(async () => {
    if (naming) return
    const code = (cell.code || '').trim()
    if (!code) return
    setNaming(true)
    try {
      const name = await suggestCellName(code, cell.type)
      if (name) updateCellName(cell.id, name)
    } catch (e) {
      console.error('네이밍 실패:', e)
    } finally {
      setNaming(false)
    }
  }, [naming, cell.id, cell.code, cell.type, updateCellName])

  const notebookId = useAppStore((s) => s.notebookId)
  const submitSheetVibe = useCallback(async (message: string) => {
    if (!message.trim() || sheetVibing) return
    const handle = sheetRef.current
    if (!handle) return
    setSheetVibing(true)
    updateCellChatInput(cell.id, '')
    try {
      const selection = handle.getSelection()
      const { data, origin } = handle.getDataRegion()
      const res = await vibeSheet({
        cell_id: cell.id,
        message,
        selection,
        data_region: data,
        data_origin: origin,
        notebook_id: notebookId,
      })
      if (res.patches?.length) handle.applyPatches(res.patches)
      if (res.explanation) console.info('[sheet-vibe]', res.explanation)
    } catch (err) {
      console.error('[sheet-vibe] failed', err)
      alert(`시트 바이브 실패: ${err}`)
    } finally {
      setSheetVibing(false)
    }
  }, [cell.id, sheetVibing, updateCellChatInput, notebookId])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    // 편집/상호작용 요소에서는 더블클릭을 기본 동작(텍스트 선택·커서 배치)에 양보
    if (target.closest('input, textarea, button, select, [contenteditable="true"], .cm-editor, .monaco-editor, [role="separator"], canvas')) return
    e.preventDefault()
    setActiveCellId(cell.id)
    setFullscreen((f) => !f)
  }, [cell.id, setActiveCellId])

  // 헤더 전용 핸들러: 에디터가 셀의 대부분을 덮는 경우에도 헤더에서 항상 전체화면 토글 가능
  const handleHeaderDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    if (target.closest('input, select')) return // 이름 input 의 더블클릭 선택은 유지
    e.preventDefault()
    e.stopPropagation()
    setActiveCellId(cell.id)
    setFullscreen((f) => !f)
  }, [cell.id, setActiveCellId])

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

  const badgeLabel =
    cell.type === 'markdown' ? 'MD'
    : cell.type === 'python' ? 'PY'
    : cell.type === 'sheet' ? 'SHEET'
    : cell.type.toUpperCase()
  const isSheetCell = cell.type === 'sheet'
  const cycleIndex = TYPE_CYCLE_ORDER.indexOf(cell.type as typeof TYPE_CYCLE_ORDER[number])
  const nextType = cycleIndex >= 0 ? TYPE_CYCLE_ORDER[(cycleIndex + 1) % TYPE_CYCLE_ORDER.length] : cell.type

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
          {t === 'output' && cell.executed && !isNonExecutable(cell.type) && (
            <span className="w-1.5 h-1.5 rounded-full ml-0.5 bg-success" />
          )}
        </button>
      ))}
    </div>
  )

  const renderPanel = (tab: CellPanelTab, fixedHeight?: number, stretch?: boolean) => {
    if (tab === 'input') {
      const isMarkdown = cell.type === 'markdown'
      const isSheet = cell.type === 'sheet'
      if (isSheet) {
        return (
          <div className={cn('relative rounded-md overflow-hidden', stretch && 'h-full flex flex-col')}>
            <Suspense fallback={<div className="flex items-center justify-center h-full min-h-[120px] text-text-tertiary text-sm"><span>로딩 중...</span></div>}>
              <SheetEditor
                ref={sheetRef}
                value={cell.code}
                onChange={(v) => updateCellCode(cell.id, v)}
                height={stretch ? '100%' : (fixedHeight ?? 480)}
                readOnly={isVibing || sheetVibing}
                showFooter={fsRenderActive}
              />
            </Suspense>
          </div>
        )
      }
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
            onRun={!isNonExecutable(cell.type) ? () => executeCell(cell.id) : undefined}
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
        'transition-colors',
        fsRenderActive
          ? cn(
              'fixed inset-0 bg-bg-page overflow-auto',
              isExitingPhase ? 'z-[99]' : 'z-[100]',
              fsAnimClass
            )
          : 'border-b border-border-subtle',
        !fsRenderActive && (isActive
          ? 'bg-primary-light/60 dark:bg-primary-light/30'
          : 'hover:bg-primary-light/15 dark:hover:bg-primary-light/10'),
      )}
      style={fsRenderActive ? { paddingRight: 'var(--right-nav-width, 256px)' } : undefined}
      onClick={() => setActiveCellId(cell.id)}
      onDoubleClick={handleDoubleClick}
      title={!fullscreen && isActive ? '더블클릭하여 전체화면' : undefined}
    >
      {/* Cell header */}
      <div
        className="group flex items-center justify-between px-4 py-2"
        onDoubleClick={handleHeaderDoubleClick}
        title={fullscreen ? '더블클릭하여 전체화면 해제' : '더블클릭하여 전체화면'}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-text-disabled shrink-0">[{cellIndex}]</span>
          <button
            title={isSheetCell ? '시트 셀은 타입 전환 불가' : `클릭하여 셀 타입 변경 (→ ${nextType.toUpperCase()})`}
            onClick={(e) => { e.stopPropagation(); if (!isSheetCell) cycleCellTypeById(cell.id) }}
            disabled={isSheetCell}
            className={cn(
              'text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide transition-all shrink-0',
              isSheetCell ? 'cursor-default' : 'cursor-pointer hover:opacity-80 hover:scale-105',
              !isSheetCell && TYPE_STYLES[cell.type]
            )}
            style={isSheetCell ? {
              backgroundColor: 'rgb(var(--color-sheet-bg))',
              color: 'rgb(var(--color-sheet-text))',
            } : undefined}
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
          <button
            title="코드 기반으로 셀 이름 자동 생성"
            disabled={naming || !cell.code?.trim()}
            onClick={(e) => { e.stopPropagation(); handleSuggestName() }}
            className="p-1 rounded text-text-disabled transition-colors enabled:hover:text-primary enabled:hover:bg-primary-light disabled:cursor-not-allowed shrink-0"
          >
            {naming ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          </button>
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
            {!isNonExecutable(cell.type) && (
              <button
                title={isExecuting ? '실행 중...' : 'Ctrl+Enter로도 실행'}
                disabled={isExecuting}
                onClick={(e) => { e.stopPropagation(); executeCell(cell.id) }}
                className="p-1.5 rounded text-text-secondary transition-colors disabled:cursor-not-allowed enabled:hover:text-primary enabled:hover:bg-primary-light"
              >
                {isExecuting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              </button>
            )}
            {isSheetCell && (
              <button
                title={gridlinesHidden ? '격자선 표시' : '격자선 숨김'}
                onClick={(e) => {
                  e.stopPropagation()
                  const nextHidden = sheetRef.current?.toggleGridlines() ?? false
                  setGridlinesHidden(nextHidden)
                }}
                className={cn(
                  'p-1.5 rounded transition-colors hover:bg-primary-light',
                  gridlinesHidden ? 'text-text-disabled' : 'text-text-secondary hover:text-primary'
                )}
              >
                <Grid3x3 size={14} />
              </button>
            )}
            <button
              title={fullscreen ? '전체화면 해제 (Esc)' : '전체화면 (더블클릭)'}
              onClick={(e) => { e.stopPropagation(); setActiveCellId(cell.id); setFullscreen((f) => !f) }}
              className="p-1.5 rounded text-text-secondary hover:text-primary hover:bg-primary-light transition-colors"
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              title="삭제"
              onClick={(e) => { e.stopPropagation(); deleteCell(cell.id) }}
              className="p-1.5 rounded text-text-secondary hover:text-danger hover:bg-danger-bg transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>

          {/* Layout mode toggle */}
          <div className={cn(
            'flex items-center rounded overflow-hidden ml-1 border border-border-subtle',
            isSheetCell && 'hidden'
          )}>
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
      <div className="px-4 pt-2 pb-0">
        {(() => {
          const CELL_HEADER = 40
          const CONTENT_PAD = 8 // pt-2 pb-0 → 상단 8px 만
          const VIBE_CHAT = isActive ? (fsRenderActive ? 116 : 104) : 24
          const SAFETY = 16
          // Sheet 셀: 탭바/분할 없이 입력(스프레드시트)만 렌더
          // 전체화면에선 뷰포트를 꽉 채우고, 기본 상태에선 사용자가 조정한 panelHeight 사용
          if (cell.type === 'sheet') {
            const viewportTotal = Math.max(viewportH - CELL_HEADER - CONTENT_PAD - VIBE_CHAT - SAFETY, 200)
            const sheetHeight = fsRenderActive ? viewportTotal : panelHeight
            return (
              <>
                <div {...panelAttrs('content')} style={{ height: sheetHeight, overflow: 'hidden' }}>
                  {renderPanel('input', sheetHeight, true)}
                </div>
                {!fsRenderActive && <PanelResizeHandle onMouseDown={handlePanelResizeMouseDown} />}
              </>
            )
          }
          // fullscreen 은 NotebookArea + CellAddBar(≈56px) 영역을 차지하므로 높이가 조금 더 큼
          // fullscreen 은 viewport 전체(단, 우측 사이드바 제외)를 차지
          const areaHeight = fsRenderActive ? viewportH : notebookAreaHeight
          const V_TOTAL = Math.max(areaHeight - CELL_HEADER - CONTENT_PAD - VIBE_CHAT - SAFETY, 200)
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
          const effectiveHeight = fsRenderActive
            ? V_TOTAL
            : userResizedRef.current
              ? panelHeight
              : (chartPreferredHeight ?? panelHeight)
          if (cell.splitMode && cell.splitDir === 'v') {
            const DIVIDER = 10
            const vTotal = effectiveHeight
            const topPx = Math.round((vTotal - DIVIDER) * vSplitRatio / 100)
            const bottomPx = vTotal - DIVIDER - topPx
            const topContent = Math.max(topPx - TAB_BAR, 60)
            const bottomContent = Math.max(bottomPx - TAB_BAR, 60)
            return (
              <>
                <div ref={splitContainerRef} style={{ height: vTotal }}>
                  <div {...panelAttrs('left')} style={{ height: topPx, overflow: 'hidden' }}>
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
                  <div {...panelAttrs('right')} style={{ height: bottomPx, overflow: 'hidden' }}>
                    {renderTabBar(cell.rightTab, (t) => setSplitTab(cell.id, 'right', t))}
                    {renderPanel(cell.rightTab, bottomContent)}
                  </div>
                </div>
                <PanelResizeHandle onMouseDown={handlePanelResizeMouseDown} />
              </>
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
                  <div ref={leftColRef} {...panelAttrs('left')} className="min-w-0 flex flex-col" style={{ height: effectiveHeight, overflow: 'hidden' }}>
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
                  <div {...panelAttrs('right')} className="min-w-0 flex flex-col" style={{ height: effectiveHeight, overflow: 'hidden' }}>
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
                <div {...panelAttrs('content')} style={{ height: effectiveHeight, overflow: 'hidden' }}>
                  {renderPanel(cell.activeTab, effectiveHeight, true)}
                </div>
                <PanelResizeHandle onMouseDown={handlePanelResizeMouseDown} />
              </>
            )
          }
          return (
            <>
              {renderTabBar(cell.activeTab, (t) => setCellTab(cell.id, t))}
              <div {...panelAttrs('content')} style={{ maxHeight: panelMaxHeight, overflow: 'auto' }}>
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

      {/* Vibe chat (active cell only) — sheet 셀은 별도 핸들러 사용 */}
      {isActive && (() => {
        const isSheet = cell.type === 'sheet'
        const effectiveVibing = isSheet ? sheetVibing : isVibing
        const submit = isSheet
          ? () => submitSheetVibe(cell.chatInput)
          : () => submitVibe(cell.id, cell.chatInput)
        const handleImageFiles = (files: FileList | File[] | null) => {
          if (!files) return
          Array.from(files).forEach((file) => {
            if (!file.type.startsWith('image/')) return
            const reader = new FileReader()
            reader.onload = (e) => {
              const dataUrl = e.target?.result as string
              const [header, data] = dataUrl.split(',')
              const mediaType = header.replace('data:', '').replace(';base64', '')
              const img: ImageAttachment = { id: crypto.randomUUID(), mediaType, data, previewUrl: dataUrl }
              updateCellChatImages(cell.id, [...(cell.chatImages ?? []), img])
            }
            reader.readAsDataURL(file)
          })
          if (imageInputRef.current) imageInputRef.current.value = ''
        }
        const placeholder = isSheet
          ? '시트를 수정해보세요 (Ctrl+Enter) — 예: 선택 영역 합계 아래 셀에'
          : cell.type === 'sql'
            ? '쿼리를 수정해보세요 (Ctrl+Enter 전송) — 예: 시도별로 group by 해줘'
            : cell.type === 'python'
              ? '코드를 수정해보세요 (Ctrl+Enter 전송) — 예: pie 차트로 바꿔줘'
              : '문서를 수정해보세요 (Ctrl+Enter 전송)'
        const busyLabel = isSheet ? '시트 업데이트 중' : '코드 생성 중'
        return (
        <div
          {...panelAttrs('vibe')}
          className={cn(
            'relative mx-4 rounded-2xl',
            fsRenderActive ? 'mt-3 mb-2' : 'mt-0 mb-2',
            !effectiveVibing && 'bg-surface border border-border-subtle shadow-sm'
          )}
          style={effectiveVibing ? {
            border: '1.5px solid transparent',
            backgroundImage: 'linear-gradient(rgb(var(--color-surface)),rgb(var(--color-surface))), linear-gradient(90deg,#D95C3F,#f0883e,#fbbf24,#f0883e,#D95C3F)',
            backgroundOrigin: 'border-box',
            backgroundClip: 'padding-box, border-box',
            backgroundSize: '300% 300%',
            animation: 'vibe-border-flow 2s linear infinite',
            boxShadow: '0 0 8px rgba(217,92,63,0.12)',
          } : undefined}
        >
          {/* 뒤 텍스트 가리기 + 상태 표시 */}
          {effectiveVibing && (
            <>
              <div className="absolute inset-0 rounded-2xl bg-surface z-[30]" />
              <div className="absolute inset-0 z-[40] flex flex-col items-center justify-center gap-1 pointer-events-none">
                <div className="flex items-center gap-1.5 text-primary-hover">
                  <Loader2 size={13} className="animate-spin" />
                  <span className="text-[12px] font-semibold">{busyLabel}</span>
                </div>
                {!isSheet && (
                  <span className="font-mono text-[11px] text-primary-hover/60">
                    {(vibeElapsed / 10).toFixed(1)}s
                  </span>
                )}
              </div>
              {!isSheet && (
                <button
                  title="생성 중지"
                  onClick={(e) => { e.stopPropagation(); cancelVibe(cell.id) }}
                  className="absolute top-1/2 right-3 -translate-y-1/2 z-[50] flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors bg-primary-light text-primary-hover border border-primary-border"
                >
                  <StopCircle size={12} />중지
                </button>
              )}
            </>
          )}

          {/* 이미지 미리보기 */}
          {(cell.chatImages ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5" style={{ zIndex: 10 }}>
              {(cell.chatImages ?? []).map((img) => (
                <div key={img.id} className="relative group/img">
                  <img src={img.previewUrl} alt="" className="w-12 h-12 object-cover rounded-lg border border-border" />
                  <button
                    title="이미지 제거"
                    onClick={() => updateCellChatImages(cell.id, (cell.chatImages ?? []).filter((i) => i.id !== img.id))}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface border border-border flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                  >
                    <XIcon size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 입력 영역 */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleImageFiles(e.target.files)}
          />
          <textarea
            ref={inputRef}
            data-vibe-chat-for={cell.id}
            className="w-full bg-transparent text-sm text-text-primary placeholder-text-tertiary focus:outline-none resize-none leading-relaxed overflow-hidden rounded-2xl"
            style={{
              minHeight: fsRenderActive ? '88px' : '56px',
              height: fsRenderActive ? '88px' : '56px',
              padding: '10px 48px 28px 16px',
              position: 'relative',
              zIndex: 10,
            }}
            placeholder={placeholder}
            disabled={effectiveVibing}
            value={cell.chatInput}
            onChange={(e) => {
              updateCellChatInput(cell.id, e.target.value)
              e.target.style.height = '44px'
              e.target.style.height = e.target.scrollHeight + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                if (!effectiveVibing && cell.chatInput.trim()) {
                  submit()
                  e.currentTarget.style.height = '44px'
                }
              }
            }}
            onPaste={(e) => {
              const imageFiles = Array.from(e.clipboardData.items)
                .filter((item) => item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null)
              if (imageFiles.length === 0) return
              e.preventDefault()
              handleImageFiles(imageFiles)
            }}
          />
          <div className="absolute right-3 bottom-2 w-8 h-8 rounded-full flex items-center justify-center transition-all" style={{ zIndex: 10 }}>
            <button
              title="바이브 전송"
              disabled={effectiveVibing || !cell.chatInput.trim()}
              onClick={() => submit()}
              className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed text-white',
                cell.chatInput.trim() && !effectiveVibing ? 'bg-primary' : 'bg-border-subtle'
              )}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
          <div className="absolute left-3 bottom-2.5 flex items-center gap-1.5" style={{ zIndex: 10 }}>
            <div className="relative flex items-center">
              <select
                value={vibeModel}
                onChange={(e) => setVibeModel(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                disabled={effectiveVibing}
                className="appearance-none text-[10px] font-medium text-text-disabled bg-transparent border-none pl-0 pr-4 py-0 cursor-pointer hover:text-text-secondary outline-none transition-colors disabled:cursor-not-allowed"
              >
                {VIBE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <ChevronDown size={9} className="absolute right-0 pointer-events-none text-text-disabled" />
            </div>
            {!isSheet && (
              <button
                title="이미지 첨부"
                disabled={effectiveVibing}
                onClick={(e) => { e.stopPropagation(); imageInputRef.current?.click() }}
                className="flex items-center justify-center text-text-disabled hover:text-text-secondary transition-colors disabled:cursor-not-allowed"
              >
                <Paperclip size={11} />
              </button>
            )}
          </div>
        </div>
        )
      })()}
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

// memo 로 감싸 부모(NotebookArea)가 cells.map 으로 다시 렌더링해도
// 자기 셀의 props (cell, index) 가 그대로면 리렌더 스킵.
// store 구독에서 발생한 변경(executingCells, vibingCells 등)은 useShallow 가
// 객체 동등성으로 감지해 정상적으로 리렌더 트리거함.
export default memo(CellContainer)
