import { useEffect } from 'react'
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

  // persist 복원이 onRehydrateStorage 에서 이미 <html>.dark 를 적용하지만,
  // 세션 중 토글에도 반응하도록 마운트/변경 시점에 재동기화한다.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    initApp()
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        useAppStore.getState().toggleAgentMode()
        return
      }
      // Cmd/Ctrl + B — 활성 셀 아래에 새 셀(활성 셀과 동일 타입, 없으면 SQL) 추가
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        const s = useAppStore.getState()
        if (!s.notebookId) return
        e.preventDefault()
        const active = s.cells.find((c) => c.id === s.activeCellId)
        s.addCell(active?.type ?? 'sql', s.activeCellId)
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
      if (e.key === 'Escape') {
        const s = useAppStore.getState()
        let closed = false
        if (s.showReport) { s.setShowReport(false); closed = true }
        if (s.showReportModal) { s.setShowReportModal(false); closed = true }
        if (s.agentMode) { s.toggleAgentMode(); closed = true }
        window.dispatchEvent(new CustomEvent('vibe:close-popups'))
        if (closed) e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
