import { useEffect, useRef, useState } from 'react'
import { PlusCircle, Loader2 } from 'lucide-react'
import LeftSidebar from '@/components/layout/LeftSidebar'
import TopMetaHeader from '@/components/layout/TopMetaHeader'
import RightNav from '@/components/layout/RightNav'
import NotebookArea from '@/components/cells/NotebookArea'
import CellAddBar from '@/components/layout/CellAddBar'
import AgentFAB from '@/components/agent/AgentFAB'
import AgentChatPanel from '@/components/agent/AgentChatPanel'
import RollbackToast from '@/components/common/RollbackToast'
import SnowflakeConnectionGuard from '@/components/common/SnowflakeConnectionGuard'
import ApiKeyGuard from '@/components/common/ApiKeyGuard'
import ReportModal from '@/components/reporting/ReportModal'
import ReportResult from '@/components/reporting/ReportResult'
import CellTypePicker from '@/components/common/CellTypePicker'
import ToastHost from '@/components/common/ToastHost'
import { useAppStore } from '@/store/useAppStore'
import { useModelStore } from '@/store/modelStore'

export default function App() {
  const agentMode = useAppStore((s) => s.agentMode)
  const loading = useAppStore((s) => s.loading)
  const creating = useAppStore((s) => s.creating)
  const createError = useAppStore((s) => s.createError)
  const notebookId = useAppStore((s) => s.notebookId)
  const initApp = useAppStore((s) => s.initApp)
  const newAnalysis = useAppStore((s) => s.newAnalysis)
  const theme = useModelStore((s) => s.theme)
  const [showCellPicker, setShowCellPicker] = useState(false)
  // showCellPicker 는 window keydown 핸들러(한 번만 등록됨) 에서 최신 값으로 참조하기 위해 ref 로도 보관
  const showCellPickerRef = useRef(false)
  useEffect(() => { showCellPickerRef.current = showCellPicker }, [showCellPicker])

  // persist 복원이 onRehydrateStorage 에서 이미 <html>.dark 를 적용하지만,
  // 세션 중 토글에도 반응하도록 마운트/변경 시점에 재동기화한다.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    initApp()
  }, [])

  // 패널이 바뀌었거나 선택된 패널이 DOM 에 없으면 활성 셀의 첫 패널을 자동 선택
  const activeCellId = useAppStore((s) => s.activeCellId)
  useEffect(() => {
    if (!notebookId) return
    const handle = requestAnimationFrame(() => {
      const s = useAppStore.getState()
      const all = Array.from(document.querySelectorAll<HTMLElement>('[data-cell-panel-key]'))
      if (all.length === 0) return
      const keys = all.map((el) => el.dataset.cellPanelKey ?? '')
      const currentCellId = s.selectedPanelKey?.split('::')[0] ?? null
      const selectedExists = !!s.selectedPanelKey && keys.includes(s.selectedPanelKey)

      // 활성 셀이 바뀌었고 현재 선택이 그 셀에 속하지 않으면 → 활성 셀의 첫 패널로
      if (s.activeCellId && currentCellId !== s.activeCellId) {
        const firstOfActive = keys.find((k) => k.startsWith(`${s.activeCellId}::`))
        if (firstOfActive) {
          s.setSelectedPanelKey(firstOfActive)
          return
        }
      }
      // 선택된 패널이 사라졌으면 첫 패널로 폴백
      if (!selectedExists) s.setSelectedPanelKey(keys[0])
    })
    return () => cancelAnimationFrame(handle)
  }, [notebookId, activeCellId])

  useEffect(() => {
    // 화살표 네비게이션 직후 짧은 시간 동안 focusin 에 의한 edit 모드 플립을 억제한다.
    // (전체화면 전환 중 CodeMirror 등이 spurious focusin 을 발사해 ring 이 잠깐 나타났다 사라지는 문제 방지)
    let navLockUntil = 0
    const NAV_LOCK_MS = 600
    function lockNavigation() {
      navLockUntil = Date.now() + NAV_LOCK_MS
    }
    function navLocked() {
      return Date.now() < navLockUntil
    }

    function getPanelList(): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>('[data-cell-panel-key]'))
    }
    function cellIdFromKey(key: string): string {
      return key.split('::')[0] ?? ''
    }
    function selectPanelByKey(key: string, scroll = true) {
      const s = useAppStore.getState()
      const cellId = cellIdFromKey(key)
      if (cellId && s.activeCellId !== cellId) s.setActiveCellId(cellId)
      s.setSelectedPanelKey(key)
      if (s.cellFocusMode !== 'command') s.setCellFocusMode('command')
      lockNavigation()
      if (scroll) {
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-cell-panel-key="${CSS.escape(key)}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
      }
    }

    function movePanel(direction: -1 | 1) {
      const s = useAppStore.getState()
      const list = getPanelList()
      if (list.length === 0) return
      const keys = list.map((el) => el.dataset.cellPanelKey ?? '')

      // 전체화면 모드: 현재 전체화면 셀의 패널 내에서만 이동, 끝에 닿으면 인접 셀로 스위치
      // (DOM 기반 flat 이동은 화면 밖에 있는 다른 셀 패널로 선택이 옮겨 시각적으로 "선택이 풀린 것처럼" 보이는 문제 방지)
      if (s.fullscreenCellId) {
        const fsId = s.fullscreenCellId
        const cellKeys = keys.filter((k) => k.startsWith(`${fsId}::`))
        const cellIdx = s.selectedPanelKey ? cellKeys.indexOf(s.selectedPanelKey) : -1
        const targetIdx = cellIdx + direction
        if (targetIdx >= 0 && targetIdx < cellKeys.length) {
          selectPanelByKey(cellKeys[targetIdx])
          return
        }
        // 경계 — 인접 셀로 전체화면 스위치
        const cellList = s.cells
        const curCellIdx = cellList.findIndex((c) => c.id === fsId)
        const nextCellIdx = curCellIdx + direction
        if (nextCellIdx < 0 || nextCellIdx >= cellList.length) return
        const nextCell = cellList[nextCellIdx]
        // 다음 셀의 실제 첫/마지막 패널 슬롯을 셀 상태로부터 계산해 키를 미리 확정 —
        // 낙관적으로 "::content" 를 쓰면 split 셀에서 존재하지 않는 키라 ring 이 일시적으로 사라진다.
        const isSplit = nextCell.splitMode && nextCell.type !== 'sheet'
        const initialSlot: 'content' | 'left' | 'right' | 'vibe' =
          direction === 1
            ? (isSplit ? 'left' : 'content')
            : 'vibe'
        const initialKey = `${nextCell.id}::${initialSlot}`
        useAppStore.setState({
          activeCellId: nextCell.id,
          fullscreenCellId: nextCell.id,
          selectedPanelKey: initialKey,
          cellFocusMode: 'command',
        })
        lockNavigation()
        // 전환 중 CodeMirror 등이 focusin 을 발사하더라도 navLock 이 edit 플립을 억제한다.
        // 그래도 활성 요소가 편집 요소로 남아 있으면 blur 하고 command 로 재확정.
        requestAnimationFrame(() => {
          const active = document.activeElement as HTMLElement | null
          if (active && (active.closest('.cm-content') || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
            active.blur()
          }
          const st = useAppStore.getState()
          if (st.cellFocusMode !== 'command') st.setCellFocusMode('command')
        })
        // 다음 프레임에 실제 DOM 에 있는 첫/마지막 패널로 보정 (split→non-split 전환 등 edge case 대비)
        requestAnimationFrame(() => {
          const latest = useAppStore.getState().selectedPanelKey
          const exists = !!document.querySelector(`[data-cell-panel-key="${CSS.escape(latest ?? '')}"]`)
          if (!exists) {
            const own = Array.from(document.querySelectorAll<HTMLElement>('[data-cell-panel-key]'))
              .map((el) => el.dataset.cellPanelKey ?? '')
              .filter((k) => k.startsWith(`${nextCell.id}::`))
            if (own.length > 0) {
              const pick = direction === -1 ? own[own.length - 1] : own[0]
              useAppStore.setState({ selectedPanelKey: pick })
            }
          }
          document.querySelector<HTMLElement>(`[data-cell-panel-key="${CSS.escape(useAppStore.getState().selectedPanelKey ?? '')}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
        return
      }

      // 일반 모드: DOM 문서 순서대로 flat 이동
      let idx = s.selectedPanelKey ? keys.indexOf(s.selectedPanelKey) : -1
      if (idx < 0) idx = direction === 1 ? -1 : 0
      const next = Math.max(0, Math.min(list.length - 1, idx + direction))
      if (next === idx) return
      selectPanelByKey(keys[next])
    }

    function reorderActiveCell(direction: -1 | 1) {
      const s = useAppStore.getState()
      const idx = s.cells.findIndex((c) => c.id === s.activeCellId)
      if (idx < 0) return
      const targetIdx = idx + direction
      if (targetIdx < 0 || targetIdx >= s.cells.length) return
      const from = s.cells[idx]
      const to = s.cells[targetIdx]
      s.reorderCells(from.id, to.id, direction === -1)
    }

    function focusSelectedPanel(): boolean {
      const s = useAppStore.getState()
      if (!s.selectedPanelKey) return false
      const host = document.querySelector<HTMLElement>(`[data-cell-panel-key="${CSS.escape(s.selectedPanelKey)}"]`)
      if (!host) return false

      // Sheet 패널은 툴바의 글꼴 select/input 이 먼저 잡히지 않도록 SheetEditor 에 focusGrid() 를 요청.
      const cellId = s.selectedPanelKey.split('::')[0]
      const cell = s.cells.find((c) => c.id === cellId)
      if (cell?.type === 'sheet') {
        window.dispatchEvent(new CustomEvent('vibe:focus-sheet-grid', { detail: { cellId } }))
        return true
      }

      // 포커스 우선순위: CodeMirror 에디터 → textarea → 일반 input → contentEditable
      const target =
        host.querySelector<HTMLElement>('.cm-content') ||
        host.querySelector<HTMLTextAreaElement>('textarea') ||
        host.querySelector<HTMLInputElement>('input') ||
        host.querySelector<HTMLElement>('[contenteditable="true"]')
      if (!target) return false
      target.focus()
      return true
    }

    function isEditingElement(el: Element | null): boolean {
      if (!el) return false
      if (el.closest('.cm-content')) return true
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true
      if ((el as HTMLElement).isContentEditable) return true
      return false
    }

    function onKeyDown(e: KeyboardEvent) {
      // 셀 타입 선택 팝업이 열려 있으면 팝업 내부에서만 키 처리 — 전역 단축키 차단
      // (단, 팝업 포커스를 잃어버렸을 때도 Esc 로는 닫을 수 있게 허용)
      if (showCellPickerRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowCellPicker(false)
        }
        return
      }

      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        useAppStore.getState().toggleAgentMode()
        return
      }
      // Cmd/Ctrl + B — 셀 타입 선택 팝업 열기
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        const s = useAppStore.getState()
        if (!s.notebookId) return
        e.preventDefault()
        setShowCellPicker(true)
        return
      }
      // Cmd/Ctrl + Shift + F — 활성 셀 전체화면 토글
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        const s = useAppStore.getState()
        if (!s.notebookId) return
        e.preventDefault()
        if (s.fullscreenCellId) {
          s.setFullscreenCellId(null)
        } else if (s.activeCellId) {
          s.setFullscreenCellId(s.activeCellId)
        }
        return
      }
      // Cmd/Ctrl + L — 활성 셀의 바이브 챗 입력으로 포커스 이동
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
        const s = useAppStore.getState()
        const id = s.activeCellId
        if (!id) return
        const el = document.querySelector<HTMLTextAreaElement>(`[data-vibe-chat-for="${id}"]`)
        if (el) {
          e.preventDefault()
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          el.focus()
        }
        return
      }

      const s = useAppStore.getState()
      const editing = isEditingElement(document.activeElement)

      // 편집 중 Esc → 커맨드 모드로 복귀 (편집기 블러)
      if (e.key === 'Escape' && editing) {
        const el = document.activeElement as HTMLElement | null
        el?.blur?.()
        s.setCellFocusMode('command')
        // 이후 모달 닫기 로직도 그대로 실행
      }

      // 커맨드 모드 네비게이션 — 편집 요소에 포커스 없을 때만
      if (!editing && s.notebookId && !mod && !e.shiftKey) {
        // Alt + ↑/↓ — 활성 셀 위/아래로 순서 이동
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          reorderActiveCell(e.key === 'ArrowUp' ? -1 : 1)
          return
        }
        // Alt + ←/→ — 활성 셀 분할 모드 순환 (단일 → 좌우 → 상하 → 단일)
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          const id = s.activeCellId
          if (!id) return
          const cell = s.cells.find((c) => c.id === id)
          if (!cell) return
          e.preventDefault()
          const modes = [
            { splitMode: false, splitDir: 'h' as const },
            { splitMode: true,  splitDir: 'h' as const },
            { splitMode: true,  splitDir: 'v' as const },
          ]
          const cur = modes.findIndex((m) => m.splitMode === cell.splitMode && m.splitDir === cell.splitDir)
          const dir = e.key === 'ArrowRight' ? 1 : -1
          const next = modes[(cur + dir + modes.length) % modes.length]
          if (!next.splitMode) {
            s.toggleCellSplitMode(id)
          } else {
            s.setCellSplitDir(id, next.splitDir)
          }
          return
        }
        // ↑/↓ — 선택된 패널 변경 (입력/출력/메모/바이브챗)
        if (!e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          movePanel(e.key === 'ArrowUp' ? -1 : 1)
          return
        }
        // ←/→ — 선택된 패널의 탭(입력/출력/메모) 전환
        if (!e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          const key = s.selectedPanelKey
          if (!key) return
          const [cellId, slot] = key.split('::')
          if (slot === 'vibe') return
          const cell = s.cells.find((c) => c.id === cellId)
          if (!cell || cell.type === 'sheet') return
          const tabs = ['input', 'output', 'memo'] as const
          type Tab = typeof tabs[number]
          const current: Tab =
            slot === 'left' ? (cell.leftTab as Tab) :
            slot === 'right' ? (cell.rightTab as Tab) :
            (cell.activeTab as Tab)
          const dir = e.key === 'ArrowLeft' ? -1 : 1
          const idx = tabs.indexOf(current)
          const next = tabs[(idx + dir + tabs.length) % tabs.length]
          e.preventDefault()
          if (slot === 'left') s.setSplitTab(cellId, 'left', next)
          else if (slot === 'right') s.setSplitTab(cellId, 'right', next)
          else s.setCellTab(cellId, next)
          return
        }
        // Enter — 선택된 패널의 편집기로 진입
        if (!e.altKey && e.key === 'Enter') {
          if (focusSelectedPanel()) {
            e.preventDefault()
            s.setCellFocusMode('edit')
            return
          }
        }
      }

      if (e.key === 'Escape') {
        let closed = false
        if (s.showReport) { s.setShowReport(false); closed = true }
        if (s.showReportModal) { s.setShowReportModal(false); closed = true }
        if (s.agentMode) { s.toggleAgentMode(); closed = true }
        window.dispatchEvent(new CustomEvent('vibe:close-popups'))
        if (closed) e.preventDefault()
      }
    }

    // 편집 요소에 포커스가 들어오면 edit 모드, 빠지면 command 모드로.
    function onFocusIn(e: FocusEvent) {
      // 화살표 네비게이션 직후의 spurious focusin 은 무시 — edit 모드로 플립되어 ring 이 사라지는 것을 방지
      if (navLocked()) {
        const target = e.target as HTMLElement | null
        // 네비게이션 중이면 편집 요소에 들어온 포커스를 강제로 blur
        if (target && isEditingElement(target)) target.blur()
        return
      }
      const s = useAppStore.getState()
      if (isEditingElement(e.target as Element)) {
        if (s.cellFocusMode !== 'edit') s.setCellFocusMode('edit')
      }
    }
    function onFocusOut() {
      // focusout 직후 activeElement 가 body 로 떨어질 수 있어 마이크로태스크로 확인
      setTimeout(() => {
        if (!isEditingElement(document.activeElement)) {
          const s = useAppStore.getState()
          if (s.cellFocusMode !== 'command') s.setCellFocusMode('command')
        }
      }, 0)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('focusin', onFocusIn)
    window.addEventListener('focusout', onFocusOut)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex w-full h-full bg-bg-page items-center justify-center">
        <span className="text-text-secondary text-sm">불러오는 중...</span>
      </div>
    )
  }

  return (
    <div className="flex w-full h-full bg-bg-page overflow-hidden">
      {/* Left sidebar */}
      <LeftSidebar />

      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {notebookId === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <button
              onClick={newAnalysis}
              disabled={creating}
              title="새 분석 만들기"
              className="flex flex-col items-center gap-3 text-text-tertiary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors group"
            >
              {creating ? (
                <Loader2 size={48} strokeWidth={1.2} className="animate-spin" />
              ) : (
                <PlusCircle size={48} strokeWidth={1.2} className="group-hover:scale-105 transition-transform" />
              )}
              <span className="text-sm font-medium">
                {creating ? '생성 중...' : '새 분석 만들기'}
              </span>
            </button>
            {createError && (
              <p className="text-xs text-danger max-w-xs text-center">{createError}</p>
            )}
          </div>
        ) : (
          <>
            {/* Top meta header */}
            <TopMetaHeader />

            {/* Center + Right */}
            <div className="flex flex-1 overflow-hidden">
              {/* Notebook area */}
              <div className="flex flex-col flex-1 overflow-hidden relative">
                <NotebookArea />
                <CellAddBar />
              </div>

              {/* Right nav */}
              <RightNav />
            </div>
          </>
        )}
      </div>

      {/* 전체화면 중 RightNav 윗부분(TopMetaHeader 우측 영역)도 사이드바 배경으로 덮기 */}
      <FullscreenRightStrip />

      {/* Floating elements */}
      {notebookId !== null && <AgentFAB />}
      {agentMode && <AgentChatPanel />}
      <RollbackToast />
      <ToastHost />
      <SnowflakeConnectionGuard />
      <ApiKeyGuard />

      {/* Modals */}
      <ReportModal />
      <ReportResult />
      {showCellPicker && (
        <CellTypePicker
          onSelect={(type) => {
            const s = useAppStore.getState()
            s.addCell(type, s.activeCellId)
            setShowCellPicker(false)
          }}
          onClose={() => setShowCellPicker(false)}
        />
      )}
    </div>
  )
}

function FullscreenRightStrip() {
  const fullscreenCellId = useAppStore((s) => s.fullscreenCellId)
  if (!fullscreenCellId) return null
  return (
    <div
      className="fixed top-0 right-0 h-header bg-bg-pane z-[110] pointer-events-none border-b border-border-subtle"
      style={{ width: 'var(--right-nav-width, 256px)' }}
    />
  )
}
