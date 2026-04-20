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
} from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { cn } from '@/lib/utils'
import ModelSettingsModal from '@/components/common/ModelSettingsModal'
import ConnectionModal from '@/components/common/ConnectionModal'
import ShortcutsModal from '@/components/common/ShortcutsModal'
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
  } = useAppStore()

  const [addingFolder, setAddingFolder] = useState(false)
  const [folderInput, setFolderInput] = useState('')
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [showConnection, setShowConnection] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)

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
    return () => {
      window.removeEventListener('vibe:close-popups', onClose)
      window.removeEventListener('vibe:open-connection', onOpenConnection)
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
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-semibold text-white transition-colors"
          style={{ backgroundColor: '#D95C3F' }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#C24E34' }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#D95C3F' }}
        >
          <Plus size={14} />
          새 분석 만들기
        </button>
      </div>

      {/* Folders section */}
      <div className="border-b border-border-subtle">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary font-semibold uppercase tracking-wide">
            <Folder size={12} />
            폴더
          </div>
          <button
            title="폴더 추가"
            onClick={() => setAddingFolder(true)}
            className="p-1 text-text-tertiary hover:text-primary hover:bg-primary-light rounded transition-colors"
          >
            <FolderPlus size={14} />
          </button>
        </div>
        {addingFolder && (
          <div className="mx-3 mb-2 flex items-center gap-1 bg-white border border-border rounded px-2 py-1">
            <Folder size={12} className="text-text-tertiary shrink-0" />
            <input
              autoFocus
              className="flex-1 text-[12px] bg-transparent outline-none"
              placeholder="폴더 이름"
              maxLength={100}
              value={folderInput}
              onChange={(e) => setFolderInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddFolder()
                if (e.key === 'Escape') { setAddingFolder(false); setFolderInput('') }
              }}
            />
            <button onClick={handleAddFolder} className="text-[11px] text-primary font-medium hover:underline">추가</button>
            <button onClick={() => { setAddingFolder(false); setFolderInput('') }} className="text-text-tertiary hover:text-danger">
              <X size={12} />
            </button>
          </div>
        )}
        <div className="px-2 pb-2 space-y-0.5">
          {folders.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-text-disabled italic">폴더 없음</div>
          )}
          {folders.map((folder) => {
            const folderHistories = histories.filter((h) => h.folderId === folder.id)
            return (
              <div key={folder.id}>
                <div className="group flex items-center gap-1 px-2 py-1 rounded hover:bg-white cursor-pointer">
                  <button onClick={() => toggleFolder(folder.id)} className="flex items-center gap-1 flex-1 min-w-0">
                    {folder.isOpen ? <ChevronDown size={12} className="text-text-tertiary shrink-0" /> : <ChevronRight size={12} className="text-text-tertiary shrink-0" />}
                    {folder.isOpen ? <FolderOpen size={12} className="text-text-secondary shrink-0" /> : <Folder size={12} className="text-text-secondary shrink-0" />}
                    <span className="text-[12px] text-text-secondary truncate">{folder.name}</span>
                  </button>
                  <button title="폴더 삭제" onClick={() => deleteFolder(folder.id)} className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-danger transition-opacity">
                    <X size={11} />
                  </button>
                </div>
                {folder.isOpen && (
                  <div className="ml-4">
                    {folderHistories.length === 0 ? (
                      <div className="px-2 py-1 text-[11px] text-text-disabled italic">비어있음</div>
                    ) : (
                      folderHistories.map((h) => (
                        <HistoryItemRow key={h.id} item={h} folders={folders} menuOpen={historyMenuOpen === h.id} menuView={historyMenuView}
                          onMenuOpen={() => setHistoryMenuOpen(h.id)} onMenuClose={() => setHistoryMenuOpen(null)} onMenuView={setHistoryMenuView}
                          onDuplicate={() => duplicateHistory(h.id)} onDelete={() => deleteHistory(h.id)} onMove={(fid) => moveHistory(h.id, fid)}
                          onLoad={() => loadAnalysis(h.id)} />
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* History header */}
      <div className="flex items-center px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary font-semibold uppercase tracking-wide">
          <History size={12} />
          히스토리
        </div>
      </div>

      {/* History list — root only */}
      <div className="flex-1 overflow-y-auto hide-scrollbar px-2 pb-2 space-y-0.5">
        {rootHistories.map((h) => (
          <HistoryItemRow key={h.id} item={h} folders={folders} menuOpen={historyMenuOpen === h.id} menuView={historyMenuView}
            onMenuOpen={() => setHistoryMenuOpen(h.id)} onMenuClose={() => setHistoryMenuOpen(null)} onMenuView={setHistoryMenuView}
            onDuplicate={() => duplicateHistory(h.id)} onDelete={() => deleteHistory(h.id)} onMove={(fid) => moveHistory(h.id, fid)}
            onLoad={() => loadAnalysis(h.id)} />
        ))}
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
      </div>

      {/* Profile */}
      <div className="h-header flex items-center gap-2 px-4 border-t border-border-subtle">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary-pale to-primary flex items-center justify-center shrink-0">
          <User size={14} className="text-white" />
        </div>
        <span className="text-[12px] font-medium text-text-secondary">하우</span>
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
    </aside>
  )
}

interface HistoryItemRowProps {
  item: ReturnType<typeof useAppStore.getState>['histories'][number]
  folders: ReturnType<typeof useAppStore.getState>['folders']
  menuOpen: boolean
  menuView: 'main' | 'move'
  onMenuOpen: () => void
  onMenuClose: () => void
  onMenuView: (v: 'main' | 'move') => void
  onDuplicate: () => void
  onDelete: () => void
  onMove: (folderId: string | null) => void
  onLoad: () => void
}

function HistoryItemRow({
  item,
  folders,
  menuOpen,
  menuView,
  onMenuOpen,
  onMenuClose,
  onMenuView,
  onDuplicate,
  onDelete,
  onMove,
  onLoad,
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
        item.isCurrent ? 'bg-white border border-primary-border' : 'hover:bg-white'
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
        <div className="text-[10px] text-text-disabled">{item.date}</div>
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
          className="fixed z-[9999] bg-white border border-border rounded-md shadow-lg py-1 min-w-[140px]"
          style={{ left: menuPos.x, top: menuPos.y }}
          onMouseLeave={onMenuClose}
        >
          {menuView === 'main' ? (
            <>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-stone-100"
                onClick={() => onMenuView('move')}
              >
                <Folder size={12} />
                이동
                <ChevronRight size={10} className="ml-auto" />
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-stone-100"
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
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-stone-100"
                onClick={() => onMenuView('main')}
              >
                <ChevronRight size={10} className="rotate-180" />
                이동할 위치
              </button>
              <div className="border-t border-bg-sidebar my-0.5" />
              <button
                className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-text-secondary hover:bg-stone-100"
                onClick={() => onMove(null)}
              >
                <span className="flex items-center gap-2">
                  <History size={12} />
                  루트
                </span>
                {!item.folderId && <span className="text-primary text-[10px]">✓</span>}
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-text-secondary hover:bg-stone-100"
                  onClick={() => onMove(f.id)}
                >
                  <span className="flex items-center gap-2">
                    <Folder size={12} />
                    {f.name}
                  </span>
                  {item.folderId === f.id && <span className="text-primary text-[10px]">✓</span>}
                </button>
              ))}
              {folders.length === 0 && (
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
