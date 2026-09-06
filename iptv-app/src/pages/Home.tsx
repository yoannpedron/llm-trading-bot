import { useMemo } from 'react'
import { useCatalog } from '../store/catalog'
import { useHomeRows } from '../hooks/useHomeRows'
import { hasTmdbKey } from '../api/tmdb'
import HeroShow from '../components/HeroShow'
import Row from '../components/Row'
import type { ListRow } from '../api/tmdbLists'
import type { Kind } from '../types'

export default function Home() {
  const catalog = useCatalog((s) => s.catalog)!
  const { data: rows, isLoading, error } = useHomeRows()

  /** Fallback rows straight from the provider (no TMDB key, or TMDB down). */
  const providerRows = useMemo<ListRow[]>(() => {
    const recent = (kind: Kind, n: number) => catalog.items.filter((i) => i.kind === kind && i.poster).sort((a, b) => (b.added ?? 0) - (a.added ?? 0)).slice(0, n)
    const top = (kind: Kind) => catalog.categories.filter((c) => c.kind === kind).map((c) => ({ c, idx: catalog.byCategory[kind + ':' + c.id] ?? [] })).sort((a, b) => b.idx.length - a.idx.length).slice(0, 4)
      .map(({ c, idx }) => ({ key: c.id, kind, type: 'row' as const, name: c.name, items: idx.slice(0, 40).map((i) => catalog.items[i]) }))
    const rows: ListRow[] = [
      { key: 'recent-m', kind: 'movie', type: 'row', name: 'Ajouts récents · Films', items: recent('movie', 40) },
      { key: 'recent-s', kind: 'series', type: 'row', name: 'Ajouts récents · Séries', items: recent('series', 40) },
      ...top('movie'), ...top('series'),
      { key: 'live', kind: 'live', type: 'row', name: 'Chaînes', items: recent('live', 40) },
    ]
    return rows.filter((r) => r.items.length)
  }, [catalog])

  const list = rows?.length ? rows : providerRows
  const hero = rows?.[0]?.items.slice(0, 6) ?? providerRows[0]?.items.slice(0, 6) ?? []
  const liveRow = rows?.length ? providerRows.find((r) => r.kind === 'live') : undefined

  return (
    <div>
      <HeroShow items={hero} />
      <div className="relative -mt-4 flex flex-col gap-7 pb-16">
        {!hasTmdbKey() && <p className="mx-6 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm text-amber-200 md:mx-12">Clé TMDB absente : rangées construites à partir des catégories du serveur uniquement.</p>}
        {isLoading && <p className="px-6 text-sm text-white/40 md:px-12">Construction des rangées TMDB…</p>}
        {error ? <p className="px-6 text-sm text-red-300 md:px-12">TMDB indisponible ({String(error)}), affichage des catégories serveur.</p> : null}
        {list.map((r) => <Row key={r.key} row={r} to={r.kind === 'live' ? '/live' : undefined} />)}
        {liveRow && <Row row={liveRow} to="/live" />}
      </div>
    </div>
  )
}
