import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Kind } from '../types'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import { useGenre, useHomeRows } from '../hooks/useHomeRows'
import { MOVIE_GENRES, TV_GENRES } from '../api/tmdbLists'
import { hasTmdbKey } from '../api/tmdb'
import VirtualGrid from '../components/VirtualGrid'
import Hero from '../components/Hero'

const LABEL: Record<Kind, string> = { movie: 'Films', series: 'Séries', live: 'Live TV' }

/**
 * Two browsing modes: TMDB genres (official taxonomy, sorted by popularity, filtered to the
 * catalogue) and the provider's own categories (everything, incl. titles TMDB doesn't know).
 */
export default function Browse({ kind }: { kind: Kind }) {
  const catalog = useCatalog((s) => s.catalog)!
  const itemsOf = useCatalog((s) => s.itemsOf)
  const item = useCatalog((s) => s.item)
  const focusedId = useUi((s) => s.focusedId)
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState('')
  const cat = params.get('cat') ?? ''
  const genreName = params.get('genre') ?? ''
  const tmdbMode = kind !== 'live' && hasTmdbKey() && !cat && (params.get('mode') ?? 'tmdb') === 'tmdb'
  const GEN = kind === 'series' ? TV_GENRES : MOVIE_GENRES
  const genre = useGenre(kind, tmdbMode && genreName ? GEN[genreName] : undefined)
  const home = useHomeRows()

  const cats = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return catalog.categories.filter((c) => c.kind === kind && (!f || c.rawName.toLowerCase().includes(f)))
  }, [catalog, kind, filter])

  const items = useMemo(() => {
    if (tmdbMode) {
      if (genreName) return genre.data ?? []
      const seen = new Set<string>(); const out = []
      for (const r of home.data ?? []) if (r.kind === kind && r.type !== 'collection') for (const i of r.items) if (!seen.has(i.id)) { seen.add(i.id); out.push(i) }
      return out
    }
    return itemsOf(kind, cat || undefined)
  }, [tmdbMode, genreName, genre.data, home.data, kind, itemsOf, cat])

  const current = catalog.categories.find((c) => c.kind === kind && c.id === cat)
  const focused = focusedId ? item(focusedId) : undefined
  const sideRef = useRef<HTMLDivElement>(null)
  const sv = useVirtualizer({ count: cats.length, getScrollElement: () => sideRef.current, estimateSize: () => 36, overscan: 10 })
  useEffect(() => { const i = cats.findIndex((c) => c.id === cat); if (i >= 0) sv.scrollToIndex(i, { align: 'center' }) }, [cat, cats, sv])

  const heading = tmdbMode ? (genreName || 'Sélection TMDB') : current ? current.name : 'Tout'
  const loading = tmdbMode && (genreName ? genre.isLoading : home.isLoading)

  return (
    <div className="flex h-screen flex-col">
      <Hero item={focused && focused.kind === kind ? focused : undefined} compact />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-white/10 bg-black/40 backdrop-blur">
          {kind !== 'live' && hasTmdbKey() && (
            <div className="m-3 grid grid-cols-2 rounded-lg bg-white/10 p-0.5 text-xs">
              <button onClick={() => setParams({})} className={`rounded-md py-1.5 ${tmdbMode ? 'bg-white text-black font-semibold' : ''}`}>Genres TMDB</button>
              <button onClick={() => setParams({ mode: 'server' })} className={`rounded-md py-1.5 ${!tmdbMode ? 'bg-white text-black font-semibold' : ''}`}>Catégories serveur</button>
            </div>
          )}
          {tmdbMode ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <button onClick={() => setParams({})} className={`block w-full px-4 py-2 text-left text-sm ${!genreName ? 'bg-white/15' : 'hover:bg-white/5'}`}>Sélection de la semaine</button>
              {Object.keys(GEN).map((g) => (
                <button key={g} onClick={() => setParams({ genre: g })} className={`block w-full px-4 py-2 text-left text-sm ${genreName === g ? 'bg-white/15' : 'hover:bg-white/5'}`}>{g}</button>
              ))}
            </div>
          ) : (
            <>
              <div className="px-3 pb-3">
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filtrer ${cats.length} catégories`} className="w-full rounded bg-white/10 px-3 py-1.5 text-sm outline-none" />
              </div>
              <button onClick={() => setParams({ mode: 'server' })} className={`px-4 py-2 text-left text-sm ${!cat ? 'bg-white/15' : 'hover:bg-white/5'}`}>Tout · {catalog.counts[kind]}</button>
              <div ref={sideRef} className="min-h-0 flex-1 overflow-y-auto">
                <div className="relative" style={{ height: sv.getTotalSize() }}>
                  {sv.getVirtualItems().map((vi) => {
                    const c = cats[vi.index]
                    const n = catalog.byCategory[kind + ':' + c.id]?.length ?? 0
                    return (
                      <button key={c.id} onClick={() => setParams({ mode: 'server', cat: c.id })} className={`absolute left-0 flex w-full items-center gap-2 px-4 text-left text-sm ${c.id === cat ? 'bg-white/15' : 'hover:bg-white/5'}`} style={{ top: vi.start, height: 36 }}>
                        {c.lang && <span className="rounded bg-white/10 px-1 text-[10px] text-white/70">{c.lang}</span>}
                        <span className="truncate">{c.name}</span>
                        <span className="ml-auto text-xs text-white/40">{n}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="px-8 pt-3 font-display text-xl font-bold">
            {LABEL[kind]} › {heading} <span className="text-sm font-normal text-white/40">{loading ? '…' : items.length}</span>
          </h2>
          <div className="min-h-0 flex-1">
            <VirtualGrid items={items} landscape={kind === 'live'} minWidth={kind === 'live' ? 200 : 150} />
          </div>
        </div>
      </div>
    </div>
  )
}
