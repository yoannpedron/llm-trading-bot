import { create } from 'zustand'
import type { Kind, MediaItem } from '../types'
import { XtreamClient, proxied, type XtreamCredentials } from '../api/xtream'
import type { WorkerIn, WorkerOut } from '../workers/catalog.worker'
import CatalogWorker from '../workers/catalog.worker?worker'
import { buildTmdbIndex, type TmdbIndex } from '../api/tmdbLists'
import { useSettings } from './settings'
import { searchBytes, type Extra } from '../catalog/columnar'
import { CatalogView, type ItemList } from '../catalog/view'

type Status = 'idle' | 'loading' | 'parsing' | 'ready' | 'error'

interface CatalogState {
  status: Status
  progress: string
  error?: string
  /** lazy view: objects are created only for what the UI touches */
  catalog?: CatalogView
  source?: 'snapshot' | 'server' | 'mock' | 'partial'
  refreshing: boolean
  lastDiff?: { added: number; removed: number; at: number }
  client?: XtreamClient
  tmdbIndex: TmdbIndex
  load: (mode: 'mock' | 'live', creds?: XtreamCredentials, includeAdult?: boolean, forceRefresh?: boolean) => Promise<void>
  rebuildIndex: (contentLangs: string[]) => void
  item: (id: string) => MediaItem | undefined
  /** plot / cast / director / genre, fetched from the worker (never resident on the UI thread) */
  extra: (item: MediaItem) => Promise<Extra>
  /** indices, filtered by the settings (hidden languages / categories / PPV) */
  indicesOf: (kind: Kind, categoryId?: string) => number[]
  /** lazy list for grids; objects only for visible cells */
  listOf: (kind: Kind, categoryId?: string) => ItemList
  itemsOf: (kind: Kind, categoryId?: string) => MediaItem[]
  search: (q: string, kind?: Kind, limit?: number) => MediaItem[]
  isVisible: (i: number) => boolean
}

let worker: Worker | undefined
let applying = 0
let reqSeq = 0
const pending = new Map<number, (x: Extra) => void>()
const EMPTY_INDEX: TmdbIndex = { keys: new Float64Array(0), starts: new Uint32Array(1), perm: new Uint32Array(0) }

export const useCatalog = create<CatalogState>()((set, get) => ({
  status: 'idle',
  progress: '',
  refreshing: false,
  tmdbIndex: EMPTY_INDEX,

  async load(mode, creds, includeAdult, forceRefresh) {
    worker?.terminate()
    worker = new CatalogWorker()
    const client = mode === 'live' && creds ? new XtreamClient(creds) : undefined
    set({ status: get().catalog ? 'ready' : 'loading', progress: 'Chargement…', error: undefined, client, refreshing: mode === 'live' })
    const key = mode === 'live' && creds ? `${creds.url}|${creds.username}` : 'mock'
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data
      if (msg.type === 'progress') { set({ progress: msg.text }); return }
      if (msg.type === 'error') { set(get().catalog ? { refreshing: false, progress: '' } : { status: 'error', error: msg.message, refreshing: false }); return }
      if (msg.type === 'extra') { pending.get(msg.req)?.(msg.extra); pending.delete(msg.req); return }
      if (msg.type === 'refreshed') { set({ refreshing: false, progress: '', lastDiff: msg.diff ? { ...msg.diff, at: Date.now() } : get().lastDiff }); return }
      const gen = ++applying
      const t0 = performance.now()
      const view = new CatalogView(msg.col)
      console.info(`[catalog] ${msg.source}: view ready in ${(performance.now() - t0).toFixed(0)} ms, ${view.n} entries`)
      set({ status: 'ready', catalog: view, source: msg.source, progress: msg.source === 'partial' ? 'Téléchargement des films en cours…' : get().progress })
      setTimeout(() => { if (gen !== applying) return; const t1 = performance.now(); set({ tmdbIndex: buildTmdbIndex(view, get().isVisible) }); console.info(`[catalog] tmdb index ${(performance.now() - t1).toFixed(0)} ms`) }, 0)
    }
    const base = creds ? proxied(creds.url) : undefined
    worker.postMessage({ type: 'load', mode, base, username: creds?.username, password: creds?.password, includeAdult, key, forceRefresh } satisfies WorkerIn)
  },

  rebuildIndex(contentLangs) { const c = get().catalog; if (c) set({ tmdbIndex: buildTmdbIndex(c, get().isVisible, contentLangs) }) },
  item(id) { return get().catalog?.item(id) },
  extra(item) {
    const c = get().catalog; const i = c?.indexOf(item.id)
    if (!worker || !c || i === undefined) return Promise.resolve({})
    const req = ++reqSeq
    return new Promise<Extra>((res) => { pending.set(req, res); setTimeout(() => { if (pending.delete(req)) res({}) }, 5000); worker!.postMessage({ type: 'extra', req, id: c.kinds[i] * 4294967296 + c.streamIds[i] } satisfies WorkerIn) })
  },

  isVisible(i) {
    const c = get().catalog; if (!c) return false
    const { hiddenLangs, hiddenCategories, hidePpv } = useSettings.getState()
    if (!hiddenLangs.length && !hiddenCategories.length && !hidePpv) return true
    const lang = c.langOf(i); if (lang && hiddenLangs.includes(lang)) return false
    if (hiddenCategories.length && hiddenCategories.includes(c.kindOf(i) + ':' + c.column('categoryIds')[i])) return false
    if (hidePpv && c.kindOf(i) === 'live' && /^\s*(NEXT|ENDED|LIVE|END)\s*\|/i.test(c.rawNameOf(i))) return false
    return true
  },
  indicesOf(kind, categoryId) {
    const c = get().catalog; if (!c) return []
    const base = categoryId ? (c.byCategory[kind + ':' + categoryId] ?? []) : c.indicesOf(kind)
    const { hiddenLangs, hiddenCategories, hidePpv } = useSettings.getState()
    return hiddenLangs.length || hiddenCategories.length || hidePpv ? base.filter(get().isVisible) : base
  },
  listOf(kind, categoryId) { const c = get().catalog; return c ? c.list(get().indicesOf(kind, categoryId)) : { length: 0, at: () => undefined } },
  itemsOf(kind, categoryId) { const c = get().catalog; return c ? c.materialize(get().indicesOf(kind, categoryId)) : [] },

  search(q, kind, limit = 200) {
    const c = get().catalog
    if (!c) return []
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return []
    const vis = get().isVisible
    const out: MediaItem[] = []
    for (const i of searchBytes(c.search, needle, kind ? limit * 6 : limit)) {
      if ((kind && c.kindOf(i) !== kind) || !vis(i)) continue
      const it = c.at(i); if (it) out.push(it); if (out.length >= limit) break
    }
    return out
  },
}))
