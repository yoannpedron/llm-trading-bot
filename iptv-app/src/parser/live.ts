/** Live TV helpers: country from category prefix, theme from category words, dated sport events from stream names. */

export interface Country { code: string; name: string; flag: string }
const C: Record<string, [string, string]> = {
  UK: ['Royaume-Uni', '🇬🇧'], US: ['États-Unis', '🇺🇸'], FR: ['France', '🇫🇷'], DE: ['Allemagne', '🇩🇪'], AR: ['Monde arabe', '🇸🇦'], ES: ['Espagne', '🇪🇸'],
  NL: ['Pays-Bas', '🇳🇱'], IT: ['Italie', '🇮🇹'], PL: ['Pologne', '🇵🇱'], CA: ['Canada', '🇨🇦'], BE: ['Belgique', '🇧🇪'], BEE: ['Belgique', '🇧🇪'], TR: ['Turquie', '🇹🇷'],
  PT: ['Portugal', '🇵🇹'], BR: ['Brésil', '🇧🇷'], LAT: ['Amérique latine', '🌎'], ASIA: ['Asie', '🌏'], IN: ['Inde', '🇮🇳'], CZ: ['Tchéquie', '🇨🇿'], GR: ['Grèce', '🇬🇷'],
  RO: ['Roumanie', '🇷🇴'], IR: ['Iran', '🇮🇷'], AFR: ['Afrique', '🌍'], AT: ['Autriche', '🇦🇹'], AU: ['Australie', '🇦🇺'], AL: ['Albanie', '🇦🇱'], ALB: ['Albanie', '🇦🇱'],
  CH: ['Suisse', '🇨🇭'], HR: ['Croatie', '🇭🇷'], EXYU: ['Ex-Yougoslavie', '🇷🇸'], RS: ['Serbie', '🇷🇸'], IS: ['Islande', '🇮🇸'], SWE: ['Suède', '🇸🇪'], SE: ['Suède', '🇸🇪'],
  NO: ['Norvège', '🇳🇴'], DK: ['Danemark', '🇩🇰'], FI: ['Finlande', '🇫🇮'], RU: ['Russie', '🇷🇺'], UKR: ['Ukraine', '🇺🇦'], BG: ['Bulgarie', '🇧🇬'], HU: ['Hongrie', '🇭🇺'],
  SK: ['Slovaquie', '🇸🇰'], SL: ['Slovénie', '🇸🇮'], MK: ['Macédoine', '🇲🇰'], CY: ['Chypre', '🇨🇾'], MT: ['Malte', '🇲🇹'], NZ: ['Nouvelle-Zélande', '🇳🇿'], SG: ['Singapour', '🇸🇬'],
  MY: ['Malaisie', '🇲🇾'], ID: ['Indonésie', '🇮🇩'], KO: ['Corée', '🇰🇷'], KU: ['Kurdistan', '🏳️'], AM: ['Arménie', '🇦🇲'], GE: ['Géorgie', '🇬🇪'], LT: ['Lituanie', '🇱🇹'],
  EST: ['Estonie', '🇪🇪'], BY: ['Biélorussie', '🇧🇾'], BAN: ['Bangladesh', '🇧🇩'], CRB: ['Caraïbes', '🌴'], CG: ['Congo', '🇨🇬'], NA: ['Amérique du Nord', '🏒'], EU: ['Europe', '🇪🇺'],
  SA: ['Arabie saoudite', '🇸🇦'], BH: ['Bahreïn', '🇧🇭'], MXC: ['Mexique', '🇲🇽'], LA: ['Laos', '🇱🇦'], KA: ['Kazakhstan', '🇰🇿'],
}
const RE_CC = /^\s*([A-Z]{2,6})\s*\|/
export function countryOf(categoryName: string): Country | undefined {
  const m = RE_CC.exec(categoryName)
  const code = m?.[1]
  if (!code || !C[code]) return undefined
  return { code, name: C[code][0], flag: C[code][1] }
}

export type Theme = 'sport' | 'news' | 'kids' | 'movies' | 'music' | 'documentary' | 'religion' | 'radio' | 'events' | '24/7' | 'general'
const THEMES: [Theme, RegExp][] = [
  ['events', /\bPPV\b|EVENT|UFC|BOXING|WWE|FORMULA|F1\b|MOTOGP/i],
  ['sport', /SPORT|FOOT|SOCCER|LEAGUE|LIGA|NBA|NFL|NHL|MLB|TENNIS|GOLF|CRICKET|RUGBY|HOCKEY|BEIN|DAZN|ESPN|CANAL\+ ?SPORT|EUROSPORT/i],
  ['news', /NEWS|INFO|ACTU|NOTICIAS|NACHRICHTEN|أخبار/i],
  ['kids', /KIDS|ENFANT|CHILDREN|CARTOON|JUNIOR|CRTANI|NIÑOS|أطفال/i],
  ['movies', /MOVIE|CINEMA|CINÉ|FILM|SERIES|SHOWS?\b|HBO|SKY CINEMA|أفلام/i],
  ['music', /MUSIC|MUSIQUE|MTV|HITS|SINGER|أغاني/i],
  ['documentary', /DOCU|DISCOVERY|NAT ?GEO|HISTORY|وثائق/i],
  ['religion', /RELIGI|ISLAM|CHRISTIAN|QURAN|قرآن|GOSPEL/i],
  ['radio', /RADIO|FM\b/i],
  ['24/7', /24\/7|24-7/i],
]
export function themeOf(categoryName: string): Theme {
  for (const [t, re] of THEMES) if (re.test(categoryName)) return t
  return 'general'
}
export const THEME_LABEL: Record<Theme, string> = { sport: 'Sport', events: 'Événements & PPV', news: 'Info', kids: 'Enfants', movies: 'Cinéma & séries', music: 'Musique', documentary: 'Documentaires', religion: 'Religion', radio: 'Radio', '24/7': '24/7', general: 'Généralistes' }

/* ---- dated events: "NEXT | ROMA - ATALANTA | Sat 05 Sep 18:35 GMT (IS) | 8K EXCLUSIVE | IS: LIVEY PPV 29" ---- */
export interface LiveEvent { status: 'live' | 'next' | 'ended'; title: string; start?: Date; country?: string; provider?: string; raw: string }
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
const TZ: Record<string, number> = { GMT: 0, UTC: 0, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180, IST: 330, EST: -300, EDT: -240, CST: -360, CDT: -300, PST: -480, PDT: -420, AST: 180 }
const RE_EVENT = /^\s*(NEXT|ENDED|LIVE)\s*\|\s*(.+?)\s*\|\s*(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})\s*([A-Z]{2,4}|[+-]\d{1,2}(?::?\d{2})?)?\s*(?:\(([A-Z]{2,3})\))?/
const RE_ISO = /\((\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::\d{2})?\)/

export function parseEvent(name: string, now = new Date()): LiveEvent | undefined {
  let m = RE_EVENT.exec(name)
  if (m) {
    const [, st, title, , d, mon, hh, mm, tz, cc] = m
    const month = MONTHS[mon.toLowerCase()]
    let offset = 0
    if (tz) offset = tz in TZ ? TZ[tz] : parseOffset(tz)
    let year = now.getFullYear()
    const utc = Date.UTC(year, month, +d, +hh, +mm) - offset * 60_000
    // events are announced a few days ahead: fix year around New Year
    const start = new Date(utc)
    if (start.getTime() - now.getTime() > 200 * 864e5) start.setUTCFullYear(year - 1)
    if (now.getTime() - start.getTime() > 200 * 864e5) start.setUTCFullYear(year + 1)
    const provider = name.split('|').pop()?.trim()
    let status: LiveEvent['status'] = st === 'ENDED' ? 'ended' : st === 'LIVE' ? 'live' : 'next'
    if (status === 'next' && start.getTime() <= now.getTime() && now.getTime() - start.getTime() < 3 * 3600e3) status = 'live'
    return { status, title: title.trim(), start, country: cc, provider, raw: name }
  }
  m = RE_ISO.exec(name)
  if (m) {
    const start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))
    const title = name.replace(RE_ISO, '').replace(/^\s*\([^)]*\)\s*\|?\s*/, '').replace(/\s*_\s*/g, ' · ').trim()
    const age = now.getTime() - start.getTime()
    return { status: age < 0 ? 'next' : age < 3 * 3600e3 ? 'live' : 'ended', title, start, raw: name }
  }
  return undefined
}
function parseOffset(s: string): number {
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(s); if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + (+(m[3] ?? 0)))
}
