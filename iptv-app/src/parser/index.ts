import type { Catalog, Category, MediaItem, RawCatalog } from '../types'
import { normalizeCategory, normalizeLive, normalizeSeries, normalizeVod } from './normalize'

export interface ParseOptions { includeAdult?: boolean }

/** Pure function: raw Xtream payloads -> indexed Catalog. Runs inside a Web Worker. */
export function parseCatalog(raw: RawCatalog, opts: ParseOptions = {}): Catalog {
  const categories: Category[] = [
    ...raw.vodCategories.map((c) => normalizeCategory(c, 'movie')),
    ...raw.seriesCategories.map((c) => normalizeCategory(c, 'series')),
    ...raw.liveCategories.map((c) => normalizeCategory(c, 'live')),
  ]
  const catName = new Map(categories.map((c) => [c.kind + ':' + c.id, c.rawName]))
  const name = (kind: string, id: string | number) => catName.get(kind + ':' + id) ?? ''

  const items: MediaItem[] = []
  const push = (it: MediaItem) => { if (opts.includeAdult || !it.isAdult) items.push(it) }
  for (const v of raw.vod) push(normalizeVod(v, name('movie', v.category_id)))
  for (const s of raw.series) push(normalizeSeries(s, name('series', s.category_id)))
  for (const l of raw.live) push(normalizeLive(l, name('live', l.category_id)))

  const byCategory: Record<string, number[]> = {}
  const counts = { movie: 0, series: 0, live: 0 }
  items.forEach((it, i) => {
    counts[it.kind]++
    ;(byCategory[it.kind + ':' + it.categoryId] ??= []).push(i)
  })
  const adultCat = /adult|xxx|18\+|porn|\bx\b/i
  return {
    items,
    categories: categories.filter((c) => (opts.includeAdult || !adultCat.test(c.rawName)) && byCategory[c.kind + ':' + c.id]?.length),
    byCategory,
    counts,
    generatedAt: Date.now(),
  }
}

export { cleanTitle, cleanCategory } from './regex'
export { classify } from './classify'
