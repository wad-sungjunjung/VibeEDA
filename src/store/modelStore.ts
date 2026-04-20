import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const ALL_MODELS = [
  // ── Gemini 3 (Preview) ─────────────────────────────────────────
  { value: 'gemini-3.1-pro-preview',   label: 'Gemini 3.1 Pro (Preview)',        provider: 'gemini' as const },
  { value: 'gemini-3-flash-preview',   label: 'Gemini 3 Flash (Preview, 빠름)',  provider: 'gemini' as const },
  // ── Gemini 2.5 (Stable) ────────────────────────────────────────
  { value: 'gemini-2.5-pro',           label: 'Gemini 2.5 Pro',                  provider: 'gemini' as const },
  { value: 'gemini-2.5-flash',         label: 'Gemini 2.5 Flash (빠름)',         provider: 'gemini' as const },
  { value: 'gemini-2.5-flash-lite',    label: 'Gemini 2.5 Flash Lite (최저비용)', provider: 'gemini' as const },
  // ── Claude 4 ──────────────────────────────────────────────────
  { value: 'claude-opus-4-7',          label: 'Claude Opus 4.7',                 provider: 'claude' as const },
  { value: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6 (빠름)',        provider: 'claude' as const },
  { value: 'claude-haiku-4-5-20251001',label: 'Claude Haiku 4.5 (최저비용)',     provider: 'claude' as const },
]

export const VIBE_MODELS   = ALL_MODELS
export const AGENT_MODELS  = ALL_MODELS
export const REPORT_MODELS = ALL_MODELS

interface ModelStore {
  geminiApiKey: string
  anthropicApiKey: string
  vibeModel: string
  agentModel: string
  reportModel: string
  setGeminiApiKey: (key: string) => void
  setAnthropicApiKey: (key: string) => void
  setVibeModel: (model: string) => void
  setAgentModel: (model: string) => void
  setReportModel: (model: string) => void
}

export const useModelStore = create<ModelStore>()(
  persist(
    (set) => ({
      geminiApiKey: '',
      anthropicApiKey: '',
      vibeModel: 'gemini-2.5-flash',
      agentModel: 'claude-opus-4-7',
      reportModel: 'claude-opus-4-7',
      setGeminiApiKey: (key) => set({ geminiApiKey: key }),
      setAnthropicApiKey: (key) => set({ anthropicApiKey: key }),
      setVibeModel: (model) => set({ vibeModel: model }),
      setAgentModel: (model) => set({ agentModel: model }),
      setReportModel: (model) => set({ reportModel: model }),
    }),
    { name: 'vibe-eda-model-settings' }
  )
)
