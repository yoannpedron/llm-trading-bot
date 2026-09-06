/**
 * Columnar snapshot of the catalogue: a handful of big strings and typed arrays instead of
 * 300k objects. Stored as one IndexedDB record; restored into MediaItem objects in a worker.
 * Strings are joined with U+001F (never present in provider names); numbers live in typed arrays.
 */
import type { Catalog, Category, Kind, MediaItem } from '../types'

export interface Columnar {
  v: 1
  n: number
  generatedAt: number
  kinds: Uint8Array            // 0 movie, 1 series, 2 live
  streamIds: Uint32Array
  years: Uint16Array           // 0 = none
  seasons: Uint8Array; episodes: Uint16Array
  tmdbIds: Uint32Array; ratings: Uint8Array /* x10 */; added: Uint32Array
  flags: Uint8Array            // bit0 adult, bit1 tvArchive
  rawNames: string; titles: string; searchTitles: string /* empty = same as title */; langs: string; qualities: string; tags: string
  categoryIds: string; posters: string; backdrops: string; exts: string; plots: string; casts: string; directors: string; genres: string; epg: string
  categories: Category[]
  /** case-folded search text + offsets, built once, persisted with the snapshot */
  searchText?: string
  searchOffsets?: Uint32Array
}
export const SEP = '', TAGSEP = ''
const KIND: Kind[] = ['movie', 'series', 'live']

/** Builds the columnar form incrementally while lists stream in, so no 300k-object array and no final pack step. */
export class ColumnarBuilder {
  n = 0
  private num: Record<string, number[]> = { kinds: [], streamIds: [], years: [], seasons: [], episodes: [], tmdbIds: [], ratings: [], added: [], flags: [] }
  private cols: Record<string, string[]> = { rawNames: [], titles: [], searchTitles: [], langs: [], qualities: [], tags: [], categoryIds: [], posters: [], backdrops: [], exts: [], plots: [], casts: [], directors: [], genres: [], epg: [] }
  private search: string[] = []
  push(it: MediaItem) {
    const N = this.num, C = this.cols
    N.kinds.push(KIND.indexOf(it.kind)); N.streamIds.push(it.streamId); N.years.push(it.year ?? 0); N.seasons.push(it.season ?? 0); N.episodes.push(it.episode ?? 0)
    N.tmdbIds.push(it.tmdbId ?? 0); N.ratings.push(Math.min(255, Math.round((it.rating ?? 0) * 10))); N.added.push(it.added ?? 0); N.flags.push((it.isAdult ? 1 : 0) | (it.tvArchive ? 2 : 0))
    C.rawNames.push(it.rawName); C.titles.push(it.title); C.searchTitles.push(it.searchTitle === it.title ? '' : it.searchTitle); C.langs.push(it.lang ?? ''); C.qualities.push(it.quality ?? '')
    C.tags.push(it.tags.join(TAGSEP)); C.categoryIds.push(it.categoryId); C.posters.push(it.poster ?? ''); C.backdrops.push(it.backdrop ?? ''); C.exts.push(it.ext ?? '')
    C.plots.push(it.plot ?? ''); C.casts.push(it.cast ?? ''); C.directors.push(it.director ?? ''); C.genres.push(it.genre ?? ''); C.epg.push(it.epgChannelId ?? '')
    this.search.push((it.title + ' ' + it.rawName).toLowerCase())
    this.n++
  }
  build(categories: Category[]): Columnar {
    const N = this.num, C = this.cols, j = (k: string) => C[k].join(SEP)
    const offsets = new Uint32Array(this.n + 1); let pos = 0
    for (let i = 0; i < this.n; i++) { offsets[i] = pos; pos += this.search[i].length + 1 }
    offsets[this.n] = pos
    return { v: 1, n: this.n, generatedAt: Date.now(), kinds: Uint8Array.from(N.kinds), streamIds: Uint32Array.from(N.streamIds), years: Uint16Array.from(N.years), seasons: Uint8Array.from(N.seasons), episodes: Uint16Array.from(N.episodes), tmdbIds: Uint32Array.from(N.tmdbIds), ratings: Uint8Array.from(N.ratings), added: Uint32Array.from(N.added), flags: Uint8Array.from(N.flags),
      rawNames: j('rawNames'), titles: j('titles'), searchTitles: j('searchTitles'), langs: j('langs'), qualities: j('qualities'), tags: j('tags'), categoryIds: j('categoryIds'), posters: j('posters'), backdrops: j('backdrops'), exts: j('exts'), plots: j('plots'), casts: j('casts'), directors: j('directors'), genres: j('genres'), epg: j('epg'), categories, searchText: this.search.join('\n'), searchOffsets: offsets }
  }
}

/** Heavy, rarely-read columns (plot, cast, director, genre) are split lazily on first access. */
export class ExtraColumns {
  private cache: Partial<Record<'plots' | 'casts' | 'directors' | 'genres', string[]>> = {}
  private col: Pick<Columnar, 'plots' | 'casts' | 'directors' | 'genres'>
  constructor(col: Pick<Columnar, 'plots' | 'casts' | 'directors' | 'genres'>) { this.col = col }
  private get(k: 'plots' | 'casts' | 'directors' | 'genres') { return (this.cache[k] ??= this.col[k].split(SEP)) }
  of(i: number): { plot?: string; cast?: string; director?: string; genre?: string } {
    const u = (x: string) => (x === '' ? undefined : x)
    return { plot: u(this.get('plots')[i]), cast: u(this.get('casts')[i]), director: u(this.get('directors')[i]), genre: u(this.get('genres')[i]) }
  }
}

export function pack(c: Catalog): Columnar {
  const n = c.items.length
  const kinds = new Uint8Array(n), streamIds = new Uint32Array(n), years = new Uint16Array(n), seasons = new Uint8Array(n), episodes = new Uint16Array(n), tmdbIds = new Uint32Array(n), ratings = new Uint8Array(n), added = new Uint32Array(n), flags = new Uint8Array(n)
  const cols: Record<string, string[]> = { rawNames: [], titles: [], searchTitles: [], langs: [], qualities: [], tags: [], categoryIds: [], posters: [], backdrops: [], exts: [], plots: [], casts: [], directors: [], genres: [], epg: [] }
  c.items.forEach((it, i) => {
    kinds[i] = KIND.indexOf(it.kind); streamIds[i] = it.streamId; years[i] = it.year ?? 0; seasons[i] = it.season ?? 0; episodes[i] = it.episode ?? 0
    tmdbIds[i] = it.tmdbId ?? 0; ratings[i] = Math.min(255, Math.round((it.rating ?? 0) * 10)); added[i] = it.added ?? 0; flags[i] = (it.isAdult ? 1 : 0) | (it.tvArchive ? 2 : 0)
    cols.rawNames.push(it.rawName); cols.titles.push(it.title); cols.searchTitles.push(it.searchTitle === it.title ? '' : it.searchTitle); cols.langs.push(it.lang ?? ''); cols.qualities.push(it.quality ?? '')
    cols.tags.push(it.tags.join(TAGSEP)); cols.categoryIds.push(it.categoryId); cols.posters.push(it.poster ?? ''); cols.backdrops.push(it.backdrop ?? ''); cols.exts.push(it.ext ?? '')
    cols.plots.push(it.plot ?? ''); cols.casts.push(it.cast ?? ''); cols.directors.push(it.director ?? ''); cols.genres.push(it.genre ?? ''); cols.epg.push(it.epgChannelId ?? '')
  })
  const j = (k: string) => cols[k].join(SEP)
  return { v: 1, n, generatedAt: c.generatedAt, kinds, streamIds, years, seasons, episodes, tmdbIds, ratings, added, flags,
    rawNames: j('rawNames'), titles: j('titles'), searchTitles: j('searchTitles'), langs: j('langs'), qualities: j('qualities'), tags: j('tags'), categoryIds: j('categoryIds'), posters: j('posters'), backdrops: j('backdrops'), exts: j('exts'), plots: j('plots'), casts: j('casts'), directors: j('directors'), genres: j('genres'), epg: j('epg'), categories: c.categories, ...(() => { const si = buildSearchIndex(c.items); return { searchText: si.text, searchOffsets: si.offsets } })() }
}

export function unpack(col: Columnar): Catalog {
  const s = (k: keyof Columnar) => (col[k] as string).split(SEP)
  const rawNames = s('rawNames'), titles = s('titles'), searchTitles = s('searchTitles'), langs = s('langs'), qualities = s('qualities'), tags = s('tags'), categoryIds = s('categoryIds'), posters = s('posters'), backdrops = s('backdrops'), exts = s('exts'), plots = s('plots'), casts = s('casts'), directors = s('directors'), genres = s('genres'), epg = s('epg')
  const EMPTY: string[] = []
  const items: MediaItem[] = new Array(col.n)
  const byCategory: Record<string, number[]> = {}
  const counts = { movie: 0, series: 0, live: 0 }
  for (let i = 0; i < col.n; i++) {
    const kind = KIND[col.kinds[i]]
    const it: MediaItem = {
      id: kind + ':' + col.streamIds[i],
      kind, rawName: rawNames[i], title: titles[i], searchTitle: searchTitles[i] || titles[i], streamId: col.streamIds[i], categoryId: categoryIds[i],
      tags: tags[i] ? tags[i].split(TAGSEP) : EMPTY, isAdult: !!(col.flags[i] & 1),
    }
    if (col.years[i]) it.year = col.years[i]
    if (col.seasons[i]) it.season = col.seasons[i]
    if (col.episodes[i]) it.episode = col.episodes[i]
    if (col.tmdbIds[i]) it.tmdbId = col.tmdbIds[i]
    if (col.ratings[i]) it.rating = col.ratings[i] / 10
    if (col.added[i]) it.added = col.added[i]
    if (langs[i]) it.lang = langs[i]
    if (qualities[i]) it.quality = qualities[i]
    if (posters[i]) it.poster = posters[i]
    if (backdrops[i]) it.backdrop = backdrops[i]
    if (exts[i]) it.ext = exts[i]
    if (plots[i]) it.plot = plots[i]
    if (casts[i]) it.cast = casts[i]
    if (directors[i]) it.director = directors[i]
    if (genres[i]) it.genre = genres[i]
    if (epg[i]) it.epgChannelId = epg[i]
    if (kind === 'live') it.tvArchive = !!(col.flags[i] & 2)
    items[i] = it; counts[kind]++
    ;(byCategory[kind + ':' + it.categoryId] ??= []).push(i)
  }
  return { items, categories: col.categories, byCategory, counts, generatedAt: col.generatedAt }
}

/** Same as unpack, but yields to the event loop every `step` items so a 300k restore never freezes the UI thread. */
export async function unpackAsync(col: Columnar, step = 25_000, onProgress?: (done: number, total: number) => void): Promise<Catalog> {
  const s = (k: keyof Columnar) => (col[k] as string).split(SEP)
  const rawNames = s('rawNames'), titles = s('titles'), searchTitles = s('searchTitles'), langs = s('langs'), qualities = s('qualities'), tags = s('tags'), categoryIds = s('categoryIds'), posters = s('posters'), backdrops = s('backdrops'), exts = s('exts'), epg = s('epg')
  const EMPTY: string[] = []
  const items: MediaItem[] = new Array(col.n)
  const byCategory: Record<string, number[]> = {}
  const counts = { movie: 0, series: 0, live: 0 }
  for (let i = 0; i < col.n; i++) {
    if (i && i % step === 0) { onProgress?.(i, col.n); await new Promise<void>((r) => setTimeout(r, 0)) }
    const kind = KIND[col.kinds[i]]
    const it: MediaItem = { id: kind + ':' + col.streamIds[i], kind, rawName: rawNames[i], title: titles[i], searchTitle: searchTitles[i] || titles[i], streamId: col.streamIds[i], categoryId: categoryIds[i], tags: tags[i] ? tags[i].split(TAGSEP) : EMPTY, isAdult: !!(col.flags[i] & 1) }
    if (col.years[i]) it.year = col.years[i]
    if (col.seasons[i]) it.season = col.seasons[i]
    if (col.episodes[i]) it.episode = col.episodes[i]
    if (col.tmdbIds[i]) it.tmdbId = col.tmdbIds[i]
    if (col.ratings[i]) it.rating = col.ratings[i] / 10
    if (col.added[i]) it.added = col.added[i]
    if (langs[i]) it.lang = langs[i]
    if (qualities[i]) it.quality = qualities[i]
    if (posters[i]) it.poster = posters[i]
    if (backdrops[i]) it.backdrop = backdrops[i]
    if (exts[i]) it.ext = exts[i]
    if (epg[i]) it.epgChannelId = epg[i]
    if (kind === 'live') it.tvArchive = !!(col.flags[i] & 2)
    items[i] = it; counts[kind]++
    ;(byCategory[kind + ':' + it.categoryId] ??= []).push(i)
  }
  return { items, categories: col.categories, byCategory, counts, generatedAt: col.generatedAt }
}

/** Case-folded search index: one big string with newline separators + offsets, so a search is one indexOf loop, no per-item work. */
export interface SearchIndex { text: string; offsets: Uint32Array }
export function buildSearchIndex(items: MediaItem[]): SearchIndex {
  const parts: string[] = new Array(items.length); const offsets = new Uint32Array(items.length + 1); let pos = 0
  for (let i = 0; i < items.length; i++) { const t = (items[i].title + ' ' + items[i].rawName).toLowerCase(); parts[i] = t; offsets[i] = pos; pos += t.length + 1 }
  offsets[items.length] = pos
  return { text: parts.join('\n'), offsets }
}
export function searchIndex(idx: SearchIndex, needle: string, limit = 200): number[] {
  const out: number[] = []; const q = needle.toLowerCase(); if (!q) return out
  let from = 0
  while (out.length < limit) {
    const at = idx.text.indexOf(q, from); if (at < 0) break
    let lo = 0, hi = idx.offsets.length - 2
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (idx.offsets[mid] <= at) lo = mid; else hi = mid - 1 }
    out.push(lo); from = idx.offsets[lo + 1]
  }
  return out
}

/* ---- IndexedDB persistence (one record; structured clone keeps typed arrays as-is) ---- */
const DB = 'iptv-catalog', STORE = 'snap'
function open(): Promise<IDBDatabase> { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }) }
export async function saveSnapshot(key: string, col: Columnar): Promise<void> { const d = await open(); await new Promise<void>((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(col, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error) }); d.close() }
export async function loadSnapshot(key: string): Promise<Columnar | undefined> { try { const d = await open(); const v = await new Promise<Columnar | undefined>((res) => { const r = d.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined) }); d.close(); return v?.v === 1 ? v : undefined } catch { return undefined } }
export async function clearSnapshots(): Promise<void> { try { const d = await open(); await new Promise<void>((res) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).clear(); t.oncomplete = () => res(); t.onerror = () => res() }); d.close() } catch { /* ignore */ } }

/* ---- wire format: string columns as transferable UTF-8 buffers (zero-copy between worker and UI) ---- */
const STRING_COLS = ['rawNames', 'titles', 'searchTitles', 'langs', 'qualities', 'tags', 'categoryIds', 'posters', 'backdrops', 'exts', 'plots', 'casts', 'directors', 'genres', 'epg', 'searchText'] as const
export type Wire = Omit<Columnar, (typeof STRING_COLS)[number]> & { wire: true; bytes: Record<(typeof STRING_COLS)[number], Uint8Array> }
export function toWire(col: Columnar): { wire: Wire; transfer: ArrayBuffer[] } {
  const enc = new TextEncoder()
  const bytes = {} as Wire['bytes']
  const transfer: ArrayBuffer[] = []
  for (const k of STRING_COLS) { const b = enc.encode((col[k] as string | undefined) ?? ''); bytes[k] = b; transfer.push(b.buffer as ArrayBuffer) }
  const rest = { ...col } as Record<string, unknown>
  for (const k of STRING_COLS) delete rest[k]
  const wire = { ...(rest as Omit<Columnar, (typeof STRING_COLS)[number]>), wire: true as const, bytes }
  for (const k of ['kinds', 'streamIds', 'years', 'seasons', 'episodes', 'tmdbIds', 'ratings', 'added', 'flags', 'searchOffsets'] as const) { const v = wire[k]; if (v) transfer.push(v.buffer as ArrayBuffer) }
  return { wire, transfer }
}
export function fromWire(w: Wire): Columnar {
  const dec = new TextDecoder()
  const out = { ...w } as unknown as Record<string, unknown>
  delete out.wire; delete out.bytes
  for (const k of STRING_COLS) out[k] = dec.decode(w.bytes[k])
  return out as unknown as Columnar
}
