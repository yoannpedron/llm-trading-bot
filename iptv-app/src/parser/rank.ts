/** Importance of a match for this viewer: competition tier + own country + live + kick-off soon + favourites + big clubs + streams. */
import type { Match } from '../api/sports'
import { norm } from '../api/sports'

const TIER: [RegExp, number][] = [
  [/champions league/i, 100], [/world cup/i, 95], [/euro\b|nations league/i, 88], [/europa league/i, 84], [/libertadores/i, 72], [/conference league/i, 70],
  [/premier league/i, 78], [/laliga|la liga/i, 77], [/serie a/i, 75], [/bundesliga$/i, 75], [/ligue 1/i, 74],
  [/primeira liga/i, 55], [/eredivisie/i, 55], [/super lig/i, 50], [/pro league/i, 48], [/brazilian serie a|brasileir/i, 50], [/argentin/i, 48],
  [/fa cup|coupe de france|copa del rey|coppa italia|dfb/i, 60], [/nfl|national football league/i, 62], [/nba|national basketball/i, 60], [/nhl|national hockey/i, 55],
  [/championship|ligue 2|2\. bundesliga|segunda|serie b/i, 42], [/mls/i, 40], [/j\.league/i, 38], [/liga mx|liga bbva/i, 40],
]
const COUNTRY_OF: [RegExp, string][] = [[/premier league|championship|fa cup|english/i, 'GB'], [/laliga|la liga|copa del rey|spanish/i, 'ES'], [/serie a|serie b|coppa|italian/i, 'IT'], [/bundesliga|dfb|german/i, 'DE'], [/ligue 1|ligue 2|coupe de france|french/i, 'FR'], [/primeira|portugu/i, 'PT'], [/eredivisie|dutch/i, 'NL'], [/super lig|turkish/i, 'TR'], [/pro league|belgian/i, 'BE'], [/saudi/i, 'SA'], [/brazil/i, 'BR'], [/argentin/i, 'AR'], [/mls|nfl|nba|nhl|mlb|american/i, 'US'], [/j\.league|japan/i, 'JP'], [/mexic/i, 'MX'], [/scottish/i, 'GB']]
const BIG = new Set(['paris saint germain', 'marseille', 'lyon', 'real madrid', 'barcelona', 'atletico madrid', 'manchester united', 'manchester city', 'liverpool', 'arsenal', 'chelsea', 'tottenham hotspur', 'bayern munich', 'borussia dortmund', 'juventus', 'internazionale', 'inter', 'ac milan', 'napoli', 'benfica', 'porto', 'ajax', 'psv', 'celtic', 'galatasaray', 'fenerbahce', 'inter miami cf', 'al hilal', 'al nassr', 'flamengo', 'boca juniors', 'river plate'])
const REGION_ALIAS: Record<string, string> = { UK: 'GB', BEE: 'BE' }

export function competitionTier(name: string): number { for (const [re, v] of TIER) if (re.test(name)) return v; return 35 }
export function competitionCountry(name: string): string | undefined { for (const [re, c] of COUNTRY_OF) if (re.test(name)) return c; return undefined }

export function importance(m: Match, opts: { region: string; favTeams: string[]; favCompetitions: string[]; streams: number; now?: Date }): number {
  const now = opts.now ?? new Date()
  let s = competitionTier(m.competition)
  const region = REGION_ALIAS[opts.region] ?? opts.region
  if (competitionCountry(m.competition) === region) s += 35
  if (m.state === 'in') s += 1000 // live is a hard tier: always above anything scheduled
  const h = (m.start.getTime() - now.getTime()) / 3600e3
  if (h >= 0 && h <= 2) s += 15
  if (BIG.has(norm(m.home))) s += 10
  if (BIG.has(norm(m.away))) s += 10
  // favourites are a hard tier above everything, live favourites above scheduled ones
  if (opts.favTeams.includes(norm(m.home)) || opts.favTeams.includes(norm(m.away))) s += 2000
  if (opts.favCompetitions.includes(m.competition)) s += 25
  return s + Math.min(20, opts.streams * 3)
}
