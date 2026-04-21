import { useEffect, useRef, useState } from 'react'
import { Telescope, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { cn } from '@/lib/utils'

export default function AgentFAB() {
  const { agentMode, agentLoading, agentStatus, agentChatHistory, toggleAgentMode } = useAppStore()
  const [doneBubble, setDoneBubble] = useState<string | null>(null)
  const [showCheck, setShowCheck] = useState(false)
  const prevLoadingRef = useRef(false)
  const agentModeRef = useRef(agentMode)
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { agentModeRef.current = agentMode }, [agentMode])

  useEffect(() => {
    if (agentLoading) {
      setDoneBubble(null)
      setShowCheck(false)
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
    } else if (prevLoadingRef.current) {
      // 실행 완료 — 체크(초록) 상태 유지. 창 닫혀 있으면 최종 답변 말풍선도 유지.
      // 사용자가 에이전트 모드를 한 번 토글해야 원복된다.
      setShowCheck(true)

      if (!agentModeRef.current) {
        const lastAssistant = [...agentChatHistory].reverse().find(
          (m) => m.role === 'assistant' && m.kind !== 'step' && m.content
        )
        if (lastAssistant?.content) {
          setDoneBubble(lastAssistant.content.trim())
        }
      }
    }
    prevLoadingRef.current = agentLoading
  }, [agentLoading, agentChatHistory])

  useEffect(() => {
    // 에이전트 모드를 토글(열기/닫기 어느 쪽이든)하면 완료 상태 해제 → 색/말풍선 원복
    setShowCheck(false)
    setDoneBubble(null)
    if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
  }, [agentMode])

  const isGenerating = agentLoading && !agentMode
  const liveStatus = isGenerating ? (agentStatus ?? '생각 중') : null
  const liveAssistantMsg = isGenerating
    ? [...agentChatHistory].reverse().find(
        (m) => m.role === 'assistant' && m.kind !== 'step' && m.content
      )
    : null
  const liveAssistantText = liveAssistantMsg?.content?.trim() || null

  return (
    <div className="fixed bottom-6 right-6 z-40">
      {(doneBubble || liveStatus || liveAssistantText) && !agentMode && (
        <div
          className="absolute bottom-16 right-0 bg-white border border-border rounded-2xl shadow-lg px-4 py-3 animate-fade-in"
          style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.10)', width: 340, maxHeight: '60vh', overflowY: 'auto' }}
        >
          {doneBubble ? (
            <p className="text-[13.5px] text-text-primary leading-relaxed whitespace-pre-wrap break-keep">{doneBubble}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {liveStatus && (
                <div className="flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin shrink-0" style={{ color: '#D95C3F' }} />
                  <p className="text-[13px] font-semibold leading-relaxed whitespace-pre-wrap break-keep" style={{ color: '#c94a2e' }}>{liveStatus}</p>
                </div>
              )}
              {liveAssistantText && (
                <p className="text-[13.5px] text-text-primary leading-relaxed whitespace-pre-wrap break-keep">{liveAssistantText}</p>
              )}
            </div>
          )}
          <div
            className="absolute -bottom-[7px] right-5 w-3 h-3 bg-white border-r border-b border-border"
            style={{ transform: 'rotate(45deg)' }}
          />
        </div>
      )}

      <button
        title={agentMode ? '에이전트 모드 끄기' : '에이전트 모드 켜기'}
        onClick={toggleAgentMode}
        className={cn(
          'w-14 h-14 rounded-full flex items-center justify-center shadow-xl transition-all relative',
          agentMode
            ? 'bg-primary text-white'
            : isGenerating
              ? 'bg-primary text-white shadow-[0_4px_20px_rgba(217,92,63,0.4)]'
              : showCheck
                ? 'bg-emerald-600 text-white shadow-[0_4px_20px_rgba(16,160,90,0.35)]'
                : 'bg-white text-text-secondary border border-border hover:shadow-2xl hover:border-primary hover:text-primary hover:scale-110'
        )}
      >
        <Telescope size={22} strokeWidth={2} />

        {isGenerating && !agentMode && (
          <div className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-yellow-400 border-2 border-white animate-ping" />
        )}
      </button>
    </div>
  )
}
