/**
 * Live fixtures and scores from two free sources, normalised to one shape.
 * ESPN (no key, CORS open): football (all leagues), NHL, NBA, NFL, MLB, UFC, F1, ATP, WTA.
 * TheSportsDB (test key, CORS open): ice hockey, basketball, rugby, cricket, handball, volleyball, motorsport.
 */
export type Sport = 'football' | 'hockey' | 'basketball' | 'amfootball' | 'baseball' | 'mma' | 'motorsport' | 'tennis' | 'rugby' | 'cricket' | 'handball' | 'volleyball' | 'cycling' | 'other'
export const SPORT_LABEL: Record<Sport, string> = { cycling: 'Cyclisme', football: 'Football', hockey: 'Hockey', basketball: 'Basket', amfootball: 'Football US', baseball: 'Baseball', mma: 'MMA & Boxe', motorsport: 'Sports mécaniques', tennis: 'Tennis', rugby: 'Rugby', cricket: 'Cricket', handball: 'Handball', volleyball: 'Volley', other: 'Autres' }
export const SPORT_ICON: Record<Sport, string> = { cycling: '🚴', football: '⚽', hockey: '🏒', basketball: '🏀', amfootball: '🏈', baseball: '⚾', mma: '🥊', motorsport: '🏎️', tennis: '🎾', rugby: '🏉', cricket: '🏏', handball: '🤾', volleyball: '🏐', other: '🏆' }

export type MatchKind = 'team' | 'players' | 'session' | 'event'
export interface Match {
  id: string
  kind: MatchKind
  /** For sessions/events: the parent name (Grand Prix, tournament, fight card) */
  event?: string
  sport: Sport
  competition: string
  home: string; away: string
  homeShort?: string; awayShort?: string
  homeLogo?: string; awayLogo?: string
  start: Date
  state: 'pre' | 'in' | 'post'
  homeScore?: number; awayScore?: number
  clock?: string          // "67'" / "Q3 4:12" / "Mi-temps"
  detail?: string
  source: 'espn' | 'tsdb'
  leagueLogo?: string
  leagueKey?: string
}

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const SOCCER = ['uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'fifa.worldq.uefa', 'fifa.world', 'uefa.nations', 'uefa.euro', 'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'por.1', 'ned.1', 'tur.1', 'bel.1', 'sco.1', 'jpn.1', 'bra.1', 'usa.1', 'mex.1', 'arg.1', 'ksa.1', 'eng.2', 'fra.2', 'ger.2', 'esp.2', 'ita.2', 'eng.fa', 'fra.coupe_de_france', 'esp.copa_del_rey', 'ita.coppa_italia', 'ger.dfb_pokal', 'conmebol.libertadores', 'caf.nations', 'afc.champions']
const ESPN_FEEDS: [string, Sport][] = [
  ...SOCCER.map((l) => ['soccer/' + l, 'football'] as [string, Sport]), ['soccer/all', 'football'], ['hockey/nhl', 'hockey'], ['hockey/mens-college-hockey', 'hockey'], ['basketball/euroleague', 'basketball'], ['basketball/mens-college-basketball', 'basketball'], ['basketball/nba', 'basketball'], ['basketball/wnba', 'basketball'], ['football/nfl', 'amfootball'],
  ['football/college-football', 'amfootball'], ['baseball/mlb', 'baseball'], ['mma/ufc', 'mma'], ['racing/f1', 'motorsport'], ['tennis/atp', 'tennis'], ['tennis/wta', 'tennis'],
]
const TSDB = 'https://www.thesportsdb.com/api/v1/json/3'
const TSDB_SPORTS: [string, Sport][] = [['Ice Hockey', 'hockey'], ['Basketball', 'basketball'], ['Rugby', 'rugby'], ['Cricket', 'cricket'], ['Handball', 'handball'], ['Volleyball', 'volleyball'], ['Motorsport', 'motorsport'], ['Cycling', 'cycling'], ['Fighting', 'mma'], ['Tennis', 'tennis'], ['American Football', 'amfootball']]

interface EspnAthlete { displayName: string; shortName?: string; flag?: { href: string }; headshot?: { href: string } | string }
interface EspnComp { competitors: { homeAway: 'home' | 'away'; score?: string; winner?: boolean; team?: { displayName: string; shortDisplayName?: string; logo?: string }; athlete?: EspnAthlete; linescores?: { value: number }[] }[]; status?: EspnEvent['status']; date?: string; type?: { abbreviation?: string; text?: string }; round?: { displayName?: string } }
interface EspnEvent {
  id: string; name: string; shortName?: string; date: string; endDate?: string; season?: { slug?: string }
  groupings?: { competitions: EspnComp[]; grouping?: { displayName?: string } }[]
  status: { type: { state: 'pre' | 'in' | 'post'; detail?: string; shortDetail?: string; description?: string }; displayClock?: string; period?: number }
  competitions?: EspnComp[]
}
function humanizeSlug(slug?: string) {
  if (!slug) return ''
  return slug.replace(/^\d{4}(-\d{2})?-/, '').split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ')
}
async function espn(feed: string, sport: Sport): Promise<Match[]> {
  const r = await fetch(`${ESPN}/${feed}/scoreboard?limit=500`, { signal: AbortSignal.timeout(12_000) })
  if (!r.ok) return []
  const d = (await r.json()) as { events?: EspnEvent[]; leagues?: { name?: string; logos?: { href: string }[] }[] }
  const leagueName = feed === 'soccer/all' ? undefined : d.leagues?.[0]?.name
  const leagueLogo = d.leagues?.[0]?.logos?.[0]?.href
  const out: Match[] = []
  for (const e of d.events ?? []) {
    const competition = leagueName ?? (humanizeSlug(e.season?.slug) || 'Football')
    const base = { sport, competition, leagueLogo: feed === 'soccer/all' ? undefined : leagueLogo, leagueKey: feed, source: 'espn' as const }
    if (sport === 'tennis') {
      // tournament -> every match in every grouping; players carry country flags and set scores
      for (const g of e.groupings ?? []) for (const c of g.competitions) {
        const [a, b] = c.competitors
        if (!a?.athlete || !b?.athlete) continue
        const st = c.status ?? e.status; const state = st.type.state
        const sets = (x: typeof a) => (x.linescores ?? []).filter((l, i) => { const o = (x === a ? b : a).linescores?.[i]; return o && l.value > o.value }).length
        out.push({ ...base, id: 'espn:' + e.id + ':' + (c as unknown as { id?: string }).id, kind: 'players', event: e.name, competition: e.name, home: a.athlete.displayName, away: b.athlete.displayName, homeShort: a.athlete.shortName, awayShort: b.athlete.shortName,
          homeLogo: a.athlete.flag?.href, awayLogo: b.athlete.flag?.href, start: new Date(c.date ?? e.date), state, homeScore: state !== 'pre' ? sets(a) : undefined, awayScore: state !== 'pre' ? sets(b) : undefined,
          clock: state === 'in' ? (a.linescores ?? []).map((l, i) => `${l.value}-${b.linescores?.[i]?.value ?? 0}`).join(' ') : undefined, detail: g.grouping?.displayName ?? c.round?.displayName })
      }
      continue
    }
    if (sport === 'motorsport') {
      // Grand Prix -> one entry per session (FP1, Qualifying, Race)
      for (const c of e.competitions ?? []) {
        const st = c.status ?? e.status; const state = st.type.state
        if (state === 'post') continue
        const session = c.type?.text ?? c.type?.abbreviation ?? 'Session'
        out.push({ ...base, id: 'espn:' + e.id + ':' + (c as unknown as { id?: string }).id, kind: 'session', event: e.name, home: e.shortName ?? e.name, away: session, start: new Date(c.date ?? e.date), state, clock: state === 'in' ? st.type.shortDetail : undefined, detail: e.name })
      }
      continue
    }
    if (sport === 'mma') {
      // fight card -> one entry per bout, main event first; athletes with headshots when ESPN has them
      const comps = e.competitions ?? []
      comps.forEach((c, i) => {
        const [a, b] = c.competitors
        if (!a?.athlete || !b?.athlete) return
        const st = c.status ?? e.status; const state = st.type.state
        const hs = (x: EspnAthlete) => (typeof x.headshot === 'string' ? x.headshot : x.headshot?.href)
        out.push({ ...base, id: 'espn:' + e.id + ':' + i, kind: 'event', event: e.name, competition: e.name, home: a.athlete.displayName, away: b.athlete.displayName, homeLogo: hs(a.athlete) ?? a.athlete.flag?.href, awayLogo: hs(b.athlete) ?? b.athlete.flag?.href, start: new Date(c.date ?? e.date), state, clock: state === 'in' ? st.type.shortDetail : undefined, detail: c.type?.text ?? (i === 0 ? 'Main event' : undefined) })
      })
      continue
    }
    const c = e.competitions?.[0]; if (!c) continue
    const home = c.competitors.find((x) => x.homeAway === 'home'), away = c.competitors.find((x) => x.homeAway === 'away')
    if (!home?.team || !away?.team) continue
    const st = c.status ?? e.status
    const state = st.type.state
    const clock = state === 'in' ? (st.type.description === 'Halftime' ? 'Mi-temps' : st.displayClock ? (sport === 'football' ? st.displayClock.replace(/:00$/, "'") : `${st.period ? 'P' + st.period + ' ' : ''}${st.displayClock}`) : st.type.shortDetail) : undefined
    out.push({ ...base, id: 'espn:' + e.id, kind: 'team', home: home.team.displayName, away: away.team.displayName, homeShort: home.team.shortDisplayName, awayShort: away.team.shortDisplayName, homeLogo: home.team.logo, awayLogo: away.team.logo, start: new Date(e.date), state,
      homeScore: home.score !== undefined ? +home.score : undefined, awayScore: away.score !== undefined ? +away.score : undefined, clock, detail: st.type.detail })
  }
  return out
}

interface TsdbEvent { idEvent: string; strEvent: string; strLeague: string; strHomeTeam: string; strAwayTeam: string; strTimestamp?: string; dateEvent?: string; strTime?: string; strHomeTeamBadge?: string; strAwayTeamBadge?: string; intHomeScore?: string | null; intAwayScore?: string | null; strStatus?: string; strProgress?: string }
async function tsdb(day: string, sportName: string, sport: Sport): Promise<Match[]> {
  const r = await fetch(`${TSDB}/eventsday.php?d=${day}&s=${encodeURIComponent(sportName)}`, { signal: AbortSignal.timeout(12_000) })
  if (!r.ok) return []
  const d = (await r.json()) as { events?: TsdbEvent[] | null }
  const single = ['cycling', 'motorsport'].includes(sport)
  return (d.events ?? []).filter((e) => single || (e.strHomeTeam && e.strAwayTeam)).map((e) => {
    const start = new Date((e.strTimestamp ?? `${e.dateEvent}T${e.strTime ?? '00:00:00'}`) + (e.strTimestamp?.endsWith('Z') ? '' : 'Z'))
    const st = (e.strStatus ?? '').toUpperCase()
    const state: Match['state'] = ['FT', 'AOT', 'AP', 'FINISHED', 'MATCH FINISHED'].includes(st) ? 'post' : st && st !== 'NS' && st !== 'NOT STARTED' && !st.startsWith('POSTP') ? 'in' : Date.now() - start.getTime() > 3 * 3600e3 ? 'post' : 'pre'
    return {
      id: 'tsdb:' + e.idEvent, kind: single ? 'event' : sport === 'tennis' || sport === 'mma' ? 'players' : 'team', event: single ? e.strEvent : undefined, sport, competition: e.strLeague, home: single ? e.strEvent : e.strHomeTeam, away: single ? e.strLeague : e.strAwayTeam, homeLogo: e.strHomeTeamBadge ? e.strHomeTeamBadge + '/small' : undefined, awayLogo: e.strAwayTeamBadge ? e.strAwayTeamBadge + '/small' : undefined,
      start, state, homeScore: e.intHomeScore != null ? +e.intHomeScore : undefined, awayScore: e.intAwayScore != null ? +e.intAwayScore : undefined, clock: state === 'in' ? e.strProgress || 'En cours' : undefined, source: 'tsdb',
    } satisfies Match
  })
}

/** All fixtures for today and tomorrow (UTC days), live and upcoming only. */
export async function fetchMatches(): Promise<Match[]> {
  const days = [0, 1].map((o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10))
  const jobs: Promise<Match[]>[] = [
    ...ESPN_FEEDS.map(([f, s]) => espn(f, s).catch(() => [])),
    ...days.flatMap((day) => TSDB_SPORTS.map(([n, s]) => tsdb(day, n, s).catch(() => []))),
  ]
  const all = (await Promise.all(jobs)).flat()
  // dedupe (same teams within 2h) preferring ESPN
  const seen = new Map<string, Match>()
  const pri = (m: Match) => (m.source === 'espn' ? (m.leagueLogo ? 0 : 1) : 2)
  for (const m of all.sort((a, b) => pri(a) - pri(b))) {
    const k = m.kind + '|' + [norm(m.home), norm(m.away)].sort().join('|') + '|' + Math.round(m.start.getTime() / 7200e3)
    if (!seen.has(k)) seen.set(k, m)
  }
  const cutoff = Date.now() - 3 * 3600e3
  return [...seen.values()].filter((m) => m.state !== 'post' && m.start.getTime() > cutoff).sort((a, b) => a.start.getTime() - b.start.getTime())
}
export function norm(s: string) { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() }
