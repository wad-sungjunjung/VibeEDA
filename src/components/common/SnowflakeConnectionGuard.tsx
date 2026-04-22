import { useEffect, useState } from 'react'
import { WifiOff, X, Loader2 } from 'lucide-react'
import { useConnectionStore } from '@/store/connectionStore'
import { useAppStore } from '@/store/useAppStore'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:4750/v1'

type Phase = 'checking' | 'retrying' | 'connected' | 'disconnected' | 'dismissed'

export default function SnowflakeConnectionGuard() {
  const creds = useConnectionStore()
  const refreshMarts = useAppStore((s) => s.refreshMarts)
  const [phase, setPhase] = useState<Phase>('checking')

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      // 1차: 현재 연결 상태 확인
      let connected = false
      try {
        const r = await fetch(`${API_BASE}/snowflake/status`)
        const d = await r.json()
        connected = !!d.connected
      } catch {
        // 백엔드 미기동 — 무시
        if (!cancelled) setPhase('disconnected')
        return
      }
      if (cancelled) return
      if (connected) { setPhase('connected'); return }

      // 2차: 저장된 자격 증명이 있으면 자동 재접속 1회 시도
      const hasCreds = creds.sfAccount.trim() && creds.sfUser.trim()
      if (!hasCreds) { setPhase('disconnected'); return }

      setPhase('retrying')
      try {
        const r = await fetch(`${API_BASE}/snowflake/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account: creds.sfAccount,
            user: creds.sfUser,
            authenticator: creds.sfAuthenticator,
            role: creds.sfRole,
            warehouse: creds.sfWarehouse,
            database: creds.sfDatabase,
            schema: creds.sfSchema,
            // 조용한 재접속이 목표 — 캐시된 SSO 토큰이 없거나 만료면 빠르게 실패시킴
            login_timeout: 15,
          }),
        })
        const data = await r.json()
        if (cancelled) return
        if (data.ok) {
          setPhase('connected')
          refreshMarts()
        } else {
          setPhase('disconnected')
        }
      } catch {
        if (!cancelled) setPhase('disconnected')
      }
    })()

    return () => { cancelled = true }
  }, [])

  if (phase === 'connected' || phase === 'dismissed' || phase === 'checking') return null

  const isRetrying = phase === 'retrying'

  return (
    <div className="fixed top-4 right-4 z-[200] animate-fade-in">
      <div
        role="alert"
        className="flex items-start gap-2.5 bg-surface border border-danger/30 rounded-xl shadow-lg px-4 py-3 w-[300px]"
        style={{ boxShadow: '0 6px 24px rgba(0,0,0,0.10)' }}
      >
        <div className="shrink-0 mt-0.5">
          {isRetrying
            ? <Loader2 size={16} className="animate-spin text-warning" />
            : <WifiOff size={16} className="text-danger" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-primary">
            {isRetrying ? 'Snowflake 재연결 중...' : 'Snowflake 연결 안됨'}
          </div>
          {!isRetrying && (
            <div className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">
              SQL 셀을 실행하려면 연결이 필요해요.{' '}
              <button
                className="text-primary font-medium hover:underline"
                onClick={() => window.dispatchEvent(new CustomEvent('vibe:open-connection'))}
              >
                연결 관리 열기
              </button>
            </div>
          )}
        </div>
        {!isRetrying && (
          <button
            title="닫기"
            onClick={() => setPhase('dismissed')}
            className="shrink-0 p-0.5 -mt-0.5 text-text-tertiary hover:text-text-primary rounded transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
