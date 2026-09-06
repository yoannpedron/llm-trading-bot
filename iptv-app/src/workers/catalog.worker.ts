/// <reference lib="webworker" />
/**
 * Catalogue worker: everything heavy happens here, never on the UI thread.
 *  1. Restore the last snapshot from IndexedDB and hand it to the UI (restart in ~1 s).
 *  2. Stream the provider lists, normalise each batch as it arrives (parse CPU hidden behind the network),
 *     post partial catalogues on first start (live and series show up before the movies finish),
 *     then pack, save the new snapshot and hand over the final catalogue with a diff.
 */
import { normalizeCategory, normalizeLive, normalizeSeries, normalizeVod } from '../parser/normalize'
import { buildSearchIndex, loadSnapshot, pack, saveSnapshot, SEP, type Columnar } from '../catalog/columnar'
import { fetchList } from '../catalog/stream'
import type { Catalog, Category, MediaItem, Kind, XtreamCategory, XtreamLive, XtreamSeries, XtreamVod } from '../types'

export type WorkerIn = { type: 'load'; mode: 'mock' | 'live'; base?: string; username?: string; password?: string; includeAdult?: boolean; key: string; forceRefresh?: boolean }
export type WorkerOut =
  | { type: 'progress'; text: string }
  | { type: 'catalog'; col: Columnar; source: 'snapshot' | 'server' | 'mock' | 'partial'; search: { text: string; offsets: Uint32Array }; diff?: { added: number; removed: number } }
  | { type: 'refreshed' }
  | { type: 'error'; message: string }

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
const ADULT_CAT = /adult|xxx|18\+|porn|\bx\b/i

function finish(items: MediaItem[], categories: Category[], includeAdult: boolean): { col: Columnar; search: ReturnType<typeof buildSearchIndex> } {
  const kept = includeAdult ? items : items.filter((i) => !i.isAdult)
  const used = new Set(kept.map((i) => i.kind + ':' + i.categoryId))
  const cats = categories.filter((c) => (includeAdult || !ADULT_CAT.test(c.rawName)) && used.has(c.kind + ':' + c.id))
  const catalog: Catalog = { items: kept, categories: cats, byCategory: {}, counts: { movie: 0, series: 0, live: 0 }, generatedAt: Date.now() }
  return { col: pack(catalog), search: buildSearchIndex(kept) }
}
const transferables = (col: Columnar, search: { offsets: Uint32Array }) => [col.kinds.buffer, col.streamIds.buffer, col.years.buffer, col.seasons.buffer, col.episodes.buffer, col.tmdbIds.buffer, col.ratings.buffer, col.added.buffer, col.flags.buffer, search.offsets.buffer]

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data
  try {
    if (m.mode === 'mock') {
      const [vod, series, live, vc, sc, lc] = await Promise.all([import('../api/mock/vod_streams.json'), import('../api/mock/series.json'), import('../api/mock/live_streams.json'), import('../api/mock/vod_categories.json'), import('../api/mock/series_categories.json'), import('../api/mock/live_categories.json')])
      const cats = [...(vc.default as XtreamCategory[]).map((c) => normalizeCategory(c, 'movie')), ...(sc.default as XtreamCategory[]).map((c) => normalizeCategory(c, 'series')), ...(lc.default as XtreamCategory[]).map((c) => normalizeCategory(c, 'live'))]
      const name = catNames(cats)
      const items = [...(vod.default as unknown as XtreamVod[]).map((x) => normalizeVod(x, name('movie', x.category_id))), ...(series.default as unknown as XtreamSeries[]).map((x) => normalizeSeries(x, name('series', x.category_id))), ...(live.default as unknown as XtreamLive[]).map((x) => normalizeLive(x, name('live', x.category_id)))]
      const { col, search } = finish(items, cats, !!m.includeAdult)
      post({ type: 'catalog', col, source: 'mock', search }, transferables(col, search))
      return
    }
    // 1. snapshot first
    const snap = await loadSnapshot(m.key)
    let snapIds: Set<string> | undefined
    if (snap) {
      const search = buildSearchIndexFromColumnar(snap)
      snapIds = new Set(); for (let i = 0; i < snap.n; i++) snapIds.add(snap.kinds[i] + ':' + snap.streamIds[i])
      post({ type: 'catalog', col: snap, source: 'snapshot', search }, [search.offsets.buffer])
      if (!m.forceRefresh && Date.now() - snap.generatedAt < 10 * 60_000) { post({ type: 'refreshed' }); return }
    }
    // 2. refresh from the server, streaming
    const api = (action: string) => `${m.base}/player_api.php?username=${encodeURIComponent(m.username ?? '')}&password=${encodeURIComponent(m.password ?? '')}&action=${action}`
    post({ type: 'progress', text: snap ? 'Mise à jour du catalogue en arrière-plan…' : 'Connexion…' })
    const me = await (await fetch(api(''))).json() as { user_info?: { auth?: number; message?: string } }
    if (!me.user_info?.auth) throw new Error(me.user_info?.message || 'Identifiants refusés')
    const [vc, sc, lc] = await Promise.all(['get_vod_categories', 'get_series_categories', 'get_live_categories'].map((a) => fetch(api(a)).then((r) => r.json() as Promise<XtreamCategory[]>)))
    const cats = [...vc.map((c) => normalizeCategory(c, 'movie')), ...sc.map((c) => normalizeCategory(c, 'series')), ...lc.map((c) => normalizeCategory(c, 'live'))]
    const name = catNames(cats)
    const items: MediaItem[] = []
    const counts = { live: 0, series: 0, movie: 0 }
    let lastPartial = 0
    const partial = () => { if (snap) return; const now = Date.now(); if (now - lastPartial < 4000) return; lastPartial = now; const { col, search } = finish(items.slice(), cats, !!m.includeAdult); post({ type: 'catalog', col, source: 'partial', search }, transferables(col, search)) }
    const progress = () => post({ type: 'progress', text: `${counts.movie.toLocaleString('fr-FR')} films · ${counts.series.toLocaleString('fr-FR')} séries · ${counts.live.toLocaleString('fr-FR')} chaînes reçus` })
    await Promise.all([
      fetchList<XtreamLive>(api('get_live_streams'), (b) => { for (const x of b) items.push(normalizeLive(x, name('live', x.category_id))); counts.live += b.length; progress() }).then(partial),
      fetchList<XtreamSeries>(api('get_series'), (b) => { for (const x of b) items.push(normalizeSeries(x, name('series', x.category_id))); counts.series += b.length; progress() }).then(partial),
      fetchList<XtreamVod>(api('get_vod_streams'), (b) => { for (const x of b) items.push(normalizeVod(x, name('movie', x.category_id))); counts.movie += b.length; progress(); if (!snap && counts.movie % 40000 < b.length) partial() }),
    ])
    const { col, search } = finish(items, cats, !!m.includeAdult)
    let diff: { added: number; removed: number } | undefined
    if (snapIds) { const now = new Set<string>(); for (let i = 0; i < col.n; i++) now.add(col.kinds[i] + ':' + col.streamIds[i]); let added = 0; for (const k of now) if (!snapIds.has(k)) added++; let removed = 0; for (const k of snapIds) if (!now.has(k)) removed++; diff = { added, removed } }
    await saveSnapshot(m.key, col).catch(() => undefined)
    post({ type: 'catalog', col, source: 'server', search, diff }, transferables(col, search))
    post({ type: 'refreshed' })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function catNames(cats: Category[]) { const map = new Map(cats.map((c) => [c.kind + ':' + c.id, c.rawName])); return (kind: Kind, id: string | number) => map.get(kind + ':' + id) ?? '' }
/** Search index straight from the columnar strings, no objects needed. */
function buildSearchIndexFromColumnar(col: Columnar) {
  const titles = col.titles.split(SEP), raw = col.rawNames.split(SEP)
  const parts: string[] = new Array(col.n); const offsets = new Uint32Array(col.n + 1); let pos = 0
  for (let i = 0; i < col.n; i++) { const t = (titles[i] + ' ' + raw[i]).toLowerCase(); parts[i] = t; offsets[i] = pos; pos += t.length + 1 }
  offsets[col.n] = pos
  return { text: parts.join('\n'), offsets }
}
