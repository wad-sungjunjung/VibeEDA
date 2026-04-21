import { useState } from 'react'
import { X, Eye, EyeOff, Key, AlertCircle } from 'lucide-react'
import { useModelStore, ALL_MODELS } from '@/store/modelStore'

interface Props {
  onClose: () => void
}

function modelProvider(value: string) {
  return value.startsWith('claude-') ? 'claude' : 'gemini'
}

function ApiKeyWarning({ model, geminiKey, anthropicKey }: { model: string; geminiKey: string; anthropicKey: string }) {
  const provider = modelProvider(model)
  const missing = provider === 'gemini' ? !geminiKey : !anthropicKey
  if (!missing) return null
  const name = provider === 'gemini' ? 'Google Gemini' : 'Anthropic Claude'
  return (
    <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-warning">
      <AlertCircle size={10} className="shrink-0" />
      {name} API 키가 필요합니다
    </div>
  )
}

export default function ModelSettingsModal({ onClose }: Props) {
  const {
    geminiApiKey, anthropicApiKey, vibeModel, agentModel,
    setGeminiApiKey, setAnthropicApiKey, setVibeModel, setAgentModel,
  } = useModelStore()

  const [showGeminiKey, setShowGeminiKey] = useState(false)
  const [showAnthropicKey, setShowAnthropicKey] = useState(false)
  const [geminiDraft, setGeminiDraft] = useState(geminiApiKey)
  const [anthropicDraft, setAnthropicDraft] = useState(anthropicApiKey)

  function handleSave() {
    setGeminiApiKey(geminiDraft.trim())
    setAnthropicApiKey(anthropicDraft.trim())
    onClose()
  }

  const inputClass = 'w-full text-[12px] bg-bg-sidebar border border-border rounded-md px-3 py-2 pr-9 outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 font-mono'
  const selectClass = 'w-full text-[12px] bg-bg-sidebar border border-border rounded-md px-3 py-2 outline-none focus:border-primary cursor-pointer'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-surface rounded-xl shadow-2xl w-[480px] max-w-[95vw] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div>
            <div className="text-[14px] font-semibold text-text-primary">모델 설정</div>
            <div className="text-[11px] text-text-tertiary mt-0.5">API 키와 모델을 설정합니다</div>
          </div>
          <button onClick={onClose} className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-chip rounded transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5 overflow-y-auto">

          {/* ── API 키 섹션 ── */}
          <section className="space-y-4">
            <div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">API 키</div>

            {/* Gemini */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-4 h-4 rounded bg-chip flex items-center justify-center shrink-0">
                  <Key size={9} className="text-text-secondary" />
                </div>
                <span className="text-[11px] font-semibold text-text-primary">Google Gemini</span>
              </div>
              <div className="relative">
                <input
                  type={showGeminiKey ? 'text' : 'password'}
                  value={geminiDraft}
                  onChange={(e) => setGeminiDraft(e.target.value)}
                  placeholder="AIza..."
                  className={inputClass}
                />
                <button onClick={() => setShowGeminiKey((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                  {showGeminiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* Anthropic */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-4 h-4 rounded bg-primary-light flex items-center justify-center shrink-0">
                  <Key size={9} className="text-primary" />
                </div>
                <span className="text-[11px] font-semibold text-text-primary">Anthropic Claude</span>
              </div>
              <div className="relative">
                <input
                  type={showAnthropicKey ? 'text' : 'password'}
                  value={anthropicDraft}
                  onChange={(e) => setAnthropicDraft(e.target.value)}
                  placeholder="sk-ant-..."
                  className={inputClass}
                />
                <button onClick={() => setShowAnthropicKey((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                  {showAnthropicKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </section>

          <div className="border-t border-border-subtle" />

          {/* ── 기능별 모델 ── */}
          <section className="space-y-4">
            <div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wide">기능별 모델</div>

            {/* Vibe Chat */}
            <div>
              <label className="block text-[11px] text-text-secondary mb-1">바이브 챗 모델</label>
              <select value={vibeModel} onChange={(e) => setVibeModel(e.target.value)} className={selectClass}>
                <optgroup label="Google Gemini">
                  {ALL_MODELS.filter((m) => m.provider === 'gemini').map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Anthropic Claude">
                  {ALL_MODELS.filter((m) => m.provider === 'claude').map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </optgroup>
              </select>
              <ApiKeyWarning model={vibeModel} geminiKey={geminiDraft} anthropicKey={anthropicDraft} />
            </div>

            {/* Agent Mode */}
            <div>
              <label className="block text-[11px] text-text-secondary mb-1">에이전트 모드 모델</label>
              <select value={agentModel} onChange={(e) => setAgentModel(e.target.value)} className={selectClass}>
                <optgroup label="Anthropic Claude">
                  {ALL_MODELS.filter((m) => m.provider === 'claude').map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Google Gemini">
                  {ALL_MODELS.filter((m) => m.provider === 'gemini').map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </optgroup>
              </select>
              <ApiKeyWarning model={agentModel} geminiKey={geminiDraft} anthropicKey={anthropicDraft} />
            </div>
          </section>

          <div className="rounded-md bg-warning-bg border border-warning/30 px-3 py-2 text-[11px] text-warning-text">
            API 키는 브라우저 로컬 스토리지에 저장됩니다. 미설정 시 백엔드 .env의 GEMINI_API_KEY / ANTHROPIC_API_KEY를 사용합니다.
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <button onClick={onClose} className="px-4 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-chip rounded-md transition-colors">취소</button>
          <button onClick={handleSave} className="px-4 py-1.5 text-[12px] font-medium bg-primary text-white rounded-md hover:bg-primary-dark transition-colors">저장</button>
        </div>
      </div>
    </div>
  )
}
