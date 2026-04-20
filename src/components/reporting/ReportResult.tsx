import { FileText, X, Copy, Check, Sparkles, Download, AlertTriangle, Loader2, CheckCircle2, Circle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import Markdown from '@/components/common/Markdown'
import { API_BASE_URL } from '@/lib/api'

const STAGE_ORDER = [
  { key: 'collecting', label: '셀 데이터 수집' },
  { key: 'writing', label: '리포트 작성' },
  { key: 'finalizing', label: '차트 삽입·저장' },
] as const

export default function ReportResult() {
  const {
    showReport,
    reportContent,
    reportTitle,
    reportError,
    generatingReport,
    currentReportId,
    reportStages,
    reportStartedAt,
    setShowReport,
  } = useAppStore()
  const [copied, setCopied] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  // 경과 타이머 — 생성 중일 때만 갱신
  useEffect(() => {
    if (!generatingReport || !reportStartedAt) {
      if (reportStartedAt) setElapsed(Date.now() - reportStartedAt)
      return
    }
    setElapsed(Date.now() - reportStartedAt)
    const id = setInterval(() => setElapsed(Date.now() - reportStartedAt), 100)
    return () => clearInterval(id)
  }, [generatingReport, reportStartedAt])

  // 상대 경로(./{id}_images/xxx.png) 를 백엔드 자산 URL로 치환해 화면에서 이미지가 보이도록 함.
  // 다운로드용 원본(reportContent)은 그대로 유지. hook은 early-return 이전에 호출해야 함.
  const displayContent = useMemo(() => {
    if (!currentReportId) return reportContent
    const pattern = new RegExp(
      `\\./${currentReportId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_images/`,
      'g',
    )
    return reportContent.replace(pattern, `${API_BASE_URL}/reports/${currentReportId}/assets/`)
  }, [reportContent, currentReportId])

  if (!showReport) return null

  async function handleCopy() {
    await navigator.clipboard.writeText(reportContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleDownload() {
    const safeTitle = (reportTitle || 'report').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    const blob = new Blob([reportContent], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentReportId || safeTitle}.md`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // 단계별 상태 계산: "collected" 는 collecting 완료 신호로 취급
  const stageSet = new Set(reportStages.map((s) => s.stage))
  const hasComplete = !generatingReport && !!currentReportId
  function stageStatus(key: typeof STAGE_ORDER[number]['key']): 'done' | 'active' | 'pending' {
    if (hasComplete) return 'done'
    if (key === 'collecting') {
      if (stageSet.has('collected') || stageSet.has('writing') || stageSet.has('finalizing')) return 'done'
      if (stageSet.has('collecting')) return 'active'
      return 'pending'
    }
    if (key === 'writing') {
      if (stageSet.has('finalizing')) return 'done'
      if (stageSet.has('writing')) return 'active'
      return 'pending'
    }
    // finalizing
    if (stageSet.has('finalizing')) return hasComplete ? 'done' : 'active'
    return 'pending'
  }

  const elapsedSec = (elapsed / 1000).toFixed(1)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl h-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border-subtle">
          <FileText size={16} className="text-primary" />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold text-text-primary truncate">
              {reportTitle || '리포트'}
            </div>
            {currentReportId && (
              <div className="text-[10px] text-text-tertiary truncate">{currentReportId}.md</div>
            )}
          </div>
          {(generatingReport || reportStartedAt) && (
            <span className="flex items-center gap-1 text-[11px] font-mono shrink-0" style={{ color: generatingReport ? '#c94a2e' : '#6b7280' }}>
              {generatingReport && <Loader2 size={12} className="animate-spin" />}
              {elapsedSec}s
            </span>
          )}
          <button
            onClick={handleCopy}
            disabled={!reportContent}
            title="Markdown 복사"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] bg-bg-sidebar hover:bg-border rounded-lg transition-colors disabled:opacity-50"
          >
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            {copied ? '복사됨' : '복사'}
          </button>
          <button
            onClick={handleDownload}
            disabled={!reportContent}
            title=".md 파일로 다운로드"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] bg-bg-sidebar hover:bg-border rounded-lg transition-colors disabled:opacity-50"
          >
            <Download size={13} /> 다운로드
          </button>
          <button
            onClick={() => setShowReport(false)}
            className="p-1 text-text-tertiary hover:text-text-secondary ml-1"
          >
            <X size={16} />
          </button>
        </div>

        {/* Stage tracker */}
        {(generatingReport || reportStages.length > 0) && (
          <div className="px-5 py-3 border-b border-border-subtle bg-[#faf8f2]">
            <div className="flex items-center gap-3">
              {STAGE_ORDER.map((s, i) => {
                const status = stageStatus(s.key)
                const stageInfo = reportStages.find((x) =>
                  x.stage === s.key || (s.key === 'collecting' && x.stage === 'collected'),
                )
                const label = stageInfo?.label || s.label
                return (
                  <div key={s.key} className="flex items-center gap-2 min-w-0">
                    {status === 'done' && <CheckCircle2 size={14} className="text-success shrink-0" />}
                    {status === 'active' && <Loader2 size={14} className="animate-spin shrink-0" style={{ color: '#c94a2e' }} />}
                    {status === 'pending' && <Circle size={14} className="text-text-disabled shrink-0" />}
                    <span
                      className={
                        status === 'done'
                          ? 'text-[11px] text-text-secondary'
                          : status === 'active'
                            ? 'text-[11px] font-semibold text-text-primary'
                            : 'text-[11px] text-text-disabled'
                      }
                    >
                      {label}
                    </span>
                    {i < STAGE_ORDER.length - 1 && (
                      <div className="w-4 h-px bg-border-subtle shrink-0" />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Error */}
        {reportError && (
          <div className="px-5 py-3 text-[12px] flex items-start gap-2" style={{ backgroundColor: '#fff1f0', color: '#8a1c1c' }}>
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{reportError}</span>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 bg-bg-output">
          <div className="bg-white p-6 rounded-lg border border-border">
            {reportContent ? (
              <Markdown content={displayContent} />
            ) : generatingReport ? (
              <div className="flex items-center gap-2 text-text-tertiary text-[12px]">
                <Sparkles size={14} className="text-primary animate-pulse" />
                리포트 내용을 작성하는 중입니다…
              </div>
            ) : (
              <div className="text-text-tertiary text-[12px]">내용이 없습니다.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
