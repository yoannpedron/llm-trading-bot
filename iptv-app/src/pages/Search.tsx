import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import Carousel from '../components/Carousel'
import Hero from '../components/Hero'

export default function Search() {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const search = useCatalog((s) => s.search)
  const item = useCatalog((s) => s.item)
  const focusedId = useUi((s) => s.focusedId)
  const res = useMemo(() => ({ movie: search(q, 'movie', 100), series: search(q, 'series', 100), live: search(q, 'live', 100) }), [q, search])
  const total = res.movie.length + res.series.length + res.live.length
  return (
    <div>
      <Hero item={focusedId ? item(focusedId) : res.movie[0] ?? res.series[0]} compact />
      <h2 className="px-8 text-xl font-semibold">Résultats pour « {q} » <span className="text-sm text-white/40">{total}</span></h2>
      <Carousel title="Films" items={res.movie} />
      <Carousel title="Séries" items={res.series} />
      <Carousel title="Chaînes" items={res.live} landscape width={200} />
      {!total && <p className="px-8 py-10 text-white/40">Aucun résultat.</p>}
    </div>
  )
}
