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
  ImageAttachment,
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
  loadCurrentSessionMeta,
  saveCurrentSessionMeta,
  toSnakeCase,
  toolStatusLabel,
  summarizeCellOutput,
} from '@/lib/utils'
import {
  streamVibeChat,
  streamAgentMessage,
  archiveAgentHistory,
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
const _vibeControllers = new Map<string, AbortController>()
let _agentController: AbortController | null = null
const _pendingSaves = new Map<string, () => void>()
function debounced(key: string, fn: () => void, delay = 800) {
  const t = _debounceTimers.get(key)
  if (t) clearTimeout(t)
  _pendingSaves.set(key, fn)
  _debounceTimers.set(key, setTimeout(() => {
    _debounceTimers.delete(key)
    _pendingSaves.delete(key)
    fn()
  }, delay))
}
function flushDebouncedForCell(cellId: string) {
  // 해당 셀 관련 debounce (code-<id>, memo-<id>) 를 즉시 실행 + timer 해제
  for (const key of Array.from(_pendingSaves.keys())) {
    if (key.endsWith(`-${cellId}`)) {
      const t = _debounceTimers.get(key)
      if (t) { clearTimeout(t); _debounceTimers.delete(key) }
      const fn = _pendingSaves.get(key)
      _pendingSaves.delete(key)
      try { fn?.() } catch (e) { console.warn('flush failed', key, e) }
    }
  }
}

// ─── DB row → Cell converter ─────────────────────────────────────────────────

function defaultCellUi(type: CellType) {
  // sheet 셀은 단일 패널(입력=스프레드시트)이 기본. 그 외는 좌우 분할.
  if (type === 'sheet') {
    return { splitMode: false, splitDir: 'h' as const, activeTab: 'input' as const, leftTab: 'input' as const, rightTab: 'output' as const }
  }
  return { splitMode: true, splitDir: 'h' as const, activeTab: 'input' as const, leftTab: 'input' as const, rightTab: 'output' as const }
}

function rowToCell(row: CellRow): Cell {
  const savedUi = loadCellUi(row.id)
  const type = row.type as CellType
  const defUi = defaultCellUi(type)
  // 온보딩 마크다운 셀은 분할 없이 출력 탭으로 고정 (읽기용 가이드)
  const isOnboardingMarkdown = row.onboarding && type === 'markdown'
  return {
    id: row.id,
    name: row.name,
    type,
    code: row.code,
    memo: row.memo ?? '',
    ordering: row.ordering,
    splitMode: isOnboardingMarkdown ? false : (savedUi.splitMode ?? defUi.splitMode),
    splitDir: savedUi.splitDir ?? defUi.splitDir,
    activeTab: isOnboardingMarkdown ? 'output' : (savedUi.activeTab ?? (row.executed ? 'output' : defUi.activeTab)),
    leftTab: savedUi.leftTab ?? defUi.leftTab,
    rightTab: savedUi.rightTab ?? defUi.rightTab,
    executed: row.executed,
    executedAt: null,
    output: (row.output as Cell['output']) ?? null,
    chatInput: '',
    chatHistory: row.chat_entries.map((e, i, arr) => ({
      id: i + 1,
      user: e.user_message,
      assistant: e.assistant_reply,
      timestamp: new Date(e.created_at).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      codeSnapshot: e.code_snapshot,
      // legacy 엔트리(code_result 없음): 다음 엔트리의 snapshot(=N+1 pre=N post).
      // 마지막 엔트리이면서 code_result 비어있으면 현재 row.code로 폴백.
      codeResult: e.code_result ?? (i < arr.length - 1 ? arr[i + 1].code_snapshot : row.code),
      agentCreated: e.agent_created ?? false,
    })),
    historyOpen: row.chat_entries.length > 0,
    chatImages: [],
    insight: row.insight ?? null,
    agentGenerated: row.agent_generated,
  }
}

function rowToAgentMsgs(row: AgentMessageRow): AgentMessage[] {
  const ts = new Date(row.created_at).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  })
  // 레거시 엔트리(blocks 없음) 또는 user role → 단일 메시지.
  if (row.role === 'user' || !row.blocks || row.blocks.length === 0) {
    return [
      {
        id: row.id,
        role: row.role,
        content: row.content,
        timestamp: ts,
        createdCellIds: row.created_cell_ids,
      },
    ]
  }
  // assistant + blocks: 라이브 스트림과 동일한 step/message 시퀀스로 확장.
  const out: AgentMessage[] = []
  let idx = 0
  const nextId = () => `${row.id}-b${idx++}`
  let lastTextIdx = -1
  for (const block of row.blocks) {
    if (block.type === 'text') {
      out.push({ id: nextId(), role: 'assistant', content: block.text, timestamp: ts, kind: 'message' })
      lastTextIdx = out.length - 1
    } else if (block.type === 'tool_use') {
      out.push({
        id: nextId(), role: 'assistant', content: '', timestamp: ts,
        kind: 'step', stepType: 'tool',
        stepLabel: toolStatusLabel(block.tool, block.input),
        collapsed: true,
      })
    } else if (block.type === 'cell_created') {
      out.push({
        id: nextId(), role: 'assistant', content: '', timestamp: ts,
        kind: 'step', stepType: 'cell_created',
        stepLabel: `셀 생성 · ${block.cell_name}`,
        stepDetail: block.code,
        collapsed: true,
      })
    } else if (block.type === 'cell_code_updated') {
      out.push({
        id: nextId(), role: 'assistant', content: '', timestamp: ts,
        kind: 'step', stepType: 'cell_created',
        stepLabel: '셀 코드 수정',
        stepDetail: block.code,
        collapsed: true,
      })
    } else if (block.type === 'cell_executed') {
      // 라이브 UX 와 동일: 직전 cell_created step 을 in-place 업그레이드.
      const prev = out[out.length - 1]
      const patch = {
        stepType: (block.is_error ? 'error' : 'cell_executed') as NonNullable<AgentMessage['stepType']>,
        stepLabel: block.is_error ? '셀 실행 실패' : '셀 실행 완료',
        stepDetail: block.is_error ? (block.error_message || '알 수 없는 오류') : undefined,
      }
      if (prev && prev.kind === 'step' && prev.stepType === 'cell_created') {
        out[out.length - 1] = { ...prev, ...patch }
      } else {
        out.push({
          id: nextId(), role: 'assistant', content: '', timestamp: ts,
          kind: 'step', collapsed: true, ...patch,
        })
      }
    } else if (block.type === 'cell_memo_updated') {
      out.push({
        id: nextId(), role: 'assistant', content: '', timestamp: ts,
        kind: 'step', stepType: 'cell_memo',
        stepLabel: '인사이트 메모 기록',
        stepDetail: block.memo,
        collapsed: true,
      })
    } else if (block.type === 'error') {
      out.push({
        id: nextId(), role: 'assistant', content: '', timestamp: ts,
        kind: 'step', stepType: 'error',
        stepLabel: '오류 발생',
        stepDetail: block.message,
        collapsed: true,
      })
    }
  }
  // createdCellIds 는 마지막 텍스트 버블(= "최종 답변") 에 부착.
  if (lastTextIdx >= 0 && row.created_cell_ids?.length) {
    out[lastTextIdx] = { ...out[lastTextIdx], createdCellIds: row.created_cell_ids }
  } else if (out.length > 0 && row.created_cell_ids?.length) {
    // 텍스트가 전혀 없으면 마지막 step 에 부착.
    out[out.length - 1] = { ...out[out.length - 1], createdCellIds: row.created_cell_ids }
  }
  // blocks 만으로 복원 실패 시 최소한 content 로 폴백
  if (out.length === 0 && row.content) {
    out.push({
      id: row.id, role: 'assistant', content: row.content, timestamp: ts,
      createdCellIds: row.created_cell_ids,
    })
  }
  return out
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
  cellFocusMode: 'command' | 'edit'
  setCellFocusMode: (mode: 'command' | 'edit') => void
  selectedPanelKey: string | null
  setSelectedPanelKey: (key: string | null) => void
  fullscreenCellId: string | null
  setFullscreenCellId: (id: string | null) => void
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
  cycleCellTypeById: (id: string) => Promise<void>
  executeCell: (id: string) => Promise<void>
  executeAllCells: () => Promise<void>
  updateCellChatInput: (id: string, input: string) => void
  updateCellChatImages: (id: string, images: ImageAttachment[]) => void
  cellEditOrigins: Record<string, number>
  setCellEditOrigin: (cellId: string, idx: number | null) => void
  cellActiveEntryId: Record<string, number | null>
  submitVibe: (cellId: string, message: string) => void
  cancelVibe: (cellId: string) => void
  rollbackCell: (cellId: string, entryId: number) => void
  deleteChatEntry: (cellId: string, index: number) => void
  toggleCellHistory: (id: string) => void
  toggleAllCellHistory: () => void
  setCellInsight: (id: string, insight: string | null) => void

  // ── Agent mode ─────────────────────────────────────────────────────────────
  agentMode: boolean
  agentChatInput: string
  agentChatImages: ImageAttachment[]
  setAgentChatImages: (images: ImageAttachment[]) => void
  agentChatHistory: AgentMessage[]
  agentSessions: AgentSession[]
  agentSessionTitle: string | null
  currentSessionCreatedAtMs: number | null
  /**
   * 현재 진행 중인 에이전트 대화의 안정적인 ID.
   * - 첫 턴 전에는 null
   * - 첫 턴 시작 시 새 ID 발급
   * - 세션 아카이브(newAgentSession) 시 이 ID 그대로 `agentSessions[]` 에 보관 (새 ID 생성 X)
   * - 다른 세션 resume 시 해당 세션 ID가 그대로 currentSessionId 가 됨
   * 덕분에 접힘 상태 같은 UI 상태를 이 ID 기준으로 일관되게 유지 가능.
   */
  currentSessionId: string | null
  /** 접힘 상태: 세션 ID → collapsed 여부 */
  collapsedSessionIds: Record<string, boolean>
  toggleSessionCollapsed: (id: string) => void
  toggleAllSessionsCollapsed: (sessionIds: string[]) => void
  agentLoading: boolean
  agentStartedAtMs: number | null
  agentStatus: string | null
  agentRefCells: string[]
  toggleAgentRefCell: (id: string) => void
  toggleAgentMode: () => void
  setAgentChatInput: (v: string) => void
  submitAgentMessage: (message: string) => void
  cancelAgent: () => void
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
  reportTitle: string
  reportError: string | null
  currentReportId: string | null
  showReport: boolean
  reports: import('@/lib/api').ReportSummary[]
  reportStages: { stage: import('@/lib/api').ReportStage; label: string; at: number }[]
  reportStartedAt: number | null
  reportProcessingNotes: import('@/lib/api').ReportProcessingNotes | null
  reportOutline: import('@/lib/api').ReportOutline | null
  reportIsDraft: boolean
  reportSaving: boolean
  saveCurrentReport: () => Promise<void>
  closeCurrentReport: () => Promise<void>
  setShowReportModal: (v: boolean) => void
  generateReport: (args: { cellIds: string[]; goal?: string }) => Promise<void>
  setShowReport: (v: boolean) => void
  fetchReports: () => Promise<void>
  openReport: (id: string) => Promise<void>
  removeReport: (id: string) => Promise<void>

  // ── Files tree (root notebooks-dir) ───────────────────────────────────────
  filesTree: import('@/lib/api').FileNode[]
  filesRoot: string
  filesLoading: boolean
  fetchFilesTree: () => Promise<void>

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

      // 리포트 목록도 초기 로드 (실패해도 앱 동작에 영향 없음)
      void get().fetchReports()
      void get().fetchFilesTree()

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
      // 제목 변경은 서버에서 .ipynb 파일명을 rename 한다. 응답 후 filesTree 를 다시 fetch 해서
      // 사이드바 경로 목록이 stale 상태로 남지 않게 한다 — stale path 로 POST /files/move 호출 시 404 방지.
      debounced(`theme-${notebookId}`, async () => {
        try {
          await updateNotebook(notebookId, { title: v })
          await get().fetchFilesTree()
        } catch {}
      })
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
  fullscreenCellId: null,
  cellFocusMode: 'command',
  setCellFocusMode: (mode) => set({ cellFocusMode: mode }),
  selectedPanelKey: null,
  setSelectedPanelKey: (key) => set({ selectedPanelKey: key }),

  setFullscreenCellId: (id) => set({ fullscreenCellId: id }),

  setActiveCellId: (id) =>
    set((s) => ({
      activeCellId: id,
      // 전체화면 중에 활성 셀이 바뀌면 전체화면 대상도 따라 이동.
      // (id가 null이면 전체화면 유지 — 명시적으로 setFullscreenCellId(null) 호출 필요)
      fullscreenCellId: s.fullscreenCellId && id ? id : s.fullscreenCellId,
      cells:
        id && id !== s.activeCellId
          ? s.cells.map((c) => {
              if (c.id === id) return c.chatHistory.length > 0 ? { ...c, historyOpen: true } : c
              if (c.id === s.activeCellId) return { ...c, historyOpen: false }
              return c
            })
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
        chatImages: [],
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
      await get().fetchFilesTree()
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
      executed: type === 'markdown' || type === 'sheet',
      executedAt: null,
      output: null,
      chatInput: '',
      chatImages: [],
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
      chatImages: [],
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

  cycleCellTypeById: async (id) => {
    const current = get().cells.find((c) => c.id === id)
    if (!current) return
    // sheet 셀은 타입 전환 불가(고정)
    if (current.type === 'sheet') return
    const newType = cycleCellType(current.type)
    if (newType === current.type) return
    set((s) => ({
      cells: s.cells.map((c) =>
        c.id === id
          ? { ...c, type: newType, executed: newType === 'markdown' || newType === 'sheet' }
          : c
      ),
    }))
    const { notebookId } = get()
    if (notebookId) {
      try {
        await updateCell(notebookId, id, { type: newType })
      } catch (e) {
        console.warn('cycle type failed', e)
      }
    }
  },

  executeCell: async (id) => {
    const { executingCells } = get()
    if (executingCells.has(id)) return

    // 디바운스 저장이 대기 중인 코드/메모를 즉시 flush — stale 상태로 실행되는 것 방지
    flushDebouncedForCell(id)
    // debounce flush 가 API 호출을 바로 보내므로 약간 대기해 네트워크 정착
    await new Promise((r) => setTimeout(r, 30))

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
      const { ApiError } = await import('@/lib/api')
      const { toast } = await import('@/store/useToastStore')
      const detail = err instanceof ApiError ? err.detail : String(err)
      const cell = get().cells.find((c) => c.id === id)
      toast.error(`셀 실행 실패${cell?.name ? ` — ${cell.name}` : ''}`, detail)
      const errOutput: import('@/types').CellOutput = {
        type: 'error',
        message: detail,
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
      .filter((c) => c.type !== 'markdown' && c.type !== 'sheet')
      .sort((a, b) => a.ordering - b.ordering)
    for (const cell of toRun) {
      await get().executeCell(cell.id)
    }
  },

  cellEditOrigins: {},
  cellActiveEntryId: {},

  setCellEditOrigin: (cellId, idx) =>
    set((s) => {
      const next = { ...s.cellEditOrigins }
      if (idx === null) delete next[cellId]
      else next[cellId] = idx
      return { cellEditOrigins: next }
    }),

  updateCellChatInput: (id, input) =>
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, chatInput: input } : c)) })),

  updateCellChatImages: (id, images) =>
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, chatImages: images } : c)) })),

  submitVibe: async (cellId, message) => {
    if (!message.trim()) return
    const { cells, analysisTheme, selectedMarts, martCatalog, cellEditOrigins, setCellEditOrigin, notebookId } = get()
    const cell = cells.find((c) => c.id === cellId)
    if (!cell) return

    const editFromIdx = cellEditOrigins[cellId] ?? null
    const codeSnapshot = cell.code
    const pendingImages = cell.chatImages ?? []

    set((s) => ({
      vibingCells: new Set([...s.vibingCells, cellId]),
      cells: s.cells.map((c) =>
        c.id === cellId
          ? {
              ...c,
              chatInput: '',
              chatImages: [],
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
    const controller = new AbortController()
    _vibeControllers.set(cellId, controller)

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
          images: pendingImages.length > 0
            ? pendingImages.map((img) => ({ media_type: img.mediaType, data: img.data }))
            : undefined,
          current_output_summary: summarizeCellOutput(cell.output),
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
              codeResult: finalCode,
            }
            set((s) => ({
              cells: s.cells.map((c) =>
                c.id === cellId ? { ...c, code: finalCode, chatHistory: [...c.chatHistory, entry] } : c
              ),
              cellActiveEntryId: { ...s.cellActiveEntryId, [cellId]: null },
            }))
            const { notebookId: nbId } = get()
            // 실행 전에 최종 코드가 파일에 반영돼 있어야 한다. debounce 취소 후 동기 저장.
            const debounceKey = `code-${cellId}`
            const t = _debounceTimers.get(debounceKey)
            if (t) { clearTimeout(t); _debounceTimers.delete(debounceKey) }
            if (nbId) {
              updateCell(nbId, cellId, { code: finalCode })
                .catch(() => {})
                .finally(() => { get().executeCell(cellId) })
            } else {
              get().executeCell(cellId)
            }
          } else if (event.type === 'error') {
            console.error('Vibe error:', event.message)
            set((s) => ({
              cells: s.cells.map((c) =>
                c.id === cellId ? { ...c, code: codeSnapshot } : c
              ),
            }))
          }
        },
        controller.signal,
      )
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError'
      if (!aborted) console.error('Vibe chat failed:', err)
      set((s) => ({
        cells: s.cells.map((c) =>
          c.id === cellId ? { ...c, code: codeSnapshot } : c
        ),
      }))
    } finally {
      _vibeControllers.delete(cellId)
      set((s) => ({
        vibingCells: new Set([...s.vibingCells].filter((id) => id !== cellId)),
      }))
    }
  },

  cancelVibe: (cellId) => {
    const ctrl = _vibeControllers.get(cellId)
    if (ctrl) {
      ctrl.abort()
      _vibeControllers.delete(cellId)
    }
  },

  rollbackCell: (cellId, entryId) => {
    const { cells } = get()
    const cell = cells.find((c) => c.id === cellId)
    if (!cell) return
    const entry = cell.chatHistory.find((e) => e.id === entryId)
    if (!entry) return

    const targetCode = entry.codeResult

    set((s) => ({
      cells: s.cells.map((c) => (c.id === cellId ? { ...c, code: targetCode } : c)),
      cellActiveEntryId: { ...s.cellActiveEntryId, [cellId]: entryId },
      rollbackToast: { cellName: cell.name, timestamp: entry.timestamp },
    }))

    const { notebookId } = get()
    if (notebookId) updateCell(notebookId, cellId, { code: targetCode }).catch(() => {})
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
  toggleAllCellHistory: () =>
    set((s) => {
      const withHistory = s.cells.filter((c) => c.chatHistory.length > 0)
      if (withHistory.length === 0) return {}
      // 하나라도 열려 있으면 전부 접고, 전부 닫혀 있으면 전부 편다.
      const anyOpen = withHistory.some((c) => c.historyOpen)
      const next = !anyOpen
      return {
        cells: s.cells.map((c) =>
          c.chatHistory.length > 0 ? { ...c, historyOpen: next } : c
        ),
      }
    }),

  setCellInsight: (id, insight) => {
    set((s) => ({ cells: s.cells.map((c) => (c.id === id ? { ...c, insight } : c)) }))
    const { notebookId } = get()
    if (notebookId) updateCell(notebookId, id, { insight }).catch(() => {})
  },

  // ── Agent mode ─────────────────────────────────────────────────────────────
  agentMode: false,
  agentChatInput: '',
  agentChatImages: [],
  agentChatHistory: [],
  agentSessions: [],
  agentSessionTitle: null,
  currentSessionCreatedAtMs: null,
  currentSessionId: null,
  collapsedSessionIds: {},
  toggleSessionCollapsed: (id) =>
    set((s) => ({ collapsedSessionIds: { ...s.collapsedSessionIds, [id]: !s.collapsedSessionIds[id] } })),
  toggleAllSessionsCollapsed: (sessionIds) =>
    set((s) => {
      if (sessionIds.length === 0) return {}
      // 하나라도 펼쳐져 있으면 전부 접고, 전부 접혀 있으면 전부 편다.
      const anyExpanded = sessionIds.some((id) => !s.collapsedSessionIds[id])
      const next = anyExpanded
      const map = { ...s.collapsedSessionIds }
      sessionIds.forEach((id) => { map[id] = next })
      return { collapsedSessionIds: map }
    }),
  agentLoading: false,
  agentStartedAtMs: null,
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
  setAgentChatImages: (images) => set({ agentChatImages: images }),

  toggleAgentMessageCollapse: (id) =>
    set((s) => ({
      agentChatHistory: s.agentChatHistory.map((m) =>
        m.id === id ? { ...m, collapsed: !m.collapsed } : m
      ),
    })),

  newAgentSession: () => {
    const { agentChatHistory, agentSessions, agentSessionTitle, notebookId, currentSessionCreatedAtMs, currentSessionId } = get()
    if (!agentChatHistory.length) return
    const firstUser = agentChatHistory.find((m) => m.role === 'user')
    const fallback = (firstUser?.content ?? '새 대화').trim().replace(/\s+/g, ' ')
    const fallbackTitle = fallback.length > 40 ? fallback.slice(0, 40) + '…' : fallback
    const title = agentSessionTitle?.trim() || fallbackTitle
    // 안정적 ID 유지: 현재 세션 ID를 그대로 사용해 아카이브 (새 ID 생성 X).
    // 덕분에 접힘 상태 같은 UI 메타가 이 ID 기준으로 계속 유효.
    const stableId = currentSessionId ?? generateId('as')
    const session: AgentSession = {
      id: stableId,
      title,
      startedAt: agentChatHistory[0]?.timestamp ?? nowTimestamp(),
      createdAtMs: currentSessionCreatedAtMs ?? Date.now(),
      messages: agentChatHistory,
    }
    // 생성 시점 오름차순 위치에 삽입 (기존 순서 유지)
    const updated = [...agentSessions]
    const insertAt = updated.findIndex((s) => (s.createdAtMs ?? 0) > (session.createdAtMs ?? 0))
    if (insertAt < 0) updated.push(session)
    else updated.splice(insertAt, 0, session)
    set({
      agentChatHistory: [],
      agentSessions: updated,
      agentSessionTitle: null,
      currentSessionCreatedAtMs: null,
      currentSessionId: null,
      agentRefCells: [],
    })
    if (notebookId) {
      saveAgentSessions(notebookId, updated)
      saveCurrentSessionMeta(notebookId, null)
      // 서버의 agent_history 도 비워, 다음 로드 때 아카이브된 메시지가 '현재 대화'로 다시 올라오지 않게 한다.
      archiveAgentHistory(notebookId).catch(() => {})
    }
  },

  resumeAgentSession: (id) => {
    const {
      agentChatHistory, agentSessions, agentSessionTitle, agentLoading,
      notebookId, currentSessionCreatedAtMs, currentSessionId,
    } = get()
    if (agentLoading) return
    const targetIdx = agentSessions.findIndex((s) => s.id === id)
    if (targetIdx < 0) return
    const target = agentSessions[targetIdx]

    // 현재 대화가 있으면 원래 생성 순서 위치에 아카이브 (가장 아래로 밀리지 않게).
    // 아카이브 시 현재 세션의 안정적 ID 를 그대로 사용 — 접힘 상태 일관성 유지.
    let sessions: AgentSession[] = [...agentSessions]
    if (agentChatHistory.length > 0) {
      const firstUser = agentChatHistory.find((m) => m.role === 'user')
      const fallback = (firstUser?.content ?? '새 대화').trim().replace(/\s+/g, ' ')
      const fallbackTitle = fallback.length > 40 ? fallback.slice(0, 40) + '…' : fallback
      const title = agentSessionTitle?.trim() || fallbackTitle
      const archivedId = currentSessionId ?? generateId('as')
      const archived: AgentSession = {
        id: archivedId,
        title,
        startedAt: agentChatHistory[0]?.timestamp ?? nowTimestamp(),
        createdAtMs: currentSessionCreatedAtMs ?? Date.now(),
        messages: agentChatHistory,
      }
      // 생성 시점 오름차순으로 정렬된 위치에 삽입
      const insertAt = sessions.findIndex((s) => (s.createdAtMs ?? 0) > (archived.createdAtMs ?? 0))
      if (insertAt < 0) sessions.push(archived)
      else sessions.splice(insertAt, 0, archived)
    }
    // resume한 세션은 목록에서 제거 (활성 대화로 올라감)
    sessions = sessions.filter((s) => s.id !== id)

    set({
      agentChatHistory: target.messages,
      agentSessions: sessions,
      agentSessionTitle: target.title,
      currentSessionCreatedAtMs: target.createdAtMs ?? Date.now(),
      currentSessionId: id, // resume 된 세션 ID 를 그대로 current 로 사용
      agentRefCells: [],
      agentMode: true,
    })
    if (notebookId) {
      saveAgentSessions(notebookId, sessions)
      // resume 한 세션을 "현재 대화" 메타로 기록 — 새로고침 시 sidebar 에 그대로 복원.
      saveCurrentSessionMeta(notebookId, {
        id,
        createdAtMs: target.createdAtMs ?? Date.now(),
        title: target.title ?? null,
      })
      // 현재 대화를 아카이브했다면 서버의 agent_history 도 비운다.
      // resume 된 세션의 메시지들은 localStorage 에만 있고, 다음 턴부터 새로 agent_history 에 쌓임.
      archiveAgentHistory(notebookId).catch(() => {})
    }
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
    const isAgentMarkdown = type === 'markdown'
    const newCell: Cell = {
      id,
      name,
      type,
      code,
      memo: '',
      ordering,
      splitMode: isAgentMarkdown ? false : defUi.splitMode,
      splitDir: defUi.splitDir,
      activeTab: isAgentMarkdown ? 'output' : defUi.activeTab,
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

    const pendingImages = get().agentChatImages ?? []

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
      agentChatImages: [],
      currentSessionCreatedAtMs: isFirstUserMsg ? Date.now() : (s.currentSessionCreatedAtMs ?? Date.now()),
      currentSessionId: s.currentSessionId ?? generateId('as'),
      agentLoading: true,
      agentStartedAtMs: Date.now(),
      agentStatus: '생각 중',
    }))

    // 현재 세션 메타를 localStorage 에 반영 — 새로고침 후에도 "현재 대화" 로 복원 가능.
    {
      const st = get()
      if (st.notebookId && st.currentSessionId && st.currentSessionCreatedAtMs) {
        saveCurrentSessionMeta(st.notebookId, {
          id: st.currentSessionId,
          createdAtMs: st.currentSessionCreatedAtMs,
          title: st.agentSessionTitle,
        })
      }
    }

    if (isFirstUserMsg && !get().agentSessionTitle) {
      generateAgentSessionTitle(message).then((title) => {
        if (title && !get().agentSessionTitle) {
          set({ agentSessionTitle: title })
          const st = get()
          if (st.notebookId && st.currentSessionId && st.currentSessionCreatedAtMs) {
            saveCurrentSessionMeta(st.notebookId, {
              id: st.currentSessionId,
              createdAtMs: st.currentSessionCreatedAtMs,
              title,
            })
          }
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

    const { cells, selectedMarts, martCatalog, analysisTheme, analysisDescription, agentChatHistory, notebookId } = get()
    const assistantMsgId = generateId('am')
    set((s) => ({
      agentChatHistory: [
        ...s.agentChatHistory,
        { id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: nowTimestamp(), kind: 'message' },
      ],
    }))

    const createdCellIds: string[] = []
    let currentAssistantMsgId: string = assistantMsgId
    _agentController = new AbortController()

    try {
      await streamAgentMessage(
        {
          message,
          cells: cells.map((c) => ({ id: c.id, name: c.name, type: c.type, code: c.code, executed: c.executed })),
          selected_marts: selectedMarts,
          mart_metadata: martCatalog
            .filter((m) => selectedMarts.includes(m.key))
            .map((m) => ({ key: m.key, description: m.description, columns: m.columns })),
          analysis_theme: analysisTheme,
          analysis_description: analysisDescription,
          conversation_history: agentChatHistory
            .filter((m) => m.content)
            .map((m) => ({ role: m.role, content: m.content })),
          notebook_id: notebookId,
          images: pendingImages.length > 0
            ? pendingImages.map((img) => ({ media_type: img.mediaType, data: img.data }))
            : undefined,
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
          } else if (event.type === 'reset_current_bubble') {
            // 백엔드가 내레이션 가드로 턴을 폐기할 때, 현재 말풍선에 흘러간 텍스트를 비운다.
            const msgId = currentAssistantMsgId
            set((s) => ({
              agentChatHistory: s.agentChatHistory.map((m) =>
                m.id === msgId ? { ...m, content: '' } : m
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
            if (event.agent_chat_entry) {
              const entry = event.agent_chat_entry
              const ts = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
              set((s) => ({
                cells: s.cells.map((c) =>
                  c.id === event.cell_id
                    ? {
                        ...c,
                        chatHistory: [...c.chatHistory, {
                          id: c.chatHistory.length + 1,
                          user: entry.user,
                          assistant: entry.assistant,
                          timestamp: ts,
                          codeSnapshot: '',
                          codeResult: event.code,
                          agentCreated: entry.agent_created ?? true,
                        }],
                        historyOpen: true,
                      }
                    : c
                ),
              }))
            }
            pushStep('cell_created', `셀 생성 · ${event.cell_name}`, event.code)
          } else if (event.type === 'cell_code_updated') {
            set({ agentStatus: '셀 재실행 중' })
            get().updateCellCode(event.cell_id, event.code)
            if (event.agent_chat_entry) {
              const entry = event.agent_chat_entry
              const ts = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
              set((s) => ({
                cells: s.cells.map((c) =>
                  c.id === event.cell_id
                    ? {
                        ...c,
                        chatHistory: [...c.chatHistory, {
                          id: c.chatHistory.length + 1,
                          user: entry.user,
                          assistant: entry.assistant,
                          timestamp: ts,
                          codeSnapshot: entry.code_snapshot ?? '',
                          codeResult: event.code,
                          agentCreated: entry.agent_created ?? true,
                        }],
                        historyOpen: true,
                      }
                    : c
                ),
              }))
            }
            pushStep('cell_created', '셀 코드 수정', event.code)
          } else if (event.type === 'cell_executed') {
            const executedAt = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
            const isError = event.output?.type === 'error'
            set((s) => ({
              agentStatus: '출력 분석 중',
              cells: s.cells.map((c) => {
                if (c.id !== event.cell_id) return c
                const out = event.output ?? null
                if (c.agentGenerated) {
                  return {
                    ...c,
                    executed: true, executedAt, output: out,
                    splitMode: true, splitDir: 'h' as const,
                    activeTab: 'output' as const, leftTab: 'output' as const, rightTab: 'memo' as const,
                  }
                }
                return { ...c, executed: true, executedAt, output: out, activeTab: 'output' as const, rightTab: 'output' as const }
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
            set((s) => {
              // 스트림 종료 시점: 빈 assistant 메시지는 모두 제거(미리 만들어 둔 placeholder 포함).
              // createdCellIds는 내용이 있는 마지막 어시스턴트 말풍선에 붙인다.
              const cleaned = s.agentChatHistory.filter(
                (m) => !(m.role === 'assistant' && m.kind !== 'step' && !m.content)
              )
              let attached = false
              const withCells = [...cleaned]
              for (let i = withCells.length - 1; i >= 0 && !attached; i--) {
                const m = withCells[i]
                if (m.role === 'assistant' && m.kind !== 'step' && m.content) {
                  withCells[i] = { ...m, createdCellIds }
                  attached = true
                }
              }
              return {
                agentStatus: null,
                agentChatHistory: withCells.map((m) =>
                  m.kind === 'step' ? { ...m, collapsed: true } : m
                ),
              }
            })
            void lastId
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
        _agentController.signal,
      )
      // 에이전트 완료 후 제목 재생성 — 첫 질문 + 에이전트 최종 응답을 함께 요약해 실제 작업 맥락이 반영된 제목으로 덮어쓴다.
      // (초기 빠른 제목은 질문만으로 뽑은 것이라 "설정했어." 같은 짧은 질문에는 적절치 않음)
      try {
        const st = get()
        const firstUserMsg = st.agentChatHistory.find((m) => m.role === 'user')?.content ?? ''
        const lastAsstMsg = [...st.agentChatHistory]
          .reverse()
          .find((m) => m.role === 'assistant' && m.kind !== 'step' && m.content)?.content ?? ''
        if (firstUserMsg.trim() && lastAsstMsg.trim()) {
          const refined = await generateAgentSessionTitle(firstUserMsg, lastAsstMsg)
          if (refined) {
            const st2 = get()
            // 사용자가 resume 로 다른 세션으로 전환했으면 현재 세션이 바뀌었을 수 있음 → 확인 후 반영.
            if (st2.currentSessionId === st.currentSessionId) {
              set({ agentSessionTitle: refined })
              if (st2.notebookId && st2.currentSessionId && st2.currentSessionCreatedAtMs) {
                saveCurrentSessionMeta(st2.notebookId, {
                  id: st2.currentSessionId,
                  createdAtMs: st2.currentSessionCreatedAtMs,
                  title: refined,
                })
              }
            }
          }
        }
      } catch (e) {
        // 제목 재생성 실패는 조용히 무시 — 초기 제목이 그대로 유지됨.
        console.warn('title refresh failed:', e)
      }
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError'
      if (!aborted) console.error('Agent stream failed:', err)
    } finally {
      _agentController = null
      set({ agentLoading: false, agentStartedAtMs: null, agentStatus: null })
    }
  },

  cancelAgent: () => {
    if (_agentController) {
      _agentController.abort()
      _agentController = null
    }
    set((s) => {
      const history = [...s.agentChatHistory]
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i]
        if (m.kind !== 'step' && m.role === 'assistant' && !m.content) {
          history[i] = { ...m, content: '중지되었습니다.' }
          break
        }
      }
      return { agentChatHistory: history }
    })
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
        currentSessionId: null,
        currentSessionCreatedAtMs: null,
        collapsedSessionIds: {},
        analysisTheme: '',
        analysisDescription: '',
        selectedMarts: [],
      })
    } else {
      set({ histories: remaining, historyMenuOpen: null })
    }

    // 삭제되는 노트북의 세션 메타도 정리
    saveCurrentSessionMeta(id, null)

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
  reportTitle: '',
  reportError: null,
  currentReportId: null,
  showReport: false,
  reports: [],
  reportStages: [],
  reportStartedAt: null,
  reportProcessingNotes: null,
  reportOutline: null,
  reportIsDraft: false,
  reportSaving: false,
  setShowReportModal: (v) => set({ showReportModal: v }),

  generateReport: async ({ cellIds, goal }) => {
    const { notebookId, analysisTheme } = get()
    if (!notebookId) return
    set({
      generatingReport: true,
      showReportModal: false,
      showReport: true,
      reportContent: '',
      reportTitle: analysisTheme || '분석 리포트',
      reportError: null,
      currentReportId: null,
      reportStages: [],
      reportStartedAt: Date.now(),
      reportProcessingNotes: null,
      reportOutline: null,
      reportIsDraft: false,
    })
    try {
      const api = await import('@/lib/api')
      await api.streamReport(
        { notebook_id: notebookId, cell_ids: cellIds, goal: goal || '' },
        (event) => {
          if (event.type === 'delta') {
            set((s) => ({ reportContent: s.reportContent + event.content }))
          } else if (event.type === 'stage') {
            set((s) => ({
              reportStages: [...s.reportStages, { stage: event.stage, label: event.label, at: Date.now() }],
            }))
          } else if (event.type === 'meta') {
            set({
              reportProcessingNotes: event.processing_notes,
              reportOutline: event.outline,
            })
          } else if (event.type === 'complete') {
            set((s) => ({
              generatingReport: false,
              currentReportId: event.id,
              reportTitle: event.title,
              reportIsDraft: event.is_draft ?? true,
              reportStages: [...s.reportStages, { stage: 'finalizing', label: '완료', at: Date.now() }],
            }))
            // 저장된 최종(후처리 완료) 본문으로 교체 — 차트 이미지 경로 치환 + 취소선 제거 반영
            void api.getReport(event.id).then((r) => {
              set({
                reportContent: r.markdown,
                reportProcessingNotes: r.processing_notes ?? null,
                reportOutline: r.outline ?? null,
                reportIsDraft: r.is_draft ?? true,
              })
            }).catch((err) => console.warn('getReport after complete failed', err))
            // draft 는 사이드바에 노출되지 않음 — 승격 시에만 목록 새로고침
          } else if (event.type === 'error') {
            set({ generatingReport: false, reportError: event.message })
          }
        },
      )
    } catch (e) {
      set({
        generatingReport: false,
        reportError: e instanceof Error ? e.message : String(e),
      })
    }
  },

  setShowReport: (v) => set({ showReport: v }),

  saveCurrentReport: async () => {
    const { currentReportId, reportIsDraft, generatingReport } = get()
    if (!currentReportId || !reportIsDraft || generatingReport) return
    set({ reportSaving: true })
    try {
      const api = await import('@/lib/api')
      await api.saveReportDraft(currentReportId)
      set({ reportIsDraft: false, reportSaving: false })
      void get().fetchReports()
    } catch (e) {
      console.warn('saveReportDraft failed', e)
      set({
        reportSaving: false,
        reportError: e instanceof Error ? e.message : String(e),
      })
    }
  },

  closeCurrentReport: async () => {
    const { currentReportId, reportIsDraft, generatingReport } = get()
    // 스트리밍 중 닫기: 일단 모달만 닫음 (생성은 계속). 완료 후 draft 가 남겠지만 그건 허용.
    set({ showReport: false })
    if (generatingReport) return
    if (currentReportId && reportIsDraft) {
      try {
        const api = await import('@/lib/api')
        await api.discardReportDraft(currentReportId)
      } catch (e) {
        console.warn('discardReportDraft failed', e)
      }
      set({
        currentReportId: null,
        reportContent: '',
        reportIsDraft: false,
        reportProcessingNotes: null,
        reportOutline: null,
      })
    }
  },

  fetchReports: async () => {
    try {
      const api = await import('@/lib/api')
      const list = await api.listReports()
      set({ reports: list })
    } catch (e) {
      console.warn('fetchReports failed', e)
    }
  },

  filesTree: [],
  filesRoot: '',
  filesLoading: false,
  fetchFilesTree: async () => {
    set({ filesLoading: true })
    try {
      const api = await import('@/lib/api')
      const res = await api.getFilesTree()
      set({ filesTree: res.tree, filesRoot: res.root })
      // 하위 폴더로 옮겨진 ipynb 도 반영되도록 histories 도 함께 갱신
      try {
        const nbs = await api.getNotebooks()
        const existingMap = new Map(get().histories.map((h) => [h.id, h]))
        const merged = nbs.map((nb, i) => {
          const prev = existingMap.get(nb.id)
          return {
            id: nb.id,
            title: nb.title,
            date: prev?.date ?? formatNotebookDate(nb.updated_at),
            folderId: nb.folder_id,
            isCurrent: prev?.isCurrent ?? (i === 0 && !get().notebookId),
          }
        })
        set({ histories: merged })
      } catch (e) {
        console.warn('refresh histories after tree fetch failed', e)
      }
    } catch (e) {
      console.warn('fetchFilesTree failed', e)
    } finally {
      set({ filesLoading: false })
    }
  },

  openReport: async (id) => {
    try {
      const api = await import('@/lib/api')
      const r = await api.getReport(id)
      set({
        showReport: true,
        generatingReport: false,
        reportContent: r.markdown,
        reportTitle: r.title,
        currentReportId: r.id,
        reportError: null,
        reportProcessingNotes: r.processing_notes ?? null,
        reportOutline: r.outline ?? null,
        reportIsDraft: r.is_draft ?? false,
      })
    } catch (e) {
      set({ reportError: e instanceof Error ? e.message : String(e) })
    }
  },

  removeReport: async (id) => {
    try {
      const api = await import('@/lib/api')
      await api.deleteReport(id)
      set((s) => ({
        reports: s.reports.filter((r) => r.id !== id),
        currentReportId: s.currentReportId === id ? null : s.currentReportId,
      }))
    } catch (e) {
      console.warn('removeReport failed', e)
    }
  },

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
  const agentChatHistory = detail.agent_messages.flatMap(rowToAgentMsgs)
  const agentSessions = loadAgentSessions(detail.id)

  // 현재 진행 중인 대화가 있으면 세션 메타를 복원/생성.
  // - agent_history 가 비어있으면 (archive 후 새로 연 경우 등) currentSessionId 는 null.
  // - agent_history 에 메시지가 있으면 sidebar 에 "현재 대화" 로 뜨도록 안정적 ID 를 부여한다.
  let currentMeta = loadCurrentSessionMeta(detail.id)
  if (agentChatHistory.length === 0) {
    // 서버에 현재 대화가 없다 → 복원할 게 없으므로 메타도 정리.
    if (currentMeta) {
      saveCurrentSessionMeta(detail.id, null)
      currentMeta = null
    }
  } else if (!currentMeta) {
    // 서버엔 메시지가 있는데 프론트 메타가 없는 케이스 (다른 기기에서 만든 대화 등) → 새로 부여.
    currentMeta = { id: generateId('as'), createdAtMs: Date.now(), title: null }
    saveCurrentSessionMeta(detail.id, currentMeta)
  }

  useAppStore.setState((s) => ({
    notebookId: detail.id,
    cells,
    activeCellId: cells[0]?.id ?? null,
    analysisTheme: detail.title,
    analysisDescription: detail.description,
    selectedMarts: detail.selected_marts,
    agentChatHistory,
    agentSessions,
    agentSessionTitle: currentMeta?.title ?? null,
    currentSessionId: currentMeta?.id ?? null,
    currentSessionCreatedAtMs: currentMeta?.createdAtMs ?? null,
    collapsedSessionIds: {},
    histories: s.histories.map((h) => ({ ...h, isCurrent: h.id === detail.id })),
  }))
}
