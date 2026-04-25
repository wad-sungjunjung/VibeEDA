import { useRef, useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'
import CellContainer from './CellContainer'

export default function NotebookArea() {
  const { cells, activeCellId, setNotebookAreaHeight } = useAppStore(
    useShallow((s) => ({
      cells: s.cells,
      activeCellId: s.activeCellId,
      setNotebookAreaHeight: s.setNotebookAreaHeight,
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
        <div className="flex flex-col items-center justify-center h-full text-text-disabled text-[13px] gap-2">
          <span>셀이 없습니다</span>
          <span className="text-[12px]">하단 셀 추가 바에서 새 셀을 추가하세요</span>
        </div>
      ) : (
        cells.map((cell, idx) => <CellContainer key={cell.id} cell={cell} index={idx + 1} />)
      )}
    </div>
  )
}
