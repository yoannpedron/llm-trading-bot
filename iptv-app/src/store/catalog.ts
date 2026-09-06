import { create } from 'zustand'
import type { Catalog, Kind, MediaItem } from '../types'
import { XtreamClient, proxied, type XtreamCredentials } from '../api/xtream'
import type { WorkerIn, WorkerOut } from '../workers/catalog.worker'
import CatalogWorker from '../workers/catalog.worker?worker'
import { buildTmdbIndex, type TmdbIndex } from '../api/tmdbLists'
import { useSettings } from './settings'
import { searchIndex, unpackAsync, type SearchIndex } from '../catalog/columnar'

type Status = 'idle' | 'loading' | 'parsing' | 'ready' | 'error'

interface CatalogState {
  status: Status
  progress: string
  error?: string
  catalog?: Catalog
  /** where the current catalogue came from; 'partial' while the first download is still running */
  source?: 'snapshot' | 'server' | 'mock' | 'partial'
  refreshing: boolean
  lastDiff?: { added: number; removed: number; at: number }
  client?: XtreamClient
  byId: Map<string, number>
  tmdbIndex: TmdbIndex
  searchIdx?: SearchIndex
  load: (mode: 'mock' | 'live', creds?: XtreamCredentials, includeAdult?: boolean, forceRefresh?: boolean) => Promise<void>
  rebuildIndex: (contentLangs: string[]) => void
  item: (id: string) => MediaItem | undefined
  itemsOf: (kind: Kind, categoryId?: string) => MediaItem[]
  search: (q: string, kind?: Kind, limit?: number) => MediaItem[]
}

let worker: Worker | undefined
let applying = 0

export const useCatalog = create<CatalogState>()((set, get) => ({
  status: 'idle',
  progress: '',
  refreshing: false,
  byId: new Map(),
  tmdbIndex: { best: new Map(), versions: new Map(), fourK: new Set(), added: new Map(), all: new Map() },

  async load(mode, creds, includeAdult, forceRefresh) {
    worker?.terminate()
    worker = new CatalogWorker()
    const client = mode === 'live' && creds ? new XtreamClient(creds) : undefined
    set({ status: get().catalog ? 'ready' : 'loading', progress: 'Chargement…', error: undefined, client, refreshing: mode === 'live' })
    const key = mode === 'live' && creds ? `${creds.url}|${creds.username}` : 'mock'
    worker.onmessage = async (e: MessageEvent<WorkerOut>) => {
      const msg = e.data
      if (msg.type === 'progress') { set({ progress: msg.text }); return }
      if (msg.type === 'error') { set(get().catalog ? { refreshing: false, progress: '' } : { status: 'error', error: msg.message, refreshing: false }); return }
      if (msg.type === 'refreshed') { set({ refreshing: false, progress: '' }); return }
      // catalogue: restore objects in slices so the UI thread never freezes
      const gen = ++applying
      if (!get().catalog) set({ status: 'parsing', progress: msg.source === 'snapshot' ? 'Restauration du catalogue…' : 'Préparation…' })
      const catalog = await unpackAsync(msg.col, 30_000)
      if (gen !== applying) return
      const byId = new Map<string, number>()
      catalog.items.forEach((it, i) => byId.set(it.id, i))
      set({ status: 'ready', catalog, source: msg.source, byId, searchIdx: msg.search, tmdbIndex: buildTmdbIndex(visibleItems(catalog.items)), progress: msg.source === 'partial' ? 'Téléchargement des films en cours…' : get().progress, lastDiff: msg.diff ? { ...msg.diff, at: Date.now() } : get().lastDiff })
    }
    const base = creds ? proxied(creds.url) : undefined
    worker.postMessage({ type: 'load', mode, base, username: creds?.username, password: creds?.password, includeAdult, key, forceRefresh } satisfies WorkerIn)
  },

  rebuildIndex(contentLangs) {
    const c = get().catalog
    if (c) set({ tmdbIndex: buildTmdbIndex(visibleItems(c.items), contentLangs), catalog: { ...c, generatedAt: Date.now() } })
  },

  item(id) {
    const { catalog, byId } = get()
    const i = byId.get(id)
    return i === undefined ? undefined : catalog?.items[i]
  },

  itemsOf(kind, categoryId) {
    const c = get().catalog
    if (!c) return []
    if (categoryId) return (c.byCategory[kind + ':' + categoryId] ?? []).map((i) => c.items[i])
    return visibleItems(c.items.filter((it) => it.kind === kind))
  },

  search(q, kind, limit = 200) {
    const { catalog, searchIdx } = get()
    if (!catalog) return []
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return []
    const out: MediaItem[] = []
    if (searchIdx) {
      for (const i of searchIndex(searchIdx, needle, kind ? limit * 6 : limit)) { const it = catalog.items[i]; if (!it || (kind && it.kind !== kind)) continue; out.push(it); if (out.length >= limit) break }
      return visibleItems(out)
    }
    for (const it of catalog.items) { if (kind && it.kind !== kind) continue; if (it.title.toLowerCase().includes(needle) || it.rawName.toLowerCase().includes(needle)) { out.push(it); if (out.length >= limit) break } }
    return visibleItems(out)
  },
}))

/** Applies the settings filters (hidden languages / categories / PPV). */
export function visibleItems(items: MediaItem[]): MediaItem[] {
  const { hiddenLangs, hiddenCategories, hidePpv } = useSettings.getState()
  if (!hiddenLangs.length && !hiddenCategories.length && !hidePpv) return items
  const hl = new Set(hiddenLangs), hc = new Set(hiddenCategories)
  return items.filter((it) => !(it.lang && hl.has(it.lang)) && !hc.has(it.kind + ':' + it.categoryId) && !(hidePpv && it.kind === 'live' && /^(NEXT|ENDED|LIVE|END)\s*\|/i.test(it.rawName)))
}
