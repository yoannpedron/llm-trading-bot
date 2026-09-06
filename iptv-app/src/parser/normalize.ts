import type { Category, Kind, MediaItem, XtreamCategory, XtreamLive, XtreamSeries, XtreamVod } from '../types'
import { cleanCategory, cleanTitle, toNumber } from './regex'
import { classify } from './classify'
import { TAG_PREFIXES, resolveLang } from './langs'

/** language cascade: title prefix → category prefix → unidentified; platform prefixes (NF, 4K…) become tags */
function withLang<T extends { lang?: string; tags: string[] }>(p: T, catName: string): T {
  const raw = p.lang
  const lang = resolveLang(raw, cleanCategory(catName).lang)
  const tags = raw && TAG_PREFIXES.has(raw.toUpperCase()) && !p.tags.includes(raw) ? [...p.tags, raw] : p.tags
  return { ...p, lang, tags }
}

export function normalizeCategory(c: XtreamCategory, kind: Kind): Category {
  const { name, lang } = cleanCategory(c.category_name)
  return { id: String(c.category_id), kind, rawName: c.category_name, name, lang }
}

function firstImage(v?: string[] | string): string | undefined {
  if (!v) return undefined
  const s = Array.isArray(v) ? v[0] : v
  return s && /^https?:\/\//.test(s) ? s : undefined
}

export function normalizeVod(x: XtreamVod, catName: string): MediaItem {
  const p = withLang(cleanTitle(x.name), catName)
  const kind = classify('movie', p, catName)
  return {
    ...p,
    id: `movie:${x.stream_id}`,
    kind,
    rawName: x.name,
    streamId: x.stream_id,
    categoryId: String(x.category_id),
    tmdbId: toNumber(x.tmdb),
    poster: firstImage(x.stream_icon),
    rating: toNumber(x.rating),
    added: toNumber(x.added),
    ext: x.container_extension || 'mp4',
    isAdult: p.isAdult || String(x.is_adult) === '1',
  }
}

export function normalizeSeries(x: XtreamSeries, catName: string): MediaItem {
  const p = withLang(cleanTitle(x.name), catName)
  const date = x.releaseDate || x.release_date
  const year = p.year ?? toNumber(date?.slice(0, 4))
  return {
    ...p,
    year,
    id: `series:${x.series_id}`,
    kind: classify('series', p, catName),
    rawName: x.name,
    streamId: x.series_id,
    categoryId: String(x.category_id),
    tmdbId: toNumber(x.tmdb),
    poster: firstImage(x.cover),
    backdrop: firstImage(x.backdrop_path),
    rating: toNumber(x.rating),
    added: toNumber(x.last_modified),
    plot: x.plot || undefined,
    cast: x.cast || undefined,
    director: x.director || undefined,
    genre: x.genre || undefined,
  }
}

export function normalizeLive(x: XtreamLive, catName: string): MediaItem {
  const p = cleanTitle(x.name)
  return {
    ...p,
    id: `live:${x.stream_id}`,
    kind: classify('live', p, catName),
    rawName: x.name,
    streamId: x.stream_id,
    categoryId: String(x.category_id),
    poster: firstImage(x.stream_icon),
    added: toNumber(x.added),
    ext: 'm3u8',
    epgChannelId: x.epg_channel_id || undefined,
    tvArchive: !!x.tv_archive,
    isAdult: p.isAdult || String(x.is_adult) === '1',
  }
}
