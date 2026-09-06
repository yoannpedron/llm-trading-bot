import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { XtreamCredentials } from '../api/xtream'

export interface Account extends XtreamCredentials { id: string; label: string }

interface Settings {
  accounts: Account[]
  activeAccountId?: string
  tmdbKeyOverride?: string
  /** Home rows */
  hiddenRows: string[]
  pinnedRows: string[]
  rowOrder: string[]
  renamedRows: Record<string, string>
  /** Catalogue filters */
  hiddenLangs: string[]
  hiddenCategories: string[]
  hidePpv: boolean
  /** Data */
  autoRefreshHours: number
  addAccount: (a: Omit<Account, 'id'>) => string
  removeAccount: (id: string) => void
  setActive: (id?: string) => void
  toggleRow: (key: string, list: 'hiddenRows' | 'pinnedRows') => void
  renameRow: (key: string, name: string) => void
  setRowOrder: (keys: string[]) => void
  toggleLang: (l: string) => void
  toggleCategory: (id: string) => void
  set: (p: Partial<Settings>) => void
  exportJson: () => string
  importJson: (s: string) => void
}

const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

export const useSettings = create<Settings>()(persist((set, get) => ({
  accounts: [], hiddenRows: [], pinnedRows: [], rowOrder: [], renamedRows: {}, hiddenLangs: [], hiddenCategories: [], hidePpv: false, autoRefreshHours: 12,
  addAccount: (a) => { const id = crypto.randomUUID(); set({ accounts: [...get().accounts, { ...a, id }] }); return id },
  removeAccount: (id) => set({ accounts: get().accounts.filter((a) => a.id !== id), activeAccountId: get().activeAccountId === id ? undefined : get().activeAccountId }),
  setActive: (id) => set({ activeAccountId: id }),
  toggleRow: (key, list) => set({ [list]: toggle(get()[list], key) } as Partial<Settings>),
  renameRow: (key, name) => set({ renamedRows: { ...get().renamedRows, [key]: name } }),
  setRowOrder: (keys) => set({ rowOrder: keys }),
  toggleLang: (l) => set({ hiddenLangs: toggle(get().hiddenLangs, l) }),
  toggleCategory: (id) => set({ hiddenCategories: toggle(get().hiddenCategories, id) }),
  set: (p) => set(p),
  exportJson: () => {
    const s = get()
    const profile = localStorage.getItem('iptv-profile'), list = localStorage.getItem('iptv-mylist'), progress = localStorage.getItem('iptv-progress'), history = localStorage.getItem('iptv-history')
    return JSON.stringify({ version: 1, settings: { accounts: s.accounts, activeAccountId: s.activeAccountId, hiddenRows: s.hiddenRows, pinnedRows: s.pinnedRows, rowOrder: s.rowOrder, renamedRows: s.renamedRows, hiddenLangs: s.hiddenLangs, hiddenCategories: s.hiddenCategories, hidePpv: s.hidePpv, autoRefreshHours: s.autoRefreshHours }, profile: profile && JSON.parse(profile), mylist: list && JSON.parse(list), progress: progress && JSON.parse(progress), history: history && JSON.parse(history) }, null, 2)
  },
  importJson: (txt) => {
    const d = JSON.parse(txt)
    if (d.settings) set(d.settings)
    for (const [k, v] of [['iptv-profile', d.profile], ['iptv-mylist', d.mylist], ['iptv-progress', d.progress], ['iptv-history', d.history]] as const) if (v) localStorage.setItem(k, JSON.stringify(v))
    location.reload()
  },
}), { name: 'iptv-settings' }))
