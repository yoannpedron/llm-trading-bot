import { useCallback, useEffect, useMemo } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useProgress } from '../store/progress'
import type { XtreamSeriesInfo } from '../api/xtream'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import { useSession } from '../store/session'
import Player from '../components/Player'
import { useQuery } from '@tanstack/react-query'

export default function Watch() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const item = useCatalog((s) => s.item(id))
  const client = useCatalog((s) => s.client)
  const mode = useSession((s) => s.mode)
  const setBackdrop = useUi((s) => s.setBackdrop)
  const nav = useNavigate()
  const progress = useProgress()
  useEffect(() => { setBackdrop(undefined) }, [setBackdrop])
  const ep = params.get('ep') ?? undefined
  const startAt = progress.map[id]?.ep === ep ? progress.map[id]?.t : undefined
  const onProgress = useCallback((t: number, d: number) => progress.save(id, { t, d, ep, ext: params.get('ext') ?? undefined }), [id, ep, params, progress])
  // next episode: series info gives the ordered episode list
  const seriesInfo = useQuery<XtreamSeriesInfo | undefined>({ queryKey: ['series-info', id], queryFn: () => client!.seriesInfo(item!.streamId), enabled: !!client && item?.kind === 'series' && !!ep, staleTime: 10 * 60 * 1000 })
  const nextEp = useMemo(() => { const all = Object.values(seriesInfo.data?.episodes ?? {}).flat(); const i = all.findIndex((e) => e.id === ep); return i >= 0 ? all[i + 1] : undefined }, [seriesInfo.data, ep])
  const onEnded = useCallback(() => { progress.clear(id); if (nextEp) nav(`/watch/${id}?ep=${nextEp.id}&ext=${nextEp.container_extension}`, { replace: true }) }, [progress, id, nextEp, nav])
  const epg = useQuery({ queryKey: ['epg', id], queryFn: () => client!.shortEpg(item!.streamId), enabled: !!client && item?.kind === 'live', refetchInterval: 5 * 60 * 1000 })

  if (!item) return <p className="p-24">Introuvable.</p>

  let src: string | undefined
  if (client) {
    if (item.kind === 'live') src = client.liveUrl(item.streamId)
    else if (ep) src = client.episodeUrl(ep, params.get('ext') ?? 'mp4')
    else if (item.id.startsWith('movie:')) src = client.movieUrl(item.streamId, item.ext)
  }

  return (
    <div className="mx-auto max-w-6xl px-8 pt-20">
      <div className="mb-4 flex items-baseline gap-4">
        <h1 className="text-2xl font-bold">{item.title}</h1>
        <span className="text-sm text-white/50">{[item.year, item.lang, item.quality].filter(Boolean).join(' · ')}</span>
        {item.kind !== 'live' && <Link to={`/details/${item.id}`} className="ml-auto text-sm text-white/60 hover:text-white">Détails →</Link>}
      </div>
      {src ? (
        <Player src={src} title={item.title} startAt={startAt} onProgress={item.kind === 'live' ? undefined : onProgress} onEnded={onEnded} />
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-xl bg-white/5 text-center text-white/60">
          {mode === 'mock' ? (
            <p>Mode démo : aucun flux. <Link to="/login" className="underline">Connecte un serveur Xtream</Link> pour lire ce contenu.</p>
          ) : (
            <p>Choisis un épisode depuis la page <Link to={`/details/${item.id}`} className="underline">détails</Link>.</p>
          )}
        </div>
      )}
      {nextEp && <p className="mt-3 text-sm text-white/60">Épisode suivant : <Link to={`/watch/${id}?ep=${nextEp.id}&ext=${nextEp.container_extension}`} className="underline">{nextEp.title}</Link> (lecture automatique à la fin)</p>}
      {item.kind === 'live' && epg.data?.length ? (
        <section className="mt-5">
          <h3 className="mb-2 font-display text-base font-bold">Guide des programmes</h3>
          <ol className="divide-y divide-white/10">
            {epg.data.map((e, i) => { const on = e.start <= new Date() && e.end > new Date(); return (
              <li key={i} className={`flex gap-4 py-2.5 ${on ? '' : 'opacity-60'}`}>
                <span className="w-24 shrink-0 text-sm tabular-nums text-white/60">{e.start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} – {e.end.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="min-w-0 flex-1"><span className="block font-medium">{on && <span className="mr-2 rounded bg-red-600 px-1.5 text-[10px] font-bold">EN COURS</span>}{e.title}</span>{e.description && <span className="line-clamp-2 text-xs text-white/50">{e.description}</span>}</span>
              </li>) })}
          </ol>
        </section>
      ) : null}
      <p className="mt-3 break-all font-mono text-[11px] text-white/30">{src}</p>
    </div>
  )
}
