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
  Check,
  Sun,
  Moon,
} from 'lucide-react'
import type { FileNode } from '@/lib/api'
import { useAppStore } from '@/store/useAppStore'
import { useConnectionStore } from '@/store/connectionStore'
import { useModelStore } from '@/store/modelStore'
import { cn } from '@/lib/utils'
import ModelSettingsModal from '@/components/common/ModelSettingsModal'
import ConnectionModal from '@/components/common/ConnectionModal'
import ShortcutsModal from '@/components/common/ShortcutsModal'
import FeaturesModal from '@/components/common/FeaturesModal'
import UserGuideModal from '@/components/common/UserGuideModal'
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
  } = useAppStore()

  const sfUser = useConnectionStore((s) => s.sfUser)
  const displayName = sfUser ? sfUser.split('@')[0] : '하우'
  const theme = useModelStore((s) => s.theme)
  const toggleTheme = useModelStore((s) => s.toggleTheme)

  const [addingFolder, setAddingFolder] = useState(false)
  const [folderInput, setFolderInput] = useState('')
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [showConnection, setShowConnection] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showFeatures, setShowFeatures] = useState(false)
  const [showGuide, setShowGuide] = useState(false)

  useEffect(() => {
    function onClose() {
      setShowModelSettings(false)
      setShowConnection(false)
      setShowShortcuts(false)
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

          const rows = histories.filter((h) => nbInfo.has(h.id))
          if (rows.length === 0) {
            return <div className="px-2 py-1 text-[11px] text-text-disabled italic">분석 없음</div>
          }
          return rows.map((h) => {
            const info = nbInfo.get(h.id)!
            return (
              <HistoryItemRow
                key={h.id}
                item={h}
                folderName={info.folderName}
                notebookPath={info.path}
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

      {/* Settings */}
      <div className="px-3 py-2 border-t border-border-subtle">
        <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-tertiary font-semibold uppercase tracking-wide">
          <Settings size={12} />
          설정
        </div>
        <button
          onClick={() => setShowConnection(true)}
          className="w-full text-left px-2 py-1.5 text-[12px] text-text-secondary hover:bg-primary-light hover:text-primary rounded transition-colors"
        >
          연결 관리
        </button>
        <button
          onClick={() => setShowModelSettings(true)}
          className="w-full text-left px-2 py-1.5 text-[12px] text-text-secondary hover:bg-primary-light hover:text-primary rounded transition-colors"
        >
          모델 설정
        </button>
        <button
          onClick={() => setShowShortcuts(true)}
          className="w-full text-left px-2 py-1.5 text-[12px] text-text-secondary hover:bg-primary-light hover:text-primary rounded transition-colors"
        >
          단축키
        </button>
        <button
          onClick={() => setShowFeatures(true)}
          className="w-full text-left px-2 py-1.5 text-[12px] text-text-secondary hover:bg-primary-light hover:text-primary rounded transition-colors"
        >
          편의 기능
        </button>
        <button
          onClick={() => setShowGuide(true)}
          className="w-full text-left px-2 py-1.5 text-[12px] text-text-secondary hover:bg-primary-light hover:text-primary rounded transition-colors"
        >
          사용 가이드
        </button>
      </div>

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
      {showShortcuts && (
        <ShortcutsModal onClose={() => setShowShortcuts(false)} />
      )}
      {showFeatures && (
        <FeaturesModal onClose={() => setShowFeatures(false)} />
      )}
      {showGuide && (
        <UserGuideModal onClose={() => setShowGuide(false)} />
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
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-chip"
                onClick={() => onMenuView('move')}
              >
                <Folder size={12} />
                이동
                <ChevronRight size={10} className="ml-auto" />
              </button>
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
                    alert(`이동 실패: ${(e as Error).message}`)
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
                      alert(`이동 실패: ${(e as Error).message}`)
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
  const submittingRef = useRef(false)
  const { fetchFilesTree } = useAppStore()

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
        <div className="px-2 pb-2 flex-1 overflow-y-auto hide-scrollbar min-h-0">
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
  const [open, setOpen] = useState(depth < 1)
  const [copied, setCopied] = useState(false)
  const indent = 4 + depth * 10
  const { fetchFilesTree } = useAppStore()

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
          className="group flex items-center gap-1 py-0.5 rounded hover:bg-surface cursor-pointer"
          style={{ paddingLeft: indent }}
          onClick={() => setOpen((v) => !v)}
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
    </div>
  )
}
