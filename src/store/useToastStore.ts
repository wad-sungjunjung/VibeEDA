import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: string
  kind: ToastKind
  title: string
  detail?: string
  // ms — 기본값은 kind 에 따라 결정 (error: 수동, 그 외: 4000ms)
  duration?: number
}

interface ToastState {
  toasts: ToastItem[]
  push: (t: Omit<ToastItem, 'id'>) => string
  dismiss: (id: string) => void
  clear: () => void
}

let counter = 0
function newId() {
  counter += 1
  return `toast-${Date.now()}-${counter}`
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = newId()
    const item: ToastItem = { ...t, id }
    set((s) => ({ toasts: [...s.toasts, item] }))
    const auto =
      t.duration ?? (t.kind === 'error' ? 0 : t.kind === 'warning' ? 6000 : 4000)
    if (auto > 0) {
      setTimeout(() => get().dismiss(id), auto)
    }
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

// 편의 헬퍼
export const toast = {
  success: (title: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'success', title, detail }),
  error: (title: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'error', title, detail }),
  warning: (title: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'warning', title, detail }),
  info: (title: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'info', title, detail }),
}
