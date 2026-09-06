import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { XtreamCredentials } from '../api/xtream'
import type { ProviderProfile } from '../download/profile'

export interface Account extends XtreamCredentials { id: string; label: string }

interface Settings {
  accounts: Account[]
  activeAccountId?: string
  profiles: Record<string, ProviderProfile>
  setProfile: (accountId: string, p: ProviderProfile) => void
  learn: (accountId: string, patch: Partial<ProviderProfile>) => void
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
  /** titles whose language could not be identified (no prefix on title nor category) */
  showUnknownLang: boolean
  /** titles without a TMDB record, shown in an "Autres" row / page */
  showUntagged: boolean
  /** Data */
  autoRefreshHours: number
  /** rendering tier: auto = detected from the device */
  perf: 'auto' | 'full' | 'lite'
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
  accounts: [], profiles: {}, hiddenRows: [], pinnedRows: [], rowOrder: [], renamedRows: {}, hiddenLangs: [], hiddenCategories: [], hidePpv: false, showUnknownLang: true, showUntagged: true, autoRefreshHours: 12, perf: 'auto',
  setProfile: (id, p) => set({ profiles: { ...get().profiles, [id]: p } }),
  learn: (id, patch) => { const cur = get().profiles[id]; if (cur) set({ profiles: { ...get().profiles, [id]: { ...cur, ...patch } } }) },
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
