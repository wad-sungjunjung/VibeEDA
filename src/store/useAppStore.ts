import { create } from 'zustand'
import type {
  Cell,
  CellType,
  ChatEntry,
  AgentMessage,
  AgentSession,
  HistoryItem,
  Folder,
  MartMeta,
  ToastData,
} from '@/types'
import {
  generateId,
  cycleCellType,
  defaultCellName,
  nowTimestamp,
  midOrdering,
  loadCellUi,
  loadAgentSessions,
  saveAgentSessions,
  toSnakeCase,
  toolStatusLabel,
} from '@/lib/utils'
import {
  streamVibeChat,
  streamAgentMessage,
  generateAgentSessionTitle,
  getNotebooks,
  createNotebook,
  getNotebook,
  updateNotebook,
  deleteNotebook,
  createCell as apiCreateCell,
  updateCell,
  deleteCell as apiDeleteCell,
  getFolders,
  createFolder as apiCreateFolder,
  updateFolder,
  deleteFolder as apiDeleteFolder,
  getMarts,
  executeCell as apiExecuteCell,
  deleteChatEntry as apiDeleteChatEntry,
  truncateChatHistory as apiTruncateChatHistory,
  type NotebookDetail,
  type CellRow,
  type AgentMessageRow,
} from '@/lib/api'
import { useModelStore } from '@/store/modelStore'

// ─── Debounce utility ────────────────────────────────────────────────────────

const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
function debounced(key: string, fn: () => void, delay = 800) {
  const t = _debounceTimers.get(key)
  if (t) clearTimeout(t)
  _debounceTimers.set(key, setTimeout(() => {
    _debounceTimers.delete(key)
    fn()
  }, delay))
}

// ─── DB row → Cell converter ─────────────────────────────────────────────────

function defaultCellUi(type: CellType) {
  if (type === 'markdown') return { splitMode: false, splitDir: 'h' as const, activeTab: 'output' as const, leftTab: 'input' as const, rightTab: 'output' as const }
  if (type === 'python') return { splitMode: true, splitDir: 'v' as const, activeTab: 'input' as const, leftTab: 'input' as const, rightTab: 'memo' as const }
  return { splitMode: true, splitDir: 'h' as const, activeTab: 'input' as const, leftTab: 'input' as const, rightTab: 'memo' as const }
}

function rowToCell(row: CellRow): Cell {
  const savedUi = loadCellUi(row.id)
  const type = row.type as CellType
  const defUi = defaultCellUi(type)
  // 온보딩 SQL/Python 셀은 입력/출력 분할로 고정
  const isOnboardingCode = row.onboarding && (type === 'sql' || type === 'python')
  const rightTabDefault = isOnboardingCode ? 'output' : defUi.rightTab
  return {
    id: row.id,
    name: row.name,
    type,
    code: row.code,
    memo: row.memo ?? '',
    ordering: row.ordering,
    splitMode: isOnboardingCode ? true : (savedUi.splitMode ?? defUi.splitMode),
    splitDir: isOnboardingCode ? (type === 'python' ? 'v' : 'h') : (savedUi.splitDir ?? defUi.splitDir),
    activeTab: row.executed ? 'output' : defUi.activeTab,
    leftTab: defUi.leftTab,
    rightTab: row.executed ? 'output' : rightTabDefault,
    executed: row.executed,
    executedAt: null,
    output: (row.output as Cell['output']) ?? null,
    chatInput: '',
    chatHistory: row.chat_entries.map((e, i) => ({
      id: i + 1,
      user: e.user_message,
      assistant: e.assistant_reply,
      timestamp: new Date(e.created_at).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      codeSnapshot: e.code_snapshot,
    })),
    historyOpen: row.chat_entries.length > 0,
    insight: row.insight ?? null,
    agentGenerated: row.agent_generated,
  }
}

function rowToAgentMsg(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    timestamp: new Date(row.created_at).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    createdCellIds: row.created_cell_ids,
  }
}

function formatNotebookDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '방금 전'
  if (diffMin < 60) return `${diffMin}분 전`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}시간 전`
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface AppStore {
  // ── App init ───────────────────────────────────────────────────────────────
  loading: boolean
  creating: boolean
  createError: string | null
  notebookId: string | null
  martCatalog: MartMeta[]
  martsLoading: boolean
  initApp: () => Promise<void>
  refreshMarts: () => Promise<void>

  // ── Layout ─────────────────────────────────────────────────────────────────
  notebookAreaHeight: number
  setNotebookAreaHeight: (h: number) => void

  // ── Analysis meta ──────────────────────────────────────────────────────────
  analysisTheme: string
  analysisDescription: string
  metaCollapsed: boolean
  setAnalysisTheme: (v: string) => void
  setAnalysisDescription: (v: string) => void
  setMetaCollapsed: (v: boolean) => void

  // ── Marts ──────────────────────────────────────────────────────────────────
  selectedMarts: string[]
  martSearchQuery: string
  martInfoExpanded: string | null
  addMart: (key: string) => void
  removeMart: (key: string) => void
  setMartSearchQuery: (q: string) => void
  setMartInfoExpanded: (key: string | null) => void

  // ── Cells ──────────────────────────────────────────────────────────────────
  cells: Cell[]
  executingCells: Set<string>
  vibingCells: Set<string>
  activeCellId: string | null
  setActiveCellId: (id: string | null) => void
  newAnalysis: () => Promise<void>
  loadAnalysis: (id: string) => void
  addCell: (type: CellType, afterId?: string | null) => void
  deleteCell: (id: string) => void
  duplicateCell: (id: string) => void
  reorderCells: (fromId: string, toId: string, before: boolean) => void
  updateCellCode: (id: string, code: string) => void
  updateCellName: (id: string, name: string) => void
  setCellTab: (id: string, tab: import('@/types').CellPanelTab) => void
  setSplitTab: (id: string, side: 'left' | 'right', tab: import('@/types').CellPanelTab) => void
  toggleCellSplitMode: (id: string) => void
  setCellSplitDir: (id: string, dir: 'h' | 'v') => void
  updateCellMemo: (id: string, memo: string) => void
  cycleCellTypeById: (id: string) => void
  executeCell: (id: string) => Promise<void>
  executeAllCells: () => Promise<void>
  updateCellChatInput: (id: string, input: string) => void
  cellEditOrigins: Record<string, number>
  setCellEditOrigin: (cellId: string, idx: number | null) => void
  submitVibe: (cellId: string, message: string) => void
  rollbackCell: (cellId: string, entryId: number) => void
  deleteChatEntry: (cellId: string, index: number) => void
  toggleCellHistory: (id: string) => void
  setCellInsight: (id: string, insight: string | null) => void

  // ── Agent mode ─────────────────────────────────────────────────────────────
  agentMode: boolean
  agentChatInput: string
  agentChatHistory: AgentMessage[]
  agentSessions: AgentSession[]
  agentSessionTitle: string | null
  agentLoading: boolean
  agentStatus: string | null
  agentRefCells: string[]
  toggleAgentRefCell: (id: string) => void
  toggleAgentMode: () => void
  setAgentChatInput: (v: string) => void
  submitAgentMessage: (message: string) => void
  newAgentSession: () => void
  resumeAgentSession: (id: string) => void
  deleteAgentSession: (id: string) => void
  addCellFromAgent: (id: string, type: CellType, code: string, name: string, afterId?: string | null) => void
  toggleAgentMessageCollapse: (id: string) => void

  // ── History & Folders ──────────────────────────────────────────────────────
  histories: HistoryItem[]
  folders: Folder[]
  historyMenuOpen: string | null
  historyMenuView: 'main' | 'move'
  addFolder: (name: string) => void
  deleteFolder: (id: string) => void
  toggleFolder: (id: string) => void
  duplicateHistory: (id: string) => void
  deleteHistory: (id: string) => void
  moveHistory: (historyId: string, folderId: string | null) => void
  setHistoryMenuOpen: (id: string | null) => void
  setHistoryMenuView: (view: 'main' | 'move') => void

  // ── Reporting ──────────────────────────────────────────────────────────────
  showReportModal: boolean
  generatingReport: boolean
  reportContent: string
  showReport: boolean
  setShowReportModal: (v: boolean) => void
  generateReport: (cellIds: string[]) => void
  setShowReport: (v: boolean) => void

  // ── Toast ──────────────────────────────────────────────────────────────────
  rollbackToast: ToastData | null
  setRollbackToast: (data: ToastData | null) => void
}

export const useAppStore = create<AppStore>((set, get) => ({
  // ── App init ───────────────────────────────────────────────────────────────
  loading: true,
  creating: false,
  createError: null,
  notebookId: null,
  martCatalog: [],
  martsLoading: false,

  initApp: async () => {
    set({ loading: true })
    try {
      const [notebooks, folders, marts] = await Promise.all([
        getNotebooks(),
        getFolders(),
        getMarts(),
      ])

      const histories: HistoryItem[] = notebooks.map((nb, i) => ({
        id: nb.id,
        title: nb.title,
        date: formatNotebookDate(nb.updated_at),
        folderId: nb.folder_id,
        isCurrent: i === 0,
      }))

      const folderItems: Folder[] = folders.map((f) => ({
        id: f.id,
        name: f.name,
        isOpen: f.is_open,
      }))

      set({ histories, folders: folderItems, martCatalog: marts })

      if (notebooks.length > 0) {
        // Load most recent notebook. 백엔드는 분석이 하나도 없으면
        // `Vibe EDA 시작하기` 온보딩 노트북을 자동 시딩하므로,
        // 이 분기 내에 그 온보딩이 가장 최근 노트북으로 잡힌다.
        const current = notebooks[0]
        const detail = await getNotebook(current.id)
        _applyNotebookDetail(detail, true)
      }
      // notebooks.length === 0 인 경우는 시딩이 실패한 예외 상황.
      // 좌측 '새 분석' 버튼으로 사용자가 직접 생성하도록 빈 상태 유지.
    } catch (err) {
      console.error('initApp failed:', err)
    } finally {
      set({ loading: false })
    }
  },

  refreshMarts: async () => {
    set({ martsLoading: true })
    try {
      const marts = await getMarts()
      set({ martCatalog: marts })
    } catch {
      // silent
    } finally {
      set({ martsLoading: false })
    }
  },

  // ── Layout ─────────────────────────────────────────────────────────────────
  notebookAreaHeight: 600,
  setNotebookAreaHeight: (h) => set({ notebookAreaHeight: h }),

  // ── Analysis meta ──────────────────────────────────────────────────────────
  analysisTheme: '',
  analysisDescription: '',
  metaCollapsed: true,

  setAnalysisTheme: (v) => {
    set({ analysisTheme: v })
    const { notebookId, histories } = get()
    if (notebookId) {
      set({ histories: histories.map((h) => h.id === notebookId ? { ...h, title: v } : h) })
      debounced(`theme-${notebookId}`, () => updateNotebook(notebookId, { title: v }))
    }
  },

  setAnalysisDescription: (v) => {
    set({ analysisDescription: v })
    const { notebookId } = get()
    if (notebookId) {
      debounced(`desc-${notebookId}`, () => updateNotebook(notebookId, { description: v }))
    }
  },

  setMetaCollapsed: (v) => set({ metaCollapsed: v }),

  // ── Marts ──────────────────────────────────────────────────────────────────
  selectedMarts: [],
  martSearchQuery: '',
  martInfoExpanded: null,

  addMart: (key) => {
    set((s) =>
      s.selectedMarts.includes(key) ? s : { selectedMarts: [...s.selectedMarts, key] }
    )
    const { notebookId, selectedMarts } = get()
    if (notebookId) {
      updateNotebook(notebookId, { selected_marts: [...selectedMarts] }).catch(() => {})
    }
  },

  removeMart: (key) => {
    set((s) => ({ selectedMarts: s.selectedMarts.filter((k) => k !== key) }))
    const { notebookId, selectedMarts } = get()
    if (notebookId) {
      updateNotebook(notebookId, { selected_marts: selectedMarts }).catch(() => {})
    }
  },

  setMartSearchQuery: (q) => set({ martSearchQuery: q }),
  setMartInfoExpanded: (key) => set({ martInfoExpanded: key }),

  // ── Cells ──────────────────────────────────────────────────────────────────
  cells: [],
  executingCells: new Set<string>(),
  vibingCells: new Set<string>(),
  activeCellId: null,

  setActiveCellId: (id) =>
    set((s) => ({
      activeCellId: id,
      cells:
        id && id !== s.activeCellId
          ? s.cells.map((c) =>
              c.id === id && c.chatHistory.length > 0 ? { ...c, historyOpen: true } : c
            )
          : s.cells,
    })),

  newAnalysis: async () => {
    const { histories } = get()
    set({ creating: true, createError: null })
    try {
      const BASE = '새 분석'
      const existingTitles = new Set(histories.map((h) => h.title))
      let title = BASE
      if (existingTitles.has(title)) {
        let n = 1
        while (existingTitles.has(`${BASE} ${n}`)) n++
        title = `${BASE} ${n}`
      }
      const nb = await createNotebook({ title, description: '', selected_marts: [] })
      const newCellId = crypto.randomUUID()
      const ordering = 1000.0

      await apiCreateCell(nb.id, {
        id: newCellId,
        name: 'query_1',
        type: 'sql',
        code: '',
        memo: '',
        ordering,
      })

      const newCell: Cell = {
        id: newCellId,
        name: 'query_1',
        type: 'sql',
        code: '',
        memo: '',
        ordering,
        splitMode: true,
        splitDir: 'h',
        activeTab: 'input',
        leftTab: 'input',
        rightTab: 'memo',
        executed: false,
        executedAt: null,
        output: null,
        chatInput: '',
        chatHistory: [],
        historyOpen: false,
        insight: null,
        agentGenerated: false,
      }

      set({
        notebookId: nb.id,
        cells: [newCell],
        activeCellId: newCellId,
        analysisTheme: title,
        analysisDescription: '',
        selectedMarts: [],
        agentChatHistory: [],
        creating: false,
        metaCollapsed: false,
        histories: [
          {
            id: nb.id,
            title,
            date: '방금 전',
            folderId: null,
            isCurrent: true,
          },
          ...histories.map((h) => ({ ...h, isCurrent: false })),
        ],
      })
    } catch (err) {
      console.error('newAnalysis failed:', err)
      set({
        creating: false,
        createError: '서버에 연결할 수 없습니다. 백엔드가 실행 중인지 확인해주세요.',
      })
    }
  },

  loadAnalysis: (id) => {
    const { histories } = get()
    const target = histories.find((h) => h.id === id)
    if (!target || target.isCurrent) return

    set({ histories: histories.map((h) => ({ ...h, isCurrent: h.id === id })) })

    ;(async () => {
      try {
        const detail = await getNotebook(id)
        _applyNotebookDetail(detail, false)
      } catch (err) {
        console.error('loadAnalysis failed:', err)
      }
    })()
  },

  addCell: (type, afterId = null) => {
    const { cells, notebookId } = get()
    if (!notebookId) return

    const newId = crypto.randomUUID()
    const name = defaultCellName(type, cells.map((c) => c.name))
    const afterIndex = afterId ? cells.findIndex((c) => c.id === afterId) : cells.length - 1
    const beforeOrdering = cells[afterIndex]?.ordering ?? null
    const afterOrdering = cells[afterIndex + 1]?.ordering ?? null
    const ordering = midOrdering(beforeOrdering, afterOrdering)

    const defUi = defaultCellUi(type)
    const newCell: Cell = {
      id: newId,
      name,
      type,
      code: '',
      memo: '',
      ordering,
      splitMode: defUi.splitMode,
      splitDir: defUi.splitDir,
      activeTab: defUi.activeTab,
      leftTab: defUi.leftTab,
      rightTab: defUi.rightTab,
      executed: type === 'markdown',
      executedAt: null,
      output: null,
      chatInput: '',
      chatHistory: [],
      historyOpen: false,
      insight: null,
      agentGenerated: false,
    }

    const updated = [...cells]
    updated.splice(afterIndex + 1, 0, newCell)
    set({ cells: updated, activeCellId: newId })

    apiCreateCell(notebookId, { id: newId, name, type, code: '', memo: '', ordering }).catch(
      (err) => {
        console.error('addCell API failed:', err)
        set((s) => ({ cells: s.cells.filter((c) => c.id !== newId) }))
      }
    )
  },

  deleteCell: (id) => {
    // Cancel any pending debounced saves for this cell
    const t = _debounceTimers.get(`code-${id}`)
    if (t) { clearTimeout(t); _debounceTimers.delete(`code-${id}`) }
    const tm = _debounceTimers.get(`memo-${id}`)
    if (tm) { clearTimeout(tm); _debounceTimers.delete(`memo-${id}`) }

    set((s) => ({
      cells: s.cells.filter((c) => c.id !== id),
      activeCellId: s.activeCellId === id ? null : s.activeCellId,
    }))
    const { notebookId } = get()
    if (notebookId) apiDeleteCell(notebookId, id).catch((err) => console.error('deleteCell API failed:', err))
  },

  duplicateCell: (id) => {
    const { cells, notebookId } = get()
    if (!notebookId) return
    const idx = cells.findIndex((c) => c.id === id)
    if (idx === -1) return
    const orig = cells[idx]
    const newId = crypto.randomUUID()
    const afterOrdering = cells[idx + 1]?.ordering ?? null
    const ordering = midOrdering(orig.ordering, afterOrdering)

    const copy: Cell = {
      ...orig,
      id: newId,
      name: orig.name + ' 복사',
      ordering,
      chatHistory: [],
      executed: false,
      executedAt: null,
      insight: null,
      chatInput: '',
      historyOpen: false,
    }
    const updated = [...cells]
    updated.splice(idx + 1, 0, copy)
    set({ cells: updated, activeCellId: newId })

    apiCreateCell(notebookId, {
      id: newId,
      name: copy.name,
      type: copy.type,
      code: copy.code,
      memo: copy.memo,
      ordering,
    }).catch((err) => {
      console.error('duplicateCell API failed:', err)
      set((s) => ({ cells: s.cells.filter((c) => c.id !== newId) }))
    })
  },

  reorderCells: (fromId, toId, before) => {
    set((s) => {
      const cells = [...s.cells]
      const fromIdx = cells.findIndex((c) => c.id === fromId)
      if (fromIdx === -1) return {}
      const [moved] = cells.splice(fromIdx, 1)
      const toIdx = cells.findIndex((c) => c.id === toId)
      if (toIdx === -1) return {}
      cells.splice(before ? toIdx : toIdx + 1, 0, moved)

      // Compute new ordering for moved cell
      const newIdx = cells.findIndex((c) => c.id === fromId)
      const beforeOrdering = cells[newIdx - 1]?.ordering ?? null
      const afterOrdering = cells[newIdx + 1]?.ordering ?? null
      const newOrdering = midOrdering(beforeOrdering, afterOrdering)
      cells[newIdx] = { ...cells[newIdx], ordering: newOrdering }

      const { notebookId } = get()
      if (notebookId) updateCell(notebookId, fromId, { ordering: newOrdering }).catch(() => {})
      return { cells }
    })
  },

  updateCellCode: (id, code) => {
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, code } : c)) }))
    const { notebookId } = get()
    if (notebookId) debounced(`code-${id}`, () => updateCell(notebookId!, id, { code }).catch(() => {}))
  },

  updateCellName: (id, name) => {
    // 중간 입력(빈 문자열/끝 '_')은 그대로 허용, 저장 시에만 최종 새니타이즈
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, name } : c)) }))
    const { notebookId } = get()
    if (notebookId) {
      const safe = toSnakeCase(name, 'cell')
      updateCell(notebookId, id, { name: safe }).catch(() => {})
    }
  },

  setCellTab: (id, tab) =>
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, activeTab: tab } : c)) })),

  setSplitTab: (id, side, tab) =>
    set((s) => ({
      cells: s.cells.map((c) =>
        c.id === id
          ? { ...c, leftTab: side === 'left' ? tab : c.leftTab, rightTab: side === 'right' ? tab : c.rightTab }
          : c
      ),
    })),

  toggleCellSplitMode: (id) =>
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, splitMode: !c.splitMode } : c)) })),

  setCellSplitDir: (id, dir) =>
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, splitDir: dir, splitMode: true } : c)) })),

  updateCellMemo: (id, memo) => {
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, memo } : c)) }))
    const { notebookId } = get()
    if (notebookId) debounced(`memo-${id}`, () => updateCell(notebookId!, id, { memo }).catch(() => {}))
  },

  cycleCellTypeById: (id) => {
    set((s) => ({
      cells: s.cells.map((c) =>
        c.id === id
          ? { ...c, type: cycleCellType(c.type), executed: cycleCellType(c.type) === 'markdown' }
          : c
      ),
    }))
    const newType = cycleCellType(get().cells.find((c) => c.id === id)?.type ?? 'sql')
    const { notebookId } = get()
    if (notebookId) updateCell(notebookId, id, { type: newType }).catch(() => {})
  },

  executeCell: async (id) => {
    const { executingCells } = get()
    if (executingCells.has(id)) return

    set((s) => ({ executingCells: new Set([...s.executingCells, id]) }))

    try {
      const { notebookId } = get()
      if (!notebookId) throw new Error('노트북이 선택되지 않았습니다.')
      const output = await apiExecuteCell(id, notebookId)
      const executedAt = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      set((s) => ({
        executingCells: new Set([...s.executingCells].filter((x) => x !== id)),
        cells: s.cells.map((c) =>
          c.id === id
            ? {
                ...c,
                executed: true,
                executedAt,
                output: output as unknown as import('@/types').CellOutput,
                activeTab: c.splitMode ? c.activeTab : 'output',
                rightTab: c.splitMode ? 'output' : c.rightTab,
              }
            : c
        ),
      }))
    } catch (err) {
      const errOutput: import('@/types').CellOutput = {
        type: 'error',
        message: String(err),
      }
      const executedAt = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      set((s) => ({
        executingCells: new Set([...s.executingCells].filter((x) => x !== id)),
        cells: s.cells.map((c) =>
          c.id === id ? { ...c, executed: true, executedAt, output: errOutput } : c
        ),
      }))
    }
  },

  executeAllCells: async () => {
    const { cells } = get()
    const toRun = [...cells]
      .filter((c) => c.type !== 'markdown')
      .sort((a, b) => a.ordering - b.ordering)
    for (const cell of toRun) {
      await get().executeCell(cell.id)
    }
  },

  cellEditOrigins: {},

  setCellEditOrigin: (cellId, idx) =>
    set((s) => {
      const next = { ...s.cellEditOrigins }
      if (idx === null) delete next[cellId]
      else next[cellId] = idx
      return { cellEditOrigins: next }
    }),

  updateCellChatInput: (id, input) =>
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, chatInput: input } : c)) })),

  submitVibe: async (cellId, message) => {
    if (!message.trim()) return
    const { cells, analysisTheme, selectedMarts, martCatalog, cellEditOrigins, setCellEditOrigin, notebookId } = get()
    const cell = cells.find((c) => c.id === cellId)
    if (!cell) return

    const editFromIdx = cellEditOrigins[cellId] ?? null
    const codeSnapshot = cell.code

    set((s) => ({
      vibingCells: new Set([...s.vibingCells, cellId]),
      cells: s.cells.map((c) =>
        c.id === cellId
          ? {
              ...c,
              chatInput: '',
              code: '',
              chatHistory:
                editFromIdx !== null ? c.chatHistory.slice(0, editFromIdx) : c.chatHistory,
            }
          : c
      ),
    }))
    if (editFromIdx !== null) {
      setCellEditOrigin(cellId, null)
      if (notebookId) apiTruncateChatHistory(notebookId, cellId, editFromIdx).catch(() => {})
    }

    let finalCode = ''

    try {
      await streamVibeChat(
        {
          cell_id: cellId,
          cell_type: cell.type,
          current_code: codeSnapshot,
          message,
          selected_marts: selectedMarts,
          mart_metadata: martCatalog
            .filter((m) => selectedMarts.includes(m.key))
            .map((m) => ({ key: m.key, description: m.description, columns: m.columns })),
          analysis_theme: analysisTheme,
          notebook_id: notebookId,
        },
        (event) => {
          if (event.type === 'code_delta') {
            set((s) => ({
              cells: s.cells.map((c) =>
                c.id === cellId ? { ...c, code: c.code + event.delta } : c
              ),
            }))
          } else if (event.type === 'complete') {
            finalCode = event.full_code
            const currentCell = get().cells.find((c) => c.id === cellId)
            const entry: ChatEntry = {
              id: (currentCell?.chatHistory.length ?? 0) + 1,
              user: message,
              assistant: event.explanation || finalCode.slice(0, 80),
              timestamp: nowTimestamp(),
              codeSnapshot,
            }
            set((s) => ({
              cells: s.cells.map((c) =>
                c.id === cellId ? { ...c, code: finalCode, chatHistory: [...c.chatHistory, entry] } : c
              ),
            }))
            const { notebookId: nbId } = get()
            if (nbId) debounced(`code-${cellId}`, () => updateCell(nbId!, cellId, { code: finalCode }).catch(() => {}), 200)
            get().executeCell(cellId)
          } else if (event.type === 'error') {
            console.error('Vibe error:', event.message)
            set((s) => ({
              cells: s.cells.map((c) =>
                c.id === cellId ? { ...c, code: codeSnapshot } : c
              ),
            }))
          }
        },
      )
    } catch (err) {
      console.error('Vibe chat failed:', err)
      set((s) => ({
        cells: s.cells.map((c) =>
          c.id === cellId ? { ...c, code: codeSnapshot } : c
        ),
      }))
    } finally {
      set((s) => ({
        vibingCells: new Set([...s.vibingCells].filter((id) => id !== cellId)),
      }))
    }
  },

  rollbackCell: (cellId, entryId) => {
    const { cells } = get()
    const cell = cells.find((c) => c.id === cellId)
    if (!cell) return
    const entry = cell.chatHistory.find((e) => e.id === entryId)
    if (!entry) return

    set((s) => ({
      cells: s.cells.map((c) => (c.id === cellId ? { ...c, code: entry.codeSnapshot } : c)),
      rollbackToast: { cellName: cell.name, timestamp: entry.timestamp },
    }))

    const { notebookId } = get()
    if (notebookId) updateCell(notebookId, cellId, { code: entry.codeSnapshot }).catch(() => {})
    setTimeout(() => set({ rollbackToast: null }), 3000)
  },

  deleteChatEntry: (cellId, index) => {
    set((s) => ({
      cells: s.cells.map((c) =>
        c.id === cellId
          ? { ...c, chatHistory: c.chatHistory.filter((_, i) => i !== index) }
          : c
      ),
    }))
    const { notebookId } = get()
    if (notebookId) apiDeleteChatEntry(notebookId, cellId, index).catch(() => {})
  },

  toggleCellHistory: (id) =>
    set((s) => ({
      cells: s.cells.map((c) => (c.id === id ? { ...c, historyOpen: !c.historyOpen } : c)),
    })),

  setCellInsight: (id, insight) => {
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, insight } : c)) }))
    const { notebookId } = get()
    if (notebookId) updateCell(notebookId, id, { insight }).catch(() => {})
  },

  // ── Agent mode ─────────────────────────────────────────────────────────────
  agentMode: false,
  agentChatInput: '',
  agentChatHistory: [],
  agentSessions: [],
  agentSessionTitle: null,
  agentLoading: false,
  agentStatus: null,
  agentRefCells: [],

  toggleAgentRefCell: (id) =>
    set((s) => ({
      agentRefCells: s.agentRefCells.includes(id)
        ? s.agentRefCells.filter((c) => c !== id)
        : [...s.agentRefCells, id],
    })),

  toggleAgentMode: () => set((s) => ({ agentMode: !s.agentMode })),
  setAgentChatInput: (v) => set({ agentChatInput: v }),

  toggleAgentMessageCollapse: (id) =>
    set((s) => ({
      agentChatHistory: s.agentChatHistory.map((m) =>
        m.id === id ? { ...m, collapsed: !m.collapsed } : m
      ),
    })),

  newAgentSession: () => {
    const { agentChatHistory, agentSessions, agentSessionTitle, notebookId } = get()
    if (!agentChatHistory.length) return
    const firstUser = agentChatHistory.find((m) => m.role === 'user')
    const fallback = (firstUser?.content ?? '새 대화').trim().replace(/\s+/g, ' ')
    const fallbackTitle = fallback.length > 40 ? fallback.slice(0, 40) + '…' : fallback
    const title = agentSessionTitle?.trim() || fallbackTitle
    const session: AgentSession = {
      id: generateId('as'),
      title,
      startedAt: agentChatHistory[0]?.timestamp ?? nowTimestamp(),
      messages: agentChatHistory,
    }
    const updated = [...agentSessions, session]
    set({ agentChatHistory: [], agentSessions: updated, agentSessionTitle: null, agentRefCells: [] })
    if (notebookId) saveAgentSessions(notebookId, updated)
  },

  resumeAgentSession: (id) => {
    const { agentChatHistory, agentSessions, agentSessionTitle, agentLoading, notebookId } = get()
    if (agentLoading) return
    const target = agentSessions.find((s) => s.id === id)
    if (!target) return

    let sessions = agentSessions.filter((s) => s.id !== id)

    if (agentChatHistory.length > 0) {
      const firstUser = agentChatHistory.find((m) => m.role === 'user')
      const fallback = (firstUser?.content ?? '새 대화').trim().replace(/\s+/g, ' ')
      const fallbackTitle = fallback.length > 40 ? fallback.slice(0, 40) + '…' : fallback
      const title = agentSessionTitle?.trim() || fallbackTitle
      sessions = [
        ...sessions,
        {
          id: generateId('as'),
          title,
          startedAt: agentChatHistory[0]?.timestamp ?? nowTimestamp(),
          messages: agentChatHistory,
        },
      ]
    }

    set({
      agentChatHistory: target.messages,
      agentSessions: sessions,
      agentSessionTitle: target.title,
      agentRefCells: [],
      agentMode: true,
    })
    if (notebookId) saveAgentSessions(notebookId, sessions)
  },

  deleteAgentSession: (id) => {
    const { agentSessions, notebookId } = get()
    const updated = agentSessions.filter((s) => s.id !== id)
    if (updated.length === agentSessions.length) return
    set({ agentSessions: updated })
    if (notebookId) saveAgentSessions(notebookId, updated)
  },

  addCellFromAgent: (id, type, code, name, afterId = null) => {
    const { cells, notebookId } = get()
    if (cells.some((c) => c.id === id)) {
      // 동일 id 셀이 이미 상태에 존재 — 중복 추가 방지. 활성화만 갱신.
      set({ activeCellId: id })
      return
    }
    const afterIndex = afterId ? cells.findIndex((c) => c.id === afterId) : cells.length - 1
    const beforeOrdering = cells[afterIndex]?.ordering ?? null
    const afterOrdering = cells[afterIndex + 1]?.ordering ?? null
    const ordering = midOrdering(beforeOrdering, afterOrdering)

    const defUi = defaultCellUi(type)
    const newCell: Cell = {
      id,
      name,
      type,
      code,
      memo: '',
      ordering,
      splitMode: defUi.splitMode,
      splitDir: defUi.splitDir,
      activeTab: defUi.activeTab,
      leftTab: defUi.leftTab,
      rightTab: defUi.rightTab,
      executed: false,
      executedAt: null,
      output: null,
      chatInput: '',
      chatHistory: [],
      historyOpen: false,
      insight: null,
      agentGenerated: true,
    }

    const updated = [...cells]
    updated.splice(afterIndex + 1, 0, newCell)
    set({ cells: updated, activeCellId: id })

    // The agent endpoint already saves cells to DB; this is a no-op if already saved.
    // We still try to upsert here in case the agent endpoint failed.
    if (notebookId) {
      apiCreateCell(notebookId, {
        id,
        name,
        type,
        code,
        memo: '',
        ordering,
        agent_generated: true,
      }).catch(() => {})
    }
  },

  submitAgentMessage: async (message) => {
    if (!message.trim()) return

    const { anthropicApiKey, geminiApiKey, agentModel } = useModelStore.getState()
    const isGemini = agentModel.startsWith('gemini-')
    const activeKey = isGemini ? geminiApiKey : anthropicApiKey
    const providerLabel = isGemini ? 'Gemini' : 'Anthropic'

    const userMsg: AgentMessage = {
      id: generateId('am'),
      role: 'user',
      content: message,
      timestamp: nowTimestamp(),
    }

    const isFirstUserMsg = !get().agentChatHistory.some((m) => m.role === 'user')

    set((s) => ({
      agentChatHistory: [...s.agentChatHistory, userMsg],
      agentChatInput: '',
      agentLoading: true,
      agentStatus: '생각 중',
    }))

    if (isFirstUserMsg && !get().agentSessionTitle) {
      generateAgentSessionTitle(message).then((title) => {
        if (title && !get().agentSessionTitle) {
          set({ agentSessionTitle: title })
        }
      }).catch(() => {})
    }

    if (!activeKey) {
      const assistantMsg: AgentMessage = {
        id: generateId('am'),
        role: 'assistant',
        content: `${providerLabel} API 키가 설정되지 않았습니다. 우측 상단 모델 설정에서 키를 입력해주세요.`,
        timestamp: nowTimestamp(),
      }
      set((s) => ({
        agentChatHistory: [...s.agentChatHistory, assistantMsg],
        agentLoading: false,
        agentStatus: null,
      }))
      return
    }

    const { cells, selectedMarts, analysisTheme, analysisDescription, agentChatHistory, notebookId } = get()
    const assistantMsgId = generateId('am')
    set((s) => ({
      agentChatHistory: [
        ...s.agentChatHistory,
        { id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: nowTimestamp(), kind: 'message' },
      ],
    }))

    const createdCellIds: string[] = []
    let currentAssistantMsgId: string = assistantMsgId

    try {
      await streamAgentMessage(
        {
          message,
          cells: cells.map((c) => ({ id: c.id, name: c.name, type: c.type, code: c.code, executed: c.executed })),
          selected_marts: selectedMarts,
          analysis_theme: analysisTheme,
          analysis_description: analysisDescription,
          conversation_history: agentChatHistory
            .filter((m) => m.content)
            .map((m) => ({ role: m.role, content: m.content })),
          notebook_id: notebookId,
        },
        (event) => {
          // helper: 새 텍스트 말풍선 시작 (현재 버블에 내용이 있으면)
          const maybeStartNewTextBubble = () => {
            const cur = get().agentChatHistory.find((m) => m.id === currentAssistantMsgId)
            if (cur && cur.content) {
              const newId = generateId('am')
              currentAssistantMsgId = newId
              set((s) => ({
                agentChatHistory: [
                  ...s.agentChatHistory,
                  { id: newId, role: 'assistant', content: '', timestamp: nowTimestamp(), kind: 'message' },
                ],
              }))
            }
          }
          // helper: step 말풍선 추가
          const pushStep = (stepType: NonNullable<AgentMessage['stepType']>, label: string, detail?: string) => {
            const stepId = generateId('am')
            set((s) => ({
              agentChatHistory: [
                ...s.agentChatHistory,
                {
                  id: stepId,
                  role: 'assistant',
                  content: '',
                  timestamp: nowTimestamp(),
                  kind: 'step',
                  stepType,
                  stepLabel: label,
                  stepDetail: detail,
                  collapsed: false,
                },
              ],
            }))
            return stepId
          }
          // helper: 가장 최근 step 메시지의 라벨/상세 보강
          const enrichLastStep = (patch: Partial<AgentMessage>) => {
            set((s) => {
              const lastStepIdx = [...s.agentChatHistory].reverse().findIndex((m) => m.kind === 'step')
              if (lastStepIdx < 0) return s
              const idx = s.agentChatHistory.length - 1 - lastStepIdx
              const next = [...s.agentChatHistory]
              next[idx] = { ...next[idx], ...patch }
              return { agentChatHistory: next }
            })
          }

          if (event.type === 'thinking') {
            set({ agentStatus: '생각 중' })
          } else if (event.type === 'tool_use') {
            const label = toolStatusLabel(event.tool, event.input)
            set({ agentStatus: label })
            maybeStartNewTextBubble()
            // 다음 텍스트 버블이 비어 있으면 사용하지 말고 step만 추가
            // 단, 빈 assistant 초기 placeholder가 있다면 제거
            set((s) => ({
              agentChatHistory: s.agentChatHistory.filter(
                (m) => !(m.role === 'assistant' && m.kind !== 'step' && !m.content && m.id === currentAssistantMsgId)
              ),
            }))
            pushStep('tool', label, undefined)
            // 다음 message_delta를 위해 새 텍스트 버블 새로 생성
            const newId = generateId('am')
            currentAssistantMsgId = newId
            set((s) => ({
              agentChatHistory: [
                ...s.agentChatHistory,
                { id: newId, role: 'assistant', content: '', timestamp: nowTimestamp(), kind: 'message' },
              ],
            }))
          } else if (event.type === 'message_delta') {
            const msgId = currentAssistantMsgId
            set((s) => ({
              agentStatus: null,
              agentChatHistory: s.agentChatHistory.map((m) =>
                m.id === msgId ? { ...m, content: m.content + event.content } : m
              ),
            }))
          } else if (event.type === 'cell_created') {
            createdCellIds.push(event.cell_id)
            set({ agentStatus: '셀 실행 중' })
            get().addCellFromAgent(
              event.cell_id,
              event.cell_type,
              event.code,
              event.cell_name,
              event.after_cell_id ?? null,
            )
            pushStep('cell_created', `셀 생성 · ${event.cell_name}`, event.code)
          } else if (event.type === 'cell_code_updated') {
            set({ agentStatus: '셀 재실행 중' })
            get().updateCellCode(event.cell_id, event.code)
            pushStep('cell_created', '셀 코드 수정', event.code)
          } else if (event.type === 'cell_executed') {
            const executedAt = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
            const isError = event.output?.type === 'error'
            set((s) => ({
              agentStatus: '출력 분석 중',
              cells: s.cells.map((c) => {
                if (c.id !== event.cell_id) return c
                if (c.agentGenerated) {
                  return {
                    ...c,
                    executed: true, executedAt, output: event.output,
                    splitMode: true, splitDir: 'h',
                    activeTab: 'output', leftTab: 'output', rightTab: 'memo',
                  }
                }
                return { ...c, executed: true, executedAt, output: event.output, activeTab: 'output', rightTab: 'output' }
              }),
            }))
            enrichLastStep({
              stepType: isError ? 'error' : 'cell_executed',
              stepLabel: isError ? '셀 실행 실패' : '셀 실행 완료',
              stepDetail: isError ? (event.output as { message?: string })?.message ?? '알 수 없는 오류' : undefined,
            })
          } else if (event.type === 'cell_memo_updated') {
            set((s) => ({
              cells: s.cells.map((c) =>
                c.id === event.cell_id ? { ...c, memo: event.memo } : c
              ),
            }))
            pushStep('cell_memo', '인사이트 메모 기록', event.memo)
          } else if (event.type === 'complete') {
            const lastId = currentAssistantMsgId
            set((s) => ({
              agentStatus: null,
              agentChatHistory: s.agentChatHistory
                .filter((m) => !(m.role === 'assistant' && m.kind !== 'step' && !m.content && m.id !== lastId))
                // 최종 답변이 도착했으므로 중간 step들은 접어둠
                .map((m) =>
                  m.kind === 'step' ? { ...m, collapsed: true }
                  : m.id === lastId ? { ...m, createdCellIds }
                  : m
                ),
            }))
          } else if (event.type === 'error') {
            const msgId = currentAssistantMsgId
            console.error('Agent error:', event.message)
            pushStep('error', '오류 발생', event.message)
            set((s) => ({
              agentStatus: null,
              agentChatHistory: s.agentChatHistory.map((m) =>
                m.id === msgId
                  ? { ...m, content: (m.content ? m.content + '\n\n' : '') + `⚠️ ${event.message}` }
                  : m
              ),
            }))
          }
        },
      )
    } catch (err) {
      console.error('Agent stream failed:', err)
    } finally {
      set({ agentLoading: false, agentStatus: null })
    }
  },

  // ── History & Folders ──────────────────────────────────────────
  histories: [],
  folders: [],
  historyMenuOpen: null,
  historyMenuView: 'main',

  addFolder: (name) => {
    if (!name.trim()) return
    const ordering = Date.now()

    ;(async () => {
      try {
        const f = await apiCreateFolder({ name: name.slice(0, 100), ordering })
        set((s) => ({
          folders: [...s.folders, { id: f.id, name: f.name, isOpen: true }],
        }))
      } catch (err) {
        console.error('addFolder failed:', err)
      }
    })()
  },

  deleteFolder: (id) => {
    set((s) => ({
      folders: s.folders.filter((f) => f.id !== id),
      histories: s.histories.map((h) => (h.folderId === id ? { ...h, folderId: null } : h)),
    }))
    apiDeleteFolder(id).catch((err) => console.error('deleteFolder API failed:', err))
  },

  toggleFolder: (id) => {
    set((s) => ({
      folders: s.folders.map((f) => (f.id === id ? { ...f, isOpen: !f.isOpen } : f)),
    }))
    const folder = get().folders.find((f) => f.id === id)
    if (folder) {
      updateFolder(id, { is_open: folder.isOpen }).catch(() => {})
    }
  },

  duplicateHistory: (id) => {
    const { histories } = get()
    const idx = histories.findIndex((h) => h.id === id)
    if (idx < 0) return
    const original = histories[idx]

    ;(async () => {
      try {
        const detail = await getNotebook(id)
        const nb = await createNotebook({
          title: `${original.title} (복제)`,
          description: detail.description,
          selected_marts: detail.selected_marts,
          folder_id: original.folderId,
        })
        // Copy cells
        for (let i = 0; i < detail.cells.length; i++) {
          const c = detail.cells[i]
          await apiCreateCell(nb.id, {
            id: crypto.randomUUID(),
            name: c.name,
            type: c.type,
            code: c.code,
            memo: c.memo,
            ordering: c.ordering,
          })
        }

        const copy: HistoryItem = {
          id: nb.id,
          title: nb.title,
          date: '방금 전',
          folderId: nb.folder_id,
          isCurrent: false,
        }
        set((s) => {
          const updated = [...s.histories]
          updated.splice(idx + 1, 0, copy)
          return { histories: updated, historyMenuOpen: null }
        })
      } catch (err) {
        console.error('duplicateHistory failed:', err)
      }
    })()
  },

  deleteHistory: (id) => {
    const { histories, notebookId } = get()
    const target = histories.find((h) => h.id === id)
    const title = target?.title ?? '이 분석'
    const ok = typeof window !== 'undefined'
      ? window.confirm(`"${title}"을(를) 정말 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`)
      : true
    if (!ok) {
      set({ historyMenuOpen: null })
      return
    }

    const remaining = histories.filter((h) => h.id !== id)
    const wasCurrent = notebookId === id

    if (wasCurrent) {
      set({
        histories: remaining,
        historyMenuOpen: null,
        notebookId: null,
        cells: [],
        agentChatHistory: [],
        agentSessions: [],
        agentSessionTitle: null,
        analysisTheme: '',
        analysisDescription: '',
        selectedMarts: [],
      })
    } else {
      set({ histories: remaining, historyMenuOpen: null })
    }

    deleteNotebook(id).catch((err) => console.error('deleteHistory API failed:', err))
  },

  moveHistory: (historyId, folderId) => {
    set((s) => ({
      histories: s.histories.map((h) => (h.id === historyId ? { ...h, folderId } : h)),
      historyMenuOpen: null,
    }))
    updateNotebook(historyId, { folder_id: folderId }).catch(() => {})
  },

  setHistoryMenuOpen: (id) => set({ historyMenuOpen: id, historyMenuView: 'main' }),
  setHistoryMenuView: (view) => set({ historyMenuView: view }),

  // ── Reporting ──────────────────────────────────────────────────
  showReportModal: false,
  generatingReport: false,
  reportContent: '',
  showReport: false,
  setShowReportModal: (v) => set({ showReportModal: v }),

  generateReport: (cellIds) => {
    const { cells, analysisTheme, analysisDescription, selectedMarts } = get()
    set({ generatingReport: true, showReportModal: false })

    setTimeout(() => {
      const selectedCells = cells.filter((c) => cellIds.includes(c.id))
      const today = new Date().toLocaleDateString('ko-KR')

      const lines = [
        `# ${analysisTheme}`,
        '',
        `> **분석일자**: ${today}  `,
        `> **사용 마트**: ${selectedMarts.join(', ')}  `,
        `> **분석 셀 수**: ${selectedCells.length}개`,
        '',
        '## 분석 배경',
        '',
        analysisDescription,
        '',
        '---',
        '',
        ...selectedCells.flatMap((c) => [
          `## ${c.name} (${c.type.toUpperCase()})`,
          '',
          '```' + c.type,
          c.code,
          '```',
          '',
          c.type === 'markdown' ? c.code : '*(실행 결과 생략)*',
          '',
          c.insight ? `> **인사이트**: ${c.insight}` : '',
          '',
        ]),
      ]

      set({
        generatingReport: false,
        reportContent: lines.filter((l) => l !== undefined).join('\n'),
        showReport: true,
      })
    }, 1500)
  },

  setShowReport: (v) => set({ showReport: v }),

  // ── Toast ──────────────────────────────────────────────────────
  rollbackToast: null,
  setRollbackToast: (data) => set({ rollbackToast: data }),
}))

// ─── Private helper ───────────────────────────────────────────────────────────

function _applyNotebookDetail(detail: NotebookDetail, _isFirst: boolean) {
  const seenIds = new Set<string>()
  const cells = detail.cells
    .map(rowToCell)
    .filter((c) => {
      if (seenIds.has(c.id)) return false
      seenIds.add(c.id)
      return true
    })
  const agentChatHistory = detail.agent_messages.map(rowToAgentMsg)
  const agentSessions = loadAgentSessions(detail.id)

  useAppStore.setState((s) => ({
    notebookId: detail.id,
    cells,
    activeCellId: cells[0]?.id ?? null,
    analysisTheme: detail.title,
    analysisDescription: detail.description,
    selectedMarts: detail.selected_marts,
    agentChatHistory,
    agentSessions,
    agentSessionTitle: null,
    histories: s.histories.map((h) => ({ ...h, isCurrent: h.id === detail.id })),
  }))
}
