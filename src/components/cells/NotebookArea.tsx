import { useRef, useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import { ArrowUp, Layers, FileSearch, ChevronUp } from 'lucide-react'
import CellContainer from './CellContainer'

export default function NotebookArea() {
  const { cells, activeCellId, setNotebookAreaHeight, selectedMarts, analysisDescription, metaCollapsed, setMetaCollapsed } = useAppStore(
    useShallow((s) => ({
      cells: s.cells,
      activeCellId: s.activeCellId,
      setNotebookAreaHeight: s.setNotebookAreaHeight,
      selectedMarts: s.selectedMarts,
      analysisDescription: s.analysisDescription,
      metaCollapsed: s.metaCollapsed,
      setMetaCollapsed: s.setMetaCollapsed,
    }))
  )
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeCellId) {
      document.getElementById(activeCellId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [activeCellId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNotebookAreaHeight(el.clientHeight))
    ro.observe(el)
    setNotebookAreaHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto hide-scrollbar px-4"
    >
      {cells.length === 0 ? (
        <EmptyHint
          hasMarts={selectedMarts.length > 0}
          hasDescription={!!analysisDescription.trim()}
          metaCollapsed={metaCollapsed}
          expandMeta={() => setMetaCollapsed(false)}
        />
      ) : (
        cells.map((cell, idx) => <CellContainer key={cell.id} cell={cell} index={idx + 1} />)
      )}
    </div>
  )
}

function EmptyHint({ hasMarts, hasDescription, metaCollapsed, expandMeta }: {
  hasMarts: boolean
  hasDescription: boolean
  metaCollapsed: boolean
  expandMeta: () => void
}) {
  const needsSetup = !hasMarts || !hasDescription
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-disabled text-[13px] gap-3 px-6">
      {needsSetup ? (
        <div className="flex flex-col items-center gap-3 max-w-md text-center">
          <div className="flex items-center gap-1.5 text-text-secondary">
            <ArrowUp size={14} className="animate-bounce" />
            <span className="font-semibold">먼저 분석 환경을 준비해주세요</span>
          </div>
          <ul className="flex flex-col gap-1.5 text-[12px] text-text-tertiary leading-relaxed">
            {!hasDescription && (
              <li className="flex items-center gap-1.5">
                <FileSearch size={12} />
                상단 <b className="text-text-secondary">분석 내용</b>에 무엇을 알아내고 싶은지 적어주세요
              </li>
            )}
            {!hasMarts && (
              <li className="flex items-center gap-1.5">
                <Layers size={12} />
                상단 <b className="text-text-secondary">사용 마트</b>에서 분석에 쓸 마트를 골라주세요 (AI 추천 가능)
              </li>
            )}
          </ul>
          {metaCollapsed && (
            <button
              onClick={expandMeta}
              className="mt-1 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-primary-border bg-primary-pale text-primary-hover hover:bg-primary-light transition-colors"
            >
              <ChevronUp size={12} /> 분석 환경 펼치기
            </button>
          )}
          <span className="text-[11px] text-text-disabled mt-1">준비가 끝나면 하단의 셀 추가 바에서 첫 셀을 만들어보세요</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1">
          <span className="font-semibold text-text-secondary">분석 환경 준비 완료!</span>
          <span className="text-[12px]">하단 셀 추가 바에서 첫 셀을 만들거나, 우측 하단 에이전트(⌘G)에게 맡겨보세요</span>
        </div>
      )}
    </div>
  )
}
