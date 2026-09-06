import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Watched { id: string; ts: number; count: number }
interface State { items: Watched[]; record: (id: string) => void; clear: () => void }

/** Watch history (local). Newest first, capped at 500. */
export const useHistory = create<State>()(persist((set, get) => ({
  items: [],
  record: (id) => { const cur = get().items.find((w) => w.id === id); set({ items: [{ id, ts: Date.now(), count: (cur?.count ?? 0) + 1 }, ...get().items.filter((w) => w.id !== id)].slice(0, 500) }) },
  clear: () => set({ items: [] }),
}), { name: 'iptv-history' }))
