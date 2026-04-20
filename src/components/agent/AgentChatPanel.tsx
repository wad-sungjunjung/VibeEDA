import { useRef, useEffect, useState } from 'react'
import { Telescope, X, User, ArrowUp, Plus, FileCode, Search, SquarePen, ChevronDown, ChevronRight, Loader2, Wrench, FileCode2, PlayCircle, StickyNote, AlertTriangle, StopCircle } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useModelStore, AGENT_MODELS } from '@/store/modelStore'
import { useConnectionStore } from '@/store/connectionStore'
import { cn } from '@/lib/utils'
import Markdown from '@/components/common/Markdown'

const STEP_ICONS: Record<string, { icon: typeof Wrench; bg: string; fg: string }> = {
  tool: { icon: Wrench, bg: '#eef2f7', fg: '#2c5282' },
  cell_created: { icon: FileCode2, bg: '#e8f0e1', fg: '#3d5226' },
  cell_executed: { icon: PlayCircle, bg: '#e7f3e4', fg: '#1f6b2e' },
  cell_memo: { icon: StickyNote, bg: '#f7efd8', fg: '#7a5a0f' },
  error: { icon: AlertTriangle, bg: '#fde3e0', fg: '#a12d19' },
}

export default function AgentChatPanel() {
  const {
    cells,
    agentChatHistory,
    agentChatInput,
    agentRefCells,
    agentLoading,
    agentStartedAtMs,
    agentStatus,
    toggleAgentMode,
    setAgentChatInput,
    submitAgentMessage,
    cancelAgent,
    toggleAgentRefCell,
    newAgentSession,
  } = useAppStore()

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
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const pickerInputRef = useRef<HTMLInputElement>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const toggleGroup = (id: string) => setCollapsedGroups((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  type ChatItem =
    | { kind: 'msg'; msg: typeof agentChatHistory[number]; idx: number }
    | { kind: 'stepGroup'; groupId: string; steps: typeof agentChatHistory }
  const chatItems: ChatItem[] = []
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
      chatItems.push({ kind: 'stepGroup', groupId, steps })
    } else {
      chatItems.push({ kind: 'msg', msg: m, idx: i })
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [agentChatHistory])

  const refCellObjects = cells.filter((c) => agentRefCells.includes(c.id))
  const availableCells = cells.filter((c) => !agentRefCells.includes(c.id))

  const TYPE_COLORS: Record<string, string> = {
    sql: 'bg-[#e8e4d8] text-[#5c4a1e]',
    python: 'bg-[#e6ede0] text-[#3d5226]',
    markdown: 'bg-[#eae4df] text-[#4a3c2e]',
  }

  return (
    <div
      className="fixed bottom-6 rounded-2xl shadow-2xl bg-white border border-border flex flex-col z-30"
      style={{ left: 240, right: 268, maxHeight: 'calc(100vh - 96px)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle" style={{ backgroundColor: '#faf8f2' }}>
        <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
          <Telescope size={14} className="text-white" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-primary">에이전트 모드</div>
          <div className="text-[10px] text-text-tertiary">노트북 전체와 대화하며 분석을 이어가세요</div>
        </div>
        <div className="relative shrink-0">
          <select
            value={agentModel}
            onChange={(e) => setAgentModel(e.target.value)}
            className="appearance-none text-[10px] font-medium text-text-secondary bg-white border border-border rounded-md pl-2 pr-6 py-1 cursor-pointer hover:border-primary hover:text-primary outline-none transition-colors"
          >
            {AGENT_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-text-tertiary" />
        </div>
        <button
          title={agentChatHistory.length > 0 ? '새 대화 시작 (현재 대화 아카이브)' : '새 대화 시작 (대화 없음)'}
          onClick={newAgentSession}
          disabled={agentChatHistory.length === 0}
          className={cn(
            'p-1 rounded transition-colors',
            agentChatHistory.length > 0
              ? 'text-text-tertiary hover:text-primary hover:bg-stone-100'
              : 'text-text-disabled cursor-not-allowed'
          )}
        >
          <SquarePen size={15} />
        </button>
        <button
          title="닫기"
          onClick={toggleAgentMode}
          className="p-1 text-text-tertiary hover:text-text-secondary rounded hover:bg-stone-100 transition-colors"
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
                    <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: '#eef2f7', color: '#2c5282' }}>
                      <Wrench size={11} strokeWidth={2.5} />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 max-w-[85%]">
                    <button
                      type="button"
                      onClick={() => toggleGroup(item.groupId)}
                      className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-left text-[11.5px] font-medium border cursor-pointer hover:bg-stone-100 transition-colors"
                      style={{ backgroundColor: '#fafaf8', borderColor: '#ede9dd', color: '#2c5282' }}
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
                              className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-text-secondary"
                              style={{ backgroundColor: '#f5f3ef', border: '1px solid #ede9dd' }}
                            >
                              <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: sIcon.bg, color: sIcon.fg }}>
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

            const msg = item.msg
            const idx = item.idx
            const isLast = idx === agentChatHistory.length - 1
            return (
            <div key={msg.id} className={cn('flex gap-2.5', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                style={{ background: msg.role === 'user' ? 'linear-gradient(135deg, #ebc2b5, #D95C3F)' : '#D95C3F' }}
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
                  className="px-3 py-2 rounded-xl text-[13px] text-text-primary text-left leading-relaxed break-words"
                  style={{ backgroundColor: msg.role === 'user' ? '#fdede8' : '#faf8f2', border: '1px solid', borderColor: msg.role === 'user' ? '#f5d5c8' : '#ede9dd' }}
                >
                  {msg.role === 'assistant' && !msg.content && agentLoading && isLast ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="flex items-center gap-2 whitespace-nowrap" style={{ color: '#c94a2e' }}>
                        <Loader2 size={12} className="animate-spin" />
                        <span className="text-[12px] font-semibold">{agentStatus ?? '생각 중'}</span>
                        <span className="font-mono text-[11px]" style={{ color: '#c94a2e99' }}>
                          {(agentElapsed / 10).toFixed(1)}s
                        </span>
                        <button
                          title="에이전트 중지"
                          onClick={() => cancelAgent()}
                          className="ml-1 flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold transition-colors"
                          style={{ backgroundColor: '#fdede8', color: '#c94a2e', border: '1px solid #f5c5b5' }}
                        >
                          <StopCircle size={11} />중지
                        </button>
                      </span>
                      {agentElapsed >= 300 && !agentChatHistory.slice(0, idx).some((m) => m.role === 'assistant' && !!m.content) && (
                        <div
                          className="flex items-start gap-1.5 text-[11px] leading-relaxed px-2 py-1.5 rounded-md"
                          style={{ backgroundColor: '#fff7ed', border: '1px dashed #f5c5b5', color: '#7a3a22' }}
                        >
                          <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                          <span>
                            30초가 지났어요. 혹시 <b>질문이 모호</b>하거나 <b>선택된 마트가 부족</b>하진 않은지 한 번 확인해보세요. 그대로 진행해도 되지만 더 빨리 답을 받으려면 중지 후 질문을 구체화하거나 마트를 추가해보세요.
                          </span>
                        </div>
                      )}
                    </div>
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
      <div className="px-4 pt-3 pb-1 border-t border-border-subtle" style={{ borderTopColor: agentChatHistory.length > 0 ? '#ede9dd' : 'transparent' }}>
        <div className="flex items-center gap-1.5 flex-wrap relative">
          <span className="text-[10px] text-text-disabled font-medium shrink-0">참조 셀</span>

          {refCellObjects.map((cell) => (
            <span
              key={cell.id}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border"
              style={{ backgroundColor: '#fdede8', borderColor: '#ebc2b5', color: '#8f3a22' }}
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
                <div className="absolute left-0 bottom-7 z-50 bg-white border border-border rounded-lg shadow-lg min-w-[200px]">
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
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-stone-50 text-left"
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

      {/* Input */}
      <div className="px-4 py-3">
        <div className="relative">
          <textarea
            className="w-full text-[13px] text-text-primary placeholder-text-tertiary focus:outline-none resize-none leading-relaxed rounded-xl overflow-hidden"
            style={{ minHeight: '44px', height: '44px', padding: '12px 48px 12px 14px', backgroundColor: '#faf8f2', border: '1px solid #ede9dd' }}
            placeholder="에이전트에게 노트북 전체에 대해 질문하거나 분석을 요청하세요..."
            value={agentChatInput}
            onChange={(e) => {
              setAgentChatInput(e.target.value)
              e.target.style.height = '44px'
              e.target.style.height = e.target.scrollHeight + 'px'
            }}
            onFocus={(e) => { e.target.style.borderColor = '#D95C3F' }}
            onBlur={(e) => { e.target.style.borderColor = '#ede9dd' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitAgentMessage(agentChatInput)
                e.currentTarget.style.height = '44px'
              }
            }}
          />
          <button
            title="전송"
            disabled={!agentChatInput.trim()}
            onClick={() => submitAgentMessage(agentChatInput)}
            className={cn(
              'absolute right-2 bottom-2 w-8 h-8 rounded-full flex items-center justify-center transition-all',
              agentChatInput.trim()
                ? 'bg-primary text-white shadow-[0_2px_6px_rgba(217,92,63,0.3)]'
                : 'bg-bg-sidebar text-text-disabled cursor-not-allowed'
            )}
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  )
}
