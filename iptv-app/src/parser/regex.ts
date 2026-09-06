import type { ParsedTitle } from '../types'

/**
 * Title cleaning pipeline for Xtream names.
 * Handles the three shapes seen in the wild:
 *   VOD    "FR - Le Dormeur éveillé (2021)"       "EN - The Postman (1997) KEVIN COSTNER"
 *   Series "NF - Away"  "4K - The New Pope (2020) (IT)"  "EN - Yarim Kalan (2020) (TR)"
 *   Live   "FR| TF1 FHD"  "UK| SKY SPORT+ VIP ᴿᴬᵂ"  "ENDED | WOLFSBURG - COTTBUS | Sat 05 Sep"
 */

// "FR - ", "|FR| ", "FR| ", "[FR] ", "4K - ", "NF - " …  (2-6 upper alnum, incl. '+')
const RE_PREFIX = /^\s*[[|]?\s*([A-Z0-9+]{2,6})\s*(?:[\]|]\s*[-:]?|[-:|])\s*/
// Year in parentheses/brackets or bare (1900-2099), keeps last occurrence
const RE_YEAR = /[([]\s*((?:19|20)\d{2})\s*[)\]]|\b((?:19|20)\d{2})\b(?=\s*$)/
// Season/episode: S01E05, S1 E5, 1x05, "Saison 2", "Season 3"
const RE_SxxExx = /\b[Ss](\d{1,2})\s*[EeXx]\s*(\d{1,3})\b/
const RE_NxNN = /\b(\d{1,2})x(\d{1,3})\b/
// Turkish episodes: "Kara Sevda 42 Bölüm", "BOLUM 18"
const RE_BOLUM = /\b(?:(\d{1,4})\.?\s*B[oö]l[uü]m|B[oö]l[uü]m\s*(\d{1,4}))\b/i
const RE_SEASON_WORD = /\b(?:S(?:eason|aison)|Temporada|Staffel)\s*(\d{1,2})\b/i
// Quality tokens (kept as `quality`)
const RE_QUALITY = /\b(8K|4K|UHD|2160p|1080p|FHD|720p|HD|SD|HDR|HEVC|H\.?265|x265|x264|LQ|HQ|RAW|VIP)\b|(ᴴᴰ|ᶠᴴᴰ|ᵁᴴᴰ|ᴿᴬᵂ|ⱽᴵᴾ|ᴱᴺ|ᴳᴼᴸᴰ)/g
// Language / release noise (kept as tags)
const RE_NOISE = /\b(MULTI|VF|VFF|VFQ|VOSTFR|VOST|TRUEFRENCH|FRENCH|ENGLISH|ENG(?:-SUB)?|SUB(?:BED|S)?|DUB(?:BED|BING|LAJ)?|POLSKI|NAPISY|LEKTOR|DOKUMENT|DOCUMENTARY|ITALIAN|SPANISH|JAPANESE|GERMAN|WEB[- ]?DL|WEB[- ]?RIP|BLURAY|BRRIP|DVDRIP|HDTV|CAM|TS|3D|IMAX|EXTENDED|UNRATED|REMASTERED|DIRECTOR'?S CUT|COLLECTION|PPV|24\/7)\b/gi
const RE_EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu
const RE_ADULT = /^\s*\[X\]|\bXXX\b|\bPORN|\bADULT\b|\b18\+/i
const RE_TRAILING_PAREN = /\s*\(([^()]*)\)\s*$/

const SEP_WS = /[._]+|\s{2,}/g

export function cleanTitle(raw: string): ParsedTitle {
  const tags: string[] = []
  let s = (raw ?? '').normalize('NFC')
  const isAdult = RE_ADULT.test(s)

  // 1. language / provider prefix
  let lang: string | undefined
  const pm = RE_PREFIX.exec(s)
  if (pm) {
    lang = pm[1]
    s = s.slice(pm[0].length)
  }

  // 2. emojis and exotic symbols
  s = s.replace(RE_EMOJI, ' ')

  // 3. season / episode
  let season: number | undefined
  let episode: number | undefined
  let m = RE_SxxExx.exec(s)
  if (m) {
    season = +m[1]; episode = +m[2]; s = s.replace(RE_SxxExx, ' ')
  } else if ((m = RE_NxNN.exec(s))) {
    season = +m[1]; episode = +m[2]; s = s.replace(RE_NxNN, ' ')
  } else if ((m = RE_SEASON_WORD.exec(s))) {
    season = +m[1]; s = s.replace(RE_SEASON_WORD, ' ')
  } else if ((m = RE_BOLUM.exec(s))) {
    season = 1; episode = +(m[1] ?? m[2]); s = s.replace(RE_BOLUM, ' ').replace(/\b(?:Full|FİNAL|Final)\b|@\w+/g, ' ')
  }

  // 4. year (+ everything after it is a "note": actor names, country, dub info)
  let year: number | undefined
  let searchTitle: string | undefined
  const ym = RE_YEAR.exec(s)
  if (ym) {
    year = +(ym[1] ?? ym[2])
    const before = s.slice(0, ym.index)
    const after = s.slice(ym.index + ym[0].length).trim()
    if (after) tags.push(...after.split(/\s*[|/,]\s*|\s{2,}|(?<=\))\s*(?=\()/).map((t) => t.replace(/^\(|\)$/g, '').trim()).filter(Boolean))
    searchTitle = before
    s = before
  }

  // 5. quality
  let quality: string | undefined
  s = s.replace(RE_QUALITY, (_, q, sup) => {
    const v = (q ?? superToAscii(sup)).toUpperCase()
    if (!quality) quality = v
    tags.push(v)
    return ' '
  })

  // 6. tech / language noise
  s = s.replace(RE_NOISE, (t) => { tags.push(t.toUpperCase()); return ' ' })

  // 7. trailing parenthesised note "(IT)", "(DUB)" -> tag
  let tp: RegExpExecArray | null
  while ((tp = RE_TRAILING_PAREN.exec(s)) && tp[1].length <= 12) {
    tags.push(tp[1].trim()); s = s.slice(0, tp.index)
  }

  // 8. separators / whitespace / dangling punctuation
  const title = tidy(s)
  const st = tidy(searchTitle ?? s).replace(/\s*[-:|]\s*$/, '')

  return {
    title: title || tidy(raw),
    searchTitle: st || title || tidy(raw),
    year, lang, quality, season, episode,
    tags: [...new Set(tags.filter(Boolean))],
    isAdult,
  }
}

function tidy(s: string): string {
  return s
    .replace(SEP_WS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-:|,.]+|[\s\-:|,.]+$/g, '')
    .trim()
}

const SUP: Record<string, string> = { ᴴᴰ: 'HD', ᶠᴴᴰ: 'FHD', ᵁᴴᴰ: 'UHD', ᴿᴬᵂ: 'RAW', ⱽᴵᴾ: 'VIP', ᴱᴺ: 'EN', ᴳᴼᴸᴰ: 'GOLD' }
function superToAscii(s?: string) { return s ? SUP[s] ?? s : '' }

/** Category names: "|FR| NETFLIX 2026" -> { lang:'FR', name:'Netflix 2026' } */
export function cleanCategory(raw: string): { name: string; lang?: string } {
  const m = RE_PREFIX.exec(raw)
  const lang = m?.[1]
  const rest = (m ? raw.slice(m[0].length) : raw).replace(RE_EMOJI, ' ').replace(/[ᴴᴰᶠᵁᴿᴬᵂⱽᴵᴾᴱᴺᴳᴼᴸ]+/g, ' ')
  return { name: tidy(rest) || tidy(raw), lang }
}

export function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
