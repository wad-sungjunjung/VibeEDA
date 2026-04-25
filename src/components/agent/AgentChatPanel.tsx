import { useRef, useEffect, useState } from 'react'
import { Telescope, X, User, ArrowUp, Plus, FileCode, Search, SquarePen, ChevronDown, ChevronRight, Loader2, Wrench, FileCode2, PlayCircle, StickyNote, AlertTriangle, StopCircle, Paperclip, Hourglass, CheckCircle2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import { useModelStore, AGENT_MODELS, getModelContextWindow } from '@/store/modelStore'
import { useConnectionStore } from '@/store/connectionStore'
import { cn } from '@/lib/utils'
import Markdown from '@/components/common/Markdown'
import type { ImageAttachment } from '@/types'

// 스텝 타입별 아이콘/색. 색은 tailwind 시맨틱 클래스로 — 다크모드 자동 대응.
const STEP_ICONS: Record<string, { icon: typeof Wrench; className: string }> = {
  tool: { icon: Wrench, className: 'bg-chip text-text-secondary' },
  cell_created: { icon: FileCode2, className: 'bg-python-bg text-python-text' },
  cell_executed: { icon: PlayCircle, className: 'bg-success/15 text-success' },
  cell_memo: { icon: StickyNote, className: 'bg-warning-bg text-warning-text' },
  error: { icon: AlertTriangle, className: 'bg-danger-bg text-danger' },
  exec_long: { icon: Hourglass, className: 'bg-warning-bg text-warning-text' },
  exec_done: { icon: CheckCircle2, className: 'bg-success/15 text-success' },
}

export default function AgentChatPanel() {
  const {
    cells,
    agentChatHistory,
    agentChatInput,
    agentChatImages,
    agentRefCells,
    agentLoading,
    agentStartedAtMs,
    agentStatus,
    toggleAgentMode,
    setAgentChatInput,
    setAgentChatImages,
    submitAgentMessage,
    cancelAgent,
    toggleAgentRefCell,
    newAgentSession,
  } = useAppStore(useShallow((s) => ({
    cells: s.cells,
    agentChatHistory: s.agentChatHistory,
    agentChatInput: s.agentChatInput,
    agentChatImages: s.agentChatImages,
    agentRefCells: s.agentRefCells,
    agentLoading: s.agentLoading,
    agentStartedAtMs: s.agentStartedAtMs,
    agentStatus: s.agentStatus,
    toggleAgentMode: s.toggleAgentMode,
    setAgentChatInput: s.setAgentChatInput,
    setAgentChatImages: s.setAgentChatImages,
    submitAgentMessage: s.submitAgentMessage,
    cancelAgent: s.cancelAgent,
    toggleAgentRefCell: s.toggleAgentRefCell,
    newAgentSession: s.newAgentSession,
  })))

  // 에이전트 실행 경과 시간 — 스토어의 시작 시각을 기준으로 현재 시각에서 빼서 계산.
  // 컴포넌트 mount/unmount와 무관하게 올바른 경과 시간이 표시됨.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!agentLoading) return
    const t = setInterval(() => setTick((v) => v + 1), 100)
    return () => clearInterval(t)
  }, [agentLoading])
  const agentElapsed = agentLoading && agentStartedAtMs
    ? Math.floor((Date.now() - agentStartedAtMs) / 100)
    : 0

  const { agentModel, setAgentModel } = useModelStore()
  const sfUser = useConnectionStore((s) => s.sfUser)
  const displayName = sfUser ? sfUser.split('@')[0] : '하우'

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const agentImageInputRef = useRef<HTMLInputElement>(null)
  const handleAgentImageFiles = (files: FileList | File[] | null) => {
    if (!files) return
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string
        const [header, data] = dataUrl.split(',')
        const mediaType = header.replace('data:', '').replace(';base64', '')
        const img: ImageAttachment = { id: crypto.randomUUID(), mediaType, data, previewUrl: dataUrl }
        setAgentChatImages([...(agentChatImages ?? []), img])
      }
      reader.readAsDataURL(file)
    })
    if (agentImageInputRef.current) agentImageInputRef.current.value = ''
  }
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const pickerInputRef = useRef<HTMLInputElement>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const autoCollapsedRef = useRef<Set<string>>(new Set())
  const toggleGroup = (id: string) => setCollapsedGroups((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  type ChatItem =
    | { kind: 'msg'; msg: typeof agentChatHistory[number]; idx: number }
    | { kind: 'stepGroup'; groupId: string; steps: typeof agentChatHistory }
    | { kind: 'turnGroup'; groupId: string; inner: ChatItem[] }
  const rawChatItems: ChatItem[] = []
  for (let i = 0; i < agentChatHistory.length; i++) {
    const m = agentChatHistory[i]
    if (m.kind === 'step') {
      const steps: typeof agentChatHistory = []
      const groupId = m.id
      while (i < agentChatHistory.length && agentChatHistory[i].kind === 'step') {
        steps.push(agentChatHistory[i])
        i++
      }
      i--
      rawChatItems.push({ kind: 'stepGroup', groupId, steps })
    } else {
      rawChatItems.push({ kind: 'msg', msg: m, idx: i })
    }
  }

  // 대화가 종료(agentLoading=false)되면, 각 user 턴 내의
  //   [작업들 + 중간 응답들]을 "턴 묶음" 토글로 접고, **마지막 assistant 응답만** 펼쳐 둔다.
  const chatItems: ChatItem[] = (() => {
    if (agentLoading) return rawChatItems
    const isAsstMsg = (it: ChatItem) =>
      it.kind === 'msg' && it.msg.role === 'assistant' && !!it.msg.content
    const result: ChatItem[] = []
    let segmentStart = 0
    const flushSegment = (endExclusive: number) => {
      const seg = rawChatItems.slice(segmentStart, endExclusive)
      if (seg.length === 0) return
      // segment 안의 마지막 assistant 응답 위치
      let lastAsstLocalIdx = -1
      for (let i = seg.length - 1; i >= 0; i--) {
        if (isAsstMsg(seg[i])) { lastAsstLocalIdx = i; break }
      }
      // 마지막 응답이 없거나 항목이 1개뿐이면 그대로
      if (lastAsstLocalIdx < 0 || seg.length === 1) {
        for (const it of seg) result.push(it)
        return
      }
      const earlier = seg.slice(0, lastAsstLocalIdx)
      const tail = seg.slice(lastAsstLocalIdx)  // 마지막 assistant + 그 뒤 (보통 뒤는 없음)
      if (earlier.length === 0) {
        for (const it of tail) result.push(it)
        return
      }
      if (earlier.length === 1) {
        result.push(earlier[0])
      } else {
        result.push({ kind: 'turnGroup', groupId: `turn-${segmentStart}`, inner: earlier })
      }
      for (const it of tail) result.push(it)
    }
    for (let i = 0; i < rawChatItems.length; i++) {
      const it = rawChatItems[i]
      if (it.kind === 'msg' && it.msg.role === 'user') {
        flushSegment(i)
        result.push(it)
        segmentStart = i + 1
      }
    }
    flushSegment(rawChatItems.length)
    return result
  })()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [agentChatHistory])

  // 작업 그룹이 "완료"(뒤에 다른 아이템이 붙음)되면 한 번만 자동으로 접는다.
  useEffect(() => {
    const toCollapse: string[] = []
    for (let i = 0; i < chatItems.length - 1; i++) {
      const it = chatItems[i]
      if (it.kind === 'stepGroup' && !autoCollapsedRef.current.has(it.groupId)) {
        toCollapse.push(it.groupId)
      }
    }
    if (toCollapse.length > 0) {
      toCollapse.forEach((id) => autoCollapsedRef.current.add(id))
      setCollapsedGroups((prev) => {
        const next = new Set(prev)
        toCollapse.forEach((id) => next.add(id))
        return next
      })
    }
  }, [agentChatHistory])

  const refCellObjects = cells.filter((c) => agentRefCells.includes(c.id))
  const availableCells = cells.filter((c) => !agentRefCells.includes(c.id))

  // 현재 세션이 "물고 있는" 대략적인 토큰량 추정 — 대화 히스토리와
  // 다음 턴에 함께 전송되는 셀 스냅샷(코드 + 메모)을 문자열 길이로 환산.
  // 한글/영문 혼재를 고려해 보수적으로 ~3 chars/token 비율을 사용.
  const approxTokens = (() => {
    const convo = agentChatHistory
      .filter((m) => m.content)
      .map((m) => m.content)
      .join('\n')
    const cellCtx = cells
      .map((c) => `${c.name}\n${c.code}\n${c.memo ?? ''}`)
      .join('\n')
    const chars = convo.length + cellCtx.length
    return Math.max(0, Math.round(chars / 3))
  })()
  const tokenLabel = approxTokens >= 1000
    ? `~${(approxTokens / 1000).toFixed(1)}k`
    : `~${approxTokens}`
  const ctxWindow = getModelContextWindow(agentModel)
  const ctxWindowLabel = ctxWindow >= 1_000_000
    ? `${(ctxWindow / 1_000_000).toFixed(ctxWindow % 1_000_000 === 0 ? 0 : 1)}M`
    : `${Math.round(ctxWindow / 1000)}k`
  const ctxPct = Math.min(100, (approxTokens / ctxWindow) * 100)
  const ctxClass = ctxPct >= 90 ? 'text-primary-hover' : ctxPct >= 70 ? 'text-warning' : 'text-text-secondary'
  const ctxFillClass = ctxPct >= 90 ? 'bg-primary-hover' : ctxPct >= 70 ? 'bg-warning' : 'bg-text-secondary'

  const TYPE_COLORS: Record<string, string> = {
    sql: 'bg-sql-bg text-sql-text',
    python: 'bg-python-bg text-python-text',
    markdown: 'bg-markdown-bg text-markdown-text',
  }

  return (
    <div
      className="fixed bottom-6 rounded-2xl shadow-2xl border border-border flex flex-col z-[115]"
      style={{ left: 240, right: 268, maxHeight: 'calc(100vh - 96px)', backgroundColor: 'rgb(var(--color-surface))' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle bg-bg-output rounded-t-2xl">
        <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
          <Telescope size={14} className="text-white" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-primary">에이전트 모드</div>
          <div className="text-[10px] text-text-tertiary">노트북 전체와 대화하며 분석을 이어가세요</div>
        </div>
        <div
          className="shrink-0 flex flex-col items-end gap-1 px-2 py-1 rounded-md border bg-surface border-border-subtle"
          title={`이번 턴에 전송되는 토큰 추정치(대화 이력 + 셀 코드/메모 기반) / 선택 모델의 최대 컨텍스트 윈도우\n${approxTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${ctxPct.toFixed(1)}%)`}
        >
          <div className={cn('flex items-center gap-1.5 text-[10px] font-mono leading-none', ctxClass)}>
            <span className="font-semibold">{tokenLabel}</span>
            <span className="text-text-disabled">/ {ctxWindowLabel}</span>
            <span className="text-text-tertiary">({ctxPct < 1 ? ctxPct.toFixed(2) : ctxPct.toFixed(1)}%)</span>
          </div>
          <div className="w-28 h-1 rounded-full overflow-hidden bg-bg-sidebar">
            <div
              className={cn('h-full rounded-full transition-all', ctxFillClass)}
              style={{ width: `${ctxPct}%` }}
            />
          </div>
        </div>
        <button
          title={agentChatHistory.length > 0 ? '새 대화 시작 (현재 대화 아카이브)' : '새 대화 시작 (대화 없음)'}
          onClick={newAgentSession}
          disabled={agentChatHistory.length === 0}
          className={cn(
            'p-1 rounded transition-colors',
            agentChatHistory.length > 0
              ? 'text-text-tertiary hover:text-primary hover:bg-chip'
              : 'text-text-disabled cursor-not-allowed'
          )}
        >
          <SquarePen size={15} />
        </button>
        <button
          title="닫기"
          onClick={toggleAgentMode}
          className="p-1 text-text-tertiary hover:text-text-secondary rounded hover:bg-chip transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Chat history */}
      {agentChatHistory.length > 0 && (
        <div className="overflow-y-auto hide-scrollbar px-4 py-3 space-y-3">
          {chatItems.map((item) => {
            if (item.kind === 'stepGroup') {
              const collapsed = collapsedGroups.has(item.groupId)
              const lastStep = item.steps[item.steps.length - 1]
              return (
                <div key={item.groupId} className="flex gap-2.5 flex-row">
                  <div className="w-7 shrink-0 flex items-start justify-center pt-1">
                    <div className="w-5 h-5 rounded-full flex items-center justify-center bg-chip text-text-secondary">
                      <Wrench size={11} strokeWidth={2.5} />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 max-w-[85%]">
                    <button
                      type="button"
                      onClick={() => toggleGroup(item.groupId)}
                      className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-left text-[11.5px] font-medium border cursor-pointer hover:bg-chip transition-colors bg-bg-output border-border-subtle text-text-secondary"
                    >
                      {collapsed
                        ? <ChevronRight size={10} className="text-text-disabled shrink-0" />
                        : <ChevronDown size={10} className="text-text-disabled shrink-0" />}
                      <span className="truncate flex-1">
                        {collapsed ? `작업 ${item.steps.length}개 · ${lastStep.stepLabel ?? ''}` : `작업 ${item.steps.length}개`}
                      </span>
                      <span className="text-[9px] text-text-disabled shrink-0 font-normal">{lastStep.timestamp}</span>
                    </button>
                    {!collapsed && (
                      <div className="mt-1 space-y-1 pl-1">
                        {item.steps.map((step) => {
                          const sIcon = STEP_ICONS[step.stepType ?? 'tool']
                          const SIconComp = sIcon.icon
                          return (
                            <div
                              key={step.id}
                              className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-text-secondary bg-bg-sidebar border border-border-subtle"
                            >
                              <div className={cn('w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0', sIcon.className)}>
                                <SIconComp size={8} strokeWidth={2.5} />
                              </div>
                              <span className="truncate flex-1">{step.stepLabel ?? '작업'}</span>
                              <span className="text-[9px] text-text-disabled shrink-0">{step.timestamp}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            if (item.kind === 'turnGroup') {
              const collapsed = !collapsedGroups.has(item.groupId) // 기본 접힘
              const stepCount = item.inner.reduce(
                (acc, it) => acc + (it.kind === 'stepGroup' ? it.steps.length : 0), 0,
              )
              const msgCount = item.inner.filter(
                (it) => it.kind === 'msg' && it.msg.role === 'assistant' && !!it.msg.content,
              ).length
              const firstTs = (() => {
                for (const it of item.inner) {
                  if (it.kind === 'msg') return it.msg.timestamp
                  if (it.kind === 'stepGroup' && it.steps.length > 0) return it.steps[0].timestamp
                }
                return ''
              })()
              const summaryBits: string[] = []
              if (stepCount > 0) summaryBits.push(`작업 ${stepCount}개`)
              if (msgCount > 0) summaryBits.push(`응답 ${msgCount}개`)
              return (
                <div key={item.groupId} className="flex gap-2.5 flex-row">
                  <div className="w-7 shrink-0 flex items-start justify-center pt-1">
                    <div className="w-5 h-5 rounded-full flex items-center justify-center bg-primary/15 text-primary">
                      <Telescope size={11} strokeWidth={2.5} />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 max-w-[90%]">
                    <button
                      type="button"
                      onClick={() => toggleGroup(item.groupId)}
                      className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-left text-[11.5px] font-medium border cursor-pointer hover:bg-chip transition-colors bg-bg-output border-border-subtle text-text-secondary"
                    >
                      {collapsed
                        ? <ChevronRight size={10} className="text-text-disabled shrink-0" />
                        : <ChevronDown size={10} className="text-text-disabled shrink-0" />}
                      <span className="truncate flex-1">이번 턴 · {summaryBits.join(' · ') || '대화'}</span>
                      <span className="text-[9px] text-text-disabled shrink-0 font-normal">{firstTs}</span>
                    </button>
                    {!collapsed && (
                      <div className="mt-2 space-y-3 pl-1">
                        {item.inner.map((inner) => {
                          if (inner.kind === 'stepGroup') {
                            return (
                              <div key={inner.groupId} className="space-y-1">
                                <div className="text-[10px] font-semibold text-text-disabled">작업 {inner.steps.length}개</div>
                                {inner.steps.map((step) => {
                                  const sIcon = STEP_ICONS[step.stepType ?? 'tool']
                                  const SIconComp = sIcon.icon
                                  return (
                                    <div
                                      key={step.id}
                                      className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-text-secondary bg-bg-sidebar border border-border-subtle"
                                    >
                                      <div className={cn('w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0', sIcon.className)}>
                                        <SIconComp size={8} strokeWidth={2.5} />
                                      </div>
                                      <span className="truncate flex-1">{step.stepLabel ?? '작업'}</span>
                                      <span className="text-[9px] text-text-disabled shrink-0">{step.timestamp}</span>
                                    </div>
                                  )
                                })}
                              </div>
                            )
                          }
                          if (inner.kind === 'msg' && inner.msg.role === 'assistant' && inner.msg.content) {
                            const m = inner.msg
                            return (
                              <div
                                key={m.id}
                                className="px-3 py-2 rounded-xl text-[12.5px] text-text-primary text-left leading-relaxed break-words border border-border-subtle"
                                style={{ backgroundColor: 'rgb(var(--color-bg-sidebar))' }}
                              >
                                <div className="text-[9px] text-text-disabled mb-1">{m.timestamp}</div>
                                <Markdown content={m.content} />
                              </div>
                            )
                          }
                          return null
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            const msg = item.msg
            const idx = item.idx
            const isLast = idx === agentChatHistory.length - 1
            const isEmptyAssistant = msg.role === 'assistant' && !msg.content
            // 에이전트가 턴 전환 중 생성한 빈 말풍선은 로딩이 끝나면 숨긴다 (마지막 메시지는 제외)
            if (isEmptyAssistant && !agentLoading && !isLast) return null
            return (
            <div key={msg.id} className={cn('flex gap-2.5', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
              <div
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                  msg.role === 'user' ? 'bg-gradient-to-br from-primary-border to-primary' : 'bg-primary'
                )}
              >
                {msg.role === 'user'
                  ? <User size={14} className="text-white" strokeWidth={2} />
                  : <Telescope size={14} className="text-white" strokeWidth={2} />}
              </div>
              <div className={cn('flex-1 min-w-0 max-w-[80%] flex flex-col', msg.role === 'user' ? 'items-end' : 'items-start')}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[10px] font-semibold text-text-secondary">{msg.role === 'user' ? displayName : '에이전트'}</span>
                  <span className="text-[9px] text-text-disabled">{msg.timestamp}</span>
                </div>
                <div
                  className={cn(
                    'px-3 py-2 rounded-xl text-[13px] text-text-primary text-left leading-relaxed break-words border',
                    msg.role === 'user' ? 'border-primary-border/70' : 'border-border-subtle'
                  )}
                  style={{
                    backgroundColor: msg.role === 'user'
                      ? 'rgb(var(--color-primary-light))'
                      : 'rgb(var(--color-bg-sidebar))',
                  }}
                >
                  {msg.role === 'assistant' && agentLoading && isLast ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="flex items-center gap-2 whitespace-nowrap text-primary-hover">
                        <Loader2 size={12} className="animate-spin" />
                        <span className="text-[12px] font-semibold">{agentStatus ?? '생각 중'}</span>
                        <span className="font-mono text-[11px] text-primary-hover/60">
                          {(agentElapsed / 10).toFixed(1)}s
                        </span>
                        <button
                          title="에이전트 중지"
                          onClick={() => cancelAgent()}
                          className="ml-1 flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold transition-colors bg-primary-light text-primary-hover border border-primary-border"
                        >
                          <StopCircle size={11} />중지
                        </button>
                      </span>
                      {msg.content && <Markdown content={msg.content} />}
                      {agentElapsed >= 300 && !msg.content && !agentChatHistory.slice(0, idx).some((m) => m.role === 'assistant' && !!m.content) && (
                        <div
                          className="flex items-start gap-1.5 text-[11px] leading-relaxed px-2 py-1.5 rounded-md bg-warning-bg/50 border border-dashed border-primary-border text-primary-text"
                        >
                          <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                          <span>
                            30초가 지났어요. 혹시 <b>질문이 모호</b>하거나 <b>선택된 마트가 부족</b>하진 않은지 한 번 확인해보세요. 그대로 진행해도 되지만 더 빨리 답을 받으려면 중지 후 질문을 구체화하거나 마트를 추가해보세요.
                          </span>
                        </div>
                      )}
                    </div>
                  ) : isEmptyAssistant && agentLoading ? (
                    // 턴 전환 중인 빈 말풍선 — 현재 상태 라벨을 붙여 진행 맥락을 보여준다.
                    <span className="flex items-center gap-2 whitespace-nowrap text-primary-hover">
                      <Loader2 size={12} className="animate-spin" />
                      <span className="text-[12px] font-semibold">{agentStatus ?? '출력 분석 중'}</span>
                    </span>
                  ) : msg.role === 'assistant' ? (
                    <Markdown content={msg.content} />
                  ) : (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  )}
                </div>
                {msg.createdCellIds && msg.createdCellIds.length > 0 && (
                  <button
                    className="mt-1.5 text-[10px] font-semibold flex items-center gap-1 text-primary hover:underline"
                    style={{ justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}
                    onClick={() => document.getElementById(msg.createdCellIds![0])?.scrollIntoView({ behavior: 'smooth' })}
                  >
                    셀 {msg.createdCellIds.length}개 생성됨 · 보러가기 →
                  </button>
                )}
              </div>
            </div>
            )
          })}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Reference cells */}
      <div className={cn('px-4 pt-3 pb-1 border-t', agentChatHistory.length > 0 ? 'border-border-subtle' : 'border-transparent')}>
        <div className="flex items-center gap-1.5 flex-wrap relative">
          <span className="text-[10px] text-text-disabled font-medium shrink-0">참조 셀</span>

          {refCellObjects.map((cell) => (
            <span
              key={cell.id}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-primary-light border-primary-border text-primary-text"
            >
              <FileCode size={9} />
              {cell.name}
              <button
                title="참조 제거"
                onClick={() => toggleAgentRefCell(cell.id)}
                className="ml-0.5 hover:text-danger"
              >
                <X size={9} />
              </button>
            </span>
          ))}

          <div className="relative">
            <button
              title="참조 셀 추가"
              onClick={() => {
                setPickerOpen((v) => !v)
                setPickerQuery('')
                setTimeout(() => pickerInputRef.current?.focus(), 50)
              }}
              className="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] text-text-tertiary border border-dashed border-border hover:border-primary hover:text-primary transition-colors"
            >
              <Plus size={10} />
              추가
            </button>

            {pickerOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setPickerOpen(false)} />
                <div className="absolute left-0 bottom-7 z-50 bg-surface border border-border rounded-lg shadow-lg min-w-[200px]">
                  {/* Search */}
                  <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border-subtle">
                    <Search size={11} className="text-text-disabled shrink-0" />
                    <input
                      ref={pickerInputRef}
                      className="flex-1 text-[11px] bg-transparent outline-none text-text-primary placeholder-text-disabled"
                      placeholder="셀 검색..."
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                    {pickerQuery && (
                      <button onClick={() => setPickerQuery('')} className="text-text-disabled hover:text-text-secondary">
                        <X size={10} />
                      </button>
                    )}
                  </div>
                  {/* Cell list */}
                  <div className="py-1 max-h-[180px] overflow-y-auto hide-scrollbar">
                    {availableCells
                      .filter((c) => c.name.toLowerCase().includes(pickerQuery.toLowerCase()))
                      .map((cell, idx) => (
                        <button
                          key={cell.id}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-chip text-left"
                          onClick={() => { toggleAgentRefCell(cell.id); setPickerOpen(false); setPickerQuery('') }}
                        >
                          <span className="text-[9px] text-text-disabled font-mono shrink-0">[{idx + 1}]</span>
                          <span className={cn('text-[8px] font-bold px-1 py-0.5 rounded uppercase tracking-wide shrink-0', TYPE_COLORS[cell.type])}>
                            {cell.type === 'markdown' ? 'MD' : cell.type === 'python' ? 'PY' : cell.type.toUpperCase()}
                          </span>
                          <span className="truncate">{cell.name}</span>
                        </button>
                      ))}
                    {availableCells.filter((c) => c.name.toLowerCase().includes(pickerQuery.toLowerCase())).length === 0 && (
                      <div className="px-3 py-2 text-[11px] text-text-disabled text-center">검색 결과 없음</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {availableCells.length === 0 && refCellObjects.length === 0 && (
            <span className="text-[10px] text-text-disabled italic">셀이 없습니다</span>
          )}
        </div>
      </div>

      {/* Input — 바이브 챗 박스와 동일 포맷: 모델 select 좌하단, 전송 우하단 */}
      <div className="px-4 py-3">
        <div
          className="relative rounded-2xl border border-border shadow-sm"
          style={{ backgroundColor: 'rgb(var(--color-surface-hover))' }}
        >
          {/* 이미지 미리보기 */}
          {(agentChatImages ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {(agentChatImages ?? []).map((img) => (
                <div key={img.id} className="relative group/img">
                  <img src={img.previewUrl} alt="" className="w-12 h-12 object-cover rounded-lg border border-border" />
                  <button
                    title="이미지 제거"
                    onClick={() => setAgentChatImages((agentChatImages ?? []).filter((i) => i.id !== img.id))}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface border border-border flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={agentImageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleAgentImageFiles(e.target.files)}
          />
          <textarea
            className="w-full bg-transparent text-[13px] text-text-primary placeholder-text-tertiary focus:outline-none resize-none leading-relaxed overflow-hidden rounded-2xl"
            style={{ minHeight: '56px', height: '56px', padding: '10px 48px 28px 16px' }}
            placeholder="에이전트에게 노트북 전체에 대해 질문하거나 분석을 요청하세요..."
            value={agentChatInput}
            onChange={(e) => {
              setAgentChatInput(e.target.value)
              e.target.style.height = '56px'
              e.target.style.height = e.target.scrollHeight + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitAgentMessage(agentChatInput)
                e.currentTarget.style.height = '56px'
              }
            }}
            onPaste={(e) => {
              const imageFiles = Array.from(e.clipboardData.items)
                .filter((item) => item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null)
              if (imageFiles.length === 0) return
              e.preventDefault()
              handleAgentImageFiles(imageFiles)
            }}
          />
          <div className="absolute left-3 bottom-2.5 flex items-center gap-1.5" style={{ zIndex: 10 }}>
            <div className="relative flex items-center">
              <select
                value={agentModel}
                onChange={(e) => setAgentModel(e.target.value)}
                className="appearance-none text-[10px] font-medium text-text-disabled bg-transparent border-none pl-0 pr-4 py-0 cursor-pointer hover:text-text-secondary outline-none transition-colors"
              >
                {AGENT_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <ChevronDown size={9} className="absolute right-0 pointer-events-none text-text-disabled" />
            </div>
            <button
              title="이미지 첨부"
              disabled={agentLoading}
              onClick={() => agentImageInputRef.current?.click()}
              className="flex items-center justify-center text-text-disabled hover:text-text-secondary transition-colors disabled:cursor-not-allowed"
            >
              <Paperclip size={11} />
            </button>
          </div>
          <button
            title="전송"
            disabled={!agentChatInput.trim()}
            onClick={() => submitAgentMessage(agentChatInput)}
            className={cn(
              'absolute right-3 bottom-2 w-8 h-8 rounded-full flex items-center justify-center transition-all disabled:cursor-not-allowed text-white z-10',
              agentChatInput.trim() ? 'bg-primary' : 'bg-border-subtle'
            )}
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  )
}
