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
}
export const SEP = '', TAGSEP = ''
const KIND: Kind[] = ['movie', 'series', 'live']

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
    rawNames: j('rawNames'), titles: j('titles'), searchTitles: j('searchTitles'), langs: j('langs'), qualities: j('qualities'), tags: j('tags'), categoryIds: j('categoryIds'), posters: j('posters'), backdrops: j('backdrops'), exts: j('exts'), plots: j('plots'), casts: j('casts'), directors: j('directors'), genres: j('genres'), epg: j('epg'), categories: c.categories }
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
  const rawNames = s('rawNames'), titles = s('titles'), searchTitles = s('searchTitles'), langs = s('langs'), qualities = s('qualities'), tags = s('tags'), categoryIds = s('categoryIds'), posters = s('posters'), backdrops = s('backdrops'), exts = s('exts'), plots = s('plots'), casts = s('casts'), directors = s('directors'), genres = s('genres'), epg = s('epg')
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
