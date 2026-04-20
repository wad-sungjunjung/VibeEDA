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
      // 실행 완료 — 체크 아이콘 + (창 닫혔으면) 최종 답변 요약 말풍선
      setShowCheck(true)
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
      checkTimerRef.current = setTimeout(() => setShowCheck(false), 2500)

      if (!agentModeRef.current) {
        const lastAssistant = [...agentChatHistory].reverse().find(
          (m) => m.role === 'assistant' && m.kind !== 'step' && m.content
        )
        if (lastAssistant?.content) {
          const text = lastAssistant.content.trim()
          setDoneBubble(text.length > 80 ? text.slice(0, 80) + '…' : text)
          if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
          doneTimerRef.current = setTimeout(() => setDoneBubble(null), 4000)
        }
      }
    }
    prevLoadingRef.current = agentLoading
  }, [agentLoading, agentChatHistory])

  useEffect(() => {
    if (agentMode) {
      setDoneBubble(null)
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
    }
  }, [agentMode])

  const isGenerating = agentLoading && !agentMode
  const liveBubble = isGenerating ? (agentStatus ?? '생각 중') : null
  const bubbleText = doneBubble ?? liveBubble

  return (
    <div className="fixed bottom-6 right-6 z-40">
      {bubbleText && !agentMode && (
        <div
          className="absolute bottom-16 right-0 bg-white border border-border rounded-2xl shadow-lg px-3.5 py-2.5 w-max max-w-[240px] animate-fade-in"
          style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.10)' }}
        >
          <div className="flex items-center gap-1.5">
            {isGenerating && !doneBubble && <Loader2 size={12} className="animate-spin shrink-0" style={{ color: '#D95C3F' }} />}
            <p className="text-[12px] text-text-primary leading-relaxed whitespace-pre-wrap break-keep">{bubbleText}</p>
          </div>
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
