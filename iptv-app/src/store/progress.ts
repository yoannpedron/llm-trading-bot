import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Progress { t: number; d: number; updated: number; ep?: string; ext?: string }
interface State { map: Record<string, Progress>; save: (id: string, p: Omit<Progress, 'updated'>) => void; clear: (id: string) => void }

/** Playback positions per title (local device). Finished titles (>95 %) are removed. */
export const useProgress = create<State>()(persist((set, get) => ({
  map: {},
  save: (id, p) => {
    if (p.d && p.t / p.d > 0.95) { const m = { ...get().map }; delete m[id]; set({ map: m }); return }
    set({ map: { ...get().map, [id]: { ...p, updated: Date.now() } } })
  },
  clear: (id) => { const m = { ...get().map }; delete m[id]; set({ map: m }) },
}), { name: 'iptv-progress' }))
