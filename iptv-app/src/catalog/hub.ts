/**
 * Dynamic rows straight from provider data, for any set of indices (a server category, a kind, a country…).
 * Polymorphic by construction: a row exists only when this provider has enough titles for it, so a
 * 40-title category shows two rows and a 20k-title one shows twelve. Typed-array passes only.
 */
import type { Kind } from '../types'
import type { ListRow } from '../api/tmdbLists'
import type { CatalogView } from './view'
import { PREFIX_INFO } from '../store/profile'

export const MIN_ROW = 8        // a row needs at least this many titles
export const MIN_HUB = 24       // below this, a category is just a grid
const ROW = 30

export function hubRows(view: CatalogView, indices: number[], kind: Kind, prefix = ''): ListRow[] {
  if (indices.length < MIN_HUB) return []
  const rows: ListRow[] = []
  const added = view.added, ratings = view.ratings, years = view.years, langs = view.column('langs'), quals = view.column('qualities')
  const key = (k: string) => prefix + k
  const top = (n: number, score: (i: number) => number): number[] => {
    const best: { s: number; i: number }[] = []; let min = -1
    for (const i of indices) { const s = score(i); if (s < 0 || (best.length >= n && s <= min)) continue; best.push({ s, i }); best.sort((a, b) => b.s - a.s); if (best.length > n) best.pop(); min = best[best.length - 1].s }
    return best.map((b) => b.i)
  }
  const push = (k: string, name: string, idx: number[], sub?: string, type: ListRow['type'] = 'row') => { if (idx.length >= MIN_ROW) rows.push({ key: key(k), kind, type, name, sub, items: view.materialize(idx), src: 'Serveur' }) }

  // 1. recent additions (only meaningful if the provider timestamps them)
  let stamped = 0; for (const i of indices) if (added[i]) stamped++
  if (stamped >= MIN_ROW) push('recent', 'Ajouts récents', top(ROW, (i) => (added[i] && view.has('posters', i) ? added[i] : -1)), 'Derniers titres publiés par le serveur')
  // 2. best rated (needs real ratings: ≥ 7.0 and a poster)
  push('rated', 'Les mieux notés', top(ROW, (i) => (ratings[i] >= 70 && view.has('posters', i) ? ratings[i] * 10000 + (years[i] || 0) : -1)), 'Note ≥ 7', kind === 'live' ? 'row' : 'top10')
  if (kind !== 'live') {
    // 3. this year / last year
    const y = new Date().getFullYear()
    push('new', `Sorties ${y}`, top(ROW, (i) => (years[i] === y && view.has('posters', i) ? ratings[i] + 1 : -1)))
    push('last', `Sorties ${y - 1}`, top(ROW, (i) => (years[i] === y - 1 && view.has('posters', i) ? ratings[i] + 1 : -1)))
    // 4. decades, only the ones this category actually covers
    const decades = new Map<number, number>()
    for (const i of indices) { const d = years[i] ? Math.floor(years[i] / 10) * 10 : 0; if (d && d < y - 10) decades.set(d, (decades.get(d) ?? 0) + 1) }
    for (const [d] of [...decades.entries()].filter(([, n]) => n >= MIN_ROW).sort((a, b) => b[0] - a[0]).slice(0, 4))
      push('dec' + d, `Années ${d}`, top(ROW, (i) => (years[i] >= d && years[i] < d + 10 && view.has('posters', i) ? ratings[i] + 1 : -1)))
    // 5. 4K versions
    push('4k', '4K · UHD', top(ROW, (i) => (langs[i] === '4K' || /^(4K|UHD|2160P)$/.test(quals[i]) ? ratings[i] + 1 : -1)), 'Versions ultra-haute définition')
    // 6. language versions when the category mixes several
    const byLang = new Map<string, number>()
    for (const i of indices) if (langs[i] && PREFIX_INFO[langs[i]]) byLang.set(langs[i], (byLang.get(langs[i]) ?? 0) + 1)
    if (byLang.size >= 2) for (const [l] of [...byLang.entries()].filter(([, n]) => n >= MIN_ROW).sort((a, b) => b[1] - a[1]).slice(0, 5))
      push('lang' + l, `${PREFIX_INFO[l].flag} ${PREFIX_INFO[l].name}`, top(ROW, (i) => (langs[i] === l && view.has('posters', i) ? ratings[i] + 1 : -1)))
  }
  // dedupe across rows: a title appears in the first row that claims it ("recent" is chronological and claims nothing)
  const seen = new Set<string>()
  for (const r of rows) if (!r.key.endsWith('recent')) r.items = r.items.filter((it) => !seen.has(it.id) && (seen.add(it.id), true))
  return rows.filter((r) => r.items.length >= (r.type === 'top10' ? 5 : MIN_ROW))
}
