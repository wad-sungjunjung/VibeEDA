import { FileText, X, Copy, Check, Sparkles, Download, AlertTriangle, Loader2, CheckCircle2, Circle, Save } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import Markdown from '@/components/common/Markdown'
import { API_BASE_URL } from '@/lib/api'
import { cn } from '@/lib/utils'

const STAGE_ORDER = [
  { key: 'collecting', label: '셀 데이터 수집' },
  { key: 'outlining', label: '개요 설계' },
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
    reportProcessingNotes,
    reportIsDraft,
    reportSaving,
    saveCurrentReport,
    closeCurrentReport,
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
    // 신규 구조: ![alt](./xxx.png) — 리포트 폴더 내부 상대 경로
    const newPattern = /\]\(\.\/([A-Za-z0-9_\-]+\.png)\)/g
    let rewritten = reportContent.replace(
      newPattern,
      `](${API_BASE_URL}/reports/${currentReportId}/assets/$1)`,
    )
    // 레거시 구조: ![alt](./{id}_images/xxx.png)
    const legacyPattern = new RegExp(
      `\\./${currentReportId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_images/`,
      'g',
    )
    rewritten = rewritten.replace(
      legacyPattern,
      `${API_BASE_URL}/reports/${currentReportId}/assets/`,
    )
    return rewritten
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
      if (stageSet.has('collected') || stageSet.has('outlining') || stageSet.has('outlined') || stageSet.has('writing') || stageSet.has('finalizing')) return 'done'
      if (stageSet.has('collecting')) return 'active'
      return 'pending'
    }
    if (key === 'outlining') {
      if (stageSet.has('outlined') || stageSet.has('writing') || stageSet.has('finalizing')) return 'done'
      if (stageSet.has('outlining')) return 'active'
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
      <div className="bg-surface rounded-xl shadow-2xl w-full max-w-3xl h-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border-subtle">
          <FileText size={16} className="text-primary" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="text-[14px] font-semibold text-text-primary truncate">
                {reportTitle || '리포트'}
              </div>
              {reportIsDraft && !generatingReport && (
                <span
                  className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warning-bg text-warning-text"
                  title="저장하지 않은 임시 리포트입니다. 저장하지 않고 닫으면 삭제됩니다."
                >
                  임시
                </span>
              )}
            </div>
            {currentReportId && (
              <div className="text-[10px] text-text-tertiary truncate">{currentReportId}.md</div>
            )}
          </div>
          {(generatingReport || reportStartedAt) && (
            <span className={cn('flex items-center gap-1 text-[11px] font-mono shrink-0', generatingReport ? 'text-primary-hover' : 'text-text-tertiary')}>
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
            onClick={() => { void saveCurrentReport() }}
            disabled={!reportContent || !reportIsDraft || reportSaving || generatingReport}
            title={reportIsDraft ? '~/vibe-notebooks/reports/ 에 영구 저장' : '이미 저장된 리포트입니다'}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold rounded-lg transition-colors disabled:opacity-50',
              !reportContent || !reportIsDraft || reportSaving || generatingReport
                ? 'bg-bg-sidebar text-text-disabled'
                : 'bg-primary text-white hover:bg-primary-hover'
            )}
          >
            {reportSaving
              ? <Loader2 size={13} className="animate-spin" />
              : <Save size={13} />}
            {reportIsDraft ? '저장하기' : '저장됨'}
          </button>
          <button
            onClick={() => { void closeCurrentReport() }}
            className="p-1 text-text-tertiary hover:text-text-secondary ml-1"
            title={reportIsDraft ? '닫기 (저장하지 않으면 임시 리포트는 삭제됩니다)' : '닫기'}
          >
            <X size={16} />
          </button>
        </div>

        {/* Stage tracker */}
        {(generatingReport || reportStages.length > 0) && (
          <div className="px-5 py-3 border-b border-border-subtle bg-bg-output">
            <div className="flex items-center gap-3">
              {STAGE_ORDER.map((s, i) => {
                const status = stageStatus(s.key)
                const stageInfo = reportStages.find((x) =>
                  x.stage === s.key
                    || (s.key === 'collecting' && x.stage === 'collected')
                    || (s.key === 'outlining' && x.stage === 'outlined'),
                )
                const label = stageInfo?.label || s.label
                return (
                  <div key={s.key} className="flex items-center gap-2 min-w-0">
                    {status === 'done' && <CheckCircle2 size={14} className="text-success shrink-0" />}
                    {status === 'active' && <Loader2 size={14} className="animate-spin shrink-0 text-primary-hover" />}
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

        {/* Quality banner (processing notes) */}
        {reportProcessingNotes && (
          (reportProcessingNotes.missing_charts.length > 0
            || reportProcessingNotes.unreferenced_charts.length > 0
            || reportProcessingNotes.suspicious_number_count > 0) && (
            <div className="px-5 py-2 text-[11px] border-b border-border-subtle bg-warning-bg text-warning-text">
              <div className="flex items-start gap-2">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {reportProcessingNotes.missing_charts.length > 0 && (
                    <span>차트 미삽입 {reportProcessingNotes.missing_charts.length}개: <code className="font-mono">{reportProcessingNotes.missing_charts.join(', ')}</code></span>
                  )}
                  {reportProcessingNotes.unreferenced_charts.length > 0 && (
                    <span>본문 미참조 {reportProcessingNotes.unreferenced_charts.length}개 (부록 추가됨)</span>
                  )}
                  {reportProcessingNotes.suspicious_number_count > 0 && (
                    <span title={reportProcessingNotes.suspicious_numbers.slice(0, 10).map((n) => n.raw).join(' · ')}>
                      검증 불가 수치 {reportProcessingNotes.suspicious_number_count}개 — 원문 확인 필요
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        )}

        {/* Error */}
        {reportError && (
          <div className="px-5 py-3 text-[12px] flex items-start gap-2 bg-danger-bg text-danger">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{reportError}</span>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 bg-bg-output">
          <div className="bg-surface p-6 rounded-lg border border-border">
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
