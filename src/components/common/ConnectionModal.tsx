import { useState, useEffect } from 'react'
import {
  X, Database, CheckCircle, AlertCircle, Loader, Wifi, WifiOff, RefreshCw,
  Server, Monitor, FolderOpen, HardDrive, Circle,
} from 'lucide-react'
import { useConnectionStore } from '@/store/connectionStore'
import { useAppStore } from '@/store/useAppStore'
import { useShallow } from 'zustand/react/shallow'

interface Props {
  onClose: () => void
}

type ConnectState = 'idle' | 'connecting' | 'ok' | 'error'
type Tab = 'snowflake' | 'local'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:4750/v1'
const BACKEND_BASE = API_BASE.replace('/v1', '')
const FRONTEND_ORIGIN = window.location.origin

export default function ConnectionModal({ onClose }: Props) {
  const store = useConnectionStore()
  const { refreshMarts, martsLoading, martCatalog } = useAppStore(
    useShallow((s) => ({
      refreshMarts: s.refreshMarts,
      martsLoading: s.martsLoading,
      martCatalog: s.martCatalog,
    }))
  )

  const [activeTab, setActiveTab] = useState<Tab>('snowflake')

  // ── Snowflake state ─────────────────────────────────────────────────────────
  const [draft, setDraft] = useState({
    sfAccount: store.sfAccount,
    sfUser: store.sfUser,
    sfAuthenticator: store.sfAuthenticator,
    sfRole: store.sfRole,
    sfWarehouse: store.sfWarehouse,
    sfDatabase: store.sfDatabase,
    sfSchema: store.sfSchema,
  })
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectMsg, setConnectMsg] = useState('')
  const isConnected = useConnectionStore((s) => s.isConnected)
  const setIsConnected = useConnectionStore((s) => s.setIsConnected)

  // ── Local env state ─────────────────────────────────────────────────────────
  type ServiceStatus = 'checking' | 'ok' | 'error'
  const [backendStatus, setBackendStatus] = useState<ServiceStatus>('checking')
  const [frontendStatus] = useState<ServiceStatus>('ok')
  const [notebooksDir, setNotebooksDir] = useState('')
  const [notebookCount, setNotebookCount] = useState<number | null>(null)
  const [backendVersion, setBackendVersion] = useState('')
  const [dirDraft, setDirDraft] = useState('')
  const [dirSaving, setDirSaving] = useState(false)
  const [dirMsg, setDirMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/snowflake/status`)
      .then((r) => r.json())
      .then((d) => setIsConnected(d.connected))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (activeTab !== 'local') return
    setBackendStatus('checking')
    Promise.all([
      fetch(`${BACKEND_BASE}/healthz`).then((r) => r.json()),
      fetch(`${API_BASE}/system/info`).then((r) => r.json()),
    ])
      .then(([, info]) => {
        setBackendStatus('ok')
        setNotebooksDir(info.notebooks_dir ?? '')
        setDirDraft(info.notebooks_dir ?? '')
        setNotebookCount(info.notebook_count ?? 0)
        setBackendVersion(info.backend_version ?? '')
      })
      .catch(() => setBackendStatus('error'))
  }, [activeTab])

  function fieldProps(key: keyof typeof draft) {
    return {
      value: draft[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value })),
    }
  }

  function saveToStore() {
    store.setSfAccount(draft.sfAccount)
    store.setSfUser(draft.sfUser)
    store.setSfAuthenticator(draft.sfAuthenticator)
    store.setSfRole(draft.sfRole)
    store.setSfWarehouse(draft.sfWarehouse)
    store.setSfDatabase(draft.sfDatabase)
    store.setSfSchema(draft.sfSchema)
  }

  async function handleSaveDir() {
    if (!dirDraft.trim() || dirDraft.trim() === notebooksDir) return
    setDirSaving(true)
    setDirMsg(null)
    try {
      const res = await fetch(`${API_BASE}/system/notebooks-dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirDraft.trim() }),
      })
      const data = await res.json()
      if (res.ok) {
        setNotebooksDir(data.notebooks_dir)
        setDirDraft(data.notebooks_dir)
        setNotebookCount(data.notebook_count)
        setDirMsg({ ok: true, text: '저장 경로가 변경됐습니다.' })
      } else {
        setDirMsg({ ok: false, text: data.detail ?? '변경 실패' })
      }
    } catch (e) {
      setDirMsg({ ok: false, text: String(e) })
    } finally {
      setDirSaving(false)
    }
  }

  async function handleConnect() {
    if (!draft.sfAccount.trim() || !draft.sfUser.trim()) {
      setConnectState('error')
      setConnectMsg('Account Identifier와 Login Name(이메일)은 필수입니다.')
      return
    }
    saveToStore()
    setConnectState('connecting')
    setConnectMsg('브라우저에서 SSO 로그인 창이 열립니다. 로그인 후 자동으로 완료됩니다...')
    try {
      const res = await fetch(`${API_BASE}/snowflake/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: draft.sfAccount,
          user: draft.sfUser,
          authenticator: draft.sfAuthenticator,
          role: draft.sfRole,
          warehouse: draft.sfWarehouse,
          database: draft.sfDatabase,
          schema: draft.sfSchema,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setConnectState('ok')
        setConnectMsg(data.message)
        setIsConnected(true)
        refreshMarts()
      } else {
        setConnectState('error')
        setConnectMsg(data.message)
      }
    } catch (e) {
      setConnectState('error')
      setConnectMsg(String(e))
    }
  }

  async function handleDisconnect() {
    await fetch(`${API_BASE}/snowflake/connect`, { method: 'DELETE' })
    setIsConnected(false)
    setConnectState('idle')
    setConnectMsg('')
  }

  const inputClass =
    'w-full text-[12px] bg-bg-sidebar border border-border rounded-md px-3 py-2 outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 font-mono'

  // ── Status dot ──────────────────────────────────────────────────────────────
  function StatusDot({ status }: { status: ServiceStatus }) {
    if (status === 'checking') return <Loader size={12} className="animate-spin text-text-tertiary" />
    if (status === 'ok') return <Circle size={10} className="fill-success text-success" />
    return <Circle size={10} className="fill-danger text-danger" />
  }

  function StatusLabel({ status }: { status: ServiceStatus }) {
    if (status === 'checking') return <span className="text-text-tertiary">확인 중...</span>
    if (status === 'ok') return <span className="text-success font-medium">실행 중</span>
    return <span className="text-danger font-medium">연결 실패</span>
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-surface rounded-xl shadow-2xl w-[520px] max-w-[95vw] flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-primary" />
            <div>
              <div className="text-[14px] font-semibold text-text-primary">연결 관리</div>
              <div className="text-[11px] text-text-tertiary mt-0.5">데이터 소스 및 로컬 환경을 관리합니다</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeTab === 'snowflake' && (
              <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold ${
                isConnected ? 'bg-success/15 text-success' : 'bg-chip text-text-tertiary'
              }`}>
                {isConnected ? <Wifi size={11} /> : <WifiOff size={11} />}
                {isConnected ? '연결됨' : '연결 안됨'}
              </div>
            )}
            <button onClick={onClose} className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-chip rounded transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle shrink-0 px-5">
          {([['snowflake', '스노우플레이크', Database], ['local', '로컬 환경', Monitor]] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium border-b-2 transition-colors -mb-px ${
                activeTab === key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1">

          {/* ── Snowflake Tab ── */}
          {activeTab === 'snowflake' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-secondary mb-1">Account Identifier</label>
                  <input {...fieldProps('sfAccount')} placeholder="예: XXXXXXX-XXXXXXX" className={inputClass} />
                </div>
                <div>
                  <label className="block text-[11px] text-text-secondary mb-1">Authenticator</label>
                  <input {...fieldProps('sfAuthenticator')} placeholder="externalbrowser" className={inputClass} />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-text-secondary mb-1">Login Name (이메일)</label>
                <input {...fieldProps('sfUser')} placeholder="user@company.com" className={inputClass} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-secondary mb-1">Role</label>
                  <input {...fieldProps('sfRole')} placeholder="예: USERNAME__U_ROLE" className={inputClass} />
                </div>
                <div>
                  <label className="block text-[11px] text-text-secondary mb-1">Warehouse</label>
                  <input {...fieldProps('sfWarehouse')} placeholder="DATA_ANALYSIS_WH" className={inputClass} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-text-secondary mb-1">Database</label>
                  <input {...fieldProps('sfDatabase')} placeholder="WAD_DW_PROD" className={inputClass} />
                </div>
                <div>
                  <label className="block text-[11px] text-text-secondary mb-1">Schema (마트)</label>
                  <input {...fieldProps('sfSchema')} placeholder="MART" className={inputClass} />
                </div>
              </div>

              {connectState !== 'idle' && (
                <div className={`flex items-start gap-2 rounded-md px-3 py-2.5 text-[11px] ${
                  connectState === 'ok' ? 'bg-success/15 border border-success/30 text-success' :
                  connectState === 'error' ? 'bg-danger-bg border border-danger/30 text-danger' :
                  'bg-primary-light border border-primary-border text-primary-text'
                }`}>
                  {connectState === 'connecting' && <Loader size={13} className="animate-spin shrink-0 mt-0.5" />}
                  {connectState === 'ok' && <CheckCircle size={13} className="shrink-0 mt-0.5" />}
                  {connectState === 'error' && <AlertCircle size={13} className="shrink-0 mt-0.5" />}
                  <span className="break-all leading-relaxed">{connectMsg}</span>
                </div>
              )}

              {isConnected && (
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-chip border-b border-border">
                    <div className="flex items-center gap-1.5">
                      <Database size={12} className="text-primary" />
                      <span className="text-[11px] font-semibold text-text-primary">
                        마트 목록
                        {martCatalog.length > 0 && (
                          <span className="ml-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary-light text-primary">
                            {martCatalog.length}개
                          </span>
                        )}
                      </span>
                    </div>
                    <button onClick={refreshMarts} disabled={martsLoading} title="마트 목록 새로고침"
                      className="p-1 text-text-tertiary hover:text-primary rounded transition-colors disabled:opacity-40">
                      <RefreshCw size={12} className={martsLoading ? 'animate-spin' : ''} />
                    </button>
                  </div>
                  <div className="max-h-[120px] overflow-y-auto hide-scrollbar divide-y divide-border-subtle">
                    {martsLoading ? (
                      <div className="flex items-center justify-center gap-2 py-4 text-[11px] text-text-tertiary">
                        <Loader size={12} className="animate-spin" /> 마트 목록 불러오는 중...
                      </div>
                    ) : martCatalog.length === 0 ? (
                      <div className="py-4 text-center text-[11px] text-text-disabled">
                        마트가 없거나 연결 후 새로고침이 필요합니다
                      </div>
                    ) : (
                      martCatalog.map((m) => (
                        <div key={m.key} className="flex items-center gap-2 px-3 py-1.5">
                          <span className="text-[11px] font-mono text-text-primary">{m.key}</span>
                          {m.description && m.description !== m.key && (
                            <span className="text-[10px] text-text-tertiary truncate">{m.description}</span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              <div className="rounded-md bg-warning-bg border border-warning/30 px-3 py-2 text-[11px] text-warning-text">
                "연결" 클릭 시 브라우저에서 Snowflake SSO 로그인 창이 열립니다. 로그인이 완료되면 자동으로 연결됩니다.
              </div>
            </>
          )}

          {/* ── Local Tab ── */}
          {activeTab === 'local' && (
            <div className="space-y-3">

              {/* 서비스 상태 */}
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-chip border-b border-border">
                  <span className="text-[11px] font-semibold text-text-primary">서비스 상태</span>
                </div>
                <div className="divide-y divide-border-subtle">
                  {/* Backend */}
                  <div className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Server size={13} className="text-text-tertiary" />
                      <div>
                        <div className="text-[12px] font-medium text-text-primary">백엔드 서버</div>
                        <div className="text-[10px] text-text-tertiary font-mono mt-0.5">{BACKEND_BASE}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <StatusDot status={backendStatus} />
                      <StatusLabel status={backendStatus} />
                      {backendVersion && backendStatus === 'ok' && (
                        <span className="text-[10px] text-text-disabled ml-1">v{backendVersion}</span>
                      )}
                    </div>
                  </div>

                  {/* Frontend */}
                  <div className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Monitor size={13} className="text-text-tertiary" />
                      <div>
                        <div className="text-[12px] font-medium text-text-primary">프론트엔드</div>
                        <div className="text-[10px] text-text-tertiary font-mono mt-0.5">{FRONTEND_ORIGIN}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <StatusDot status={frontendStatus} />
                      <StatusLabel status={frontendStatus} />
                    </div>
                  </div>
                </div>
              </div>

              {/* 데이터 저장 위치 */}
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-chip border-b border-border">
                  <span className="text-[11px] font-semibold text-text-primary">데이터 저장 위치</span>
                </div>
                <div className="divide-y divide-border-subtle">
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2 mb-2">
                      <FolderOpen size={13} className="text-text-tertiary shrink-0" />
                      <span className="text-[12px] font-medium text-text-primary">노트북 파일</span>
                      {notebookCount !== null && (
                        <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-chip text-text-secondary">
                          {notebookCount}개
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2 items-center">
                      <input
                        className="flex-1 text-[11px] font-mono bg-bg-sidebar border border-border rounded-md px-2.5 py-1.5 outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 text-text-primary min-w-0"
                        value={dirDraft}
                        onChange={(e) => { setDirDraft(e.target.value); setDirMsg(null) }}
                        placeholder={notebooksDir || '경로 입력...'}
                        spellCheck={false}
                      />
                      <button
                        onClick={handleSaveDir}
                        disabled={dirSaving || !dirDraft.trim() || dirDraft.trim() === notebooksDir}
                        className="shrink-0 px-3 py-1.5 text-[11px] font-medium bg-primary text-white rounded-md hover:bg-primary-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {dirSaving ? <Loader size={11} className="animate-spin" /> : '변경'}
                      </button>
                    </div>
                    {dirMsg && (
                      <div className={`flex items-center gap-1 mt-1.5 text-[10px] ${dirMsg.ok ? 'text-success' : 'text-danger'}`}>
                        {dirMsg.ok ? <CheckCircle size={10} /> : <AlertCircle size={10} />}
                        {dirMsg.text}
                      </div>
                    )}
                    <div className="mt-1.5 text-[10px] text-text-disabled">
                      분석 노트북이 .ipynb 형식으로 저장됩니다. 기존 파일은 이동되지 않습니다.
                    </div>
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2 mb-1">
                      <HardDrive size={13} className="text-text-tertiary shrink-0" />
                      <span className="text-[12px] font-medium text-text-primary">브라우저 로컬 스토리지</span>
                    </div>
                    <div className="ml-5 text-[11px] text-text-secondary">
                      API 키, 모델 설정, 연결 정보
                    </div>
                    <div className="ml-5 mt-1 text-[10px] text-text-disabled">
                      브라우저를 초기화하면 설정이 삭제됩니다
                    </div>
                  </div>
                </div>
              </div>

              {/* 빠른 링크 */}
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-chip border-b border-border">
                  <span className="text-[11px] font-semibold text-text-primary">빠른 링크</span>
                </div>
                <div className="divide-y divide-border-subtle">
                  {[
                    { label: 'API 문서 (Swagger)', url: `${BACKEND_BASE}/docs` },
                    { label: 'API 문서 (ReDoc)', url: `${BACKEND_BASE}/redoc` },
                    { label: '헬스체크', url: `${BACKEND_BASE}/healthz` },
                  ].map(({ label, url }) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between px-3 py-2 text-[11px] text-primary hover:bg-chip transition-colors"
                    >
                      <span>{label}</span>
                      <span className="text-[10px] text-text-tertiary font-mono truncate max-w-[200px] ml-2">{url}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-subtle shrink-0">
          {activeTab === 'snowflake' ? (
            <>
              {isConnected ? (
                <button onClick={handleDisconnect}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-medium border border-danger/30 rounded-md text-danger hover:bg-danger-bg transition-colors">
                  <WifiOff size={12} />
                  연결 해제
                </button>
              ) : <div />}
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-chip rounded-md transition-colors">닫기</button>
                <button onClick={handleConnect} disabled={connectState === 'connecting'}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-medium bg-primary text-white rounded-md hover:bg-primary-dark transition-colors disabled:opacity-50">
                  {connectState === 'connecting'
                    ? <><Loader size={12} className="animate-spin" /> 연결 중...</>
                    : <><Database size={12} /> {isConnected ? '재연결' : '연결'}</>}
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex justify-end">
              <button onClick={onClose} className="px-4 py-1.5 text-[12px] text-text-secondary hover:text-text-primary hover:bg-chip rounded-md transition-colors">닫기</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
