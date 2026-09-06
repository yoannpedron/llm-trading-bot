import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useCatalog } from '../store/catalog'
import { allItems, bestIndex, versionsOf, is4K } from '../api/tmdbLists'
import { useUi } from '../store/ui'
import { useEnrich } from '../hooks/useEnrich'
import { useExtra } from '../hooks/useExtra'
import Hero from '../components/Hero'
import { useMyList } from '../store/mylist'
import { useDownloads } from '../download/store'
import { opfsAvailable } from '../download/opfs'
import type { XtreamSeriesInfo } from '../api/xtream'

export default function Details() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const item = useCatalog((s) => s.item(id))
  const client = useCatalog((s) => s.client)
  const catalog = useCatalog((s) => s.catalog)!
  const idx = useCatalog((s) => s.tmdbIndex)
  const ex = useExtra(item)
  const tkey = item ? item.kind + ':' + item.tmdbId : ''
  const versionsIdx = versionsOf(idx, tkey)
  const versions = versionsIdx.length ? versionsIdx : item?.lang ? [item.lang] : []
  const is4k = is4K(idx, tkey)
  const all = allItems(idx, tkey)
  const editions = (all.length ? all : item ? [item] : []).filter((e) => e.id.startsWith(item?.kind === 'series' ? 'series:' : 'movie:'))
  const setFocused = useUi((s) => s.setFocused)
  const { data, isLoading } = useEnrich(item)
  const list = useMyList()
  const dl = useDownloads()
  const canDl = !!client && opfsAvailable()
  const dlState = (id: string) => dl.items[id]?.status
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
    return data.similar.map((s) => { const i = bestIndex(idx, (item?.kind ?? 'movie') + ':' + s.id); return { ...s, localId: i === undefined ? undefined : catalog.idOf(i) } })
  }, [data, catalog, idx, item?.kind])

  if (!item) return <p className="p-24">Introuvable.</p>

  return (
    <div className="pb-16">
      <Hero item={item} />
      <div className="grid grid-cols-1 gap-10 px-8 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-8">
          {isLoading && <p className="text-white/40">Chargement TMDB…</p>}
          <div className="-mt-2 flex flex-wrap gap-2">
            <button onClick={() => list.toggle(item.id)} className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold ${list.ids.includes(item.id) ? 'bg-amber-400 text-black' : 'bg-white/10 hover:bg-white/20'}`}>{list.ids.includes(item.id) ? '✓ Dans ma liste' : '+ Ma liste'}</button>
            {canDl && item.kind === 'movie' && item.id.startsWith('movie:') && (
              dlState(item.id) === 'done' ? <Link to={`/watch/${item.id}?local=${encodeURIComponent(item.id)}`} className="inline-flex h-10 items-center rounded-lg bg-emerald-500/20 px-4 text-sm font-semibold text-emerald-200">⤓ Hors ligne · Lire</Link>
              : dlState(item.id) ? <Link to="/downloads" className="inline-flex h-10 items-center rounded-lg bg-white/10 px-4 text-sm font-semibold">⤓ {dlState(item.id) === 'waiting-slot' ? 'Attente du créneau' : 'Téléchargement…'}</Link>
              : <button onClick={() => dl.add({ id: item.id, title: data?.title ?? item.title, url: client!.movieUrl(item.streamId, item.ext), ext: item.ext ?? 'mp4' })} className="inline-flex h-10 items-center rounded-lg bg-white/10 px-4 text-sm font-semibold hover:bg-white/20">⤓ Télécharger</button>)}
          </div>
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
                      {canDl && <span onClick={(e) => { e.stopPropagation(); const id = `${item.id}#${ep.id}`; if (dl.items[id]?.status === 'done') nav(`/watch/${item.id}?ep=${ep.id}&ext=${ep.container_extension}&local=${encodeURIComponent(id)}`); else if (!dl.items[id]) dl.add({ id, title: `${data?.title ?? item.title} · ${ep.title}`, url: client!.episodeUrl(ep.id, ep.container_extension), ext: ep.container_extension || 'mp4' }) }} className={`grid h-8 w-8 shrink-0 place-items-center self-center rounded-full text-sm ${dl.items[`${item.id}#${ep.id}`]?.status === 'done' ? 'bg-emerald-500/20 text-emerald-200' : dl.items[`${item.id}#${ep.id}`] ? 'bg-white/10 text-white/50' : 'bg-white/10'}`} title="Télécharger">⤓</span>}
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
          <Row k="Réalisateur" v={data?.director ?? ex.director} />
          <Row k="Créateurs" v={data?.creators?.join(', ')} />
          <Row k="Genres" v={data?.genres.join(', ') ?? ex.genre} />
          <Row k="Année" v={data?.year ?? item.year} />
          <Row k="Note TMDB" v={data?.rating ? `${data.rating.toFixed(1)} / 10 (${data.votes} votes)` : undefined} />
          <Row k="Statut" v={data?.status} />
          <div><p className="text-[11px] uppercase tracking-wide text-white/40">Regarder en</p><div className="mt-1 flex flex-wrap gap-1.5">{editions.map((e) => <Link key={e.id} to={`/watch/${e.id}`} title={e.rawName} className={`rounded px-2 py-1 text-xs font-semibold ${e.id === item.id ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20'}`}>{e.lang ?? 'VO'}{e.quality ? ` · ${e.quality}` : ''}{e.tags.some((t) => /SUB|VOST/.test(t)) ? ' · ST' : ''}</Link>)}{is4k && <span className="rounded border border-amber-400 px-2 py-1 text-xs font-bold text-amber-400">4K</span>}</div>{versions.length > editions.length && <p className="mt-1 text-[11px] text-white/40">{versions.length} versions au total</p>}</div>
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
