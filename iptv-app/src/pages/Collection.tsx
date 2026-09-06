import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { collection } from '../api/tmdbLists'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'

export default function Collection() {
  const { id = '' } = useParams()
  const idx = useCatalog((s) => s.tmdbIndex)
  const setBackdrop = useUi((s) => s.setBackdrop)
  const { data: c, isLoading } = useQuery({ queryKey: ['collection', id], queryFn: () => collection(+id, idx), staleTime: 30 * 60 * 1000 })
  useEffect(() => { if (c?.backdrop) setBackdrop(c.backdrop) }, [c?.backdrop, setBackdrop])
  if (isLoading) return <p className="p-24 text-white/40">Chargement…</p>
  if (!c) return <p className="p-24">Saga introuvable.</p>
  return (
    <div className="mx-auto max-w-4xl px-6 pb-20 pt-[38vh] md:px-12">
      <h1 className="font-display text-4xl font-black tracking-tight text-shadow md:text-5xl">{c.name}</h1>
      <p className="mb-8 mt-2 text-sm text-white/70">{c.total} films · <span className={c.complete ? 'font-semibold text-amber-400' : ''}>{c.complete ? 'Saga complète sur le serveur' : `${c.have} disponibles sur le serveur`}</span></p>
      <h3 className="mb-3 font-display text-lg font-bold">Dans l'ordre de sortie</h3>
      <ol className="flex flex-col gap-2">
        {c.parts.map((p) => {
          const inner = (
            <>
              {p.poster ? <img src={p.poster} alt="" className="w-11 shrink-0 rounded object-cover" style={{ aspectRatio: '2/3' }} loading="lazy" /> : <div className="w-11 shrink-0 rounded bg-white/10" style={{ aspectRatio: '2/3' }} />}
              <div className="min-w-0 flex-1"><b className="block truncate font-semibold">{p.title}</b><span className="text-xs text-white/50">{p.year}{p.rating ? ` · ★ ${p.rating.toFixed(1)}` : ''}</span></div>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${p.item ? 'bg-amber-400/15 text-amber-400' : 'bg-white/10 text-white/60'}`}>{p.item ? 'Disponible' : 'Absent'}</span>
            </>
          )
          return (
            <li key={p.tmdbId}>
              {p.item ? <Link to={`/details/${p.item.id}`} className="flex items-center gap-3 rounded-lg bg-white/5 p-2 hover:bg-white/10">{inner}</Link> : <div className="flex items-center gap-3 rounded-lg bg-white/5 p-2 opacity-50">{inner}</div>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
