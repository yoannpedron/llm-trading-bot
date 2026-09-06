import { create } from 'zustand'
import type { Catalog, Kind, MediaItem } from '../types'
import { XtreamClient, loadMockCatalog, type XtreamCredentials } from '../api/xtream'
import type { WorkerIn, WorkerOut } from '../workers/parser.worker'
import ParserWorker from '../workers/parser.worker?worker'
import { buildTmdbIndex, type TmdbIndex } from '../api/tmdbLists'
import { useSettings } from './settings'

type Status = 'idle' | 'loading' | 'parsing' | 'ready' | 'error'

interface CatalogState {
  status: Status
  progress: string
  error?: string
  catalog?: Catalog
  client?: XtreamClient
  byId: Map<string, number>
  tmdbIndex: TmdbIndex
  load: (mode: 'mock' | 'live', creds?: XtreamCredentials, includeAdult?: boolean) => Promise<void>
  rebuildIndex: (contentLangs: string[]) => void
  item: (id: string) => MediaItem | undefined
  itemsOf: (kind: Kind, categoryId?: string) => MediaItem[]
  search: (q: string, kind?: Kind, limit?: number) => MediaItem[]
}

let abort: AbortController | undefined

export const useCatalog = create<CatalogState>()((set, get) => ({
  status: 'idle',
  progress: '',
  byId: new Map(),
  tmdbIndex: { best: new Map(), versions: new Map(), fourK: new Set(), added: new Map(), all: new Map() },

  async load(mode, creds, includeAdult) {
    abort?.abort()
    abort = new AbortController()
    const signal = abort.signal
    set({ status: 'loading', progress: 'Connexion…', error: undefined, catalog: undefined })
    try {
      let client: XtreamClient | undefined
      let raw
      if (mode === 'live' && creds) {
        client = new XtreamClient(creds)
        const me = await client.login(signal)
        if (!me.user_info?.auth) throw new Error(me.user_info?.message || 'Identifiants refusés')
        set({ progress: 'Téléchargement du catalogue…' })
        raw = await client.catalog(signal, (s) => set({ progress: `Reçu : ${s}` }))
      } else {
        raw = await loadMockCatalog()
      }
      if (signal.aborted) return
      set({ status: 'parsing', progress: `Analyse de ${raw.vod.length + raw.series.length + raw.live.length} entrées…` })
      const catalog = await parseInWorker(raw, includeAdult)
      if (signal.aborted) return
      const byId = new Map<string, number>()
      catalog.items.forEach((it, i) => byId.set(it.id, i))
      set({ status: 'ready', catalog, client, byId, tmdbIndex: buildTmdbIndex(visibleItems(catalog.items)), progress: '' })
    } catch (e) {
      if (signal.aborted) return
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
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
    const c = get().catalog
    if (!c) return []
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return []
    const out: MediaItem[] = []
    for (const it of c.items) {
      if (kind && it.kind !== kind) continue
      if (it.title.toLowerCase().includes(needle) || it.rawName.toLowerCase().includes(needle)) {
        out.push(it)
        if (out.length >= limit) break
      }
    }
    return out
  },
}))

function parseInWorker(raw: WorkerIn['raw'], includeAdult?: boolean): Promise<Catalog> {
  return new Promise((res, rej) => {
    const w = new ParserWorker()
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      w.terminate()
      if (e.data.type === 'done') res(e.data.catalog)
      else rej(new Error(e.data.message))
    }
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message)) }
    w.postMessage({ type: 'parse', raw, includeAdult } satisfies WorkerIn)
  })
}

/** Applies the settings filters (hidden languages / categories / PPV). */
export function visibleItems(items: MediaItem[]): MediaItem[] {
  const { hiddenLangs, hiddenCategories, hidePpv } = useSettings.getState()
  if (!hiddenLangs.length && !hiddenCategories.length && !hidePpv) return items
  const hl = new Set(hiddenLangs), hc = new Set(hiddenCategories)
  return items.filter((it) => !(it.lang && hl.has(it.lang)) && !hc.has(it.kind + ':' + it.categoryId) && !(hidePpv && it.kind === 'live' && /^(NEXT|ENDED|LIVE)\s*\|/.test(it.rawName)))
}
