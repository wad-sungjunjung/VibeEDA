import { RotateCcw } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'

export default function RollbackToast() {
  const toast = useAppStore((s) => s.rollbackToast)

  if (!toast) return null

  return (
    <div className="fixed top-24 right-72 z-50 flex items-center gap-2 bg-primary text-white px-4 py-2.5 rounded-xl shadow-lg animate-in slide-in-from-right">
      <RotateCcw size={14} strokeWidth={2.5} />
      <div>
        <div className="text-[12px] font-semibold">{toast.cellName} 롤백 완료</div>
        <div className="text-[11px] opacity-80">{toast.timestamp} 시점의 코드로 복원했어요</div>
      </div>
    </div>
  )
}
