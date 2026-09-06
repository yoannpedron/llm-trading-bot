import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useMatches, teamKey, type MatchCard } from '../hooks/useMatches'
import { SPORT_ICON, SPORT_LABEL, type Sport as SportKind } from '../api/sports'
import { useSportPrefs } from '../store/sportPrefs'
import { useCatalog } from '../store/catalog'
import { useProfile } from '../store/profile'
import { countryOf, themeOf } from '../parser/live'
import { flagOf } from '../hooks/useMatches'

/** Match Center: live and upcoming fixtures, each linked to every stream the server has for it. One tap plays the best source. */
export default function Sport() {
  const { cards, unmatched, isLoading, dataUpdatedAt } = useMatches()
  const prefs = useSportPrefs()
  const [sport, setSport] = useState<SportKind | ''>('')
  const [q, setQ] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30_000); return () => clearInterval(t) }, [])
  useReminders(cards)

  const withStreams = cards
  const sports = useMemo(() => { const m = new Map<SportKind, number>(); for (const c of withStreams) m.set(c.match.sport, (m.get(c.match.sport) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]) }, [withStreams])
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return withStreams.filter((c) => (!sport || c.match.sport === sport) && (!n || `${c.match.home} ${c.match.away} ${c.match.competition}`.toLowerCase().includes(n)))
  }, [withStreams, sport, q])
  const isFav = (c: MatchCard) => prefs.teams.includes(teamKey(c.match.home)) || prefs.teams.includes(teamKey(c.match.away)) || prefs.competitions.includes(c.match.competition)
  const live = filtered.filter((c) => c.match.state === 'in')
  const favs = filtered.filter((c) => isFav(c) && c.match.state !== 'in')
  const upcoming = filtered.filter((c) => c.match.state === 'pre' && !isFav(c))
  const byCompetition = useMemo(() => { const m = new Map<string, MatchCard[]>(); for (const c of upcoming) m.set(c.match.competition, [...(m.get(c.match.competition) ?? []), c]); return [...m.entries()].sort((a, b) => b[1].length - a[1].length) }, [upcoming])

  return (
    <div className="mx-auto max-w-6xl px-6 pb-28 pt-20 md:px-12">
      <Ticker cards={cards.filter((c) => c.match.state === 'in')} />
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">Match Center</h1>
        <span className="text-sm text-white/40 tabular-nums">{withStreams.length} matchs avec flux · {cards.filter((c) => c.match.state === 'in').length} en direct{dataUpdatedAt ? ` · scores ${Math.round((Date.now() - dataUpdatedAt) / 1000)} s` : ''}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Équipe, compétition…" className="ml-auto w-56 rounded-full bg-white/10 px-4 py-1.5 text-sm outline-none focus:bg-white/20" />
      </div>
      <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto">
        <button onClick={() => setSport('')} className={`h-9 shrink-0 rounded-full px-3.5 text-sm ${!sport ? 'bg-white font-semibold text-black' : 'bg-white/10'}`}>Tous</button>
        {sports.map(([s, n]) => <button key={s} onClick={() => setSport(s)} className={`h-9 shrink-0 rounded-full px-3.5 text-sm ${sport === s ? 'bg-white font-semibold text-black' : 'bg-white/10 hover:bg-white/20'}`}>{SPORT_ICON[s]} {SPORT_LABEL[s]} <span className="opacity-50 tabular-nums">{n}</span></button>)}
        {live.length > 1 && <Link to={`/sport/multi?ids=${live.slice(0, 4).map((c) => c.sources[0].item.id).join(',')}`} className="ml-auto h-9 shrink-0 rounded-full bg-red-600 px-4 text-sm font-semibold leading-9">Multi-match ▣ {Math.min(4, live.length)}</Link>}
      </div>
      {isLoading && <p className="mt-8 text-sm text-white/40">Chargement des calendriers ESPN et TheSportsDB…</p>}
      <Section title="En direct" cards={live} live />
      <Section title="Tes équipes et compétitions" cards={favs} />
      {byCompetition.map(([comp, cs]) => <Section key={comp} title={comp} cards={cs} sportOf={cs[0].match.sport} />)}
      <SportChannels />
      {unmatched.length > 0 && (
        <details className="mt-10">
          <summary className="cursor-pointer text-sm text-white/50">Autres événements non identifiés ({unmatched.length})</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {unmatched.filter((u) => u.event.status !== 'ended').sort((a, b) => a.event.start!.getTime() - b.event.start!.getTime()).slice(0, 80).map((u) => (
              <li key={u.item.id}><Link to={`/watch/${u.item.id}`} className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-sm hover:bg-white/10"><span className="w-12 text-white/60 tabular-nums">{u.event.start!.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>{u.event.status === 'live' && <span className="rounded bg-red-600 px-1.5 text-[10px] font-bold">LIVE</span>}<span className="flex-1 truncate">{u.event.title}</span><span className="text-xs text-white/40">{u.event.provider}</span></Link></li>
            ))}
          </ul>
        </details>
      )}
      <span hidden>{tick}</span>
    </div>
  )
}

function Section({ title, cards, live, sportOf }: { title: string; cards: MatchCard[]; live?: boolean; sportOf?: SportKind }) {
  if (!cards.length) return null
  return (
    <section className="mt-8">
      <h2 className="mb-3 font-display text-lg font-bold">{live && <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" />}{sportOf ? SPORT_ICON[sportOf] + ' ' : ''}{title} <span className="text-sm font-normal text-white/40">{cards.length}</span></h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{cards.map((c) => <Card key={c.match.id} c={c} />)}</div>
    </section>
  )
}

function Card({ c }: { c: MatchCard }) {
  const nav = useNavigate()
  const prefs = useSportPrefs()
  const m = c.match
  const best = c.sources[0]
  const play = () => nav(`/watch/${best.item.id}?alts=${c.sources.map((s) => s.item.id).join(',')}&match=${encodeURIComponent(m.id)}`)
  const liveNow = m.state === 'in'
  const isRem = prefs.reminders.includes(m.id)
  const fav = (t: string) => prefs.teams.includes(teamKey(t))
  return (
    <div className={`relative overflow-hidden rounded-xl p-3 ${liveNow ? 'bg-red-500/10 ring-1 ring-red-500/40' : 'bg-white/5'}`}>
      <div className="mb-2 flex items-center gap-2 text-[11px] text-white/50">
        <span>{SPORT_ICON[m.sport]}</span><span className="truncate">{m.competition}</span>
        <span className="ml-auto tabular-nums">{liveNow ? <span className="font-semibold text-red-400">{m.clock ?? 'Direct'}</span> : m.start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + (isToday(m.start) ? '' : ' · ' + m.start.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }))}</span>
      </div>
      <button onClick={play} className="flex w-full items-center gap-3 text-left">
        <Team name={m.home} short={m.homeShort} logo={m.homeLogo} fav={fav(m.home)} />
        <div className="w-16 shrink-0 text-center">
          {m.homeScore !== undefined && m.state !== 'pre' && !prefs.hideScores ? <span className="font-display text-2xl font-black tabular-nums">{m.homeScore}<span className="mx-1 text-white/30">:</span>{m.awayScore}</span> : <span className="font-display text-lg font-bold text-white/40">vs</span>}
        </div>
        <Team name={m.away} short={m.awayShort} logo={m.awayLogo} fav={fav(m.away)} right />
      </button>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={play} className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-black">▶ {liveNow ? 'Regarder' : 'Ouvrir'}</button>
        <span className="text-xs text-white/50">{c.sources.length} flux · {best.flag}{best.lang ? ' ' + best.lang : ''}{best.quality ? ' · ' + best.quality : ''}</span>
        <div className="ml-auto flex gap-1">
          {!liveNow && <button onClick={() => prefs.toggleReminder(m.id)} title="Rappel 10 min avant" className={`h-8 w-8 rounded-lg text-sm ${isRem ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>⏰</button>}
          <button onClick={() => prefs.toggleTeam(teamKey(m.home))} title={`Suivre ${m.home}`} className={`h-8 rounded-lg px-2 text-xs ${fav(m.home) ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>★ {m.homeShort ?? m.home}</button>
          <button onClick={() => prefs.toggleTeam(teamKey(m.away))} title={`Suivre ${m.away}`} className={`h-8 rounded-lg px-2 text-xs ${fav(m.away) ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>★ {m.awayShort ?? m.away}</button>
        </div>
      </div>
    </div>
  )
}
function Team({ name, short, logo, fav, right }: { name: string; short?: string; logo?: string; fav?: boolean; right?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 ${right ? 'flex-row-reverse text-right' : ''}`}>
      {logo ? <img src={logo} alt="" className="h-9 w-9 shrink-0 object-contain" loading="lazy" /> : <div className="h-9 w-9 shrink-0 rounded-full bg-white/10" />}
      <span className="truncate text-sm font-semibold">{fav && <span className="text-amber-400">★ </span>}<span className="sm:hidden">{short ?? name}</span><span className="hidden sm:inline">{name}</span></span>
    </div>
  )
}
const isToday = (d: Date) => d.toDateString() === new Date().toDateString()

/** Bottom score bar with every live match. */
function Ticker({ cards }: { cards: MatchCard[] }) {
  const nav = useNavigate()
  const hide = useSportPrefs((s) => s.hideScores)
  if (!cards.length) return null
  return (
    <div className="no-scrollbar fixed inset-x-0 bottom-0 z-30 flex gap-2 overflow-x-auto border-t border-white/10 bg-black/85 px-4 py-2 backdrop-blur md:bottom-auto md:top-14 md:border-b md:border-t-0">
      {cards.map((c) => (
        <button key={c.match.id} onClick={() => nav(`/watch/${c.sources[0].item.id}?alts=${c.sources.map((s) => s.item.id).join(',')}`)} className="flex shrink-0 items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs hover:bg-white/20">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" /><span>{c.match.homeShort ?? c.match.home}</span>
          <b className="tabular-nums">{hide ? 'vs' : `${c.match.homeScore ?? 0}–${c.match.awayScore ?? 0}`}</b><span>{c.match.awayShort ?? c.match.away}</span><span className="text-white/40">{c.match.clock}</span>
        </button>
      ))}
    </div>
  )
}

/** In-app reminders 10 minutes before kick-off (plus a system notification when allowed). */
function useReminders(cards: MatchCard[]) {
  const { reminders, toggleReminder } = useSportPrefs()
  useEffect(() => {
    const timers = reminders.map((id) => {
      const c = cards.find((x) => x.match.id === id); if (!c) return undefined
      const ms = c.match.start.getTime() - 10 * 60000 - Date.now()
      if (ms < -60000) { toggleReminder(id); return undefined }
      return setTimeout(() => {
        const text = `${c.match.home} – ${c.match.away} commence dans 10 minutes`
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('LUMEN · Match', { body: text })
        else alert(text)
        toggleReminder(id)
      }, Math.max(0, ms))
    })
    if (reminders.length && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined)
    return () => timers.forEach((t) => t && clearTimeout(t))
  }, [reminders, cards, toggleReminder])
}

/** Sports channels of the profile's country with their EPG now/next, linked to the Match Center when the title matches. */
function SportChannels() {
  const catalog = useCatalog((s) => s.catalog)
  const client = useCatalog((s) => s.client)
  const region = useProfile((s) => s.region)
  const channels = useMemo(() => {
    const cats = (catalog?.categories ?? []).filter((c) => c.kind === 'live').map((c) => ({ c, cc: countryOf(c.rawName)?.code, theme: themeOf(c.rawName) }))
    const mine = cats.filter((x) => (x.theme === 'sport') && (x.cc === region || (region === 'GB' && x.cc === 'UK') || (region === 'BE' && x.cc === 'BEE')))
    return mine.flatMap((x) => (catalog?.byCategory['live:' + x.c.id] ?? []).map((i) => catalog!.items[i])).filter((i) => i.epgChannelId && !/^(NEXT|ENDED|LIVE)\s*\|/.test(i.rawName)).slice(0, 16)
  }, [catalog, region])
  const epg = useQuery({ queryKey: ['sport-epg', channels.map((c) => c.id).join()], queryFn: async () => Object.fromEntries(await Promise.all(channels.map(async (c) => [c.id, await client!.shortEpg(c.streamId, 3).catch(() => [])] as const))), enabled: !!client && channels.length > 0, refetchInterval: 10 * 60_000 })
  if (!channels.length) return null
  return (
    <section className="mt-10">
      <h2 className="mb-3 font-display text-lg font-bold">Chaînes sport {flagOf(region === 'GB' ? 'UK' : region)} <span className="text-sm font-normal text-white/40">en ce moment et à suivre</span></h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {channels.map((c) => { const list = epg.data?.[c.id] ?? []; const now = list.find((e) => e.start <= new Date() && e.end > new Date()); const next = list.find((e) => e.start > new Date()); return (
          <Link key={c.id} to={`/watch/${c.id}`} className="flex items-center gap-3 rounded-lg bg-white/5 p-2.5 hover:bg-white/10">
            {c.poster ? <img src={c.poster} alt="" className="h-9 w-14 shrink-0 object-contain" loading="lazy" /> : <span className="w-14 shrink-0 truncate text-xs font-bold">{c.title}</span>}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{c.title}</div>
              {!client ? <div className="text-xs text-white/40">EPG indisponible en mode démo</div> : now ? <div className="truncate text-xs"><span className="mr-1 rounded bg-red-600 px-1 text-[10px] font-bold">EN COURS</span>{now.title}</div> : <div className="text-xs text-white/40">{epg.isLoading ? 'Guide…' : 'Pas de programme'}</div>}
              {next && <div className="truncate text-[11px] text-white/50">{next.start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · {next.title}</div>}
            </div>
          </Link>) })}
      </div>
    </section>
  )
}
