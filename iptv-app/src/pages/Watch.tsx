import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useProgress } from '../store/progress'
import { useHistory } from '../store/history'
import { useMatches, teamKey } from '../hooks/useMatches'
import { useSportPrefs } from '../store/sportPrefs'
import { useBadge } from '../hooks/useBadge'
import { parseEvent } from '../parser/live'
import { useDownloads } from '../download/store'
import { fileOf } from '../download/opfs'
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
  const record = useHistory((s) => s.record)
  useEffect(() => { if (item) record(item.id) }, [item, record])
  useEffect(() => { setBackdrop(undefined) }, [setBackdrop])
  const ep = params.get('ep') ?? undefined
  const localId = params.get('local') ?? undefined
  const dlItem = useDownloads((s) => localId ? s.items[localId] : undefined)
  const [localUrl, setLocalUrl] = useState<string>()
  useEffect(() => { let u: string | undefined; if (dlItem?.status === 'done') void fileOf(dlItem.file).then((f) => { if (f) { u = URL.createObjectURL(f); setLocalUrl(u) } }); return () => { if (u) URL.revokeObjectURL(u) } }, [dlItem])
  const alts = useMemo(() => (params.get('alts') ?? '').split(',').filter(Boolean), [params])
  const { cards } = useMatches()
  const sportPrefs = useSportPrefs()
  const card = useMemo(() => cards.find((c) => c.sources.some((s) => s.item.id === id) || c.sources.some((s) => alts.includes(s.item.id))), [cards, id, alts])
  const [failed, setFailed] = useState<string[]>([])
  const onError = useCallback(() => {
    if (item?.kind !== 'live' || !card) return
    const next = card.sources.find((s) => s.item.id !== id && !failed.includes(s.item.id))
    setFailed((f) => [...f, id])
    if (next) nav(`/watch/${next.item.id}?alts=${alts.join(',')}`, { replace: true })
  }, [item, card, id, failed, alts, nav])
  const startAt = progress.map[id]?.ep === ep ? progress.map[id]?.t : undefined
  const onProgress = useCallback((t: number, d: number) => progress.save(id, { t, d, ep, ext: params.get('ext') ?? undefined }), [id, ep, params, progress])
  // next episode: series info gives the ordered episode list
  const seriesInfo = useQuery<XtreamSeriesInfo | undefined>({ queryKey: ['series-info', id], queryFn: () => client!.seriesInfo(item!.streamId), enabled: !!client && item?.kind === 'series' && !!ep, staleTime: 10 * 60 * 1000 })
  const nextEp = useMemo(() => { const all = Object.values(seriesInfo.data?.episodes ?? {}).flat(); const i = all.findIndex((e) => e.id === ep); return i >= 0 ? all[i + 1] : undefined }, [seriesInfo.data, ep])
  const onEnded = useCallback(() => { progress.clear(id); if (nextEp) nav(`/watch/${id}?ep=${nextEp.id}&ext=${nextEp.container_extension}`, { replace: true }) }, [progress, id, nextEp, nav])
  const epg = useQuery({ queryKey: ['epg', id], queryFn: () => client!.shortEpg(item!.streamId), enabled: !!client && item?.kind === 'live', refetchInterval: 5 * 60 * 1000 })

  if (!item) return <p className="p-24">Introuvable.</p>

  let src: string | undefined = localUrl
  if (!src && client) {
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
      {localUrl && <p className="mb-2 text-xs text-emerald-300">Lecture hors ligne depuis l'appareil. Le créneau du serveur reste libre.</p>}
      {src ? (
        <Player src={src} title={item.title} startAt={startAt} onProgress={item.kind === 'live' ? undefined : onProgress} onEnded={onEnded} onError={onError} />
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-xl bg-white/5 text-center text-white/60">
          {mode === 'mock' ? (
            <p>Mode démo : aucun flux. <Link to="/login" className="underline">Connecte un serveur Xtream</Link> pour lire ce contenu.</p>
          ) : (
            <p>Choisis un épisode depuis la page <Link to={`/details/${item.id}`} className="underline">détails</Link>.</p>
          )}
        </div>
      )}
      {!card && item.kind === 'live' && (() => { const e = parseEvent(item.rawName); const t = e?.title.split(/\s+(?:vs?\.?|-|–|@)\s+/i); return e && t?.length === 2 ? (
        <section className="mt-5">
          <div className="flex items-center justify-between"><TeamBlock name={t[0]} /><div className="text-center"><b className="font-display text-2xl font-black text-red-500">{e.status === 'live' ? 'DIRECT' : e.start ? e.start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}</b>{e.competition && <span className="mt-0.5 block text-xs text-white/50">{e.competition}</span>}</div><TeamBlock name={t[1]} /></div>
        </section>) : null })()}
      {card && (
        <section className="mt-5">
          <div className="flex items-center justify-between">
            <TeamBlock name={card.match.home} logo={card.match.homeLogo} />
            <div className="text-center"><b className="font-display text-4xl font-black tracking-tight tabular-nums">{card.match.state === 'in' && card.match.homeScore !== undefined ? `${card.match.homeScore}–${card.match.awayScore}` : card.match.state === 'in' ? <span className="text-red-500">DIRECT</span> : card.match.start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</b><span className="mt-0.5 block text-xs text-white/50">{card.match.state === 'in' ? card.match.clock : card.match.start.toDateString() === new Date().toDateString() ? (card.match.start.getHours() >= 18 ? 'Ce soir' : 'Aujourd’hui') : card.match.start.toLocaleDateString('fr-FR', { weekday: 'long' })}</span></div>
            <TeamBlock name={card.match.away} logo={card.match.awayLogo} />
          </div>
          <p className="mt-3 text-center text-[13px] text-white/50">{card.match.competition}</p>
          <div className="mt-5 flex items-center gap-3">
            <span className="text-sm text-white/50">Source</span>
            <div className="flex flex-wrap gap-1.5">
              {card.sources.map((s2) => <Link key={s2.item.id} to={`/watch/${s2.item.id}?alts=${alts.join(',')}&match=${encodeURIComponent(card.match.id)}`} replace title={s2.item.rawName} className={`grid h-9 w-9 place-items-center rounded-[10px] text-xl ${s2.item.id === id ? 'bg-white' : failed.includes(s2.item.id) ? 'bg-red-500/20 opacity-50' : 'bg-white/10 hover:bg-white/20'}`}>{s2.flag}</Link>)}
            </div>
            {failed.length > 0 && <span className="ml-auto text-xs text-amber-300">Bascule automatique</span>}
          </div>
          {card.match.state !== 'in' && <button onClick={() => sportPrefs.toggleReminder(card.match.id)} className={`mt-4 h-10 w-full rounded-xl text-sm font-semibold ${sportPrefs.reminders.includes(card.match.id) ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>{sportPrefs.reminders.includes(card.match.id) ? '⏰ Rappel activé, 10 min avant' : '⏰ Me rappeler 10 min avant'}</button>}
        </section>
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

function TeamBlock({ name, logo }: { name: string; logo?: string }) {
  const prefs = useSportPrefs()
  const on = prefs.teams.includes(teamKey(name))
  const badge = useBadge(logo ? undefined : name)
  logo = logo ?? badge
  return (
    <button onClick={() => prefs.toggleTeam(teamKey(name))} className="flex w-[110px] flex-col items-center gap-2" title={on ? 'Ne plus suivre' : 'Suivre'}>
      {logo ? <img src={logo} alt="" className="h-14 w-14 object-contain" /> : <span className="grid h-14 w-14 place-items-center rounded-full bg-white/10 text-lg font-semibold text-white/70">{name.split(' ').slice(0, 2).map((w) => w[0]).join('')}</span>}
      <span className="text-center text-sm font-semibold leading-tight">{on && <span className="mr-1 text-amber-400">★</span>}{name}</span>
    </button>
  )
}
