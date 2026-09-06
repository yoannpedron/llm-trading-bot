/// <reference lib="webworker" />
/**
 * Catalogue worker: everything heavy happens here, never on the UI thread.
 *  1. Restore the last snapshot from IndexedDB and hand it to the UI (restart in ~1 s).
 *  2. Stream the provider lists, normalise each batch as it arrives (parse CPU hidden behind the network),
 *     post partial catalogues on first start (live and series show up before the movies finish),
 *     then pack, save the new snapshot and hand over the final catalogue with a diff.
 */
import { normalizeCategory, normalizeLive, normalizeSeries, normalizeVod } from '../parser/normalize'
import { ColumnarBuilder, ExtrasReader, buffersOf, cloneColumnar, loadExtras, loadSnapshot, saveExtras, saveSnapshot, type Columnar, type Extra, type Extras } from '../catalog/columnar'
import { fetchList } from '../catalog/stream'
import type { Category, MediaItem, Kind, XtreamCategory, XtreamLive, XtreamSeries, XtreamVod } from '../types'

export type WorkerIn =
  | { type: 'load'; mode: 'mock' | 'live'; base?: string; username?: string; password?: string; includeAdult?: boolean; key: string; forceRefresh?: boolean }
  | { type: 'extra'; req: number; id: number }
export type WorkerOut =
  | { type: 'progress'; text: string }
  | { type: 'catalog'; col: Columnar; source: 'snapshot' | 'server' | 'mock' | 'partial'; diff?: { added: number; removed: number } }
  | { type: 'refreshed'; diff?: { added: number; removed: number } }
  | { type: 'extra'; req: number; extra: Extra }
  | { type: 'error'; message: string }

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
const T0 = performance.now(); const log = (s: string) => console.info(`[catalog.worker +${((performance.now() - T0) / 1000).toFixed(2)}s] ${s}`)
const ADULT_CAT = /adult|xxx|18\+|porn|\bx\b/i

function finish(b: ColumnarBuilder, categories: Category[], includeAdult: boolean): Columnar {
  return b.build(categories.filter((c) => includeAdult || !ADULT_CAT.test(c.rawName)))
}
/** Send a catalogue to the UI: every buffer is transferred, nothing is copied. `col` is consumed. */
function send(col: Columnar, source: 'snapshot' | 'server' | 'mock' | 'partial', diff?: { added: number; removed: number }) {
  post({ type: 'catalog', col, source, diff }, buffersOf(col))
}

/* ---- extras (plot / cast / director / genre): never on the UI thread; read here on demand, dropped after 60 s idle ---- */
let extrasKey = ''
let extrasMem: Extras | undefined            // in memory only while building (first start / mock) or briefly after a read
let reader: Extras | undefined, readerObj: ExtrasReader | undefined, readerTimer: ReturnType<typeof setTimeout> | undefined
async function extraOf(id: number): Promise<Extra> {
  const x = extrasMem ?? reader ?? (extrasKey ? await loadExtras(extrasKey) : undefined)
  if (!x) return {}
  if (readerObj && reader === x) { /* cached */ } else { reader = x; readerObj = new ExtrasReader(x) }
  clearTimeout(readerTimer); readerTimer = setTimeout(() => { reader = undefined; readerObj = undefined }, 60_000)
  return readerObj!.of(id)
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data
  if (m.type === 'extra') { post({ type: 'extra', req: m.req, extra: await extraOf(m.id).catch(() => ({})) }); return }
  extrasKey = m.key
  try {
    if (m.mode === 'mock') {
      const [vod, series, live, vc, sc, lc] = await Promise.all([import('../api/mock/vod_streams.json'), import('../api/mock/series.json'), import('../api/mock/live_streams.json'), import('../api/mock/vod_categories.json'), import('../api/mock/series_categories.json'), import('../api/mock/live_categories.json')])
      const cats = [...(vc.default as XtreamCategory[]).map((c) => normalizeCategory(c, 'movie')), ...(sc.default as XtreamCategory[]).map((c) => normalizeCategory(c, 'series')), ...(lc.default as XtreamCategory[]).map((c) => normalizeCategory(c, 'live'))]
      const name = catNames(cats)
      const b = new ColumnarBuilder(); const keep = (it: MediaItem) => { if (m.includeAdult || !it.isAdult) b.push(it) }
      for (const x of vod.default as unknown as XtreamVod[]) keep(normalizeVod(x, name('movie', x.category_id)))
      for (const x of series.default as unknown as XtreamSeries[]) keep(normalizeSeries(x, name('series', x.category_id)))
      for (const x of live.default as unknown as XtreamLive[]) keep(normalizeLive(x, name('live', x.category_id)))
      extrasMem = b.buildExtras()
      send(finish(b, cats, !!m.includeAdult), 'mock')
      return
    }
    // 1. snapshot first
    log('load snapshot…'); const snap = await loadSnapshot(m.key); log(snap ? `snapshot read: ${snap.n} items` : 'no snapshot')
    let snapIds: Set<number> | undefined
    if (snap) {
      snapIds = new Set(); for (let i = 0; i < snap.n; i++) snapIds.add(snap.kinds[i] * 4294967296 + snap.streamIds[i])
      send(snap, 'snapshot'); log('snapshot posted')
      if (!m.forceRefresh && Date.now() - snap.generatedAt < 10 * 60_000) { post({ type: 'refreshed' }); return }
      log('refreshing in background')
    }
    // 2. refresh from the server, streaming
    const api = (action: string) => `${m.base}/player_api.php?username=${encodeURIComponent(m.username ?? '')}&password=${encodeURIComponent(m.password ?? '')}&action=${action}`
    post({ type: 'progress', text: snap ? 'Mise à jour du catalogue en arrière-plan…' : 'Connexion…' })
    const me = await (await fetch(api(''))).json() as { user_info?: { auth?: number; message?: string } }
    if (!me.user_info?.auth) throw new Error(me.user_info?.message || 'Identifiants refusés')
    const [vc, sc, lc] = await Promise.all(['get_vod_categories', 'get_series_categories', 'get_live_categories'].map((a) => fetch(api(a)).then((r) => r.json() as Promise<XtreamCategory[]>)))
    const cats = [...vc.map((c) => normalizeCategory(c, 'movie')), ...sc.map((c) => normalizeCategory(c, 'series')), ...lc.map((c) => normalizeCategory(c, 'live'))]
    const name = catNames(cats)
    const b = new ColumnarBuilder()
    const keep = (it: MediaItem) => { if (m.includeAdult || !it.isAdult) b.push(it) }
    reader = undefined; readerObj = undefined
    const counts = { live: 0, series: 0, movie: 0 }
    let partials = 0
    // first start only: hand over what is already there (live + series arrive well before the movies)
    const partial = () => { if (snap || partials >= 2) return; partials++; extrasMem = b.buildExtras(); send(finish(b, cats, !!m.includeAdult), 'partial') }
    const progress = () => post({ type: 'progress', text: `${counts.movie.toLocaleString('fr-FR')} films · ${counts.series.toLocaleString('fr-FR')} séries · ${counts.live.toLocaleString('fr-FR')} chaînes reçus` })
    await Promise.all([
      fetchList<XtreamLive>(api('get_live_streams'), (batch) => { for (const x of batch) keep(normalizeLive(x, name('live', x.category_id))); counts.live += batch.length; progress() }),
      fetchList<XtreamSeries>(api('get_series'), (batch) => { for (const x of batch) keep(normalizeSeries(x, name('series', x.category_id))); counts.series += batch.length; progress() }).then(partial),
      fetchList<XtreamVod>(api('get_vod_streams'), (batch) => { for (const x of batch) keep(normalizeVod(x, name('movie', x.category_id))); counts.movie += batch.length; progress(); if (counts.movie >= 90_000 && counts.movie - batch.length < 90_000) partial() }),
    ])
    log(`lists received: ${b.n} items`)
    const col = finish(b, cats, !!m.includeAdult)
    log('packed')
    // hand a copy to the UI first (memcpy of typed arrays, then zero-copy transfer), persist the original afterwards
    send(cloneColumnar(col), 'server'); log('final posted')
    let diff: { added: number; removed: number } | undefined
    if (snapIds) { const now = new Set<number>(); for (let i = 0; i < col.n; i++) now.add(col.kinds[i] * 4294967296 + col.streamIds[i]); let added = 0; for (const k of now) if (!snapIds.has(k)) added++; let removed = 0; for (const k of snapIds) if (!now.has(k)) removed++; diff = { added, removed } }
    const extras = b.buildExtras(); extrasMem = extras
    await saveSnapshot(m.key, col).catch(() => undefined); log('snapshot saved')
    await saveExtras(m.key, extras).catch(() => undefined); extrasMem = undefined; reader = undefined; readerObj = undefined; log('extras saved')
    post({ type: 'refreshed', diff })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function catNames(cats: Category[]) { const map = new Map(cats.map((c) => [c.kind + ':' + c.id, c.rawName])); return (kind: Kind, id: string | number) => map.get(kind + ':' + id) ?? '' }
