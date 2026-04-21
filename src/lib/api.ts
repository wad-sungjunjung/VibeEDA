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
export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; tool: string; input: Record<string, unknown> }
  | { type: 'message_delta'; content: string }
  | { type: 'reset_current_bubble' }
  | { type: 'cell_created'; cell_id: string; cell_type: CellType; cell_name: string; code: string; after_cell_id?: string | null }
  | { type: 'cell_code_updated'; cell_id: string; code: string }
  | { type: 'cell_executed'; cell_id: string; output?: import('@/types').CellOutput | null }
  | { type: 'cell_memo_updated'; cell_id: string; memo: string }
  | { type: 'ask_user'; question: string; options: string[] }
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

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...((options.headers as Record<string, string>) ?? {}) },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${options.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
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
}

export async function generateAgentSessionTitle(question: string): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/agent/title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getLLMHeaders() },
      body: JSON.stringify({ question }),
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
