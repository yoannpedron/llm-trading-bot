import { useMemo } from 'react'
import { useCatalog } from '../store/catalog'
import { useProgress } from '../store/progress'
import { useProfile } from '../store/profile'
import { useSettings } from '../store/settings'
import { parseEvent } from '../parser/live'
import { useHomeRows } from '../hooks/useHomeRows'
import { hasTmdbKey } from '../api/tmdb'
import HeroShow from '../components/HeroShow'
import Row from '../components/Row'
import type { ListRow } from '../api/tmdbLists'
import type { Kind } from '../types'

const KIDS = /Animation|Familial|Anime|Enfant|Kids/i

export default function Home() {
  const catalog = useCatalog((s) => s.catalog)!
  const { data: rows, isLoading, error } = useHomeRows()
  const progress = useProgress((s) => s.map)
  const item = useCatalog((s) => s.item)
  const kids = useProfile((s) => s.kids)
  const resume = useMemo<ListRow | undefined>(() => { const items = Object.entries(progress).sort((a, b) => b[1].updated - a[1].updated).map(([id]) => item(id)).filter((x): x is NonNullable<typeof x> => !!x); return items.length ? { key: 'resume', kind: 'movie', type: 'row', name: 'Continuer à regarder', sub: 'Reprise là où tu t’es arrêté', items } : undefined }, [progress, item])

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

  const { hiddenRows, pinnedRows, rowOrder, renamedRows } = useSettings()
  const matches = useMemo<ListRow | undefined>(() => {
    const now = new Date(); const soon = now.getTime() + 60 * 60000
    const items = catalog.items.filter((i) => { if (i.kind !== 'live') return false; const e = parseEvent(i.rawName, now); return !!e && !!e.start && (e.status === 'live' || (e.status === 'next' && e.start.getTime() <= soon)) })
      .sort((a, b) => (parseEvent(a.rawName, now)!.start!.getTime()) - (parseEvent(b.rawName, now)!.start!.getTime())).slice(0, 30)
    return items.length ? { key: 'matches', kind: 'live', type: 'row', name: 'Matchs en direct et dans l’heure', sub: 'Scores et sources dans le Match Center', items } : undefined
  }, [catalog])
  const list = useMemo(() => {
    const base = [...(rows?.length ? rows : providerRows)]
    if (matches) base.splice(Math.min(2, base.length), 0, matches)
    const withPrefs = base.filter((r) => !hiddenRows.includes(r.key) && (!kids || KIDS.test(r.name))).map((r) => renamedRows[r.key] ? { ...r, name: renamedRows[r.key] } : r)
    const pos = (k: string) => { const i = rowOrder.indexOf(k); return i < 0 ? 1e6 : i }
    return withPrefs.sort((a, b) => Number(pinnedRows.includes(b.key)) - Number(pinnedRows.includes(a.key)) || pos(a.key) - pos(b.key))
  }, [rows, providerRows, matches, hiddenRows, pinnedRows, rowOrder, renamedRows, kids])
  const hero = (list.find((r) => r.kind !== 'live' && r.items.length) ?? providerRows[0])?.items.slice(0, 6) ?? []

  return (
    <div>
      <HeroShow items={hero} />
      <div className="relative -mt-4 flex flex-col gap-7 pb-16">
        {!hasTmdbKey() && <p className="mx-6 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm text-amber-200 md:mx-12">Clé TMDB absente : rangées construites à partir des catégories du serveur uniquement.</p>}
        {isLoading && <p className="px-6 text-sm text-white/40 md:px-12">Construction des rangées TMDB…</p>}
        {error ? <p className="px-6 text-sm text-red-300 md:px-12">TMDB indisponible ({String(error)}), affichage des catégories serveur.</p> : null}
        {resume && !kids && <Row row={resume} />}
        {kids && <p className="mx-6 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-200 md:mx-12">Mode enfant actif : animation et famille uniquement. Désactivable dans le profil.</p>}
        {list.map((r) => <Row key={r.key} row={r} to={r.key === 'matches' ? '/sport' : r.kind === 'live' ? '/live' : undefined} />)}
      </div>
    </div>
  )
}
