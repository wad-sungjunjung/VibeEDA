import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Settings,
  History,
  FolderPlus,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Copy,
  Trash2,
  X,
  User,
  Plus,
  FileText,
  File,
  FileSpreadsheet,
  FileJson,
  FileCode,
  FileImage,
  FileArchive,
  HardDrive,
  RefreshCw,
  Upload,
  FilePlus,
  Check,
  Sun,
  Moon,
  ExternalLink,
} from 'lucide-react'
import type { FileNode } from '@/lib/api'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import { useConnectionStore } from '@/store/connectionStore'
import { useModelStore } from '@/store/modelStore'
import { cn } from '@/lib/utils'
import { toast } from '@/store/useToastStore'
import ModelSettingsModal from '@/components/common/ModelSettingsModal'
import ConnectionModal from '@/components/common/ConnectionModal'
import HelpModal from '@/components/common/HelpModal'
import catchtableIcon from '@/assets/catchtable-icon.png'

export default function LeftSidebar() {
  const {
    histories,
    folders,
    historyMenuOpen,
    historyMenuView,
    addFolder,
    deleteFolder,
    toggleFolder,
    duplicateHistory,
    deleteHistory,
    moveHistory,
    setHistoryMenuOpen,
    setHistoryMenuView,
    newAnalysis,
    loadAnalysis,
    reports,
    openReport,
    removeReport,
    currentReportId,
    filesTree,
    filesRoot,
    filesLoading,
    fetchFilesTree,
  } = useAppStore(useShallow((s) => ({
    histories: s.histories,
    folders: s.folders,
    historyMenuOpen: s.historyMenuOpen,
    historyMenuView: s.historyMenuView,
    addFolder: s.addFolder,
    deleteFolder: s.deleteFolder,
    toggleFolder: s.toggleFolder,
    duplicateHistory: s.duplicateHistory,
    deleteHistory: s.deleteHistory,
    moveHistory: s.moveHistory,
    setHistoryMenuOpen: s.setHistoryMenuOpen,
    setHistoryMenuView: s.setHistoryMenuView,
    newAnalysis: s.newAnalysis,
    loadAnalysis: s.loadAnalysis,
    reports: s.reports,
    openReport: s.openReport,
    removeReport: s.removeReport,
    currentReportId: s.currentReportId,
    filesTree: s.filesTree,
    filesRoot: s.filesRoot,
    filesLoading: s.filesLoading,
    fetchFilesTree: s.fetchFilesTree,
  })))

  const sfUser = useConnectionStore((s) => s.sfUser)
  const sfConnected = useConnectionStore((s) => s.isConnected)
  const displayName = sfUser ? sfUser.split('@')[0] : '하우'
  const theme = useModelStore((s) => s.theme)
  const toggleTheme = useModelStore((s) => s.toggleTheme)
  const geminiKey = useModelStore((s) => s.geminiApiKey)
  const anthropicKey = useModelStore((s) => s.anthropicApiKey)
  const hasModelKey = !!(geminiKey || anthropicKey)

  const [addingFolder, setAddingFolder] = useState(false)
  const [folderInput, setFolderInput] = useState('')
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [showConnection, setShowConnection] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const [memUsed, setMemUsed] = useState<number | null>(null)
  const [memTotal, setMemTotal] = useState<number | null>(null)
  const [memPeak, setMemPeak] = useState<number | null>(null)

  useEffect(() => {
    async function fetchMem() {
      try {
        const res = await fetch('http://localhost:4750/v1/system/memory')
        if (!res.ok) return
        const d = await res.json()
        setMemUsed(d.used_bytes)
        setMemTotal(d.total_bytes)
        setMemPeak(prev => prev === null ? d.used_bytes : Math.max(prev, d.used_bytes))
      } catch {}
    }
    fetchMem()
    const id = setInterval(fetchMem, 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    function onClose() {
      setShowModelSettings(false)
      setShowConnection(false)
      setShowHelp(false)
      setAddingFolder(false)
      setHistoryMenuOpen(null)
    }
    window.addEventListener('vibe:close-popups', onClose)
    function onOpenConnection() { setShowConnection(true) }
    window.addEventListener('vibe:open-connection', onOpenConnection)
    function onOpenModelSettings() { setShowModelSettings(true) }
    window.addEventListener('vibe:open-model-settings', onOpenModelSettings)
    return () => {
      window.removeEventListener('vibe:close-popups', onClose)
      window.removeEventListener('vibe:open-connection', onOpenConnection)
      window.removeEventListener('vibe:open-model-settings', onOpenModelSettings)
    }
  }, [setHistoryMenuOpen])

  function handleAddFolder() {
    if (folderInput.trim()) {
      addFolder(folderInput.trim())
    }
    setAddingFolder(false)
    setFolderInput('')
  }

  const rootHistories = histories.filter((h) => !h.folderId)

  return (
    <aside className="w-sidebar-left h-full flex flex-col bg-bg-sidebar border-r border-border-subtle shrink-0">
      {/* Logo */}
      <div className="h-header flex items-center gap-2 px-4 border-b border-border-subtle">
        <img
          src={catchtableIcon}
          alt="Catchtable"
          className="w-7 h-7 rounded-lg shrink-0"
          style={{
            // 톤앤매너: 원본 주황을 앱 primary(#D95C3F) 톤으로 살짝 당김
            filter: 'saturate(0.85) hue-rotate(-8deg) brightness(0.95)',
            boxShadow: '0 1px 2px rgba(217,92,63,0.25)',
          }}
        />
        <div>
          <div className="text-[13px] font-semibold text-text-primary leading-tight">Vibe EDA</div>
          <div className="text-[10px] text-text-tertiary">분석가용 AI EDA</div>
        </div>
      </div>

      {/* New analysis button */}
      <div className="px-3 py-2 border-b border-border-subtle">
        <button
          onClick={newAnalysis}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-semibold text-white transition-colors bg-primary hover:bg-primary-hover"
        >
          <Plus size={14} />
          새 분석 만들기
        </button>
      </div>

      {/* Unified 폴더 tree (filesystem) */}
      <UnifiedFolderSection
        tree={filesTree}
        root={filesRoot}
        loading={filesLoading}
        onRefresh={() => void fetchFilesTree()}
        currentNotebookId={useAppStore.getState().notebookId}
        currentReportId={currentReportId}
        onOpenNotebook={(id) => loadAnalysis(id)}
        onOpenReport={(id) => openReport(id)}
      />

      {/* History: 전체 분석 (폴더 위치 포함 서브타이틀) */}
      <div className="flex items-center px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary font-semibold uppercase tracking-wide">
          <History size={12} />
          히스토리
        </div>
      </div>
      <div className="flex-1 overflow-y-auto hide-scrollbar px-2 pb-2 space-y-0.5">
        {(() => {
          // filesTree 로부터: notebook_id → {folderName, path} · 루트 폴더 리스트
          const nbInfo = new Map<string, { folderName: string | null; path: string }>()
          const rootFolders: { name: string; path: string }[] = []
          const walk = (nodes: typeof filesTree, parent: string | null) => {
            for (const n of nodes) {
              if (n.type === 'folder') {
                if (parent === null) rootFolders.push({ name: n.name, path: n.path })
                if (n.children) walk(n.children, n.name)
              } else if (n.kind === 'notebook' && n.notebook_id) {
                nbInfo.set(n.notebook_id, { folderName: parent, path: n.path })
              }
            }
          }
          walk(filesTree, null)

          // nbInfo 에 없는 항목도 표시 — 이동 후 id_to_file 미갱신 등의 엣지케이스 대응
          if (histories.length === 0) {
            return <div className="px-2 py-1 text-[11px] text-text-disabled italic">분석 없음</div>
          }
          return histories.map((h) => {
            const info = nbInfo.get(h.id) ?? null
            return (
              <HistoryItemRow
                key={h.id}
                item={h}
                folderName={info?.folderName ?? null}
                notebookPath={info?.path ?? ''}
                rootPath={filesRoot}
                rootFolders={rootFolders}
                menuOpen={historyMenuOpen === h.id}
                menuView={historyMenuView}
                onMenuOpen={() => setHistoryMenuOpen(h.id)}
                onMenuClose={() => setHistoryMenuOpen(null)}
                onMenuView={setHistoryMenuView}
                onDuplicate={() => duplicateHistory(h.id)}
                onDelete={() => deleteHistory(h.id)}
                onLoad={() => loadAnalysis(h.id)}
                onRefresh={() => void fetchFilesTree()}
              />
            )
          })
        })()}
      </div>

      {/* Settings + Memory */}
      <div className="px-3 pt-2 pb-2 border-t border-border-subtle">
        <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-tertiary font-semibold uppercase tracking-wide">
          <Settings size={12} />
          설정
        </div>
        <SettingsRow
          label="연결 관리"
          onClick={() => setShowConnection(true)}
          ok={sfConnected}
          okLabel="연결됨"
          offLabel="끊김"
        />
        <SettingsRow
          label="모델 설정"
          onClick={() => setShowModelSettings(true)}
          ok={hasModelKey}
          okLabel="키 등록됨"
          offLabel="키 없음"
        />
        <button
          onClick={() => setShowHelp(true)}
          className="w-full text-left px-2 py-1.5 text-[12px] text-text-secondary hover:bg-primary-light hover:text-primary rounded transition-colors"
        >
          도움말
        </button>

      </div>

      {/* Memory bar */}
      {memUsed !== null && memTotal !== null && (
        <div className="px-4 pb-2 pt-2 border-t border-border-subtle">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-text-tertiary font-medium">메모리</span>
            <span className="text-[10px] text-text-tertiary tabular-nums">
              {(memUsed / 1024 / 1024).toFixed(0)}
              <span className="text-text-disabled"> / </span>
              {(memTotal / 1024 / 1024 / 1024).toFixed(1)} GB
            </span>
          </div>
          <div className="relative h-1.5 rounded-full bg-chip overflow-hidden">
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${Math.min((memUsed / memTotal) * 100, 100)}%` }}
            />
            {memPeak !== null && (
              <div
                className="absolute top-0 h-full w-0.5 bg-warning opacity-70"
                style={{ left: `${Math.min((memPeak / memTotal) * 100, 100)}%` }}
                title={`최대: ${(memPeak / 1024 / 1024).toFixed(0)} MB`}
              />
            )}
          </div>
          {memPeak !== null && (
            <div className="flex items-center justify-between mt-0.5">
              <button
                onClick={() => setMemPeak(null)}
                title="최대값 초기화"
                className="text-[9px] text-text-disabled hover:text-danger transition-colors"
              >
                초기화
              </button>
              <span className="text-[9px] text-text-disabled tabular-nums">
                최대 {(memPeak / 1024 / 1024).toFixed(0)} MB
              </span>
            </div>
          )}
        </div>
      )}

      {/* Profile */}
      <div className="h-header flex items-center gap-2 px-4 border-t border-border-subtle">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary-pale to-primary flex items-center justify-center shrink-0">
          <User size={14} className="text-white" />
        </div>
        <span className="flex-1 text-[12px] font-medium text-text-secondary truncate" title={sfUser || displayName}>{displayName}</span>
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
          className="shrink-0 p-1.5 rounded text-text-tertiary hover:text-primary hover:bg-primary-light transition-colors"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      {showModelSettings && (
        <ModelSettingsModal onClose={() => setShowModelSettings(false)} />
      )}
      {showConnection && (
        <ConnectionModal onClose={() => setShowConnection(false)} />
      )}
      {showHelp && (
        <HelpModal onClose={() => setShowHelp(false)} />
      )}
    </aside>
  )
}

interface HistoryItemRowProps {
  item: ReturnType<typeof useAppStore.getState>['histories'][number]
  folderName: string | null
  notebookPath: string
  rootPath: string
  rootFolders: { name: string; path: string }[]
  menuOpen: boolean
  menuView: 'main' | 'move'
  onMenuOpen: () => void
  onMenuClose: () => void
  onMenuView: (v: 'main' | 'move') => void
  onDuplicate: () => void
  onDelete: () => void
  onLoad: () => void
  onRefresh: () => void
}

function HistoryItemRow({
  item,
  folderName,
  notebookPath,
  rootPath,
  rootFolders,
  menuOpen,
  menuView,
  onMenuOpen,
  onMenuClose,
  onMenuView,
  onDuplicate,
  onDelete,
  onLoad,
  onRefresh,
}: HistoryItemRowProps) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  function handleMenuToggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (menuOpen) {
      onMenuClose()
    } else {
      const rect = btnRef.current?.getBoundingClientRect()
      if (rect) setMenuPos({ x: rect.right + 4, y: rect.top })
      onMenuOpen()
    }
  }

  return (
    <div
      className={cn(
        'group relative flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer',
        item.isCurrent ? 'bg-surface border border-primary-border' : 'hover:bg-surface'
      )}
      onClick={() => { if (!item.isCurrent) onLoad() }}
    >
      <div className="flex-1 min-w-0">
        <div className={cn(
          'text-[12px] truncate',
          item.isCurrent ? 'text-primary-text font-medium' : 'text-text-secondary'
        )}>
          {item.title}
        </div>
        <div className="text-[10px] text-text-disabled truncate flex items-center gap-1">
          <span>{item.date}</span>
          {folderName && (
            <>
              <span>·</span>
              <Folder size={9} className="shrink-0" />
              <span className="truncate">{folderName}</span>
            </>
          )}
        </div>
      </div>
      <button
        ref={btnRef}
        title="더보기"
        onClick={handleMenuToggle}
        className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-text-secondary rounded transition-opacity"
      >
        <MoreHorizontal size={14} />
      </button>

      {/* Context menu — rendered via portal to escape overflow:hidden parents */}
      {menuOpen && createPortal(
        <div
          className="fixed z-[9999] bg-surface border border-border rounded-md shadow-lg py-1 min-w-[140px]"
          style={{ left: menuPos.x, top: menuPos.y }}
          onMouseLeave={onMenuClose}
        >
          {menuView === 'main' ? (
            <>
              {notebookPath && (
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-chip"
                  onClick={() => onMenuView('move')}
                >
                  <Folder size={12} />
                  이동
                  <ChevronRight size={10} className="ml-auto" />
                </button>
              )}
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-chip"
                onClick={onDuplicate}
              >
                <Copy size={12} />
                복제
              </button>
              <div className="border-t border-bg-sidebar my-0.5" />
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-danger hover:bg-danger-bg"
                onClick={onDelete}
              >
                <Trash2 size={12} />
                삭제
              </button>
            </>
          ) : (
            <>
              <button
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-chip"
                onClick={() => onMenuView('main')}
              >
                <ChevronRight size={10} className="rotate-180" />
                이동할 위치
              </button>
              <div className="border-t border-bg-sidebar my-0.5" />
              <button
                className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-text-secondary hover:bg-chip"
                onClick={async () => {
                  if (folderName === null) { onMenuClose(); return }
                  try {
                    const api = await import('@/lib/api')
                    await api.moveEntry(notebookPath, rootPath)
                    onRefresh()
                  } catch (e) {
                    onRefresh()  // stale 경로로 실패했을 수 있으니 트리 새로고침
                    const msg = (e as Error).message || ''
                    if (msg.includes('src not found')) {
                      alert('경로가 변경됐어요 (최근에 제목을 바꾸셨나요?). 사이드바를 새로고침했으니 다시 시도해주세요.')
                    } else {
                      alert(`이동 실패: ${msg}`)
                    }
                  } finally {
                    onMenuClose()
                  }
                }}
              >
                <span className="flex items-center gap-2">
                  <History size={12} />
                  루트
                </span>
                {folderName === null && <span className="text-primary text-[10px]">✓</span>}
              </button>
              {rootFolders.map((f) => (
                <button
                  key={f.path}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-text-secondary hover:bg-chip"
                  onClick={async () => {
                    if (folderName === f.name) { onMenuClose(); return }
                    try {
                      const api = await import('@/lib/api')
                      await api.moveEntry(notebookPath, f.path)
                      onRefresh()
                    } catch (e) {
                      onRefresh()  // stale 경로로 실패했을 수 있으니 트리 새로고침
                      const msg = (e as Error).message || ''
                      if (msg.includes('src not found')) {
                        alert('경로가 변경됐어요 (최근에 제목을 바꾸셨나요?). 사이드바를 새로고침했으니 다시 시도해주세요.')
                      } else {
                        alert(`이동 실패: ${msg}`)
                      }
                    } finally {
                      onMenuClose()
                    }
                  }}
                >
                  <span className="flex items-center gap-2">
                    <Folder size={12} />
                    {f.name}
                  </span>
                  {folderName === f.name && <span className="text-primary text-[10px]">✓</span>}
                </button>
              ))}
              {rootFolders.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-text-disabled">
                  폴더를 먼저 만드세요
                </div>
              )}
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── Unified 폴더 section (filesystem-backed) ─────────────────────────────────

function fileIconFor(node: FileNode) {
  if (node.kind === 'notebook') return FileCode
  if (node.kind === 'report') return FileText
  const e = (node.ext || '').toLowerCase()
  if (['csv', 'tsv', 'xlsx', 'xls', 'parquet', 'feather'].includes(e)) return FileSpreadsheet
  if (['json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml'].includes(e)) return FileJson
  if (['py', 'sql', 'js', 'ts', 'tsx', 'jsx', 'sh'].includes(e)) return FileCode
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(e)) return FileImage
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(e)) return FileArchive
  if (e === 'md' || e === 'txt') return FileText
  return File
}

function formatSize(n: number | undefined): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`
}

function UnifiedFolderSection({
  tree, root, loading, onRefresh,
  currentNotebookId, currentReportId,
  onOpenNotebook, onOpenReport,
}: {
  tree: FileNode[]
  root: string
  loading: boolean
  onRefresh: () => void
  currentNotebookId: string | null
  currentReportId: string | null
  onOpenNotebook: (id: string) => void
  onOpenReport: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<{ok: string[]; fail: string[]; dstLabel: string} | null>(null)
  const [rootDragOver, setRootDragOver] = useState(false)
  const submittingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchFilesTree = useAppStore((s) => s.fetchFilesTree)

  async function handleRootDrop(e: React.DragEvent) {
    e.preventDefault()
    setRootDragOver(false)
    // 외부 파일 드롭 → 루트에 업로드
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleUpload(e.dataTransfer.files, '')
      return
    }
    // 내부 드래그 → 루트로 이동
    const srcPath = e.dataTransfer.getData('application/x-vibe-path')
    if (!srcPath) return
    const srcParent = srcPath.substring(0, srcPath.lastIndexOf('/'))
    if (srcParent === root) return
    try {
      const api = await import('@/lib/api')
      await api.moveEntry(srcPath, root)
      await fetchFilesTree()
    } catch (err) {
      alert(`이동 실패: ${(err as Error).message}`)
      await fetchFilesTree()
    }
  }

  async function handleUpload(fileList: FileList | null, dstDir: string = '') {
    // FileList 는 <input> 을 참조하는 라이브 객체라 input.value='' 로 reset 되면 비어진다.
    // 첫 await 이전에 plain array 로 스냅샷을 떠야 함 (onChange 의 다음 라인이 input 을 reset 함).
    const files = fileList ? Array.from(fileList) : []
    if (files.length === 0) return
    setUploading(true)
    setUploadStatus(null)
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    const api = await import('@/lib/api')
    const ok: string[] = []
    const fail: string[] = []
    try {
      for (const f of files) {
        try {
          const r = await api.uploadFile(f, dstDir)
          ok.push(r.name)
        } catch (e) {
          fail.push(`${f.name}: ${(e as Error).message}`)
        }
      }
      await fetchFilesTree().catch(() => {})
    } finally {
      setUploading(false)
    }
    if (ok.length === 0 && fail.length === 0) return
    const dstLabel = dstDir ? (dstDir.split(/[\\/]/).pop() || '폴더') : '루트'
    setUploadStatus({ ok, fail, dstLabel })
    statusTimerRef.current = setTimeout(() => setUploadStatus(null), 4000)
    if (fail.length > 0) {
      toast.error(
        `업로드 실패 (${fail.length}개)`,
        fail.join('\n'),
      )
    }
  }

  // FileTreeNode(자식) 의 폴더 업로드 결과도 여기 배너로 받아 표시
  useEffect(() => {
    function onUploadStatus(e: Event) {
      const detail = (e as CustomEvent<{ok: string[]; fail: string[]; dstLabel: string}>).detail
      if (!detail) return
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
      setUploadStatus(detail)
      statusTimerRef.current = setTimeout(() => setUploadStatus(null), 4000)
    }
    function onUploadStart() { setUploading(true) }
    function onUploadEnd() { setUploading(false) }
    window.addEventListener('vibe:upload-status', onUploadStatus)
    window.addEventListener('vibe:upload-start', onUploadStart)
    window.addEventListener('vibe:upload-end', onUploadEnd)
    return () => {
      window.removeEventListener('vibe:upload-status', onUploadStatus)
      window.removeEventListener('vibe:upload-start', onUploadStart)
      window.removeEventListener('vibe:upload-end', onUploadEnd)
    }
  }, [])

  async function createRootFolder() {
    // 동기 guard — React state 는 비동기라 중복 호출 막으려면 ref 필요
    if (submittingRef.current) return
    const trimmed = name.trim()
    if (!trimmed) { setAdding(false); return }
    submittingRef.current = true
    try {
      const api = await import('@/lib/api')
      await api.mkdirFolder(root, trimmed)
    } catch (e) {
      const msg = (e as Error).message
      // 트리 먼저 동기화 (409 인 경우에도 실제 폴더는 있으니 UI 반영되어야 함)
      await fetchFilesTree()
      if (msg.includes('409') || msg.includes('already exists')) {
        alert(`"${trimmed}" 폴더가 이미 존재합니다. (왼쪽 트리에 반영되었습니다)`)
      } else {
        alert(`폴더 생성 실패: ${msg}`)
      }
      setAdding(false); setName('')
      submittingRef.current = false
      return
    }
    setAdding(false); setName('')
    await fetchFilesTree()
    submittingRef.current = false
  }

  return (
    <div className="border-b border-border-subtle flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        <button
          className="flex items-center gap-1.5 text-[11px] text-text-tertiary font-semibold uppercase tracking-wide hover:text-text-secondary"
          onClick={() => setExpanded((v) => !v)}
          title={root ? `루트: ${root}` : '폴더'}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <HardDrive size={12} />
          폴더
        </button>
        <div className="flex items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".csv,.tsv,.xlsx,.xls,.parquet,.json,.txt,.md,.ipynb"
            style={{ display: 'none' }}
            onChange={(e) => {
              void handleUpload(e.target.files, '')
              if (fileInputRef.current) fileInputRef.current.value = ''
            }}
          />
          <button
            type="button"
            title="파일 업로드 (csv, xlsx, parquet, tsv, json, ipynb 등)"
            onClick={(e) => {
              e.stopPropagation()
              if (uploading) return
              fileInputRef.current?.click()
            }}
            className={cn(
              'p-1 text-text-tertiary hover:text-primary hover:bg-primary-light rounded transition-colors',
              uploading && 'opacity-50 cursor-wait',
            )}
          >
            <Upload size={14} className={cn(uploading && 'animate-pulse')} />
          </button>
          <button
            title="파일 탐색기에서 폴더 열기"
            onClick={async () => {
              try {
                const api = await import('@/lib/api')
                await api.openFolderInExplorer()
              } catch (e) {
                console.error('폴더 열기 실패:', e)
              }
            }}
            className="p-1 text-text-tertiary hover:text-primary hover:bg-primary-light rounded transition-colors"
          >
            <ExternalLink size={12} />
          </button>
          <button
            title="새 폴더"
            onClick={() => setAdding(true)}
            className="p-1 text-text-tertiary hover:text-primary hover:bg-primary-light rounded transition-colors"
          >
            <FolderPlus size={14} />
          </button>
          <button
            title="새로고침"
            onClick={onRefresh}
            className={cn(
              'p-1 text-text-tertiary hover:text-primary hover:bg-primary-light rounded transition-colors',
              loading && 'animate-spin text-primary',
            )}
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>
      {uploading && (
        <div className="mx-3 mb-2 px-2 py-1.5 text-[11px] text-primary-hover bg-primary-pale border border-primary-border rounded flex items-center gap-1.5">
          <Upload size={11} className="animate-pulse" />
          업로드 중…
        </div>
      )}
      {uploadStatus && !uploading && (uploadStatus.ok.length > 0 || uploadStatus.fail.length > 0) && (
        <div className={cn(
          'mx-3 mb-2 px-2 py-1.5 text-[11px] rounded border flex flex-col gap-0.5',
          uploadStatus.fail.length === 0
            ? 'text-success bg-success-bg border-success/30'
            : 'text-warning-text bg-warning-bg border-warning/30',
        )}>
          {uploadStatus.ok.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Check size={11} className="shrink-0" />
              <span className="truncate" title={uploadStatus.ok.join(', ')}>
                {uploadStatus.ok.length}개 파일 → <b>{uploadStatus.dstLabel}</b>
              </span>
            </div>
          )}
          {uploadStatus.fail.length > 0 && (
            <div className="flex items-start gap-1.5">
              <X size={11} className="shrink-0 mt-0.5" />
              <span className="truncate" title={uploadStatus.fail.join('\n')}>
                {uploadStatus.fail.length}개 실패
              </span>
            </div>
          )}
        </div>
      )}
      {adding && (
        <div className="mx-3 mb-2 flex items-center gap-1 bg-surface border border-border rounded px-2 py-1 shrink-0">
          <Folder size={12} className="text-text-tertiary shrink-0" />
          <input
            autoFocus
            className="flex-1 text-[12px] bg-transparent outline-none"
            placeholder="폴더 이름"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createRootFolder()
              if (e.key === 'Escape') { setAdding(false); setName('') }
            }}
          />
          <button onClick={() => void createRootFolder()} className="text-[11px] text-primary font-medium hover:underline">추가</button>
          <button onClick={() => { setAdding(false); setName('') }} className="text-text-tertiary hover:text-danger">
            <X size={12} />
          </button>
        </div>
      )}
      {expanded && (
        <div
          className={cn(
            'px-2 pb-2 flex-1 overflow-y-auto hide-scrollbar min-h-0 transition-colors',
            rootDragOver && 'bg-primary-pale ring-1 ring-primary rounded',
          )}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move' }}
          onDragEnter={(e) => { e.preventDefault(); setRootDragOver(true) }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setRootDragOver(false) }}
          onDrop={(e) => void handleRootDrop(e)}
        >
          {tree.length === 0 && !loading && (
            <div className="px-2 py-1 text-[11px] text-text-disabled italic">
              비어있음 — 우측 상단 + 로 폴더 생성
            </div>
          )}
          {tree
            // 루트 수준의 ipynb 는 히스토리 섹션에서 보여주므로 트리에서 중복 표시 생략
            .filter((n) => !(n.type === 'file' && n.kind === 'notebook'))
            .map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                depth={0}
                currentNotebookId={currentNotebookId}
                currentReportId={currentReportId}
                onOpenNotebook={onOpenNotebook}
                onOpenReport={onOpenReport}
              />
            ))}
        </div>
      )}
    </div>
  )
}

function FileTreeNode({
  node, depth, currentNotebookId, currentReportId, onOpenNotebook, onOpenReport,
}: {
  node: FileNode
  depth: number
  currentNotebookId: string | null
  currentReportId: string | null
  onOpenNotebook: (id: string) => void
  onOpenReport: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [creatingNb, setCreatingNb] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [fileMenuPos, setFileMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const indent = 4 + depth * 10
  const fetchFilesTree = useAppStore((s) => s.fetchFilesTree)
  const newAnalysisInFolder = useAppStore((s) => s.newAnalysisInFolder)
  const folderFileInputRef = useRef<HTMLInputElement>(null)

  async function deleteThisFile() {
    if (!confirm(`파일 "${node.name}" 을 삭제할까요?`)) return
    try {
      const api = await import('@/lib/api')
      await api.deleteFile(node.path)
      await fetchFilesTree()
    } catch (e) {
      alert(`파일 삭제 실패: ${(e as Error).message}`)
    }
  }

  // ── 드롭 처리 (폴더 노드에만 적용) ─────────────────────────────────────
  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (node.type !== 'folder') return

    // 1) 외부 파일 드롭 → 업로드
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadToFolder(e.dataTransfer.files)
      return
    }

    // 2) 내부 드래그(기존 파일) → 이동
    const srcPath = e.dataTransfer.getData('application/x-vibe-path')
    if (!srcPath || srcPath === node.path) return
    // 자기 자신(부모)에게 드롭하는 건 무의미
    // 또한 부모 경로가 동일하면 이미 그 폴더 안에 있는 것
    const srcParent = srcPath.substring(0, srcPath.lastIndexOf('/'))
    if (srcParent === node.path) return

    try {
      const api = await import('@/lib/api')
      await api.moveEntry(srcPath, node.path)
      setOpen(true)
      await fetchFilesTree()
    } catch (err) {
      alert(`이동 실패: ${(err as Error).message}`)
      await fetchFilesTree()
    }
  }

  async function uploadToFolder(fileList: FileList | null) {
    // FileList 는 <input> 을 참조하는 라이브 객체 — input.value='' 시 비워지므로 await 이전에 배열 스냅샷 필수.
    const files = fileList ? Array.from(fileList) : []
    if (files.length === 0) return
    setUploading(true)
    window.dispatchEvent(new Event('vibe:upload-start'))
    const api = await import('@/lib/api')
    const ok: string[] = []
    const fail: string[] = []
    try {
      for (const f of files) {
        try {
          const r = await api.uploadFile(f, node.path)
          ok.push(r.name)
        } catch (e) {
          fail.push(`${f.name}: ${(e as Error).message}`)
        }
      }
      setOpen(true)
      await fetchFilesTree().catch(() => {})
    } finally {
      setUploading(false)
      window.dispatchEvent(new Event('vibe:upload-end'))
    }
    if (ok.length === 0 && fail.length === 0) return
    window.dispatchEvent(new CustomEvent('vibe:upload-status', {
      detail: { ok, fail, dstLabel: node.name },
    }))
    if (fail.length > 0) {
      toast.error(
        `업로드 실패 (${fail.length}개)`,
        fail.join('\n'),
      )
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(node.path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch (e) {
      console.warn('copy path failed', e)
    }
  }

  async function deleteFolder() {
    if (!confirm(`폴더 "${node.name}" 을 삭제할까요?${node.children && node.children.length > 0 ? ' (하위 내용 포함)' : ''}`)) return
    try {
      const api = await import('@/lib/api')
      const recursive = !!(node.children && node.children.length > 0)
      await api.rmdirFolder(node.path, recursive)
      await fetchFilesTree()
    } catch (e) {
      alert(`폴더 삭제 실패: ${(e as Error).message}`)
    }
  }

  if (node.type === 'folder') {
    return (
      <div>
        <div
          className={cn(
            'group flex items-center gap-1 py-0.5 rounded cursor-pointer transition-colors',
            dragOver ? 'bg-primary-light ring-1 ring-primary' : 'hover:bg-surface',
          )}
          style={{ paddingLeft: indent }}
          onClick={() => setOpen((v) => !v)}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move' }}
          onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
          onDrop={(e) => void handleDrop(e)}
          title={node.path}
        >
          {open ? (
            <ChevronDown size={11} className="text-text-tertiary shrink-0" />
          ) : (
            <ChevronRight size={11} className="text-text-tertiary shrink-0" />
          )}
          {open ? (
            <FolderOpen size={12} className="text-text-secondary shrink-0" />
          ) : (
            <Folder size={12} className="text-text-secondary shrink-0" />
          )}
          <span className="text-[12px] text-text-secondary truncate flex-1">{node.name}</span>
          <input
            ref={folderFileInputRef}
            type="file"
            multiple
            accept=".csv,.tsv,.xlsx,.xls,.parquet,.json,.txt,.md,.ipynb"
            style={{ display: 'none' }}
            onChange={(e) => {
              void uploadToFolder(e.target.files)
              if (folderFileInputRef.current) folderFileInputRef.current.value = ''
            }}
          />
          <button
            type="button"
            title={creatingNb ? '생성 중…' : '이 폴더에 새 분석 만들기'}
            onClick={async (e) => {
              e.stopPropagation()
              if (creatingNb) return
              setCreatingNb(true)
              setOpen(true)
              try { await newAnalysisInFolder(node.path) } finally { setCreatingNb(false) }
            }}
            className={cn(
              'opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-primary transition-opacity shrink-0',
              creatingNb && 'opacity-100 cursor-wait',
            )}
          >
            <FilePlus size={11} className={cn(creatingNb && 'animate-pulse')} />
          </button>
          <button
            type="button"
            title={uploading ? '업로드 중…' : '이 폴더에 파일 업로드'}
            onClick={(e) => {
              e.stopPropagation()
              if (uploading) return
              folderFileInputRef.current?.click()
            }}
            className={cn(
              'opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-primary transition-opacity shrink-0',
              uploading && 'opacity-100 cursor-wait',
            )}
          >
            <Upload size={11} className={cn(uploading && 'animate-pulse')} />
          </button>
          <button
            title={copied ? '복사됨' : '경로 복사'}
            onClick={(e) => { e.stopPropagation(); void copyPath() }}
            className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-primary transition-opacity shrink-0"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
          <button
            title="폴더 삭제"
            onClick={(e) => { e.stopPropagation(); void deleteFolder() }}
            className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-danger transition-opacity shrink-0"
          >
            <X size={11} />
          </button>
        </div>
        {open && node.children && (
          <div>
            {node.children.length === 0 && (
              <div style={{ paddingLeft: indent + 14 }} className="py-0.5 text-[11px] text-text-disabled italic">
                비어있음
              </div>
            )}
            {node.children.map((c) => (
              <FileTreeNode
                key={c.path} node={c} depth={depth + 1}
                currentNotebookId={currentNotebookId}
                currentReportId={currentReportId}
                onOpenNotebook={onOpenNotebook}
                onOpenReport={onOpenReport}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // File node — 클릭 동작은 kind 별로 분기
  const Icon = fileIconFor(node)
  const isCurrentNb = node.kind === 'notebook' && node.notebook_id === currentNotebookId
  const isCurrentRep = node.kind === 'report' && node.report_id === currentReportId
  const isActive = isCurrentNb || isCurrentRep

  function handleClick() {
    if (node.kind === 'notebook' && node.notebook_id) {
      onOpenNotebook(node.notebook_id)
    } else if (node.kind === 'report' && node.report_id) {
      onOpenReport(node.report_id)
    } else {
      void copyPath()
    }
  }

  const titleText = node.kind === 'notebook'
    ? `분석 열기\n${node.path}`
    : node.kind === 'report'
    ? `리포트 열기\n${node.path}`
    : `클릭해 경로 복사\n${node.path}`

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-vibe-path', node.path)
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={cn(
        'group flex items-center gap-1 py-0.5 rounded cursor-pointer',
        isActive ? 'bg-surface border border-primary-border' : 'hover:bg-surface',
      )}
      style={{ paddingLeft: indent + 14 }}
      onClick={handleClick}
      title={titleText}
    >
      <Icon size={12} className={cn('shrink-0', isActive ? 'text-primary' : 'text-text-secondary')} />
      <span className={cn('text-[12px] truncate flex-1', isActive ? 'text-primary font-semibold' : 'text-text-secondary')}>
        {node.name}
      </span>
      {node.size != null && node.kind === 'file' && (
        <span className="text-[10px] text-text-disabled shrink-0">{formatSize(node.size)}</span>
      )}
      <button
        title={copied ? '복사됨' : '경로 복사'}
        onClick={(e) => { e.stopPropagation(); void copyPath() }}
        className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-primary transition-opacity shrink-0"
      >
        {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
      </button>
      {node.kind === 'file' && (
        <button
          title="더보기"
          onClick={(e) => {
            e.stopPropagation()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setFileMenuPos({ x: r.right - 120, y: r.bottom + 2 })
            setFileMenuOpen((v) => !v)
          }}
          className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-text-secondary transition-opacity shrink-0"
        >
          <MoreHorizontal size={11} />
        </button>
      )}
      {fileMenuOpen && createPortal(
        <div
          className="fixed z-[9999] bg-surface border border-border rounded-md shadow-lg py-1 min-w-[120px]"
          style={{ left: fileMenuPos.x, top: fileMenuPos.y }}
          onMouseLeave={() => setFileMenuOpen(false)}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-danger hover:bg-danger-bg"
            onClick={(e) => { e.stopPropagation(); setFileMenuOpen(false); void deleteThisFile() }}
          >
            <Trash2 size={12} />
            삭제
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

function SettingsRow({
  label,
  onClick,
  ok,
  okLabel,
  offLabel,
}: {
  label: string
  onClick: () => void
  ok: boolean
  okLabel: string
  offLabel: string
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] text-text-secondary hover:bg-primary-light hover:text-primary rounded transition-colors"
      title={`${label} — ${ok ? okLabel : offLabel}`}
    >
      <span className="flex-1 text-left">{label}</span>
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full shrink-0 transition-colors',
          ok ? 'bg-success' : 'bg-danger'
        )}
      />
    </button>
  )
}
