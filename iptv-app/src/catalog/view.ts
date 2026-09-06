/**
 * Lazy view over a columnar catalogue. Nothing is materialised up front: an entry is decoded from its
 * UTF-8 bytes the first time the UI touches it, and MediaItem objects exist only for those entries
 * (a few hundred at a time on a 300k catalogue). This is what keeps old phones alive.
 */
import type { Category, Kind, MediaItem } from '../types'
import { TAGSEP, entries, entry, type Columnar, type StrCol, type StrName } from './columnar'

const KIND: Kind[] = ['movie', 'series', 'live']

export interface ItemList { length: number; at(i: number): MediaItem | undefined }

export class CatalogView {
  readonly n: number
  readonly categories: Category[]
  readonly counts: Record<Kind, number>
  readonly generatedAt: number
  /** indices per `${kind}:${categoryId}` */
  readonly byCategory: Record<string, number[]>
  private col: Columnar
  private cols = new Map<string, string[]>()
  private cache: (MediaItem | undefined)[]
  private idMap?: Map<number, number>

  constructor(col: Columnar) {
    this.col = col; this.n = col.n; this.categories = col.categories; this.generatedAt = col.generatedAt
    this.cache = new Array(col.n)
    const counts = { movie: 0, series: 0, live: 0 }
    const byCategory: Record<string, number[]> = {}
    const catIds = this.column('categoryIds')
    for (let i = 0; i < col.n; i++) { const k = KIND[col.kinds[i]]; counts[k]++; (byCategory[k + ':' + catIds[i]] ??= []).push(i) }
    this.counts = counts; this.byCategory = byCategory
  }

  /** whole column as strings, decoded once. Only for small columns (langs, qualities, categoryIds, exts, epg). */
  column(name: 'langs' | 'qualities' | 'categoryIds' | 'exts' | 'epg'): string[] {
    let c = this.cols.get(name)
    if (!c) { c = entries(this.col.strs[name]); this.cols.set(name, c) }
    return c
  }
  /** one entry of any string column, decoded on demand */
  str(name: StrName, i: number): string { return entry(this.col.strs[name], i) }
  /** non-empty test without decoding */
  has(name: StrName, i: number): boolean { const o = this.col.strs[name].offsets; return o[i + 1] > o[i] }
  get kinds() { return this.col.kinds }
  get tmdbIds() { return this.col.tmdbIds }
  get added() { return this.col.added }
  get ratings() { return this.col.ratings }
  get years() { return this.col.years }
  get streamIds() { return this.col.streamIds }
  get flags() { return this.col.flags }
  get search(): StrCol { return this.col.search }
  kindOf(i: number): Kind { return KIND[this.col.kinds[i]] }
  idOf(i: number): string { return KIND[this.col.kinds[i]] + ':' + this.col.streamIds[i] }
  rawNameOf(i: number): string { return this.str('rawNames', i) }
  titleOf(i: number): string { return this.str('titles', i) }
  langOf(i: number): string { return this.column('langs')[i] }
  posterOf(i: number): string { return this.str('posters', i) }
  isAdult(i: number): boolean { return !!(this.col.flags[i] & 1) }

  /** index of an item id (`movie:123`), O(1) after a one-off numeric map build */
  indexOf(id: string): number | undefined {
    if (!this.idMap) { this.idMap = new Map(); for (let i = 0; i < this.n; i++) this.idMap.set(this.col.kinds[i] * 4294967296 + this.col.streamIds[i], i) }
    const c = id.indexOf(':'); const k = KIND.indexOf(id.slice(0, c) as Kind); const sid = +id.slice(c + 1)
    if (k < 0 || !Number.isFinite(sid)) return undefined
    return this.idMap.get(k * 4294967296 + sid)
  }
  item(id: string): MediaItem | undefined { const i = this.indexOf(id); return i === undefined ? undefined : this.at(i) }

  /** materialise one entry (cached; objects keep identity across renders) */
  at(i: number): MediaItem | undefined {
    if (i < 0 || i >= this.n) return undefined
    const c = this.cache[i]; if (c) return c
    const col = this.col, kind = KIND[col.kinds[i]]
    const title = this.str('titles', i), st = this.str('searchTitles', i), tags = this.str('tags', i)
    const it: MediaItem = { id: kind + ':' + col.streamIds[i], kind, rawName: this.str('rawNames', i), title, searchTitle: st || title, streamId: col.streamIds[i], categoryId: this.column('categoryIds')[i], tags: tags ? tags.split(TAGSEP) : EMPTY, isAdult: !!(col.flags[i] & 1) }
    if (col.years[i]) it.year = col.years[i]
    if (col.tmdbIds[i]) it.tmdbId = col.tmdbIds[i]
    if (col.ratings[i]) it.rating = col.ratings[i] / 10
    if (col.added[i]) it.added = col.added[i]
    const lang = this.column('langs')[i]; if (lang) it.lang = lang
    const q = this.column('qualities')[i]; if (q) it.quality = q
    const p = this.str('posters', i); if (p) it.poster = p
    const b = this.str('backdrops', i); if (b) it.backdrop = b
    const e = this.column('exts')[i]; if (e) it.ext = e
    if (col.seasons[i]) it.season = col.seasons[i]
    if (col.episodes[i]) it.episode = col.episodes[i]
    if (kind === 'live') { const epg = this.column('epg')[i]; if (epg) it.epgChannelId = epg; it.tvArchive = !!(col.flags[i] & 2) }
    this.cache[i] = it
    return it
  }
  /** a lazy list over indices for virtualised grids and carousels */
  list(indices: number[]): ItemList { return { length: indices.length, at: (i) => this.at(indices[i]) } }
  materialize(indices: number[]): MediaItem[] { const out: MediaItem[] = []; for (const i of indices) { const it = this.at(i); if (it) out.push(it) } return out }
  /** indices of a kind, optionally filtered */
  indicesOf(kind: Kind, pred?: (i: number) => boolean): number[] {
    const k = KIND.indexOf(kind); const out: number[] = []
    for (let i = 0; i < this.n; i++) if (this.col.kinds[i] === k && (!pred || pred(i))) out.push(i)
    return out
  }
  /** top-n indices by a numeric score in one pass; score < 0 skips */
  topN(n: number, score: (i: number) => number): number[] {
    const best: { s: number; i: number }[] = []; let min = -1
    for (let i = 0; i < this.n; i++) { const s = score(i); if (s < 0 || (best.length >= n && s <= min)) continue; best.push({ s, i }); best.sort((a, b) => b.s - a.s); if (best.length > n) best.pop(); min = best[best.length - 1].s }
    return best.map((b) => b.i)
  }
}
const EMPTY: string[] = []
