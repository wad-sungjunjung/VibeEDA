import type { CellType, MartMeta } from '@/types'
import { useModelStore } from '@/store/modelStore'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:4750/v1'
export const API_BASE_URL = API_BASE

// ─── SSE event types ──────────────────────────────────────────────────────────

export type VibeEvent =
  | { type: 'code_delta'; delta: string }
  | { type: 'complete'; full_code: string; explanation: string }
  | { type: 'error'; message: string }

// 에이전트 SSE 이벤트 타입.
// **백엔드 `app/services/agent_events.py` 와 동기화 필수** — 둘 중 하나만 수정시 drift 발생.
export type AgentTodo = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  active_form?: string
}

export type AgentTier = 'L1' | 'L2' | 'L3'

export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; tool: string; input: Record<string, unknown> }
  | { type: 'message_delta'; content: string }
  | { type: 'reset_current_bubble' }
  | { type: 'cell_created'; cell_id: string; cell_type: CellType; cell_name: string; code: string; after_cell_id?: string | null; agent_chat_entry?: AgentChatEntry }
  | { type: 'cell_code_updated'; cell_id: string; code: string; agent_chat_entry?: AgentChatEntry }
  | { type: 'cell_executed'; cell_id: string; output?: import('@/types').CellOutput | null }
  | { type: 'cell_memo_updated'; cell_id: string; memo: string }
  | { type: 'chart_quality'; cell_id: string; passed: boolean; summary: string; issues: string[] }
  | { type: 'todos_updated'; todos: AgentTodo[] }
  | { type: 'ask_user'; question: string; options: string[] }
  | { type: 'exec_heartbeat'; cell_id: string; cell_name: string; elapsed_sec: number; message: string }
  | { type: 'exec_completed_notice'; cell_id: string; cell_name: string; elapsed_sec: number; message: string }
  | { type: 'tier_classified'; tier: AgentTier; reason: string; estimated_cells: number; estimated_seconds: number; max_turns: number; max_tool_calls: number; methods: string[] }
  | { type: 'budget_warning'; percent_used: number; remaining_turns: number; remaining_tool_calls: number; message: string }
  | { type: 'tier_promoted'; from_tier: AgentTier; to_tier: AgentTier; reason: string; new_max_turns: number; new_max_tool_calls: number }
  | { type: 'methods_selected'; methods: string[]; rationale: string; expected_artifacts: string[] }
  | { type: 'complete'; created_cell_ids: string[]; updated_cell_ids: string[] }
  | { type: 'error'; message: string }

// ─── REST response types ──────────────────────────────────────────────────────

export interface NotebookRow {
  id: string
  title: string
  description: string
  selected_marts: string[]
  folder_id: string | null
  created_at: string
  updated_at: string
}

export interface ChatEntryRow {
  id: string
  user_message: string
  assistant_reply: string
  code_snapshot: string
  code_result?: string
  created_at: string
  agent_created?: boolean
}

export interface AgentChatEntry {
  user: string
  assistant: string
  agent_created?: boolean
  code_snapshot?: string
}

export interface CellRow {
  id: string
  name: string
  type: string
  code: string
  memo: string
  ordering: number
  executed: boolean
  output: Record<string, unknown> | null
  insight: string | null
  agent_generated: boolean
  onboarding?: boolean
  chat_entries: ChatEntryRow[]
}

export interface AgentMessageRow {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_cell_ids: string[]
  created_at: string
  blocks?: import('@/types').AgentBlock[]
}

export interface NotebookDetail extends NotebookRow {
  cells: CellRow[]
  agent_messages: AgentMessageRow[]
}

export interface FolderRow {
  id: string
  name: string
  ordering: number
  is_open: boolean
  created_at: string
}

// ─── Headers ─────────────────────────────────────────────────────────────────


function getLLMHeaders(): Record<string, string> {
  const { geminiApiKey, anthropicApiKey, vibeModel, agentModel, reportModel } = useModelStore.getState()
  const headers: Record<string, string> = {}
  if (geminiApiKey) headers['X-Gemini-Key'] = geminiApiKey
  if (anthropicApiKey) headers['X-Anthropic-Key'] = anthropicApiKey
  if (vibeModel) headers['X-Vibe-Model'] = vibeModel
  if (agentModel) headers['X-Agent-Model'] = agentModel
  if (reportModel) headers['X-Report-Model'] = reportModel
  return headers
}

export class ApiError extends Error {
  status: number
  detail: string
  rawBody: string
  method: string
  path: string
  constructor(init: { status: number; detail: string; rawBody: string; method: string; path: string }) {
    super(init.detail || `API ${init.method} ${init.path} → ${init.status}`)
    this.name = 'ApiError'
    this.status = init.status
    this.detail = init.detail
    this.rawBody = init.rawBody
    this.method = init.method
    this.path = init.path
  }
  // 네트워크 단절/도달 불가 등 fetch 자체가 실패한 경우
  static networkFailure(method: string, path: string, cause: unknown): ApiError {
    const msg = cause instanceof Error ? cause.message : String(cause)
    return new ApiError({
      status: 0,
      detail: `서버에 연결할 수 없습니다 (${msg})`,
      rawBody: '',
      method,
      path,
    })
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = options.method ?? 'GET'
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...((options.headers as Record<string, string>) ?? {}) },
      ...options,
    })
  } catch (e) {
    throw ApiError.networkFailure(method, path, e)
  }
  if (!res.ok) {
    const rawBody = await res.text().catch(() => '')
    let detail = ''
    try {
      const parsed = JSON.parse(rawBody)
      if (parsed && typeof parsed === 'object') {
        // FastAPI 표준: { "detail": "..." } 또는 detail 이 배열(validation) 일 수 있음
        if (typeof parsed.detail === 'string') detail = parsed.detail
        else if (Array.isArray(parsed.detail)) {
          detail = parsed.detail
            .map((d: { msg?: string; loc?: string[] }) => d.msg ?? JSON.stringify(d))
            .join('; ')
        } else if (parsed.detail) detail = JSON.stringify(parsed.detail)
      }
    } catch {
      // JSON 파싱 실패 — rawBody 그대로
    }
    if (!detail) detail = rawBody || `요청 실패 (HTTP ${res.status})`
    throw new ApiError({ status: res.status, detail, rawBody, method, path })
  }
  return res.json() as Promise<T>
}

export async function suggestCellName(code: string, type: string): Promise<string> {
  const res = await fetch(`${API_BASE}/cells/suggest-name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getLLMHeaders() },
    body: JSON.stringify({ code, type }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`suggest-name ${res.status}: ${text}`)
  }
  const data = (await res.json()) as { name: string }
  return data.name
}

// ─── SSE reader ───────────────────────────────────────────────────────────────

async function readSSEStream<T>(
  response: Response,
  onEvent: (event: T) => void,
): Promise<void> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          onEvent(JSON.parse(line.slice(6)) as T)
        } catch {
          // ignore malformed lines
        }
      }
    }
  }
}

// ─── Notebooks ────────────────────────────────────────────────────────────────

export const getNotebooks = () => apiFetch<NotebookRow[]>('/notebooks')

export const createNotebook = (data: {
  title?: string
  description?: string
  selected_marts?: string[]
  folder_id?: string | null
}) => apiFetch<NotebookRow>('/notebooks', { method: 'POST', body: JSON.stringify(data) })

export const getNotebook = (id: string) => apiFetch<NotebookDetail>(`/notebooks/${id}`)

export const updateNotebook = (id: string, data: Partial<{
  title: string
  description: string
  selected_marts: string[]
  folder_id: string | null
}>) => apiFetch<NotebookRow>(`/notebooks/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const deleteNotebook = (id: string) =>
  apiFetch<{ ok: boolean }>(`/notebooks/${id}`, { method: 'DELETE' })

// ─── Cells ───────────────────────────────────────────────────────────────────

export const createCell = (notebookId: string, data: {
  id?: string
  name: string
  type: string
  code?: string
  memo?: string
  ordering: number
  agent_generated?: boolean
}) => apiFetch<CellRow>(`/notebooks/${notebookId}/cells`, { method: 'POST', body: JSON.stringify(data) })

export const updateCell = (notebookId: string, id: string, data: Partial<{
  name: string
  type: string
  code: string
  memo: string
  ordering: number
  executed: boolean
  output: Record<string, unknown> | null
  insight: string | null
}>) => apiFetch<CellRow>(`/notebooks/${notebookId}/cells/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const deleteCell = (notebookId: string, id: string) =>
  apiFetch<{ ok: boolean }>(`/notebooks/${notebookId}/cells/${id}`, { method: 'DELETE' })

export const deleteChatEntry = (notebookId: string, cellId: string, index: number) =>
  apiFetch<{ ok: boolean }>(`/notebooks/${notebookId}/cells/${cellId}/chat/${index}`, { method: 'DELETE' })

export const truncateChatHistory = (notebookId: string, cellId: string, keep: number) =>
  apiFetch<{ ok: boolean }>(`/notebooks/${notebookId}/cells/${cellId}/chat/truncate`, {
    method: 'POST',
    body: JSON.stringify({ keep }),
  })

// ─── Folders ─────────────────────────────────────────────────────────────────

export const getFolders = () => apiFetch<FolderRow[]>('/folders')

export const createFolder = (data: { name: string; ordering?: number }) =>
  apiFetch<FolderRow>('/folders', { method: 'POST', body: JSON.stringify(data) })

export const updateFolder = (id: string, data: Partial<{ name: string; ordering: number; is_open: boolean }>) =>
  apiFetch<FolderRow>(`/folders/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const deleteFolder = (id: string) =>
  apiFetch<{ ok: boolean }>(`/folders/${id}`, { method: 'DELETE' })

// ─── Marts ───────────────────────────────────────────────────────────────────

export const getMarts = () => apiFetch<MartMeta[]>('/marts')

export interface MartRecommendation {
  key: string
  score: number
  reason: string
}

export const recommendMarts = (data: {
  analysis_theme: string
  analysis_description: string
  marts: { key: string; description: string; keywords: string[]; columns: { name: string; type: string; desc: string }[] }[]
}) => apiFetch<{ ok: boolean; message?: string; recommendations: MartRecommendation[] }>(
  '/marts/recommend',
  { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', ...getLLMHeaders() } as Record<string, string> },
)

// ─── Execute ─────────────────────────────────────────────────────────────────

export const executeCell = (cellId: string, notebookId: string) =>
  apiFetch<Record<string, unknown>>(`/execute/${cellId}`, { method: 'POST', body: JSON.stringify({ notebook_id: notebookId }) })

export const resetKernel = (notebookId: string) =>
  apiFetch<{ ok: boolean }>(`/kernel/${notebookId}`, { method: 'DELETE' })

export const exportFullTable = (notebookId: string, cellId: string) =>
  apiFetch<{ columns: { name: string }[]; rows: unknown[][]; rowCount: number }>(
    `/execute/${notebookId}/${cellId}/export`,
    { method: 'GET' }
  )

// ─── Vibe chat ────────────────────────────────────────────────────────────────

export interface VibeMartMeta {
  key: string
  description: string
  columns: { name: string; type: string; desc: string }[]
}

export interface VibeRequest {
  cell_id: string
  cell_type: CellType
  current_code: string
  message: string
  selected_marts: string[]
  mart_metadata?: VibeMartMeta[]
  analysis_theme: string
  notebook_id?: string | null
  images?: { media_type: string; data: string }[]
  // 직전 실행 결과 요약 — 에러 메시지 / 결과 스키마 / stdout 등. "같은 오류 수정해줘" 같은 요청에 맥락 제공.
  current_output_summary?: string
}

export async function streamVibeChat(
  req: VibeRequest,
  onEvent: (event: VibeEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/vibe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getLLMHeaders() },
    body: JSON.stringify(req),
    signal,
  })
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  await readSSEStream(response, onEvent)
}

// ─── Sheet Vibe ───────────────────────────────────────────────────────────────

export interface SheetPatch {
  range: string
  value: string | number | boolean
}

export interface SheetVibeRequest {
  cell_id: string
  message: string
  selection?: string | null
  data_region: (string | number | boolean | null)[][]
  data_origin: string
  notebook_id?: string | null
}

export interface SheetVibeResponse {
  patches: SheetPatch[]
  explanation: string
}

export async function vibeSheet(req: SheetVibeRequest, signal?: AbortSignal): Promise<SheetVibeResponse> {
  const res = await fetch(`${API_BASE}/vibe/sheet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getLLMHeaders() },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return (await res.json()) as SheetVibeResponse
}

// ─── Agent stream ─────────────────────────────────────────────────────────────

export interface AgentCellSnapshot {
  id: string
  name: string
  type: CellType
  code: string
  executed: boolean
}

export interface AgentRequest {
  message: string
  cells: AgentCellSnapshot[]
  selected_marts: string[]
  mart_metadata?: VibeMartMeta[]
  analysis_theme: string
  analysis_description: string
  conversation_history: { role: 'user' | 'assistant'; content: string }[]
  notebook_id?: string | null
  images?: { media_type: string; data: string }[]
  // 사용자가 프론트에서 명시적으로 tier 를 지정했을 때 — 휴리스틱·Haiku 분류기 우회.
  tier_override?: AgentTier | null
}

export async function generateAgentSessionTitle(question: string, response?: string): Promise<string> {
  try {
    const body: { question: string; response?: string } = { question }
    if (response && response.trim()) body.response = response
    const res = await fetch(`${API_BASE}/agent/title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getLLMHeaders() },
      body: JSON.stringify(body),
    })
    if (!res.ok) return ''
    const data = (await res.json()) as { ok: boolean; title: string }
    return data.ok ? data.title : ''
  } catch {
    return ''
  }
}

export async function streamAgentMessage(
  req: AgentRequest,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getLLMHeaders() },
    body: JSON.stringify(req),
    signal,
  })
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  await readSSEStream(response, onEvent)
}

export async function archiveAgentHistory(notebookId: string): Promise<number> {
  // 서버의 agent_history 를 비운다 — 프론트에서 세션을 localStorage 에 옮긴 뒤 호출.
  try {
    const res = await fetch(`${API_BASE}/notebooks/${notebookId}/agent/archive`, { method: 'POST' })
    if (!res.ok) return 0
    const data = (await res.json()) as { ok: boolean; cleared: number }
    return data.ok ? data.cleared : 0
  } catch {
    return 0
  }
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface ReportSummary {
  id: string
  title: string
  created_at: string
  model: string
  source_notebook_id: string
  goal: string
  byte_size: number
}

export interface SuspiciousNumber {
  value: number
  unit: string
  raw: string
  context: string
}

export interface ReportProcessingNotes {
  missing_charts: string[]
  unreferenced_charts: string[]
  suspicious_numbers: SuspiciousNumber[]
  suspicious_number_count: number
  outline_sections: number
}

export interface ReportOutline {
  report_title?: string
  tldr?: string[]
  sections?: Array<{
    heading: string
    thesis?: string
    cite_cells?: string[]
    cite_charts?: string[]
    key_numbers?: string[]
  }>
  insights?: string[]
  limitations?: string[]
}

export interface ReportDetail extends ReportSummary {
  source_cell_ids: string[]
  markdown: string
  processing_notes?: ReportProcessingNotes | null
  outline?: ReportOutline | null
  is_draft?: boolean
}

export type ReportStage = 'collecting' | 'collected' | 'outlining' | 'outlined' | 'writing' | 'finalizing'

export type ReportEvent =
  | { type: 'delta'; content: string }
  | { type: 'stage'; stage: ReportStage; label: string }
  | { type: 'meta'; processing_notes: ReportProcessingNotes; outline: ReportOutline | null }
  | {
      type: 'complete'
      id: string
      title: string
      path: string
      created_at: string
      byte_size: number
      model: string
      source_notebook_id: string
      is_draft?: boolean
    }
  | { type: 'error'; message: string }

export interface ReportRequest {
  notebook_id: string
  cell_ids: string[]
  goal?: string
}

export async function streamReport(
  req: ReportRequest,
  onEvent: (event: ReportEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/reports/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getLLMHeaders() },
    body: JSON.stringify(req),
    signal,
  })
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  await readSSEStream(response, onEvent)
}

export const listReports = () => apiFetch<ReportSummary[]>('/reports')
export const getReport = (id: string) => apiFetch<ReportDetail>(`/reports/${id}`)
export const deleteReport = (id: string) =>
  apiFetch<{ ok: boolean }>(`/reports/${id}`, { method: 'DELETE' })
export const saveReportDraft = (id: string) =>
  apiFetch<ReportSummary & { is_draft: boolean }>(`/reports/${id}/save`, { method: 'POST' })
export const discardReportDraft = (id: string) =>
  apiFetch<{ ok: boolean }>(`/reports/drafts/${id}`, { method: 'DELETE' })

// ─── Root files tree ─────────────────────────────────────────────────────────

export interface FileNode {
  name: string
  path: string
  type: 'folder' | 'file'
  kind: 'folder' | 'file' | 'notebook' | 'report'
  notebook_id?: string
  report_id?: string
  children?: FileNode[]
  size?: number
  modified?: number
  ext?: string
  truncated?: boolean
}

export interface FilesTreeResponse {
  root: string
  tree: FileNode[]
  truncated?: boolean
}

export const getFilesTree = () => apiFetch<FilesTreeResponse>('/files/tree')

export const mkdirFolder = (parent: string, name: string) =>
  apiFetch<{ ok: boolean; path: string }>('/files/mkdir', {
    method: 'POST',
    body: JSON.stringify({ parent, name }),
  })

export const rmdirFolder = (path: string, recursive = false) =>
  apiFetch<{ ok: boolean }>('/files/rmdir', {
    method: 'POST',
    body: JSON.stringify({ path, recursive }),
  })

export const moveEntry = (src: string, dstDir: string) =>
  apiFetch<{ ok: boolean; path: string }>('/files/move', {
    method: 'POST',
    body: JSON.stringify({ src, dst_dir: dstDir }),
  })

export const deleteFile = (path: string) =>
  apiFetch<{ ok: boolean }>('/files/delete', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })

export const openFolderInExplorer = () =>
  apiFetch<{ ok: boolean; path: string }>('/files/open-folder', { method: 'POST' })

export async function uploadFile(file: File, dstDir: string = ''): Promise<{
  ok: boolean; path: string; name: string; size: number; profile: unknown
}> {
  const form = new FormData()
  form.append('file', file)
  if (dstDir) form.append('dst_dir', dstDir)
  const res = await fetch(`${API_BASE}/files/upload`, { method: 'POST', body: form })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).detail ?? '' } catch {}
    throw new Error(detail || `업로드 실패 (HTTP ${res.status})`)
  }
  return res.json()
}
