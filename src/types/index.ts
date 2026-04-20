// ─── Cell ──────────────────────────────────────────────────────────────────

export type CellType = 'sql' | 'python' | 'markdown'
export type CellPanelTab = 'input' | 'output' | 'memo'
export type CellTab = CellPanelTab

export interface ChatEntry {
  id: number
  user: string
  assistant: string
  timestamp: string
  codeSnapshot: string
}

export interface CellOutput {
  type: 'table' | 'chart' | 'markdown' | 'stdout' | 'error'
  // table
  columns?: { name: string; type: string }[]
  rows?: unknown[][]
  rowCount?: number
  truncated?: boolean
  // chart (plotly)
  plotlyJson?: Record<string, unknown>
  chartType?: 'bar' | 'line' | 'pie' | 'scatter'
  // stdout / markdown
  content?: string
  // error
  message?: string
  details?: Record<string, unknown>
}

export interface Cell {
  id: string
  name: string
  type: CellType
  code: string
  memo: string
  ordering: number
  splitMode: boolean
  splitDir: 'h' | 'v'
  activeTab: CellPanelTab
  leftTab: CellPanelTab
  rightTab: CellPanelTab
  executed: boolean
  executedAt: string | null
  output: CellOutput | null
  chatInput: string
  chatHistory: ChatEntry[]
  historyOpen: boolean
  insight: string | null
  agentGenerated?: boolean
}

// ─── Mart ──────────────────────────────────────────────────────────────────

export interface MartColumn {
  name: string
  type: string
  desc: string
  nullable?: boolean
}

export interface MartMeta {
  key: string
  description: string
  keywords: string[]
  columns: MartColumn[]
  rules: string[]
  recommendationScore?: number
  aiReason?: string
  updatedAt: string
}

// ─── History & Folders ─────────────────────────────────────────────────────

export interface NotebookSnapshot {
  cells: Cell[]
  analysisTheme: string
  analysisDescription: string
  selectedMarts: string[]
}

export interface HistoryItem {
  id: string
  title: string
  date: string
  folderId: string | null
  isCurrent: boolean
}

export interface Folder {
  id: string
  name: string
  isOpen: boolean
}

// ─── Agent ─────────────────────────────────────────────────────────────────

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  createdCellIds?: string[]
  // 중간 단계(step): 도구 호출, 셀 이벤트 등 파이프라인 상세
  kind?: 'message' | 'step'
  stepType?: 'tool' | 'cell_created' | 'cell_executed' | 'cell_memo' | 'error'
  stepLabel?: string       // 사용자에게 보여줄 짧은 라벨 (예: "SQL 쿼리 작성 · region_sales")
  stepDetail?: string      // 확장 시 보여줄 상세 (tool input, 메모 내용, 에러 메시지 등)
  collapsed?: boolean      // true면 UI에서 접힌 상태
}

export interface AgentSession {
  id: string
  title: string
  startedAt: string
  messages: AgentMessage[]
}

// ─── Reporting ─────────────────────────────────────────────────────────────

export interface ReportConfig {
  selectedCellIds: string[]
  includeInsights: boolean
}

// ─── Toast ─────────────────────────────────────────────────────────────────

export interface ToastData {
  cellName: string
  timestamp: string
}
