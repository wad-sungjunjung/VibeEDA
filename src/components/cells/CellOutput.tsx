import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import Plot from 'react-plotly.js'
import { Copy, Check } from 'lucide-react'
import type { Cell } from '@/types'
import { formatNumber } from '@/lib/utils'
import { cn } from '@/lib/utils'
import Markdown from '@/components/common/Markdown'
import { useModelStore } from '@/store/modelStore'
import { useAppStore } from '@/store/useAppStore'
import { exportFullTable, ApiError } from '@/lib/api'
import { toast } from '@/store/useToastStore'

interface Props {
  cell: Cell
}

function CopyButton({ onCopy, label = '복사', className }: {
  onCopy: () => Promise<void> | void
  label?: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function handle() {
    try {
      await onCopy()
      setState('copied')
    } catch (e) {
      console.error('copy failed:', e)
      setState('error')
    } finally {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setState('idle'), 2000)
    }
  }

  return (
    <button
      onClick={handle}
      title={label}
      className={cn(
        'flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-medium transition-colors shadow-sm',
        state === 'copied' && 'bg-success/15 border-success/40 text-success',
        state === 'error' && 'bg-danger-bg border-danger/40 text-danger',
        state === 'idle' && 'bg-surface/95 border-border text-text-secondary hover:border-primary hover:text-primary',
        className
      )}
    >
      {state === 'copied' ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={2} />}
      <span>{state === 'copied' ? '복사됨' : state === 'error' ? '실패' : label}</span>
    </button>
  )
}

function tableToTSV(columns: { name: string }[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'number' ? String(v) : String(v)
    // TSV: 탭·개행은 공백으로 치환 (Excel/Sheets 안전)
    return s.replace(/[\t\r\n]+/g, ' ')
  }
  const header = columns.map((c) => esc(c.name)).join('\t')
  const body = rows.map((row) => row.map(esc).join('\t')).join('\n')
  return `${header}\n${body}`
}

async function copyTextRobust(text: string): Promise<void> {
  // 1차: Clipboard API (secure context + focused document 필요)
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch (e) {
    console.warn('clipboard.writeText failed, trying execCommand fallback:', e)
  }
  // 2차: execCommand 폴백 — deprecated 지만 대부분의 브라우저에서 여전히 동작
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.left = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  try {
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('execCommand returned false')
  } finally {
    document.body.removeChild(ta)
  }
}

async function copyPlotAsImage(gd: HTMLElement | null) {
  if (!gd) throw new Error('plot not ready')
  // @ts-ignore — Plotly는 전역으로 로드되어 있음
  const Plotly = (await import('plotly.js-dist-min')).default
  const dataUrl: string = await Plotly.toImage(gd, { format: 'png', scale: 2 })
  const blob = await (await fetch(dataUrl)).blob()
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
  } else {
    // Fallback: PNG data URL을 텍스트로 복사
    await navigator.clipboard.writeText(dataUrl)
  }
}

function CellOutput({ cell }: Props) {
  const plotDivRef = useRef<HTMLDivElement | null>(null)
  const theme = useModelStore((s) => s.theme)
  const isDark = theme === 'dark'

  if (cell.type === 'markdown') {
    return <MarkdownOutput content={cell.code} />
  }

  if (cell.type === 'sheet') {
    return (
      <div className="flex items-center justify-center h-full min-h-[240px] text-[12px] text-text-disabled rounded-md border border-border bg-border-subtle">
        스프레드시트 셀은 출력이 없습니다 — 입력 탭에서 편집하세요
      </div>
    )
  }

  if (!cell.executed || !cell.output) {
    return (
      <div className="flex items-center justify-center h-full min-h-[360px] text-[12px] text-text-disabled rounded-md border border-border bg-border-subtle">
        실행 전 — 버튼을 누르거나 채팅으로 요청하세요
      </div>
    )
  }

  const { output } = cell

  if (output.type === 'table' && output.columns && output.rows) {
    return (
      <TableOutput
        cellId={cell.id}
        cols={output.columns}
        rows={output.rows}
        rowCount={output.rowCount ?? output.rows.length}
      />
    )
  }

  if (output.type === 'chart' && output.plotlyJson) {
    const pj = output.plotlyJson as { data?: unknown[]; layout?: Record<string, unknown> }
    const { template: _t, ...layoutRest } = (pj.layout ?? {}) as Record<string, unknown>
    const baseLayout = layoutRest as Record<string, any>
    // Plotly layout에 지정된 폭/높이를 그대로 사용. 없으면 기본 600x400.
    const natW = typeof baseLayout.width === 'number' && baseLayout.width > 0 ? baseLayout.width : 600
    const natH = typeof baseLayout.height === 'number' && baseLayout.height > 0 ? baseLayout.height : 400
    return (
      <div className="relative group/output h-full overflow-auto flex items-center justify-center">
        <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/output:opacity-100 focus-within:opacity-100 transition-opacity">
          <CopyButton
            label="이미지 복사"
            onCopy={() => copyPlotAsImage(plotDivRef.current?.querySelector('.js-plotly-plot') as HTMLElement | null)}
          />
        </div>
        <div ref={plotDivRef} style={{ width: natW, height: natH, maxWidth: '100%' }}>
          <Plot
            data={(pj.data ?? []) as Plotly.Data[]}
            layout={{
              ...baseLayout,
              template: (isDark ? 'plotly_dark' : 'plotly_white') as unknown as Plotly.Template,
              autosize: true,
              width: undefined,
              height: undefined,
              margin: baseLayout.margin ?? { l: 48, r: 16, t: 40, b: 40, pad: 4 },
              paper_bgcolor: isDark ? '#1b1916' : '#ffffff',
              plot_bgcolor: isDark ? '#1b1916' : '#ffffff',
              font: { family: 'Pretendard, -apple-system, sans-serif', size: 12, color: isDark ? '#e9e6df' : '#3d3530' },
              xaxis: { ...(baseLayout.xaxis ?? {}), automargin: true },
              yaxis: { ...(baseLayout.yaxis ?? {}), automargin: true },
            }}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%', height: '100%' }}
            useResizeHandler
          />
        </div>
      </div>
    )
  }

  if (output.type === 'stdout') {
    if (!output.content?.trim()) {
      return (
        <div className="px-4 py-3 text-[12px] text-text-disabled italic bg-surface h-full">출력 없음</div>
      )
    }
    const text = output.content
    return (
      <div className="relative group/output h-full overflow-auto bg-surface">
        <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/output:opacity-100 focus-within:opacity-100 transition-opacity">
          <CopyButton label="텍스트 복사" onCopy={() => copyTextRobust(text)} />
        </div>
        <pre className="px-4 py-3 text-[12px] text-text-primary font-mono whitespace-pre-wrap leading-relaxed">
          {text}
        </pre>
      </div>
    )
  }

  if (output.type === 'error') {
    const msg = output.message ?? ''
    return (
      <div className="relative group/output h-full overflow-auto">
        <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/output:opacity-100 focus-within:opacity-100 transition-opacity">
          <CopyButton label="오류 복사" onCopy={() => copyTextRobust(msg)} />
        </div>
        <pre className="bg-danger-bg px-4 py-3 text-[12px] text-danger font-mono whitespace-pre-wrap leading-relaxed h-full">
          {msg}
        </pre>
      </div>
    )
  }

  return null
}

function TableOutput({
  cellId,
  cols,
  rows,
  rowCount,
}: {
  cellId: string
  cols: { name: string }[]
  rows: unknown[][]
  rowCount: number
}) {
  const notebookId = useAppStore((s) => s.notebookId)
  const truncated = rowCount > rows.length
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const headerRowRef = useRef<HTMLTableRowElement | null>(null)
  const [frozenCount, setFrozenCount] = useState(1)
  const [widths, setWidths] = useState<number[]>([])
  const [scrollLeft, setScrollLeft] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [dragX, setDragX] = useState<number | null>(null)
  // 사용자가 직접 드래그해서 설정한 열 너비 (null = 자동)
  const [userWidths, setUserWidths] = useState<(number | null)[]>([])
  const [colResize, setColResize] = useState<
    { index: number; startX: number; startWidth: number } | null
  >(null)

  useEffect(() => {
    // 컬럼 수가 바뀌면 userWidths 배열 크기를 맞춘다
    setUserWidths((prev) => {
      if (prev.length === cols.length) return prev
      const next = cols.map((_, i) => prev[i] ?? null)
      return next
    })
  }, [cols.length])

  useLayoutEffect(() => {
    const measure = () => {
      const row = headerRowRef.current
      if (!row) return
      const ths = Array.from(row.children) as HTMLElement[]
      setWidths(ths.map((th) => th.getBoundingClientRect().width))
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (scrollRef.current) ro.observe(scrollRef.current)
    if (headerRowRef.current) ro.observe(headerRowRef.current)
    return () => ro.disconnect()
  }, [cols, rows])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setScrollLeft(el.scrollLeft)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const leftOffsets = useMemo(() => {
    const out: number[] = [0]
    for (let i = 0; i < widths.length; i++) out.push(out[i] + widths[i])
    return out
  }, [widths])

  const frozenWidth = leftOffsets[Math.min(frozenCount, widths.length)] ?? 0

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const el = scrollRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const x = Math.max(0, e.clientX - rect.left + el.scrollLeft)
      setDragX(x)
    }
    const onUp = () => {
      setDragging(false)
      setDragX((cur) => {
        if (cur == null) return null
        let best = 0
        let bestDist = Infinity
        for (let i = 0; i <= widths.length; i++) {
          const d = Math.abs(leftOffsets[i] - cur)
          if (d < bestDist) {
            bestDist = d
            best = i
          }
        }
        setFrozenCount(best)
        return null
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, leftOffsets, widths.length])

  const canDrag = cols.length > 0 && widths.length === cols.length

  // 열 너비 리사이즈 드래그
  useEffect(() => {
    if (!colResize) return
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - colResize.startX
      const next = Math.max(48, Math.round(colResize.startWidth + delta))
      setUserWidths((prev) => {
        const out = prev.slice()
        out[colResize.index] = next
        return out
      })
    }
    const onUp = () => setColResize(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [colResize])

  // colgroup 에 적용할 열별 너비 — 사용자가 지정했으면 그 값, 아니면 측정값
  const effectiveWidths = useMemo(
    () => cols.map((_, i) => userWidths[i] ?? widths[i] ?? undefined),
    [cols, userWidths, widths]
  )
  const widthsReady = widths.length === cols.length

  return (
    <div className="relative overflow-hidden group/output flex flex-col h-full">
      <div className="absolute top-1.5 right-1.5 z-30 opacity-0 group-hover/output:opacity-100 focus-within:opacity-100 transition-opacity flex flex-col items-end gap-1">
        <CopyButton
          label={truncated ? `${rows.length}행 복사` : '표 복사'}
          onCopy={() => copyTextRobust(tableToTSV(cols, rows))}
        />
        {truncated && (
          <CopyButton
            label={`모든 ${rowCount.toLocaleString()}행 복사`}
            onCopy={async () => {
              if (!notebookId) {
                toast.error('전체 행 복사 실패', '노트북 정보가 없습니다.')
                throw new Error('notebook 없음')
              }
              try {
                const full = await exportFullTable(notebookId, cellId)
                await copyTextRobust(tableToTSV(full.columns, full.rows))
                toast.success(`${full.rowCount.toLocaleString()}행 복사 완료`)
              } catch (err) {
                if (err instanceof ApiError) {
                  toast.error('전체 행 복사 실패', err.detail)
                } else {
                  const msg = err instanceof Error ? err.message : String(err)
                  toast.error('전체 행 복사 실패', msg)
                }
                throw err
              }
            }}
          />
        )}
      </div>
      <div
        ref={scrollRef}
        className={cn(
          'overflow-x-auto overflow-y-auto hide-scrollbar flex-1 min-h-0 relative',
          dragging && 'select-none'
        )}
      >
        <table
          className="w-full text-[12px] border-separate border-spacing-0"
          style={widthsReady ? { tableLayout: 'fixed' } : undefined}
        >
          {widthsReady && (
            <colgroup>
              {cols.map((col, i) => (
                <col
                  key={col.name}
                  style={effectiveWidths[i] != null ? { width: effectiveWidths[i] } : undefined}
                />
              ))}
            </colgroup>
          )}
          <thead>
            <tr ref={headerRowRef}>
              {cols.map((col, i) => {
                const frozen = i < frozenCount
                const isBoundary = frozen && i === frozenCount - 1
                return (
                  <th
                    key={col.name}
                    style={frozen ? { left: leftOffsets[i] } : undefined}
                    className={cn(
                      'relative text-left py-2 font-semibold text-text-secondary border-b border-border-subtle bg-chip sticky top-0 break-keep whitespace-normal',
                      i === 0 ? 'pl-5 pr-4' : i === cols.length - 1 ? 'pl-4 pr-5' : 'px-4',
                      frozen ? 'sticky z-20' : 'z-10',
                      isBoundary && 'border-r border-border-subtle'
                    )}
                  >
                    {col.name}
                    {widthsReady && (
                      <span
                        role="separator"
                        aria-label="열 너비 조절"
                        title="드래그하여 열 너비 조절"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          const current = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width
                          setColResize({ index: i, startX: e.clientX, startWidth: current })
                        }}
                        className="absolute top-0 right-0 h-full w-[6px] cursor-col-resize z-30 group/colresize select-none"
                      >
                        <span className="absolute inset-y-1 right-[2px] w-[2px] rounded-full transition-colors bg-transparent group-hover/colresize:bg-primary/60" />
                      </span>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="group/row">
                {row.map((c, ci) => {
                  const frozen = ci < frozenCount
                  const isBoundary = frozen && ci === frozenCount - 1
                  return (
                    <td
                      key={ci}
                      style={frozen ? { left: leftOffsets[ci] } : undefined}
                      className={cn(
                        'py-1.5 text-text-primary border-b border-border-subtle group-last/row:border-0 transition-colors break-keep whitespace-normal',
                        ci === 0 ? 'pl-5 pr-4' : ci === row.length - 1 ? 'pl-4 pr-5' : 'px-4',
                        frozen
                          ? 'sticky z-10 bg-bg-pane group-hover/row:bg-chip'
                          : 'group-hover/row:bg-chip/60',
                        isBoundary && 'border-r border-border-subtle',
                        typeof c === 'number' ? 'text-right tabular-nums' : ''
                      )}
                    >
                      {typeof c === 'number' ? formatNumber(c) : String(c ?? '')}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {canDrag && (
          <div
            role="separator"
            aria-label="고정 열 경계 드래그"
            title="드래그하여 고정 열 변경"
            onMouseDown={(e) => {
              e.preventDefault()
              const el = scrollRef.current
              if (!el) return
              const rect = el.getBoundingClientRect()
              setDragX(e.clientX - rect.left + el.scrollLeft)
              setDragging(true)
            }}
            className={cn(
              'absolute top-0 bottom-0 w-[9px] cursor-col-resize z-30 group/bar',
              dragging && 'pointer-events-none'
            )}
            style={{ left: Math.max(0, frozenWidth + scrollLeft - 4) }}
          >
            <div
              className={cn(
                'absolute inset-y-0 left-1/2 -translate-x-1/2 w-[2px] transition-colors',
                frozenCount === 0
                  ? 'bg-transparent group-hover/bar:bg-primary/60'
                  : 'bg-border-subtle group-hover/bar:bg-primary'
              )}
            />
          </div>
        )}

        {dragging && dragX != null && (
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-primary z-40 pointer-events-none"
            style={{ left: dragX }}
          />
        )}
      </div>
      <div className="sticky bottom-0 bg-chip border-t border-border-subtle px-4 py-1.5 text-[11px] text-text-disabled flex items-center gap-2">
        <span>{rowCount.toLocaleString()} rows × {cols.length} columns</span>
        {truncated && (
          <span className="text-warning-text">
            · {rows.length.toLocaleString()}행만 표시 중
          </span>
        )}
        {rowCount > 100_000 && (
          <span
            className="text-danger"
            title="대용량 데이터 — 집계/필터로 범위를 줄이거나 df.to_csv() 로 파일 저장을 권장합니다"
          >
            · 대용량 ({rowCount.toLocaleString()}행) — 집계/필터 권장
          </span>
        )}
      </div>
    </div>
  )
}

const PLAN_MARKER_RE = /<!--\s*vibe:analysis_plan\s*-->\s*/g

function MarkdownOutput({ content }: { content: string }) {
  const cleaned = content.replace(PLAN_MARKER_RE, '')
  if (!cleaned.trim()) {
    return (
      <div className="text-[12px] text-text-disabled italic">내용을 입력하세요</div>
    )
  }
  return (
    <div className="relative group/output h-full overflow-y-auto overflow-x-hidden">
      <div className="absolute top-1.5 right-1.5 z-10 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <CopyButton label="마크다운 복사" onCopy={() => navigator.clipboard.writeText(cleaned)} />
      </div>
      <div className="pl-7 pr-9 py-4 break-words min-w-0">
        <Markdown content={cleaned} />
      </div>
    </div>
  )
}

// memo: 부모(CellContainer)가 다른 이유로 리렌더링되어도
// cell prop 의 ref 가 같으면 출력 영역(테이블/차트/마크다운) 리렌더를 건너뛴다.
export default memo(CellOutput)
