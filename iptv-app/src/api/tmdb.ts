/**
 * TMDB v3 client with: single-request enrichment (append_to_response),
 * concurrency limiter (TMDB tolerates ~50 req/s; we stay well under),
 * and an IndexedDB cache so a title is never fetched twice.
 */
const KEY = import.meta.env.VITE_TMDB_API_KEY as string | undefined
const API = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p'
const LANG = 'fr-FR'

export type ImgSize = 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original'
export const img = (path?: string | null, size: ImgSize = 'w500') => (path ? `${IMG}/${size}${path}` : undefined)
export const hasTmdbKey = () => !!KEY

export interface Person { id: number; name: string; character?: string; job?: string; profile?: string }
export interface Similar { id: number; title: string; poster?: string; backdrop?: string; year?: number; rating?: number }
export interface Enriched {
  tmdbId: number
  media: 'movie' | 'tv'
  title: string
  originalTitle?: string
  tagline?: string
  overview?: string
  year?: number
  runtime?: number
  rating?: number
  votes?: number
  genres: string[]
  poster?: string
  backdrop?: string
  logo?: string
  cast: Person[]
  director?: string
  creators?: string[]
  similar: Similar[]
  trailer?: string
  seasons?: number
  episodes?: number
  status?: string
}

/* ---------- concurrency limiter ---------- */
let inFlight = 0
const queue: (() => void)[] = []
const MAX = 6
function slot(): Promise<void> {
  return new Promise((res) => { if (inFlight < MAX) { inFlight++; res() } else queue.push(() => { inFlight++; res() }) })
}
function release() { inFlight--; queue.shift()?.() }

export async function tmdb<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!KEY) throw new Error('VITE_TMDB_API_KEY missing')
  await slot()
  try {
    const q = new URLSearchParams({ api_key: KEY, language: LANG, ...params })
    const r = await fetch(`${API}${path}?${q}`)
    if (r.status === 429) { await new Promise((r) => setTimeout(r, 1500)); return tmdb<T>(path, params) }
    if (!r.ok) throw new Error(`TMDB ${r.status}`)
    return r.json() as Promise<T>
  } finally { release() }
}

/* ---------- IndexedDB cache ---------- */
const DB = 'iptv-tmdb'
let dbp: Promise<IDBDatabase> | undefined
function db(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no idb'))
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  }))
}
async function cacheGet<T>(k: string): Promise<T | undefined> {
  try {
    const d = await db()
    return await new Promise((res) => { const t = d.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined) })
  } catch { return undefined }
}
async function cacheSet(k: string, v: unknown) {
  try { const d = await db(); d.transaction('kv', 'readwrite').objectStore('kv').put(v, k) } catch { /* ignore */ }
}

/* ---------- mapping ---------- */
interface RawImages { logos?: { file_path: string; iso_639_1: string | null; vote_average: number }[] }
interface RawCredits { cast?: { id: number; name: string; character?: string; profile_path?: string | null }[]; crew?: { id: number; name: string; job?: string; profile_path?: string | null }[] }
interface RawSimilar { results?: { id: number; title?: string; name?: string; poster_path?: string | null; backdrop_path?: string | null; release_date?: string; first_air_date?: string; vote_average?: number }[] }
interface RawVideos { results?: { site: string; type: string; key: string; official?: boolean }[] }
export interface RawDetails {
  id: number; title?: string; name?: string; original_title?: string; original_name?: string; tagline?: string; overview?: string
  release_date?: string; first_air_date?: string; runtime?: number; episode_run_time?: number[]; vote_average?: number; vote_count?: number
  genres?: { name: string }[]; poster_path?: string | null; backdrop_path?: string | null; status?: string
  number_of_seasons?: number; number_of_episodes?: number; created_by?: { name: string }[]
  last_episode_to_air?: { runtime?: number | null } | null
  images?: RawImages; credits?: RawCredits; similar?: RawSimilar; videos?: RawVideos
}

function pickLogo(imgs?: RawImages) {
  const logos = imgs?.logos ?? []
  const pref = ['fr', 'en', null]
  const sorted = [...logos].sort((a, b) => pref.indexOf(a.iso_639_1) - pref.indexOf(b.iso_639_1) || b.vote_average - a.vote_average)
  const l = sorted.find((x) => pref.includes(x.iso_639_1)) ?? sorted[0]
  return l ? img(l.file_path, 'w500') : undefined
}

export function mapDetails(media: 'movie' | 'tv', d: RawDetails): Enriched {
  const date = d.release_date || d.first_air_date
  const trailer = d.videos?.results?.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ?? d.videos?.results?.find((v) => v.site === 'YouTube' && v.type === 'Trailer')
  return {
    tmdbId: d.id, media,
    title: d.title ?? d.name ?? '',
    originalTitle: d.original_title ?? d.original_name,
    tagline: d.tagline || undefined,
    overview: d.overview || undefined,
    year: date ? +date.slice(0, 4) : undefined,
    runtime: d.runtime ?? d.episode_run_time?.[0] ?? d.last_episode_to_air?.runtime ?? undefined,
    rating: d.vote_average, votes: d.vote_count,
    genres: d.genres?.map((g) => g.name) ?? [],
    poster: img(d.poster_path, 'w500'),
    backdrop: img(d.backdrop_path, 'w1280'),
    logo: pickLogo(d.images),
    cast: (d.credits?.cast ?? []).slice(0, 20).map((c) => ({ id: c.id, name: c.name, character: c.character, profile: img(c.profile_path, 'w185') })),
    director: d.credits?.crew?.find((c) => c.job === 'Director')?.name,
    creators: d.created_by?.map((c) => c.name),
    similar: (d.similar?.results ?? []).filter((s) => s.poster_path).slice(0, 20).map((s) => ({
      id: s.id, title: s.title ?? s.name ?? '', poster: img(s.poster_path, 'w342'), backdrop: img(s.backdrop_path, 'w1280'),
      year: (s.release_date || s.first_air_date) ? +(s.release_date || s.first_air_date)!.slice(0, 4) : undefined, rating: s.vote_average,
    })),
    trailer: trailer?.key,
    seasons: d.number_of_seasons, episodes: d.number_of_episodes, status: d.status,
  }
}

const APPEND = { append_to_response: 'credits,images,similar,videos', include_image_language: 'fr,en,null' }

export async function details(media: 'movie' | 'tv', id: number): Promise<Enriched> {
  const k = `${media}:${id}`
  const c = await cacheGet<Enriched>(k)
  if (c) return c
  const d = await tmdb<RawDetails>(`/${media}/${id}`, APPEND)
  const e = mapDetails(media, d)
  void cacheSet(k, e)
  return e
}

export async function search(media: 'movie' | 'tv', query: string, year?: number): Promise<number | undefined> {
  const k = `search:${media}:${query.toLowerCase()}:${year ?? ''}`
  const c = await cacheGet<number | null>(k)
  if (c !== undefined) return c ?? undefined
  const params: Record<string, string> = { query }
  if (year) params[media === 'movie' ? 'year' : 'first_air_date_year'] = String(year)
  let r = await tmdb<{ results: { id: number }[] }>(`/search/${media}`, params)
  if (!r.results.length && year) r = await tmdb<{ results: { id: number }[] }>(`/search/${media}`, { query })
  const id = r.results[0]?.id ?? null
  void cacheSet(k, id)
  return id ?? undefined
}

/** Resolve by id when the provider gives one, fall back to a title search. */
export async function enrich(media: 'movie' | 'tv', tmdbId: number | undefined, title: string, year?: number): Promise<Enriched | null> {
  const id = tmdbId ?? (await search(media, title, year))
  if (!id) return null
  try { return await details(media, id) } catch { return null }
}
