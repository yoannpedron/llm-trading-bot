import type { Kind, ParsedTitle } from '../types'

const RE_SERIES_CAT = /\bs[ée]ries?\b|\bserien\b|\bseriale\b|\bmosalsal|مسلسل|\bdizi(?:ler)?\b|\bnovelas?\b/i

/**
 * Xtream already splits the three endpoints, which is the primary signal.
 * Regex is only a safety net: series episodes mis-filed as VOD (SxxExx,
 * "12. Bölüm"), and VOD categories explicitly named "series".
 */
export function classify(source: Kind, parsed: ParsedTitle, categoryName: string): Kind {
  if (source === 'live') return 'live'
  if (source === 'series') return 'series'
  if (parsed.season !== undefined && parsed.episode !== undefined) return 'series'
  if (RE_SERIES_CAT.test(categoryName)) return 'series'
  return 'movie'
}
