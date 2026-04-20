import { FileText, X, Copy, Check, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'

export default function ReportResult() {
  const { showReport, reportContent, generatingReport, setShowReport } = useAppStore()
  const [copied, setCopied] = useState(false)

  if (generatingReport) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
        <div className="bg-white rounded-xl shadow-2xl px-8 py-6 flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center animate-pulse">
            <Sparkles size={24} className="text-white" />
          </div>
          <div className="text-sm font-semibold text-text-primary">리포팅 작성 중...</div>
        </div>
      </div>
    )
  }

  if (!showReport) return null

  async function handleCopy() {
    await navigator.clipboard.writeText(reportContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl h-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border-subtle">
          <FileText size={16} className="text-primary" />
          <div className="flex-1 text-[14px] font-semibold text-text-primary">
            리포팅 초안 (Markdown)
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] bg-bg-sidebar hover:bg-border rounded-lg transition-colors"
          >
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            {copied ? '복사됨' : '복사'}
          </button>
          <button
            onClick={() => setShowReport(false)}
            className="p-1 text-text-tertiary hover:text-text-secondary ml-1"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 bg-bg-output">
          <pre className="text-[12px] font-mono text-text-primary whitespace-pre-wrap bg-white p-5 rounded-lg border border-border">
            {reportContent}
          </pre>
        </div>
      </div>
    </div>
  )
}
