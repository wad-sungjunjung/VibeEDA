import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { CellType } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateId(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

export function formatNumber(n: number): string {
  return n.toLocaleString('ko-KR')
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

export function nowTimestamp(): string {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

// 셀 이름을 snake_case (영문/숫자/_) 식별자로 강제 변환
export function toSnakeCase(name: string, fallback = 'cell'): string {
  if (!name) return fallback
  let s = name.trim().toLowerCase()
  s = s.replace(/[\s\-.]+/g, '_')
  s = s.replace(/[^a-z0-9_]/g, '')
  s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!s) return fallback
  if (/^[0-9]/.test(s)) s = `${fallback}_${s}`
  return s
}

// 입력 중(타이핑)에도 허용되도록 하는 느슨한 필터: 현재 입력이 그대로 유효하면 유지,
// 그렇지 않으면 강제 변환. (끝에 `_` 하나 붙이는 중간 상태는 허용)
export function sanitizeCellNameInput(name: string): string {
  const loose = name.toLowerCase().replace(/[\s\-.]+/g, '_').replace(/[^a-z0-9_]/g, '')
  return loose
}

export function cycleCellType(current: CellType): CellType {
  const order: CellType[] = ['sql', 'python', 'markdown']
  return order[(order.indexOf(current) + 1) % order.length]
}

export function defaultCellName(type: CellType, existingNames: string[]): string {
  const prefix = type === 'sql' ? 'query' : type === 'python' ? 'code' : 'note'
  let n = existingNames.filter((name) => name.startsWith(prefix)).length + 1
  while (existingNames.includes(`${prefix}_${n}`)) n++
  return `${prefix}_${n}`
}

// ── Cell UI state persistence ─────────────────────────────────────────────────

const CELL_UI_KEY = 'vibe_cell_ui'

export type CellUiState = {
  splitMode: boolean
  splitDir: 'h' | 'v'
  splitRatio: number
  vSplitRatio: number
  /** 사용자가 리사이즈 핸들로 드래그해 조정한 패널 높이(px). 미설정이면 기본 360. */
  panelHeight: number
}

export function loadCellUi(cellId: string): Partial<CellUiState> {
  try {
    const all = JSON.parse(localStorage.getItem(CELL_UI_KEY) || '{}')
    return all[cellId] || {}
  } catch {
    return {}
  }
}

export function saveCellUi(cellId: string, patch: Partial<CellUiState>): void {
  try {
    const all = JSON.parse(localStorage.getItem(CELL_UI_KEY) || '{}')
    all[cellId] = { ...all[cellId], ...patch }
    localStorage.setItem(CELL_UI_KEY, JSON.stringify(all))
  } catch {}
}

// ── Agent session persistence ─────────────────────────────────────────────────

export function loadAgentSessions(notebookId: string): import('@/types').AgentSession[] {
  try {
    const raw = JSON.parse(localStorage.getItem(`vibe_agent_sessions_${notebookId}`) || '[]')
    // 기존 세션 데이터에 title이 없으면 첫 유저 메시지로 채워넣기 (마이그레이션)
    return (raw as import('@/types').AgentSession[]).map((s, idx) => {
      if (s.title) return s
      const firstUser = s.messages?.find((m) => m.role === 'user')
      const raw = (firstUser?.content ?? `대화 ${idx + 1}`).trim().replace(/\s+/g, ' ')
      return { ...s, title: raw.length > 40 ? raw.slice(0, 40) + '…' : raw }
    })
  } catch { return [] }
}

export function saveAgentSessions(notebookId: string, sessions: import('@/types').AgentSession[]): void {
  try {
    localStorage.setItem(`vibe_agent_sessions_${notebookId}`, JSON.stringify(sessions))
  } catch {}
}

// ── Agent tool → 한국어 상태 라벨 매핑 ─────────────────────────────────────
export function toolStatusLabel(tool: string, input?: Record<string, unknown>): string {
  const cellType = typeof input?.cell_type === 'string' ? input.cell_type : ''
  const martKey = typeof input?.mart_key === 'string' ? ` · ${input.mart_key}` : ''
  switch (tool) {
    case 'read_notebook_context': return '노트북 파악 중'
    case 'create_cell':
      return cellType === 'sql' ? 'SQL 쿼리 작성 중'
        : cellType === 'python' ? 'Python 코드 작성 중'
        : cellType === 'markdown' ? '분석 정리 중'
        : '셀 생성 중'
    case 'update_cell_code': return '코드 수정 중'
    case 'execute_cell': return '셀 실행 중'
    case 'read_cell_output': return '출력 확인 중'
    case 'get_mart_schema': return `마트 스키마 조회 중${martKey}`
    case 'preview_mart': return `샘플 데이터 조회 중${martKey}`
    case 'profile_mart': return `마트 프로파일링 중${martKey}`
    case 'write_cell_memo': return '인사이트 메모 기록 중'
    case 'check_chart_quality': {
      const passed = input?.passed
      if (typeof passed === 'boolean') return passed ? '차트 퀄리티 통과' : '차트 퀄리티 재작업'
      return '차트 퀄리티 검토 중'
    }
    case 'ask_user': return '질문 준비 중'
    default: return `${tool} 실행 중`
  }
}

// Insert ordering value between two cells (float-based midpoint)
export function midOrdering(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1.0
  if (before === null) return (after as number) - 1.0
  if (after === null) return before + 1.0
  return (before + after) / 2
}
