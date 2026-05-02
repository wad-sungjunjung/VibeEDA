import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const ALL_MODELS = [
  // ── Gemini 3 (Preview) ─────────────────────────────────────────
  { value: 'gemini-3.1-pro-preview',   label: 'Gemini 3.1 Pro (Preview)',        provider: 'gemini' as const, contextWindow: 1_000_000 },
  { value: 'gemini-3-flash-preview',   label: 'Gemini 3 Flash (Preview, 빠름)',  provider: 'gemini' as const, contextWindow: 1_000_000 },
  // ── Gemini 2.5 (Stable) ────────────────────────────────────────
  { value: 'gemini-2.5-pro',           label: 'Gemini 2.5 Pro',                  provider: 'gemini' as const, contextWindow: 2_000_000 },
  { value: 'gemini-2.5-flash',         label: 'Gemini 2.5 Flash (빠름)',         provider: 'gemini' as const, contextWindow: 1_000_000 },
  { value: 'gemini-2.5-flash-lite',    label: 'Gemini 2.5 Flash Lite (최저비용)', provider: 'gemini' as const, contextWindow: 1_000_000 },
  // ── Claude 4 ──────────────────────────────────────────────────
  { value: 'claude-opus-4-7',          label: 'Claude Opus 4.7',                 provider: 'claude' as const, contextWindow: 1_000_000 },
  { value: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6 (빠름)',        provider: 'claude' as const, contextWindow: 1_000_000 },
  { value: 'claude-haiku-4-5-20251001',label: 'Claude Haiku 4.5 (최저비용)',     provider: 'claude' as const, contextWindow: 200_000 },
]

export function getModelContextWindow(value: string): number {
  return ALL_MODELS.find((m) => m.value === value)?.contextWindow ?? 200_000
}

export const VIBE_MODELS   = ALL_MODELS
export const AGENT_MODELS  = ALL_MODELS
export const REPORT_MODELS = ALL_MODELS

export type ThemeMode = 'light' | 'dark'

interface ModelStore {
  geminiApiKey: string
  anthropicApiKey: string
  vibeModel: string
  agentModel: string
  reportModel: string
  vibeAutoApply: boolean
  theme: ThemeMode
  setGeminiApiKey: (key: string) => void
  setAnthropicApiKey: (key: string) => void
  setVibeModel: (model: string) => void
  setAgentModel: (model: string) => void
  setReportModel: (model: string) => void
  setVibeAutoApply: (on: boolean) => void
  toggleVibeAutoApply: () => void
  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
}

// <html> 클래스에 테마를 반영. Tailwind darkMode:'class' 와 globals.css .dark 팔레트가 이걸로 구동됨.
function applyThemeClass(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.theme = theme
}

export const useModelStore = create<ModelStore>()(
  persist(
    (set, get) => ({
      geminiApiKey: '',
      anthropicApiKey: '',
      vibeModel: 'gemini-2.5-flash',
      agentModel: 'claude-opus-4-7',
      reportModel: 'claude-opus-4-7',
      vibeAutoApply: false,
      theme: 'light',
      setGeminiApiKey: (key) => set({ geminiApiKey: key }),
      setAnthropicApiKey: (key) => set({ anthropicApiKey: key }),
      setVibeModel: (model) => set({ vibeModel: model }),
      setAgentModel: (model) => set({ agentModel: model }),
      setReportModel: (model) => set({ reportModel: model }),
      setVibeAutoApply: (on) => set({ vibeAutoApply: on }),
      toggleVibeAutoApply: () => set({ vibeAutoApply: !get().vibeAutoApply }),
      setTheme: (theme) => {
        applyThemeClass(theme)
        set({ theme })
      },
      toggleTheme: () => {
        const next: ThemeMode = get().theme === 'dark' ? 'light' : 'dark'
        applyThemeClass(next)
        set({ theme: next })
      },
    }),
    {
      name: 'vibe-eda-model-settings',
      // persist 복원 시점에 <html>.dark 동기화 — App 마운트 전 깜빡임 방지
      onRehydrateStorage: () => (state) => {
        if (state?.theme) applyThemeClass(state.theme)
      },
    }
  )
)
