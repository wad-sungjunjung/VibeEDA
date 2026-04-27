import { useEffect, useState } from 'react'
import { WifiOff, X, Loader2 } from 'lucide-react'
import { useConnectionStore } from '@/store/connectionStore'
import { useAppStore } from '@/store/useAppStore'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:4750/v1'

type Phase = 'checking' | 'retrying' | 'connected' | 'disconnected' | 'dismissed'

export default function SnowflakeConnectionGuard() {
  const creds = useConnectionStore()
  const setIsConnected = useConnectionStore((s) => s.setIsConnected)
  const refreshMarts = useAppStore((s) => s.refreshMarts)
  const [phase, setPhase] = useState<Phase>('checking')

  useEffect(() => {
    let cancelled = false

    async function checkAndMaybeReconnect(isInitial: boolean) {
      // 현재 연결 상태 확인
      let connected = false
      try {
        const r = await fetch(`${API_BASE}/snowflake/status`)
        const d = await r.json()
        connected = !!d.connected
      } catch {
        if (!cancelled) { setPhase('disconnected'); setIsConnected(false) }
        return
      }
      if (cancelled) return
      if (connected) { setPhase('connected'); setIsConnected(true); return }

      // 초기 기동 시에만 자격 증명으로 자동 재접속 시도
      if (!isInitial) { setPhase('disconnected'); setIsConnected(false); return }

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
            login_timeout: 15,
          }),
        })
        const data = await r.json()
        if (cancelled) return
        if (data.ok) {
          setPhase('connected')
          setIsConnected(true)
          refreshMarts()
        } else {
          setPhase('disconnected')
          setIsConnected(false)
        }
      } catch {
        if (!cancelled) { setPhase('disconnected'); setIsConnected(false) }
      }
    }

    checkAndMaybeReconnect(true)

    // 2분마다 연결 상태 재동기화 (세션 만료 등 감지)
    const interval = setInterval(() => {
      if (!cancelled) checkAndMaybeReconnect(false)
    }, 2 * 60 * 1000)

    return () => { cancelled = true; clearInterval(interval) }
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
