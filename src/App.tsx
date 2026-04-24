import { useEffect, useState } from 'react'
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
        // ↑/↓ — 선택된 패널 변경 (입력/출력/메모/바이브챗)
        if (!e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          movePanel(e.key === 'ArrowUp' ? -1 : 1)
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
