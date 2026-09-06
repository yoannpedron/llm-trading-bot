import { create } from 'zustand'

interface UiState {
  /** Backdrop currently shown full-screen behind the app */
  backdrop?: string
  /** Item id currently focused/selected in a carousel or grid */
  focusedId?: string
  setBackdrop: (url?: string) => void
  setFocused: (id?: string) => void
}

export const useUi = create<UiState>()((set) => ({
  setBackdrop: (backdrop) => set({ backdrop }),
  setFocused: (focusedId) => set({ focusedId }),
}))
