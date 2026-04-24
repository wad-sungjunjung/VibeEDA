import { useState } from 'react'
import { X, CheckCircle2, AlertTriangle, AlertCircle, Info, Copy, ChevronDown, ChevronRight } from 'lucide-react'
import { useToastStore, type ToastItem } from '@/store/useToastStore'
import { cn } from '@/lib/utils'

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
} as const

const KIND_STYLES = {
  success: 'bg-surface border-success/40 text-text-primary',
  error: 'bg-surface border-danger/50 text-text-primary',
  warning: 'bg-surface border-warning/50 text-text-primary',
  info: 'bg-surface border-border text-text-primary',
} as const

const ICON_COLORS = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning-text',
  info: 'text-text-secondary',
} as const

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss)
  const [expanded, setExpanded] = useState(false)
  const Icon = ICONS[item.kind]
  const hasDetail = !!item.detail && item.detail !== item.title

  return (
    <div
      className={cn(
        'w-[340px] max-w-[92vw] rounded-lg border shadow-xl backdrop-blur-sm overflow-hidden animate-in slide-in-from-right fade-in duration-200',
        KIND_STYLES[item.kind]
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <Icon size={16} strokeWidth={2} className={cn('shrink-0 mt-[1px]', ICON_COLORS[item.kind])} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold leading-tight break-keep">{item.title}</div>
          {hasDetail && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="mt-1 flex items-center gap-0.5 text-[11px] text-text-tertiary hover:text-text-secondary"
            >
              <ChevronRight size={10} /> 자세히
            </button>
          )}
          {hasDetail && expanded && (
            <div className="mt-1.5">
              <button
                onClick={() => setExpanded(false)}
                className="flex items-center gap-0.5 text-[11px] text-text-tertiary hover:text-text-secondary mb-1"
              >
                <ChevronDown size={10} /> 접기
              </button>
              <div className="text-[11px] text-text-secondary whitespace-pre-wrap break-words bg-bg-page rounded px-2 py-1.5 font-mono leading-relaxed max-h-48 overflow-y-auto">
                {item.detail}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(item.detail ?? '').catch(() => {})}
                className="mt-1 flex items-center gap-1 text-[10px] text-text-tertiary hover:text-primary"
                title="에러 본문 복사"
              >
                <Copy size={9} /> 복사
              </button>
            </div>
          )}
        </div>
        <button
          onClick={() => dismiss(item.id)}
          className="shrink-0 p-1 -mr-1 -mt-1 rounded text-text-tertiary hover:text-text-primary hover:bg-chip"
          title="닫기"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastCard item={t} />
        </div>
      ))}
    </div>
  )
}
