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
  setSfAccount: (v: string) => void
  setSfUser: (v: string) => void
  setSfAuthenticator: (v: string) => void
  setSfRole: (v: string) => void
  setSfWarehouse: (v: string) => void
  setSfDatabase: (v: string) => void
  setSfSchema: (v: string) => void
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
      setSfAccount: (v) => set({ sfAccount: v }),
      setSfUser: (v) => set({ sfUser: v }),
      setSfAuthenticator: (v) => set({ sfAuthenticator: v }),
      setSfRole: (v) => set({ sfRole: v }),
      setSfWarehouse: (v) => set({ sfWarehouse: v }),
      setSfDatabase: (v) => set({ sfDatabase: v }),
      setSfSchema: (v) => set({ sfSchema: v }),
    }),
    { name: 'vibe-eda-connection' }
  )
)
