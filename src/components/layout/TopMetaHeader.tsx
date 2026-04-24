import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ChevronRight, Pin, FileSearch, FileText, Search, X, Database, Check, Sparkles, Plus, Layers, ChevronLeft, ChevronUp, Play, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import { scoreMarts, searchMarts } from '@/data/marts'
import { recommendMarts, type MartRecommendation } from '@/lib/api'
import type { MartMeta } from '@/types'
import { cn } from '@/lib/utils'

const PREFIX_FILTERS = [
  { key: 'fact', label: 'fact' },
  { key: 'dim', label: 'dim' },
  { key: 'rpt', label: 'rpt' },
  { key: 'obt', label: 'obt' },
] as const

const PAGE_SIZE = 5

function scoreBadgeClass(score: number) {
  if (score >= 3) return 'bg-warning-bg text-warning-text'
  if (score >= 2) return 'bg-warning-bg/70 text-warning'
  return 'bg-chip text-text-disabled'
}

export default function TopMetaHeader() {
  const {
    analysisTheme,
    analysisDescription,
    metaCollapsed,
    selectedMarts,
    martSearchQuery,
    martInfoExpanded,
    martCatalog,
    setAnalysisTheme,
    setAnalysisDescription,
    setMetaCollapsed,
    addMart,
    removeMart,
    setMartSearchQuery,
    setShowReportModal,
    executeAllCells,
    executingCells,
    cells,
  } = useAppStore(useShallow((s) => ({
    analysisTheme: s.analysisTheme,
    analysisDescription: s.analysisDescription,
    metaCollapsed: s.metaCollapsed,
    selectedMarts: s.selectedMarts,
    martSearchQuery: s.martSearchQuery,
    martInfoExpanded: s.martInfoExpanded,
    martCatalog: s.martCatalog,
    setAnalysisTheme: s.setAnalysisTheme,
    setAnalysisDescription: s.setAnalysisDescription,
    setMetaCollapsed: s.setMetaCollapsed,
    addMart: s.addMart,
    removeMart: s.removeMart,
    setMartSearchQuery: s.setMartSearchQuery,
    setShowReportModal: s.setShowReportModal,
    executeAllCells: s.executeAllCells,
    executingCells: s.executingCells,
    cells: s.cells,
  })))

  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(['fact', 'dim']))
  const [martPage, setMartPage] = useState(0)
  const [viewedMarts, setViewedMarts] = useState<string[]>([])
  const [expandedMart, setExpandedMart] = useState<string | null>(null)

  // AI 추천 상태
  const [aiRecommending, setAiRecommending] = useState(false)
  const [aiRecs, setAiRecs] = useState<MartRecommendation[] | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)

  // 백그라운드 프리패치
  const prefetchedRecs = useRef<MartRecommendation[] | null>(null)
  const prefetchingRef = useRef(false)

  const buildMartPayload = useCallback(() => ({
    analysis_theme: analysisTheme,
    analysis_description: analysisDescription,
    marts: martCatalog.map((m) => ({
      key: m.key,
      description: m.description,
      keywords: m.keywords,
      columns: m.columns.map((c) => ({ name: c.name, type: c.type, desc: c.desc })),
    })),
  }), [analysisTheme, analysisDescription, martCatalog])

  useEffect(() => {
    const text = (analysisDescription + analysisTheme).trim()
    prefetchedRecs.current = null
    if (text.length < 20 || martCatalog.length === 0) return

    const timer = setTimeout(async () => {
      if (prefetchingRef.current) return
      prefetchingRef.current = true
      try {
        const res = await recommendMarts(buildMartPayload())
        if (res.ok) prefetchedRecs.current = res.recommendations
      } catch {
        // silent — user can manually trigger
      } finally {
        prefetchingRef.current = false
      }
    }, 2000)

    return () => clearTimeout(timer)
  }, [analysisDescription, analysisTheme, martCatalog, buildMartPayload])

  function toggleViewed(key: string) {
    setViewedMarts((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  async function handleAiRecommend() {
    if (!analysisDescription.trim() && !analysisTheme.trim()) {
      setAiError('분석 내용을 먼저 입력해주세요.')
      return
    }
    // 프리패치된 결과가 있으면 즉시 사용
    if (prefetchedRecs.current) {
      setAiRecs(prefetchedRecs.current)
      prefetchedRecs.current = null
      setAiError(null)
      setMartPage(0)
      return
    }
    setAiRecommending(true)
    setAiError(null)
    setAiRecs(null)
    setMartPage(0)
    try {
      const res = await recommendMarts(buildMartPayload())
      if (res.ok) {
        setAiRecs(res.recommendations)
      } else {
        setAiError(res.message ?? '추천 실패')
      }
    } catch {
      setAiError('추천 요청에 실패했습니다.')
    } finally {
      setAiRecommending(false)
    }
  }

  // AI 추천 결과가 있으면 해당 score로 덮어쓰고, 없으면 키워드 기반 score 사용
  const scoredMarts: MartMeta[] = (() => {
    const base = scoreMarts(analysisDescription, martCatalog)
    if (!aiRecs) return base
    const recMap = new Map(aiRecs.map((r) => [r.key, r]))
    return base
      .map((m) => {
        const rec = recMap.get(m.key)
        return rec ? { ...m, recommendationScore: rec.score, aiReason: rec.reason } : { ...m, recommendationScore: 0 }
      })
      .sort((a, b) => (b.recommendationScore ?? 0) - (a.recommendationScore ?? 0))
  })()

  const showSelectedOnly = activeFilters.has('__selected__')

  // Apply prefix filter (skip if search query active)
  const prefixFiltered = martSearchQuery
    ? searchMarts(martSearchQuery, scoredMarts)
    : showSelectedOnly
    ? scoredMarts.filter((m) => selectedMarts.includes(m.key))
    : activeFilters.size === 0
    ? scoredMarts
    : scoredMarts.filter((m) =>
        [...activeFilters].some((f) => m.key.startsWith(f + '_') || m.key === f)
      )

  // 선택된 마트도 목록에 유지 (필터링 하지 않음)
  const unselectedMarts = prefixFiltered
  const totalPages = Math.ceil(unselectedMarts.length / PAGE_SIZE)
  const pagedMarts = unselectedMarts.slice(martPage * PAGE_SIZE, (martPage + 1) * PAGE_SIZE)

  return (
    <div className="bg-surface border-b border-border-subtle shrink-0">
      {/* Fixed header bar */}
      <div className="h-header flex items-center gap-3 px-6">
        <button
          title={metaCollapsed ? '펼치기' : '접기'}
          onClick={() => setMetaCollapsed(!metaCollapsed)}
          className="p-1 -ml-1 rounded hover:bg-chip transition-colors shrink-0"
        >
          {metaCollapsed ? <ChevronRight size={16} className="text-text-tertiary" /> : <ChevronDown size={16} className="text-text-tertiary" />}
        </button>
        <Pin size={14} className="text-text-tertiary shrink-0" strokeWidth={2} />
        {metaCollapsed ? (
          <button
            className="flex-1 text-left font-semibold text-text-primary truncate"
            onClick={() => setMetaCollapsed(false)}
          >
            {analysisTheme || '분석 주제를 입력하세요'}
          </button>
        ) : (
          <input
            className="flex-1 font-semibold bg-transparent outline-none text-text-primary placeholder-text-tertiary border-none focus:ring-0 p-0"
            placeholder="한 줄로 주제를 입력하세요"
            maxLength={200}
            value={analysisTheme}
            onChange={(e) => setAnalysisTheme(e.target.value)}
          />
        )}
        {(() => {
          const isRunningAll = executingCells.size > 0
          const hasRunnable = cells.some((c) => c.type !== 'markdown')
          return (
            <button
              title="모든 셀 순서대로 실행"
              disabled={isRunningAll || !hasRunnable}
              onClick={executeAllCells}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg transition-all shrink-0 border border-border text-sql-text disabled:cursor-not-allowed disabled:opacity-50',
                isRunningAll ? 'bg-bg-output' : 'bg-surface'
              )}
            >
              {isRunningAll ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              모두 실행
            </button>
          )
        })()}
        <button
          onClick={() => setShowReportModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-[12px] font-semibold rounded-lg transition-all shadow-sm hover:shadow-md shrink-0"
        >
          <FileText size={14} />
          리포팅
        </button>
      </div>

      {/* Expanded area — 3-column grid */}
      {!metaCollapsed && (
        <div className="grid gap-0 border-t border-border-subtle" style={{ minHeight: 320, gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)' }}>

          {/* ── Col 1: 분석 내용 ── */}
          <div className="flex flex-col px-6 pt-3 pb-4 border-r border-border-subtle">
            <label className="flex items-center gap-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wide mb-1.5 shrink-0">
              <FileSearch size={12} strokeWidth={2} />
              분석 내용{' '}
              <span className="text-text-disabled normal-case font-normal">· 상세할수록 좋은 마트를 추천받을 수 있어요</span>
            </label>
            <textarea
              className="flex-1 text-[13px] bg-surface border border-border rounded px-3 py-2.5 outline-none resize-none text-text-primary placeholder-text-tertiary leading-relaxed focus:border-primary focus:ring-2 focus:ring-primary-pale"
              style={{ minHeight: '260px' }}
              placeholder="무엇을, 어떤 관점에서, 왜 분석하려고 하는지 구체적으로 적어주세요."
              value={analysisDescription}
              onChange={(e) => setAnalysisDescription(e.target.value)}
            />
          </div>

          {/* ── Col 2: 마트 풀 ── */}
          <div className="flex flex-col border-r border-border-subtle min-h-0 px-5 pt-3 pb-5 bg-surface">
            {/* Label */}
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wide mb-1.5 shrink-0">
              <Layers size={12} strokeWidth={2} />
              사용 마트{' '}
              <span className="text-text-disabled normal-case font-normal">· 좌측에서 고르면 우측으로 추가돼요</span>
            </div>

            {/* Panel with rounded border */}
            <div className="flex-1 flex flex-col min-h-0 border border-border rounded-lg overflow-hidden bg-surface">
              {/* Prefix filter chips */}
              <div className="flex items-center gap-1 px-2 pt-2 pb-1 shrink-0 flex-wrap">
                {PREFIX_FILTERS.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => { setActiveFilters(new Set([key])); setMartSearchQuery(''); setMartPage(0) }}
                    className={cn(
                      'px-2 py-0.5 rounded text-[10px] font-mono font-semibold border transition-colors',
                      activeFilters.has(key) && !showSelectedOnly
                        ? 'bg-primary text-white border-primary'
                        : 'bg-surface text-text-tertiary border-border hover:border-primary hover:text-primary'
                    )}
                  >
                    {label}
                  </button>
                ))}
                <button
                  onClick={() => { setActiveFilters(new Set(['__selected__'])); setMartSearchQuery(''); setMartPage(0) }}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors',
                    showSelectedOnly
                      ? 'bg-primary text-white border-primary'
                      : 'bg-surface text-text-tertiary border-border hover:border-primary hover:text-primary'
                  )}
                >
                  선택됨{selectedMarts.length > 0 && ` ${selectedMarts.length}`}
                </button>
                <button
                  onClick={() => { setActiveFilters(new Set()); setMartSearchQuery(''); setMartPage(0) }}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] border transition-colors',
                    activeFilters.size === 0 && !martSearchQuery
                      ? 'text-text-secondary border-border bg-chip'
                      : 'text-text-disabled border-transparent hover:text-text-secondary'
                  )}
                >
                  전체
                </button>
              </div>

              {/* Search */}
              <div className="px-2 pb-1.5 shrink-0">
                <div className="relative">
                  <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                  <input
                    className="w-full pl-7 pr-7 py-1.5 text-[11px] bg-surface border border-border rounded focus:outline-none focus:border-primary"
                    placeholder="마트명 검색..."
                    value={martSearchQuery}
                    onChange={(e) => { setMartSearchQuery(e.target.value); setMartPage(0) }}
                  />
                  {martSearchQuery && (
                    <button onClick={() => { setMartSearchQuery(''); setMartPage(0) }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>

              {/* Mart list — fixed 5 items */}
              <div className="flex-1 overflow-hidden px-2 pb-1">
                {/* AI 추천 버튼 영역 */}
                {!martSearchQuery && (
                  <div className="mb-1.5">
                    {aiRecs ? (
                      <div className="flex items-center gap-1.5">
                        <div className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-primary-text">
                          <Sparkles size={9} /> AI 추천 완료
                        </div>
                        <button
                          onClick={() => { setAiRecs(null); setAiError(null) }}
                          className="text-[9px] text-text-disabled hover:text-text-secondary underline"
                        >
                          초기화
                        </button>
                        <button
                          onClick={handleAiRecommend}
                          disabled={aiRecommending}
                          className="ml-auto flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border border-border hover:border-primary hover:text-primary text-text-tertiary transition-colors"
                        >
                          <Loader2 size={8} className={aiRecommending ? 'animate-spin' : 'hidden'} />
                          재추천
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={handleAiRecommend}
                          disabled={aiRecommending}
                          className={cn(
                            'flex items-center justify-center gap-1.5 w-full py-1.5 rounded-md text-[10px] font-semibold transition-all disabled:opacity-60 text-primary-hover border border-primary-border',
                            aiRecommending ? 'bg-primary-pale' : 'bg-primary-light'
                          )}
                        >
                          {aiRecommending
                            ? <><Loader2 size={10} className="animate-spin" /> AI가 분석 중...</>
                            : <><Sparkles size={10} /> AI 마트 추천받기</>}
                        </button>
                        {aiError && (
                          <div className="text-[9px] text-danger px-1">{aiError}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {unselectedMarts.length === 0 ? (
                  <div className="text-[11px] text-text-disabled text-center py-4 px-2">
                    {martSearchQuery ? `"${martSearchQuery}"에 맞는 마트가 없어요` : '모든 마트를 사용 중이에요'}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {pagedMarts.map((mart, idx) => {
                      const score = mart.recommendationScore ?? 0
                      const isTop = idx === 0 && martPage === 0 && !martSearchQuery && score > 0
                      const isRecommended = score > 0 && !martSearchQuery
                      const isViewed = viewedMarts.includes(mart.key)
                      const isSelected = selectedMarts.includes(mart.key)
                      const stateClass = isSelected
                        ? 'bg-primary-light border-primary'
                        : isViewed
                          ? 'bg-primary-pale/40 border-primary-border/60'
                          : isRecommended
                            ? 'bg-warning-bg/30 border-warning-bg'
                            : 'bg-surface border-border'
                      return (
                        <div
                          key={mart.key}
                          className={cn('rounded transition-all border overflow-hidden min-w-0', stateClass)}
                        >
                          <div className="flex items-center gap-1 px-1.5 py-1 min-w-0">
                            <button
                              title="마트 정보 보기"
                              onClick={() => { toggleViewed(mart.key); if (!isViewed) setExpandedMart(mart.key) }}
                              className="flex-1 min-w-0 text-left flex items-center gap-1.5 overflow-hidden"
                            >
                              {isTop && <Sparkles size={9} className="shrink-0 text-warning" strokeWidth={2.5} />}
                              <Database size={11} className={cn('shrink-0', isSelected || isViewed ? 'text-primary' : 'text-text-disabled')} />
                              <span className={cn('text-[11px] font-mono font-semibold truncate', isSelected ? 'text-primary' : 'text-text-primary')}>
                                {mart.key}
                              </span>
                              {isSelected && (
                                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 bg-primary-light text-primary">
                                  선택됨
                                </span>
                              )}
                              {!isSelected && isRecommended && (
                                <span className={cn('text-[8px] px-1 py-0.5 rounded font-semibold shrink-0', scoreBadgeClass(score))}>
                                  {score.toFixed(1)}
                                </span>
                              )}
                            </button>
                            {isSelected ? (
                              <button
                                title="선택 해제"
                                onClick={(e) => { e.stopPropagation(); removeMart(mart.key) }}
                                className="p-0.5 rounded shrink-0 transition-colors text-primary"
                              >
                                <Check size={13} />
                              </button>
                            ) : (
                              <button
                                title="분석에 추가"
                                onClick={(e) => { e.stopPropagation(); addMart(mart.key) }}
                                className="p-0.5 rounded shrink-0 text-primary"
                              >
                                <Plus size={13} />
                              </button>
                            )}
                          </div>
                          {/* Description — only show if not expanded */}
                          {martInfoExpanded !== mart.key && (
                            <>
                              {mart.description && mart.description !== mart.key && (
                                <div className="px-2 pb-0.5 text-[10px] text-text-tertiary truncate w-full">{mart.description}</div>
                              )}
                              {mart.aiReason && (
                                <div className="px-2 pb-1 flex items-center gap-1 text-[9px] truncate w-full text-primary-hover">
                                  <Sparkles size={8} className="shrink-0" />{mart.aiReason}
                                </div>
                              )}
                            </>
                          )}
                          {/* Column detail */}
                          {martInfoExpanded === mart.key && (
                            <div className="px-2 pb-2 pt-1 border-t border-border-subtle bg-surface/70 max-h-[80px] overflow-y-auto hide-scrollbar">
                              <div className="space-y-0.5">
                                {mart.columns.map((col) => (
                                  <div key={col.name} className="text-[10px] flex gap-1.5 min-w-0 overflow-hidden">
                                    <span className="font-mono font-semibold shrink-0 text-primary">{col.name}</span>
                                    <span className="text-text-tertiary truncate">{col.desc}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-2 py-1.5 border-t border-border-subtle shrink-0">
                  <button
                    disabled={martPage === 0}
                    onClick={() => setMartPage((p) => p - 1)}
                    className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-chip disabled:opacity-30 transition-colors"
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <span className="text-[10px] text-text-tertiary font-mono">
                    {martPage + 1} / {totalPages}
                    <span className="ml-1 text-text-disabled">({unselectedMarts.length}개)</span>
                  </span>
                  <button
                    disabled={martPage >= totalPages - 1}
                    onClick={() => setMartPage((p) => p + 1)}
                    className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-chip disabled:opacity-30 transition-colors"
                  >
                    <ChevronRight size={12} />
                  </button>
                </div>
              )}
            </div>{/* /panel */}
          </div>

          {/* ── Col 3: 마트 정보 ── */}
          <div className="flex flex-col min-h-0 px-5 pt-3 pb-5 bg-surface">
            {/* Panel with rounded border */}
            <div className="flex-1 flex flex-col min-h-0 rounded-lg overflow-hidden border border-primary-border">
              {/* Header */}
              <div className="px-3 py-2 border-b border-primary-border bg-surface flex items-center justify-between shrink-0">
                <div className="flex items-center gap-1.5">
                  <Database size={13} className="text-primary" />
                  <span className="text-[11px] font-semibold text-primary-text">마트 정보</span>
                </div>
                <span className="text-[10px] text-text-tertiary">클릭하면 컬럼 정보를 확인할 수 있어요</span>
              </div>

              {/* Col 3: 클릭해서 본 마트 목록 */}
              <div className="flex-1 overflow-y-auto hide-scrollbar p-2 bg-surface">
                {viewedMarts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-text-disabled text-[11px] px-2 py-6">
                    <Database size={20} className="opacity-30 mx-auto mb-2" />
                    좌측 마트 목록에서 이름을 클릭하면<br />컬럼 정보가 여기 표시됩니다
                  </div>
                ) : (
                  viewedMarts.map((key) => {
                    const mart = martCatalog.find((m) => m.key === key)
                    if (!mart) return null
                    const isOpen = expandedMart === mart.key
                    return (
                      <div
                        key={mart.key}
                        className={cn(
                          'rounded mb-1.5 overflow-hidden min-w-0 border',
                          isOpen ? 'border-primary' : 'border-primary-border'
                        )}
                      >
                        {/* Header: 클릭 → 아코디언 토글 */}
                        <div
                          className={cn(
                            'flex items-center gap-1.5 px-2 py-1.5 min-w-0 cursor-pointer transition-colors',
                            isOpen ? 'bg-primary-light' : 'bg-surface'
                          )}
                          onClick={() => setExpandedMart(isOpen ? null : mart.key)}
                        >
                          <Database size={11} className="shrink-0 text-primary" />
                          <span className="text-[11px] font-mono font-semibold truncate flex-1 min-w-0 text-primary-text">
                            {mart.key}
                          </span>
                          <span className="text-[9px] font-mono text-text-tertiary shrink-0">
                            {mart.columns.length}cols
                          </span>
                          {isOpen
                            ? <ChevronUp size={11} className="shrink-0 text-text-tertiary ml-1" />
                            : <ChevronDown size={11} className="shrink-0 text-text-tertiary ml-1" />
                          }
                          <button
                            title="닫기"
                            onClick={(e) => { e.stopPropagation(); toggleViewed(mart.key); if (expandedMart === mart.key) setExpandedMart(null) }}
                            className="ml-1 shrink-0 text-text-tertiary hover:text-text-secondary transition-colors"
                          >
                            <X size={11} />
                          </button>
                        </div>

                        {/* Collapsed: description */}
                        {!isOpen && mart.description && mart.description !== mart.key && (
                          <div className="px-2 pb-1.5 text-[10px] text-text-tertiary truncate bg-surface">
                            {mart.description}
                          </div>
                        )}

                        {/* Expanded: column table */}
                        {isOpen && (
                          <div className="border-t border-primary-border overflow-y-auto hide-scrollbar" style={{ maxHeight: 220 }}>
                            {mart.description && mart.description !== mart.key && (
                              <div className="px-2 py-1.5 text-[10px] text-text-secondary bg-chip border-b border-primary-border">
                                {mart.description}
                              </div>
                            )}
                            {mart.columns.length === 0 ? (
                              <div className="px-2 py-2 text-[10px] text-text-disabled text-center">컬럼 정보 없음</div>
                            ) : (
                              <table className="w-full text-[10px]">
                                <thead>
                                  <tr className="text-text-tertiary border-b border-primary-border bg-primary-pale/40">
                                    <th className="text-left px-2 py-1 font-semibold w-[42%]">컬럼</th>
                                    <th className="text-left px-1 py-1 font-semibold w-[22%]">타입</th>
                                    <th className="text-left px-1 py-1 font-semibold">설명</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {mart.columns.map((col, i) => (
                                    <tr key={col.name} className={i % 2 === 0 ? 'bg-surface' : 'bg-chip/50'}>
                                      <td className="px-2 py-1 font-mono font-semibold truncate max-w-0 text-primary">{col.name}</td>
                                      <td className="px-1 py-1 font-mono text-text-tertiary truncate max-w-0">{col.type}</td>
                                      <td className="px-1 py-1 text-text-secondary truncate max-w-0">{col.desc}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>

            </div>
          </div>

        </div>
      )}
    </div>
  )
}
