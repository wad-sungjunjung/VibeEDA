import { useRef, useState } from 'react'
import Plot from 'react-plotly.js'
import { Copy, Check } from 'lucide-react'
import type { Cell } from '@/types'
import { formatNumber } from '@/lib/utils'
import { cn } from '@/lib/utils'
import Markdown from '@/components/common/Markdown'

interface Props {
  cell: Cell
}

function CopyButton({ onCopy, label = '복사', className }: {
  onCopy: () => Promise<void> | void
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function handle() {
    try {
      await onCopy()
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.error('copy failed:', e)
    }
  }

  return (
    <button
      onClick={handle}
      title={label}
      className={cn(
        'flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-medium transition-colors shadow-sm',
        copied
          ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
          : 'bg-white/95 border-border text-text-secondary hover:border-primary hover:text-primary',
        className
      )}
    >
      {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={2} />}
      <span>{copied ? '복사됨' : label}</span>
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

export default function CellOutput({ cell }: Props) {
  const plotDivRef = useRef<HTMLDivElement | null>(null)

  if (cell.type === 'markdown') {
    return <MarkdownOutput content={cell.code} />
  }

  if (!cell.executed || !cell.output) {
    return (
      <div className="flex items-center justify-center h-full min-h-[360px] text-[12px] text-text-disabled rounded-md border border-border bg-[#ede9dd]">
        실행 전 — 버튼을 누르거나 채팅으로 요청하세요
      </div>
    )
  }

  const { output } = cell

  if (output.type === 'table' && output.columns && output.rows) {
    const cols = output.columns
    const rows = output.rows
    return (
      <div className="relative rounded-md border border-border bg-white overflow-hidden group/output flex flex-col h-full" style={{ minHeight: 180 }}>
        <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/output:opacity-100 transition-opacity">
          <CopyButton
            label="표 복사"
            onCopy={() => navigator.clipboard.writeText(tableToTSV(cols, rows))}
          />
        </div>
        <div className="overflow-x-auto overflow-y-auto hide-scrollbar flex-1 min-h-0">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-stone-100">
              <tr>
                {cols.map((col, i) => (
                  <th
                    key={col.name}
                    className={cn(
                      'text-left py-2 font-semibold text-text-secondary border-b border-border-subtle',
                      i === 0 ? 'pl-5 pr-4' : i === cols.length - 1 ? 'pl-4 pr-5' : 'px-4'
                    )}
                  >
                    {col.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="hover:bg-stone-50/60 border-b border-border-subtle last:border-0">
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={cn(
                        'py-1.5 text-text-primary',
                        ci === 0 ? 'pl-5 pr-4' : ci === row.length - 1 ? 'pl-4 pr-5' : 'px-4',
                        typeof cell === 'number' ? 'text-right tabular-nums' : ''
                      )}
                    >
                      {typeof cell === 'number' ? formatNumber(cell) : String(cell ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sticky bottom-0 bg-stone-100 border-t border-border-subtle px-4 py-1.5 text-[11px] text-text-disabled">
          {output.rowCount} rows × {cols.length} columns
        </div>
      </div>
    )
  }

  if (output.type === 'chart' && output.plotlyJson) {
    const pj = output.plotlyJson as { data?: unknown[]; layout?: Record<string, unknown> }
    const { template: _t, ...layoutRest } = (pj.layout ?? {}) as Record<string, unknown>
    const baseLayout = layoutRest as Record<string, any>
    return (
      <div className="relative rounded-md border border-border bg-white overflow-hidden group/output flex flex-col h-full" style={{ minHeight: 380 }}>
        <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/output:opacity-100 transition-opacity">
          <CopyButton
            label="이미지 복사"
            onCopy={() => copyPlotAsImage(plotDivRef.current?.querySelector('.js-plotly-plot') as HTMLElement | null)}
          />
        </div>
        <div ref={plotDivRef} className="flex-1 min-h-0">
          <Plot
            data={(pj.data ?? []) as Plotly.Data[]}
            layout={{
              ...baseLayout,
              // plotly TS 타입이 문자열 템플릿명을 직접 받지 않아 명시적 cast
              template: 'plotly_white' as unknown as Plotly.Template,
              autosize: true,
              margin: { l: 16, r: 16, t: 40, b: 16, pad: 4 },
              paper_bgcolor: '#ffffff',
              plot_bgcolor: '#ffffff',
              font: { family: 'Pretendard, -apple-system, sans-serif', size: 12, color: '#3d3530' },
              xaxis: { ...(baseLayout.xaxis ?? {}), automargin: true },
              yaxis: { ...(baseLayout.yaxis ?? {}), automargin: true },
            }}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%', height: '100%', minHeight: 380 }}
            useResizeHandler
          />
        </div>
      </div>
    )
  }

  if (output.type === 'stdout') {
    if (!output.content?.trim()) {
      return (
        <div className="px-4 py-3 text-[12px] text-text-disabled italic">출력 없음</div>
      )
    }
    const text = output.content
    return (
      <div className="relative group/output">
        <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/output:opacity-100 transition-opacity">
          <CopyButton label="텍스트 복사" onCopy={() => navigator.clipboard.writeText(text)} />
        </div>
        <pre className="px-4 py-3 text-[12px] text-text-primary font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
          {text}
        </pre>
      </div>
    )
  }

  if (output.type === 'error') {
    const msg = output.message ?? ''
    return (
      <div className="relative group/output">
        <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/output:opacity-100 transition-opacity">
          <CopyButton label="오류 복사" onCopy={() => navigator.clipboard.writeText(msg)} />
        </div>
        <pre className="rounded-md bg-danger-bg border border-danger/20 px-4 py-3 text-[12px] text-danger font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
          {msg}
        </pre>
      </div>
    )
  }

  return null
}

function MarkdownOutput({ content }: { content: string }) {
  if (!content.trim()) {
    return (
      <div className="text-[12px] text-text-disabled italic">내용을 입력하세요</div>
    )
  }
  return (
    <div className="relative group/output rounded-md border border-border bg-white px-5 py-4">
      <div className="absolute top-1.5 right-1.5 z-10 opacity-0 group-hover/output:opacity-100 transition-opacity">
        <CopyButton label="마크다운 복사" onCopy={() => navigator.clipboard.writeText(content)} />
      </div>
      <Markdown content={content} />
    </div>
  )
}
