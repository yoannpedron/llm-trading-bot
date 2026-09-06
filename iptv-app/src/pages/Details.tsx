import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import { useEnrich } from '../hooks/useEnrich'
import Hero from '../components/Hero'
import type { XtreamSeriesInfo } from '../api/xtream'

export default function Details() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const item = useCatalog((s) => s.item(id))
  const client = useCatalog((s) => s.client)
  const catalog = useCatalog((s) => s.catalog)!
  const setFocused = useUi((s) => s.setFocused)
  const { data, isLoading } = useEnrich(item)
  useEffect(() => { if (item) setFocused(item.id) }, [item, setFocused])
  useEffect(() => window.scrollTo({ top: 0 }), [id])

  const seriesInfo = useQuery<XtreamSeriesInfo | undefined>({
    queryKey: ['series-info', id],
    queryFn: () => client!.seriesInfo(item!.streamId),
    enabled: !!client && !!item && item.kind === 'series' && item.id.startsWith('series:'),
    staleTime: 10 * 60 * 1000,
  })
  const [season, setSeason] = useState<string>()
  const seasons = useMemo(() => Object.keys(seriesInfo.data?.episodes ?? {}).sort((a, b) => +a - +b), [seriesInfo.data])
  const currentSeason = season ?? seasons[0]

  /** "Similar" from TMDB, mapped back to titles present in the provider catalogue when possible. */
  const similar = useMemo(() => {
    if (!data) return []
    const byTmdb = new Map<number, string>()
    for (const it of catalog.items) if (it.tmdbId && it.kind === item?.kind) byTmdb.set(it.tmdbId, it.id)
    return data.similar.map((s) => ({ ...s, localId: byTmdb.get(s.id) }))
  }, [data, catalog, item?.kind])

  if (!item) return <p className="p-24">Introuvable.</p>

  return (
    <div className="pb-16">
      <Hero item={item} />
      <div className="grid grid-cols-1 gap-10 px-8 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-8">
          {isLoading && <p className="text-white/40">Chargement TMDB…</p>}
          {data?.cast.length ? (
            <section>
              <h3 className="mb-3 text-lg font-semibold">Casting</h3>
              <div className="no-scrollbar flex gap-4 overflow-x-auto">
                {data.cast.map((p) => (
                  <div key={p.id} className="w-24 shrink-0 text-center">
                    {p.profile ? <img src={p.profile} alt="" className="mb-1 h-24 w-24 rounded-full object-cover" loading="lazy" /> : <div className="mb-1 h-24 w-24 rounded-full bg-white/10" />}
                    <p className="truncate text-xs font-medium">{p.name}</p>
                    <p className="truncate text-[10px] text-white/50">{p.character}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {item.kind === 'series' && seasons.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-3">
                <h3 className="text-lg font-semibold">Épisodes</h3>
                <select value={currentSeason} onChange={(e) => setSeason(e.target.value)} className="rounded bg-white/10 px-2 py-1 text-sm">
                  {seasons.map((s) => <option key={s} value={s}>Saison {s}</option>)}
                </select>
              </div>
              <ul className="divide-y divide-white/10">
                {(seriesInfo.data?.episodes[currentSeason] ?? []).map((ep) => (
                  <li key={ep.id}>
                    <button onClick={() => nav(`/watch/${item.id}?ep=${ep.id}&ext=${ep.container_extension}`)} className="flex w-full gap-4 py-3 text-left hover:bg-white/5">
                      <span className="w-8 text-right text-white/40">{ep.episode_num}</span>
                      <span className="flex-1">
                        <span className="block font-medium">{ep.title}</span>
                        {ep.info?.plot && <span className="line-clamp-2 text-xs text-white/50">{ep.info.plot}</span>}
                      </span>
                      <span className="text-xs text-white/40">{ep.info?.duration}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {similar.length > 0 && (
            <section>
              <h3 className="mb-3 text-lg font-semibold">{item.kind === 'series' ? 'Séries similaires' : 'Films similaires'}</h3>
              <div className="no-scrollbar flex gap-3 overflow-x-auto">
                {similar.map((s) => (
                  <button
                    key={s.id}
                    disabled={!s.localId}
                    onClick={() => s.localId && nav(`/details/${s.localId}`)}
                    onMouseEnter={() => s.localId && setFocused(s.localId)}
                    className={`w-32 shrink-0 overflow-hidden rounded-lg bg-white/5 text-left transition ${s.localId ? 'hover:scale-105' : 'opacity-50'}`}
                    title={s.localId ? s.title : `${s.title} (absent du catalogue)`}
                  >
                    <img src={s.poster} alt="" className="h-48 w-full object-cover" loading="lazy" />
                    <p className="truncate p-2 text-xs">{s.title}{s.year ? ` (${s.year})` : ''}</p>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
        <aside className="space-y-3 text-sm">
          <Row k="Titre original" v={data?.originalTitle} />
          <Row k="Réalisateur" v={data?.director ?? item.director} />
          <Row k="Créateurs" v={data?.creators?.join(', ')} />
          <Row k="Genres" v={data?.genres.join(', ') ?? item.genre} />
          <Row k="Année" v={data?.year ?? item.year} />
          <Row k="Note TMDB" v={data?.rating ? `${data.rating.toFixed(1)} / 10 (${data.votes} votes)` : undefined} />
          <Row k="Statut" v={data?.status} />
          <Row k="Langue flux" v={item.lang} />
          <Row k="Qualité" v={item.quality} />
          <Row k="Tags" v={item.tags.join(', ')} />
          <Row k="Nom brut" v={item.rawName} mono />
          {data?.trailer && (
            <a href={`https://www.youtube.com/watch?v=${data.trailer}`} target="_blank" rel="noreferrer" className="inline-block rounded-full bg-white/10 px-4 py-1.5 hover:bg-white/20">Bande-annonce ↗</a>
          )}
          <Link to="/" className="block pt-4 text-white/50 hover:text-white">← Retour</Link>
        </aside>
      </div>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v?: string | number; mono?: boolean }) {
  if (!v) return null
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-white/40">{k}</p>
      <p className={mono ? 'break-all font-mono text-xs text-white/70' : ''}>{v}</p>
    </div>
  )
}
