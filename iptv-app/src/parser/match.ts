/** Fuzzy linking between server event streams ("ROMA - ATALANTA", 18:35) and fixtures from the sports APIs. */
import type { Match } from '../api/sports'
import type { LiveEvent } from './live'
import type { MediaItem } from '../types'
import { norm } from '../api/sports'

const STOP = new Set(['fc', 'sc', 'cf', 'afc', 'ac', 'as', 'sv', 'vfl', 'vfb', 'tsg', 'bsc', 'rb', 'rc', 'us', 'ss', 'ssc', 'club', 'de', 'du', 'the', 'city', 'united', 'town', 'real', 'athletic', 'atletico', 'sporting', 'olympique', 'stade', 'racing', 'deportivo', 'cd', 'ud', 'sd', 'ca', 'fk', 'sk', 'nk', 'hk', 'if', 'ik', 'bk', 'ff', 'hc', 'ehc', 'kfc', 'women', 'w', 'u21', 'u19', 'u23', 'ii', 'b'])
const ALIAS: Record<string, string> = { 'om': 'marseille', 'olympique de marseille': 'marseille', 'olympique marseille': 'marseille', 'ol': 'lyon', 'olympique lyonnais': 'lyon', 'losc': 'lille', 'losc lille': 'lille', 'asse': 'saint etienne', 'as saint etienne': 'saint etienne', 'ogcn': 'nice', 'ogc nice': 'nice', 'rcsa': 'strasbourg', 'rc strasbourg': 'strasbourg', 'srfc': 'rennes', 'stade rennais': 'rennes', 'fcn': 'nantes', 'psg': 'paris saint germain', 'paris sg': 'paris saint germain', 'borussia m gladbach': 'borussia monchengladbach', 'man utd': 'manchester united', 'man united': 'manchester united', 'man city': 'manchester city', 'spurs': 'tottenham hotspur', 'psg': 'paris saint germain', 'paris sg': 'paris saint germain', 'inter': 'internazionale', 'inter milan': 'internazionale', 'bayern': 'bayern munich', 'bayern munchen': 'bayern munich', 'gladbach': 'borussia monchengladbach', "borussia m'gladbach": 'borussia monchengladbach', 'wolves': 'wolverhampton wanderers', 'newcastle': 'newcastle united', 'leverkusen': 'bayer leverkusen', 'atletico': 'atletico madrid', 'barca': 'barcelona', 'juve': 'juventus', 'om': 'marseille', 'ol': 'lyon', 'losc': 'lille', 'ajax amsterdam': 'ajax', 'psv eindhoven': 'psv' }

export function teamTokens(name: string): Set<string> {
  let n = norm(name)
  n = ALIAS[n] ?? n
  return new Set(n.split(' ').filter((t) => t.length > 1 && !STOP.has(t)))
}
/** Dice coefficient on significant tokens, with a bonus for a full-token containment ("dortmund" ⊂ "borussia dortmund"). */
export function teamSimilarity(a: string, b: string): number {
  const A = teamTokens(a), B = teamTokens(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t) || [...B].some((u) => (t.length >= 5 && u.includes(t)) || (u.length >= 5 && t.includes(u)))) inter++
  const dice = (2 * inter) / (A.size + B.size)
  const contained = [...A].every((t) => B.has(t)) || [...B].every((t) => B.size && A.has(t))
  return Math.max(dice, contained ? 0.8 : 0)
}

/** Split "ROMA - ATALANTA" / "FC X VS. SV Y" / "X v Y" into two team names. */
export function splitTeams(title: string): [string, string] | undefined {
  const m = /^(.+?)\s+(?:vs?\.?|v\.|-|–|—|@)\s+(.+)$/i.exec(title.replace(/\s*\(.*?\)\s*$/, '').replace(/^(?:ligue 1|premier league|la ?liga|serie a|bundesliga|champions league|ucl|uel)\s*[:|-]?\s*/i, ''))
  if (!m) return undefined
  const a = m[1].trim(), b = m[2].trim()
  return a && b && a.length < 60 && b.length < 60 ? [a, b] : undefined
}

export interface Linked { match: Match; streams: MediaItem[]; score: number }
export interface LinkResult { linked: Map<string, Linked>; unmatched: { item: MediaItem; event: LiveEvent }[] }

/** Assign every live/upcoming event stream to at most one fixture (best team similarity within ±45 min). */
export function linkStreams(events: { item: MediaItem; event: LiveEvent }[], matches: Match[], windowMs = 45 * 60000): LinkResult {
  const linked = new Map<string, Linked>()
  const unmatched: LinkResult['unmatched'] = []
  for (const e of events) {
    const teams = splitTeams(e.event.title)
    let best: { m: Match; s: number } | undefined
    if (teams && e.event.start) {
      for (const m of matches) {
        if (Math.abs(m.start.getTime() - e.event.start.getTime()) > windowMs) continue
        const s1 = (teamSimilarity(teams[0], m.home) + teamSimilarity(teams[1], m.away)) / 2
        const s2 = (teamSimilarity(teams[0], m.away) + teamSimilarity(teams[1], m.home)) / 2
        const s = Math.max(s1, s2)
        if (s >= 0.55 && (!best || s > best.s)) best = { m, s }
      }
    }
    if (best) {
      const cur = linked.get(best.m.id) ?? { match: best.m, streams: [], score: best.s }
      cur.streams.push(e.item); cur.score = Math.max(cur.score, best.s); linked.set(best.m.id, cur)
    } else unmatched.push(e)
  }
  return { linked, unmatched }
}
