import { useEffect, useMemo } from 'react'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import Hero from '../components/Hero'
import Carousel from '../components/Carousel'
import type { Kind, MediaItem } from '../types'

const RECENT = 40
const ROWS_PER_KIND = 4

export default function Home() {
  const catalog = useCatalog((s) => s.catalog)!
  const item = useCatalog((s) => s.item)
  const focusedId = useUi((s) => s.focusedId)
  const setFocused = useUi((s) => s.setFocused)

  const rows = useMemo(() => {
    const recent = (kind: Kind) =>
      catalog.items.filter((i) => i.kind === kind && i.poster).sort((a, b) => (b.added ?? 0) - (a.added ?? 0)).slice(0, RECENT)
    const topCats = (kind: Kind) =>
      catalog.categories.filter((c) => c.kind === kind)
        .map((c) => ({ c, idx: catalog.byCategory[kind + ':' + c.id] ?? [] }))
        .sort((a, b) => b.idx.length - a.idx.length)
        .slice(0, ROWS_PER_KIND)
        .map(({ c, idx }) => ({ title: `${c.name}${c.lang ? ` (${c.lang})` : ''}`, items: idx.slice(0, 60).map((i) => catalog.items[i]), to: `/${kind === 'movie' ? 'movies' : kind}?cat=${c.id}`, kind }))
    return [
      { title: 'Films récemment ajoutés', items: recent('movie'), to: '/movies', kind: 'movie' as Kind },
      { title: 'Séries récentes', items: recent('series'), to: '/series', kind: 'series' as Kind },
      ...topCats('movie'), ...topCats('series'),
      { title: 'Chaînes populaires', items: recent('live'), to: '/live', kind: 'live' as Kind },
    ].filter((r) => r.items.length)
  }, [catalog])

  const focused: MediaItem | undefined = (focusedId && item(focusedId)) || rows[0]?.items[0]
  useEffect(() => { if (!focusedId && focused) setFocused(focused.id) }, [focusedId, focused, setFocused])

  return (
    <div>
      <Hero item={focused} />
      <div className="relative space-y-2 pb-12">
        {rows.map((r) => <Carousel key={r.title} title={r.title} items={r.items} to={r.to} landscape={r.kind === 'live'} width={r.kind === 'live' ? 200 : 150} />)}
      </div>
    </div>
  )
}
