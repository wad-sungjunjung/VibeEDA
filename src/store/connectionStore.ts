import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ConnectionStore {
  sfAccount: string
  sfUser: string
  sfAuthenticator: string
  sfRole: string
  sfWarehouse: string
  sfDatabase: string
  sfSchema: string
  // 실제 백엔드 연결 상태 — 영속화하지 않음 (런타임 상태)
  isConnected: boolean
  setSfAccount: (v: string) => void
  setSfUser: (v: string) => void
  setSfAuthenticator: (v: string) => void
  setSfRole: (v: string) => void
  setSfWarehouse: (v: string) => void
  setSfDatabase: (v: string) => void
  setSfSchema: (v: string) => void
  setIsConnected: (v: boolean) => void
}

export const useConnectionStore = create<ConnectionStore>()(
  persist(
    (set) => ({
      sfAccount: '',
      sfUser: '',
      sfAuthenticator: 'externalbrowser',
      sfRole: '',
      sfWarehouse: 'DATA_ANALYSIS_WH',
      sfDatabase: 'WAD_DW_PROD',
      sfSchema: 'MART',
      isConnected: false,
      setSfAccount: (v) => set({ sfAccount: v }),
      setSfUser: (v) => set({ sfUser: v }),
      setSfAuthenticator: (v) => set({ sfAuthenticator: v }),
      setSfRole: (v) => set({ sfRole: v }),
      setSfWarehouse: (v) => set({ sfWarehouse: v }),
      setSfDatabase: (v) => set({ sfDatabase: v }),
      setSfSchema: (v) => set({ sfSchema: v }),
      setIsConnected: (v) => set({ isConnected: v }),
    }),
    {
      name: 'vibe-eda-connection',
      // isConnected 는 런타임 상태 — 영속화 제외 (재시작 시 재검증)
      partialize: (s) => ({
        sfAccount: s.sfAccount,
        sfUser: s.sfUser,
        sfAuthenticator: s.sfAuthenticator,
        sfRole: s.sfRole,
        sfWarehouse: s.sfWarehouse,
        sfDatabase: s.sfDatabase,
        sfSchema: s.sfSchema,
      }),
    }
  )
)
