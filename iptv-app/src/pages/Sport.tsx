import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMatches, teamKey, type MatchCard } from '../hooks/useMatches'
import { importance, competitionCountry } from '../parser/rank'
import { useSportPrefs } from '../store/sportPrefs'
import { useProfile } from '../store/profile'
import { countryOf } from '../parser/live'
import type { MediaItem } from '../types'
import type { LiveEvent } from '../parser/live'

type View = 'today' | 'mine' | 'country'

/** Matches: only what the server actually streams, ranked by importance for this viewer. Live first. */
export default function Sport() {
  const { cards, unmatched, isLoading } = useMatches()
  const prefs = useSportPrefs()
  const region = useProfile((s) => s.region)
  const [view, setView] = useState<View>('today')
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t) }, [])
  useReminders(cards)

  const ranked = useMemo(() => cards.filter((c) => c.sources.length).map((c) => ({ ...c, rank: importance(c.match, { region, favTeams: prefs.teams, favCompetitions: prefs.competitions, streams: c.sources.length }) })).sort((a, b) => b.rank - a.rank), [cards, region, prefs.teams, prefs.competitions])
  const isMine = (c: MatchCard) => prefs.teams.includes(teamKey(c.match.home)) || prefs.teams.includes(teamKey(c.match.away)) || prefs.competitions.includes(c.match.competition)
  const shown = view === 'mine' ? ranked.filter(isMine) : ranked
  const hero = shown[0]
  const live = shown.filter((c) => c !== hero && c.match.state === 'in')
  const liveUnmatched = unmatched.filter((u) => u.event.status === 'live').slice(0, 12)
  const upcoming = shown.filter((c) => c !== hero && c.match.state !== 'in')
  const groups = useMemo(() => {
    const m = new Map<string, typeof upcoming>()
    for (const c of upcoming) m.set(c.match.competition, [...(m.get(c.match.competition) ?? []), c])
    let arr = [...m.entries()].sort((a, b) => Math.max(...b[1].map((x) => x.rank)) - Math.max(...a[1].map((x) => x.rank)))
    if (view === 'country') {
      const cc = (name: string) => competitionCountry(name) ?? 'ZZ'
      const mine = region === 'UK' ? 'GB' : region
      arr = arr.sort((a, b) => Number(cc(b[0]) === mine) - Number(cc(a[0]) === mine) || cc(a[0]).localeCompare(cc(b[0])))
    }
    return arr
  }, [upcoming, view, region])
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="mx-auto max-w-2xl px-5 pb-28 pt-20">
      <h1 className="font-display text-4xl font-black tracking-tight">Matchs</h1>
      <p className="mt-0.5 text-sm text-white/50 first-letter:uppercase">{today} · {shown.length + liveUnmatched.length} diffusés</p>
      <div className="mt-3 mb-5 flex rounded-xl bg-white/[.08] p-[3px] text-[13px]">
        {([['today', 'Aujourd’hui'], ['mine', 'Mes équipes'], ['country', 'Par pays']] as [View, string][]).map(([k, l]) => <button key={k} onClick={() => setView(k)} className={`flex-1 rounded-lg py-1.5 font-medium ${view === k ? 'bg-white/20 text-white' : 'text-white/50'}`}>{l}</button>)}
      </div>
      {isLoading && !cards.length && <p className="py-10 text-center text-sm text-white/40">Chargement des matchs…</p>}
      {view === 'mine' && !prefs.teams.length && !prefs.competitions.length && <p className="rounded-xl bg-white/5 p-4 text-sm text-white/60">Ouvre un match et appuie sur ★ à côté d’une équipe pour la suivre.</p>}
      {hero && <Hero c={hero} />}
      {(live.length > 0 || liveUnmatched.length > 0) && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-red-500"><span className="h-[7px] w-[7px] rounded-full bg-red-500" />En direct</h2>
          <div className="overflow-hidden rounded-2xl bg-white/[.07]">
            {live.map((c) => <Row key={c.match.id} c={c} />)}
            {liveUnmatched.map((u) => <PlainRow key={u.item.id} item={u.item} event={u.event} />)}
          </div>
        </section>
      )}
      {groups.map(([comp, cs]) => (
        <section key={comp} className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-white/50">
            {cs[0].match.leagueLogo ? <img src={cs[0].match.leagueLogo} alt="" className="h-4 w-4 object-contain" /> : <span>{flagOfCompetition(comp)}</span>}
            {shortComp(comp)}
            {prefs.competitions.includes(comp) && <span className="text-amber-400">★</span>}
          </h2>
          <div className="overflow-hidden rounded-2xl bg-white/[.07]">{cs.map((c) => <Row key={c.match.id} c={c} />)}</div>
        </section>
      ))}
      {!isLoading && !shown.length && !liveUnmatched.length && <p className="py-10 text-center text-sm text-white/40">Aucun match diffusé pour l’instant.</p>}
    </div>
  )
}

const shortComp = (c: string) => c.replace(/^(French|English|Spanish|Italian|German|Portuguese|Dutch|Turkish|Belgian|Japanese|Brazilian|Argentine|Saudi|Mexican|Scottish)\s+/, '').replace('UEFA ', '')
const flagOfCompetition = (c: string) => { const cc = competitionCountry(c); return cc ? (countryOf((cc === 'GB' ? 'UK' : cc) + '|')?.flag ?? '🏆') : '🏆' }
const time = (d: Date) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const isToday = (d: Date) => d.toDateString() === new Date().toDateString()
const watchUrl = (c: MatchCard) => `/watch/${c.sources[0].item.id}?alts=${c.sources.map((s) => s.item.id).join(',')}&match=${encodeURIComponent(c.match.id)}`

function Hero({ c }: { c: MatchCard }) {
  const nav = useNavigate()
  const m = c.match; const live = m.state === 'in'
  const fav = useSportPrefs((s) => s.teams)
  const star = (n: string) => fav.includes(teamKey(n)) ? <span className="mr-1 text-xs text-amber-400">★</span> : null
  return (
    <div className="mb-6 rounded-[18px] bg-white/[.07] p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-white/50">
        {m.leagueLogo && <img src={m.leagueLogo} alt="" className="h-4 w-4 object-contain" />}{shortComp(m.competition)}
        <b className="ml-auto font-semibold text-white tabular-nums">{live ? <span className="text-red-500">● {m.clock ?? 'Direct'}</span> : isToday(m.start) ? (m.start.getHours() >= 18 ? 'Ce soir' : 'Aujourd’hui') : m.start.toLocaleDateString('fr-FR', { weekday: 'long' })}</b>
      </div>
      <div className="flex items-center justify-between">
        <Team name={m.home} logo={m.homeLogo} big star={star(m.home)} />
        <div className="font-display text-3xl font-black tracking-tight tabular-nums">{live && m.homeScore !== undefined ? `${m.homeScore}–${m.awayScore}` : live ? <span className="text-red-500">DIRECT</span> : time(m.start)}</div>
        <Team name={m.away} logo={m.awayLogo} big star={star(m.away)} />
      </div>
      <button onClick={() => nav(watchUrl(c))} className={`mt-4 h-12 w-full rounded-xl text-[15px] font-semibold ${live ? 'bg-red-600 text-white' : 'bg-white text-black'}`}>{live ? 'Regarder' : `Regarder à ${time(m.start)}`}</button>
    </div>
  )
}
function Team({ name, logo, big, star }: { name: string; logo?: string; big?: boolean; star?: React.ReactNode }) {
  return (
    <div className={`flex flex-col items-center gap-2 ${big ? 'w-[120px]' : ''}`}>
      {logo ? <img src={logo} alt="" className={`${big ? 'h-[72px] w-[72px]' : 'h-7 w-7'} object-contain`} loading="lazy" /> : <Initials name={name} size={big ? 72 : 28} />}
      <span className="text-center text-[15px] font-semibold leading-tight">{star}{name}</span>
    </div>
  )
}
function Initials({ name, size }: { name: string; size: number }) {
  return <span className="grid shrink-0 place-items-center rounded-full bg-white/10 font-semibold text-white/70" style={{ width: size, height: size, fontSize: size / 3 }}>{name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
}
function Row({ c }: { c: MatchCard }) {
  const m = c.match; const live = m.state === 'in'
  const fav = useSportPrefs((s) => s.teams)
  const star = (n: string) => fav.includes(teamKey(n)) ? <span className="mr-1 text-[11px] text-amber-400">★</span> : null
  return (
    <Link to={watchUrl(c)} className="grid min-h-[60px] grid-cols-[1fr_64px_1fr] items-center border-b border-white/[.08] px-3.5 py-2.5 last:border-b-0 hover:bg-white/5">
      <span className="flex min-w-0 items-center gap-2.5 text-[14.5px] font-medium">{m.homeLogo ? <img src={m.homeLogo} alt="" className="h-7 w-7 shrink-0 object-contain" loading="lazy" /> : <Initials name={m.home} size={28} />}<span className="truncate">{star(m.home)}{m.homeShort ?? m.home}</span></span>
      <span className="text-center tabular-nums">{live ? (m.homeScore !== undefined ? <><span className="block text-xl font-extrabold tracking-tight">{m.homeScore}–{m.awayScore}</span><span className="block text-[11px] font-semibold text-red-500">{m.clock}</span></> : <span className="text-sm font-bold text-red-500">DIRECT</span>) : <span className="text-sm font-semibold">{isToday(m.start) ? time(m.start) : m.start.toLocaleDateString('fr-FR', { weekday: 'short' })}</span>}</span>
      <span className="flex min-w-0 flex-row-reverse items-center gap-2.5 text-right text-[14.5px] font-medium">{m.awayLogo ? <img src={m.awayLogo} alt="" className="h-7 w-7 shrink-0 object-contain" loading="lazy" /> : <Initials name={m.away} size={28} />}<span className="truncate">{star(m.away)}{m.awayShort ?? m.away}</span></span>
    </Link>
  )
}
/** A live stream the score sources don't track: still watchable, shown as DIRECT without a score. */
function PlainRow({ item, event }: { item: MediaItem; event: LiveEvent }) {
  const t = event.title.split(/\s+(?:vs?\.?|-|–)\s+/i)
  const [a, b] = t.length === 2 ? t : [event.title, '']
  return (
    <Link to={`/watch/${item.id}`} className="grid min-h-[60px] grid-cols-[1fr_64px_1fr] items-center border-b border-white/[.08] px-3.5 py-2.5 last:border-b-0 hover:bg-white/5">
      <span className="flex min-w-0 items-center gap-2.5 text-[14.5px] font-medium"><Initials name={a} size={28} /><span className="truncate">{titleCase(a)}</span></span>
      <span className="text-center text-sm font-bold text-red-500">DIRECT</span>
      <span className="flex min-w-0 flex-row-reverse items-center gap-2.5 text-right text-[14.5px] font-medium">{b && <Initials name={b} size={28} />}<span className="truncate">{titleCase(b) || event.competition || ''}</span></span>
    </Link>
  )
}
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s|-)\S/g, (c) => c.toUpperCase())

function useReminders(cards: MatchCard[]) {
  const { reminders, toggleReminder } = useSportPrefs()
  useEffect(() => {
    const timers = reminders.map((id) => {
      const c = cards.find((x) => x.match.id === id); if (!c) return undefined
      const ms = c.match.start.getTime() - 10 * 60000 - Date.now()
      if (ms < -60000) { toggleReminder(id); return undefined }
      return setTimeout(() => { const text = `${c.match.home} – ${c.match.away} commence dans 10 minutes`; if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('LUMEN', { body: text }); else alert(text); toggleReminder(id) }, Math.max(0, ms))
    })
    if (reminders.length && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined)
    return () => timers.forEach((t) => t && clearTimeout(t))
  }, [reminders, cards, toggleReminder])
}
