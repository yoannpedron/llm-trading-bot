import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCatalog } from '../store/catalog'
import { useMatches } from '../hooks/useMatches'
import Player from '../components/Player'

/** Up to four live streams side by side, one with sound. Bound by the subscription's connection limit. */
export default function Multi() {
  const [params, setParams] = useSearchParams()
  const item = useCatalog((s) => s.item)
  const client = useCatalog((s) => s.client)
  const ids = useMemo(() => (params.get('ids') ?? '').split(',').filter(Boolean).slice(0, 4), [params])
  const [sound, setSound] = useState(0)
  const { cards } = useMatches()
  const items = ids.map(item).filter((x): x is NonNullable<typeof x> => !!x)
  const remove = (id: string) => setParams({ ids: ids.filter((x) => x !== id).join(',') })
  const add = (id: string) => setParams({ ids: [...ids, id].slice(0, 4).join(',') })
  return (
    <div className="px-4 pb-24 pt-16 md:px-8">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="font-display text-2xl font-extrabold">Multi-match</h1>
        <span className="text-xs text-white/40">{items.length} flux simultanés. Chaque flux compte comme une connexion sur ton abonnement.</span>
        <Link to="/sport" className="ml-auto text-sm text-white/60 hover:text-white">← Match Center</Link>
      </div>
      {!client && <p className="mb-3 rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-200">Mode démo : aucun flux réel.</p>}
      <div className={`grid gap-3 ${items.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {items.map((it, i) => {
          const card = cards.find((c) => c.sources.some((s) => s.item.id === it.id))
          return (
            <div key={it.id} className={`relative rounded-xl ${sound === i ? 'ring-2 ring-amber-400' : ''}`} onClick={() => setSound(i)}>
              {client ? <Player src={client.liveUrl(it.streamId)} title={it.title} muted={sound !== i} /> : <div className="grid aspect-video place-items-center rounded-xl bg-black text-white/40">{it.title}</div>}
              <div className="mt-1 flex items-center gap-2 text-xs text-white/70">
                <span className="truncate">{card ? `${card.match.home} ${card.match.homeScore ?? ''}–${card.match.awayScore ?? ''} ${card.match.away}` : it.title}</span>
                {sound === i ? <span className="rounded bg-amber-400 px-1.5 text-[10px] font-bold text-black">SON</span> : <span className="text-white/40">muet</span>}
                <button onClick={(e) => { e.stopPropagation(); remove(it.id) }} className="ml-auto text-white/40 hover:text-red-300">Retirer</button>
              </div>
            </div>
          )
        })}
      </div>
      {ids.length < 4 && (
        <div className="mt-6">
          <h2 className="mb-2 font-display text-base font-bold">Ajouter un match en direct</h2>
          <div className="flex flex-wrap gap-2">
            {cards.filter((c) => c.match.state === 'in' && !c.sources.some((s) => ids.includes(s.item.id))).map((c) => <button key={c.match.id} onClick={() => add(c.sources[0].item.id)} className="rounded-full bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">+ {c.match.homeShort ?? c.match.home} – {c.match.awayShort ?? c.match.away}</button>)}
          </div>
        </div>
      )}
    </div>
  )
}
