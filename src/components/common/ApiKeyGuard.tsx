import { useState } from 'react'
import { KeyRound, X } from 'lucide-react'
import { useModelStore } from '@/store/modelStore'

// Gemini · Anthropic API 키가 **하나도** 설정돼 있지 않으면 우상단 토스트를 띄워
// 사용자가 모델 설정을 열 수 있도록 유도한다. 한 쪽이라도 있으면 토스트는 렌더되지 않는다.
// SnowflakeConnectionGuard 와 동일한 위치/스타일을 따른다.
export default function ApiKeyGuard() {
  const geminiKey = useModelStore((s) => s.geminiApiKey)
  const anthropicKey = useModelStore((s) => s.anthropicApiKey)
  const [dismissed, setDismissed] = useState(false)

  const hasAnyKey = geminiKey.trim().length > 0 || anthropicKey.trim().length > 0
  if (hasAnyKey || dismissed) return null

  return (
    <div className="fixed top-[108px] right-4 z-[60] animate-fade-in">
      <div
        role="alert"
        className="flex items-start gap-2.5 bg-surface border border-primary-border rounded-xl shadow-lg px-4 py-3 w-[300px]"
        style={{ boxShadow: '0 6px 24px rgba(0,0,0,0.10)' }}
      >
        <div className="shrink-0 mt-0.5">
          <KeyRound size={16} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-primary">
            API 키 미설정
          </div>
          <div className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">
            바이브 챗 · 에이전트 모드를 사용하려면 <b>Gemini</b> 또는 <b>Anthropic</b> 키가 최소 하나 필요해요.{' '}
            <button
              className="text-primary font-medium hover:underline"
              onClick={() => window.dispatchEvent(new CustomEvent('vibe:open-model-settings'))}
            >
              모델 설정 열기
            </button>
          </div>
        </div>
        <button
          title="닫기"
          onClick={() => setDismissed(true)}
          className="shrink-0 p-0.5 -mt-0.5 text-text-tertiary hover:text-text-primary rounded transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
