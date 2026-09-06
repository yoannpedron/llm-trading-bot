import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import Carousel from '../components/Carousel'
import Hero from '../components/Hero'

export default function Search() {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const searchSplit = useCatalog((s) => s.searchSplit)
  const search = useCatalog((s) => s.search)
  const item = useCatalog((s) => s.item)
  const focusedId = useUi((s) => s.focusedId)
  const [more, setMore] = useState(false)
  const res = useMemo(() => ({ movie: searchSplit(q, 'movie', 100), series: searchSplit(q, 'series', 100), live: search(q, 'live', 100) }), [q, search, searchSplit])
  const mine = res.movie.mine.length + res.series.mine.length + res.live.length
  const other = res.movie.other.length + res.series.other.length
  return (
    <div>
      <Hero item={focusedId ? item(focusedId) : res.movie.mine[0] ?? res.series.mine[0] ?? res.movie.other[0]} compact />
      <h2 className="px-8 text-xl font-semibold">Résultats pour « {q} » <span className="text-sm text-white/40">{mine}</span></h2>
      <Carousel title="Films" items={res.movie.mine} />
      <Carousel title="Séries" items={res.series.mine} />
      <Carousel title="Chaînes" items={res.live} landscape width={200} />
      {!mine && <p className="px-8 py-6 text-white/40">Aucun résultat dans tes langues.</p>}
      {other > 0 && (
        <div className="mt-6 border-t border-white/[.06] pt-4">
          <button onClick={() => setMore((m) => !m)} className="mx-8 flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-sm hover:bg-white/15">
            {more ? '▾' : '▸'} Autres langues <span className="text-white/50">{other}</span>
          </button>
          {more && (
            <div className="mt-3">
              <Carousel title="Films · autres langues" items={res.movie.other} />
              <Carousel title="Séries · autres langues" items={res.series.other} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
