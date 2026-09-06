import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Kind } from '../types'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import { useSettings } from '../store/settings'
import { useGenre } from '../hooks/useHomeRows'
import { MOVIE_GENRES, TV_GENRES } from '../api/tmdbLists'
import { hasTmdbKey } from '../api/tmdb'
import VirtualGrid from '../components/VirtualGrid'
import Hero from '../components/Hero'
import Row from '../components/Row'
import { MIN_ROW, hubRows } from '../catalog/hub'

const LABEL: Record<Kind, string> = { movie: 'Films', series: 'Séries', live: 'Live TV' }

/**
 * Films / Séries: TMDB genres only, on the viewer's catalogue (profile languages). Every page is
 * dynamic: rows built from the provider data of that genre, then the full grid.
 * Provider categories never appear here; they live in Settings › Catégories (enable / disable).
 * Without a TMDB key the page falls back to the provider categories.
 */
export default function Browse({ kind }: { kind: Kind }) {
  const catalog = useCatalog((s) => s.catalog)!
  const indicesOf = useCatalog((s) => s.indicesOf)
  const item = useCatalog((s) => s.item)
  const focusedId = useUi((s) => s.focusedId)
  const showUntagged = useSettings((s) => s.showUntagged)
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState('')
  const tmdb = hasTmdbKey()
  const genreName = params.get('genre') ?? ''
  const cat = params.get('cat') ?? ''
  const page: 'all' | 'genre' | 'other' | 'cat' = genreName === '_other' ? 'other' : genreName ? 'genre' : cat ? 'cat' : 'all'
  const GEN = kind === 'series' ? TV_GENRES : MOVIE_GENRES
  const genre = useGenre(kind, page === 'genre' ? GEN[genreName] : undefined)

  /** the viewer's catalogue for this kind (profile languages, hidden categories removed) */
  const all = useMemo(() => indicesOf(kind), [indicesOf, kind, catalog])
  const untagged = useMemo(() => all.filter((i) => !catalog.tmdbIds[i]), [all, catalog])
  const cats = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return catalog.categories.filter((c) => c.kind === kind && (indicesOf(kind, c.id).length) >= 4 && (!f || c.rawName.toLowerCase().includes(f)))
  }, [catalog, kind, filter, indicesOf])

  const indices = useMemo(() => {
    if (page === 'genre') return (genre.data ?? []).map((it) => catalog.indexOf(it.id)).filter((i): i is number => i !== undefined)
    if (page === 'other') return untagged
    if (page === 'cat') return indicesOf(kind, cat)
    return all
  }, [page, genre.data, catalog, untagged, all, indicesOf, kind, cat])
  const hub = useMemo(() => hubRows(catalog, indices, kind, `${kind}:${page}:${genreName}${cat}:`), [catalog, indices, kind, page, genreName, cat])
  const items = useMemo(() => (page === 'genre' ? genre.data ?? [] : catalog.list(indices)), [page, genre.data, catalog, indices])

  const heading = page === 'genre' ? genreName : page === 'other' ? 'Autres titres' : page === 'cat' ? (catalog.categories.find((c) => c.kind === kind && c.id === cat)?.name ?? cat) : 'Tout'
  const focused = (focusedId ? item(focusedId) : undefined) ?? hub[0]?.items[0] ?? items.at(0)
  const loading = page === 'genre' && genre.isLoading
  const side = `block w-full px-4 py-2 text-left text-sm`

  return (
    <div className="flex h-screen flex-col">
      <Hero item={focused && focused.kind === kind ? focused : undefined} compact />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-black/40 backdrop-blur">
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            <button onClick={() => setParams({})} className={`${side} ${page === 'all' ? 'bg-white/15' : 'hover:bg-white/5'}`}>Tout <span className="text-xs text-white/40">{all.length.toLocaleString('fr-FR')}</span></button>
            {tmdb ? (
              <>
                <p className="px-4 pb-1 pt-3 text-[10.5px] uppercase tracking-[.12em] text-white/35">Genres</p>
                {Object.keys(GEN).map((g) => (
                  <button key={g} onClick={() => setParams({ genre: g })} className={`${side} ${genreName === g ? 'bg-white/15' : 'hover:bg-white/5'}`}>{g}</button>
                ))}
                {showUntagged && untagged.length >= MIN_ROW && (
                  <button onClick={() => setParams({ genre: '_other' })} className={`${side} mt-3 border-t border-white/[.06] pt-3 ${page === 'other' ? 'bg-white/15' : 'hover:bg-white/5'}`}>Autres titres <span className="text-xs text-white/40">{untagged.length.toLocaleString('fr-FR')}</span><span className="block text-[11px] text-white/40">Sans fiche TMDB</span></button>
                )}
              </>
            ) : (
              <>
                <p className="px-4 pb-1 pt-3 text-[10.5px] uppercase tracking-[.12em] text-white/35">Catégories du serveur (pas de clé TMDB)</p>
                <div className="px-3 pb-2"><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filtrer ${cats.length}`} className="w-full rounded bg-white/10 px-3 py-1.5 text-sm outline-none" /></div>
                {cats.map((c) => <button key={c.id} onClick={() => setParams({ cat: c.id })} className={`${side} truncate ${c.id === cat ? 'bg-white/15' : 'hover:bg-white/5'}`}>{c.name}</button>)}
              </>
            )}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="px-8 pt-3 font-display text-xl font-bold">
            {LABEL[kind]} › {heading} <span className="text-sm font-normal text-white/40">{loading ? '…' : items.length.toLocaleString('fr-FR')}</span>
            {hub.length > 0 && <span className="ml-2 align-middle text-[10.5px] font-normal uppercase tracking-[.08em] text-white/35">· {hub.length} sélections</span>}
          </h2>
          <div className="min-h-0 flex-1">
            <VirtualGrid items={items} landscape={kind === 'live'} minWidth={kind === 'live' ? 200 : 150}
              header={hub.length ? <div className="-mx-8 mb-6 space-y-7 border-b border-white/[.06] pb-6">{hub.map((r) => <Row key={r.key} row={r} />)}</div> : undefined} />
          </div>
        </div>
      </div>
    </div>
  )
}
