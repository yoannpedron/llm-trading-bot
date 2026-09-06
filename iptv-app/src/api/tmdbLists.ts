/**
 * "Official" rows: TMDB curated lists intersected with the provider catalogue by TMDB id,
 * plus cross-referenced rows (server × TMDB). Strict dedup: a title appears in one row only.
 * ~60 requests for the whole home page whatever the catalogue size.
 */
import { tmdb, img } from './tmdb'
import type { Kind, MediaItem } from '../types'

export interface ListRow { key: string; kind: Kind; type: 'top10' | 'row' | 'wide' | 'collection'; name: string; sub?: string; items: MediaItem[]; collections?: CollectionCard[] }
export interface CollectionPart { tmdbId: number; title: string; year?: string; rating?: number; poster?: string; item?: MediaItem }
export interface CollectionCard { id: number; name: string; poster?: string; backdrop?: string; total: number; have: number; complete: boolean; parts: CollectionPart[] }

export interface TmdbIndex {
  best: Map<string, MediaItem>            // `${kind}:${tmdbId}` -> preferred provider entry (FR > EN)
  versions: Map<string, string[]>         // all language versions on the server
  fourK: Set<string>                      // keys available in 4K/UHD
  added: Map<string, number>              // latest `added` timestamp per key
}

const PREF: Record<string, number> = { FR: 0, QFR: 1, EN: 2, ENG: 2, NF: 3, '4K': 3, EX: 4 }

export function buildTmdbIndex(items: MediaItem[]): TmdbIndex {
  const best = new Map<string, MediaItem>(), versions = new Map<string, string[]>(), fourK = new Set<string>(), added = new Map<string, number>()
  for (const it of items) {
    if (!it.tmdbId || it.kind === 'live') continue
    const k = it.kind + ':' + it.tmdbId
    const cur = best.get(k)
    if (!cur || (PREF[it.lang ?? ''] ?? 9) < (PREF[cur.lang ?? ''] ?? 9)) best.set(k, it)
    if (it.lang) { const v = versions.get(k) ?? []; if (!v.includes(it.lang)) v.push(it.lang); versions.set(k, v) }
    if (it.lang === '4K' || /^(4K|UHD|2160P)$/.test(it.quality ?? '')) fourK.add(k)
    if (it.added) added.set(k, Math.max(added.get(k) ?? 0, it.added))
  }
  return { best, versions, fourK, added }
}

interface R { id: number; release_date?: string; vote_count?: number; job?: string }
interface Page { results: R[] }
async function list(path: string, pages: number, params: Record<string, string> = {}): Promise<R[]> {
  const res = await Promise.all(Array.from({ length: pages }, (_, i) => tmdb<Page>(path, { ...params, page: String(i + 1) }).catch(() => ({ results: [] }))))
  return res.flatMap((p) => p.results)
}

export const MOVIE_GENRES: Record<string, number> = {
  Action: 28, Aventure: 12, Animation: 16, Comédie: 35, Crime: 80, Documentaire: 99, Drame: 18, Familial: 10751, Fantastique: 14,
  Histoire: 36, Horreur: 27, Musique: 10402, Mystère: 9648, Romance: 10749, 'Science-Fiction': 878, Thriller: 53, Guerre: 10752, Western: 37,
}
export const TV_GENRES: Record<string, number> = {
  'Action & Aventure': 10759, Animation: 16, Comédie: 35, Crime: 80, Documentaire: 99, Drame: 18, Familial: 10751, Mystère: 9648,
  'Science-Fiction & Fantastique': 10765, 'Guerre & Politique': 10768, Western: 37,
}
const DIRECTORS: Record<string, number> = { 'Christopher Nolan': 525, 'Denis Villeneuve': 137427, 'Quentin Tarantino': 138, 'Martin Scorsese': 1032 }
const SAGAS = [10, 1241, 86311, 9485, 263, 2344, 119, 87359, 645, 528, 8945, 748, 328, 31562, 1575]

export async function homeRows(idx: TmdbIndex): Promise<ListRow[]> {
  const used = new Set<string>()
  const take = (kind: Kind, ids: number[], n: number): MediaItem[] => {
    const out: MediaItem[] = []
    for (const id of ids) { const k = kind + ':' + id; const it = idx.best.get(k); if (it && !used.has(k)) { used.add(k); out.push(it); if (out.length >= n) break } }
    return out
  }
  const ids = (r: R[]) => r.map((x) => x.id)
  const recentKeys = new Set([...idx.added.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1500).map(([k]) => k))

  const [trM, now, popM, topM, masters, gems, fr, trT, air, topT, popT, ...rest] = await Promise.all([
    list('/trending/movie/week', 3), list('/movie/now_playing', 6, { region: 'FR' }), list('/movie/popular', 10), list('/movie/top_rated', 5),
    list('/discover/movie', 4, { sort_by: 'vote_average.desc', 'vote_count.gte': '8000' }),
    list('/discover/movie', 4, { sort_by: 'vote_average.desc', 'vote_count.gte': '400', 'vote_count.lte': '2500', 'primary_release_date.gte': '2015-01-01' }),
    list('/discover/movie', 5, { with_original_language: 'fr', sort_by: 'popularity.desc', 'vote_count.gte': '200' }),
    list('/trending/tv/week', 3), list('/tv/on_the_air', 5), list('/tv/top_rated', 3), list('/tv/popular', 4),
    ...Object.values(DIRECTORS).map((pid) => tmdb<{ crew: R[] }>(`/person/${pid}/movie_credits`).then((c) => c.crew.filter((x) => x.job === 'Director').sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))).catch(() => [] as R[])),
    ...Object.values(MOVIE_GENRES).slice(0, 12).map((g) => list('/discover/movie', 5, { with_genres: String(g), sort_by: 'popularity.desc', 'vote_count.gte': '300' })),
    ...Object.values(TV_GENRES).slice(0, 6).map((g) => list('/discover/tv', 4, { with_genres: String(g), sort_by: 'popularity.desc', 'vote_count.gte': '200' })),
  ])
  const dirs = rest.slice(0, 4), mg = rest.slice(4, 16), tg = rest.slice(16)

  const rows: ListRow[] = []
  rows.push({ key: 'top-m', kind: 'movie', type: 'top10', name: 'Top 10 films cette semaine', sub: 'Tendances TMDB croisées avec le catalogue', items: take('movie', ids(trM), 10) })
  rows.push({ key: 'now', kind: 'movie', type: 'wide', name: 'Dernières sorties cinéma disponibles', sub: 'Sorties récentes en salle déjà sur le serveur', items: take('movie', ids([...now].sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))), 16) })
  rows.push({ key: 'fresh', kind: 'movie', type: 'wide', name: 'Ajoutés cette semaine sur le serveur', sub: 'Derniers ajouts du provider, classés par popularité TMDB', items: take('movie', ids(popM).filter((i) => recentKeys.has('movie:' + i)), 16) })
  rows.push({ key: '4k', kind: 'movie', type: 'row', name: 'Disponibles en 4K', sub: 'Versions 4K/UHD du serveur, triées par popularité', items: take('movie', ids([...popM, ...topM]).filter((i) => idx.fourK.has('movie:' + i)), 16) })
  rows.push({ key: 'sagas', kind: 'movie', type: 'collection', name: 'Sagas complètes sur le serveur', sub: 'Franchises dont tous les films sont disponibles', items: [], collections: await collections(idx) })
  rows.push({ key: 'masters', kind: 'movie', type: 'row', name: 'Chefs-d’œuvre', sub: 'Note ≥ 8 avec plus de 8 000 votes', items: take('movie', ids(masters), 16) })
  rows.push({ key: 'gems', kind: 'movie', type: 'row', name: 'Pépites méconnues', sub: 'Très bien notés, peu vus : 400 à 2 500 votes depuis 2015', items: take('movie', ids(gems), 16) })
  Object.keys(DIRECTORS).forEach((name, i) => { const items = take('movie', ids(dirs[i]), 12); if (items.length >= 4) rows.push({ key: 'dir-' + name, kind: 'movie', type: 'row', name: `Réalisés par ${name}`, sub: `${items.length} films du réalisateur sur le serveur`, items }) })
  rows.push({ key: 'fr', kind: 'movie', type: 'row', name: 'Cinéma français', sub: 'Films en langue originale française', items: take('movie', ids(fr), 16) })
  rows.push({ key: 'top-t', kind: 'series', type: 'top10', name: 'Top 10 séries cette semaine', items: take('series', ids(trT), 10) })
  rows.push({ key: 'air', kind: 'series', type: 'wide', name: 'Nouveaux épisodes cette semaine', sub: 'Séries en cours de diffusion, présentes sur le serveur', items: take('series', ids(air), 16) })
  Object.keys(MOVIE_GENRES).slice(0, 12).forEach((g, i) => rows.push({ key: 'g-' + g, kind: 'movie', type: 'row', name: g, items: take('movie', ids(mg[i]), 14) }))
  rows.push({ key: 'rated-t', kind: 'series', type: 'row', name: 'Séries les mieux notées', items: take('series', ids(topT), 16) })
  rows.push({ key: 'pop-t', kind: 'series', type: 'row', name: 'Séries populaires', items: take('series', ids(popT), 16) })
  Object.keys(TV_GENRES).slice(0, 6).forEach((g, i) => rows.push({ key: 'tg-' + g, kind: 'series', type: 'row', name: `Séries · ${g}`, items: take('series', ids(tg[i]), 14) }))
  return rows.filter((r) => r.type === 'collection' ? (r.collections?.length ?? 0) > 0 : r.items.length >= 4)
}

interface RawCollection { id: number; name: string; poster_path?: string | null; backdrop_path?: string | null; parts: { id: number; title: string; release_date?: string; vote_average?: number; poster_path?: string | null }[] }
export async function collection(id: number, idx: TmdbIndex): Promise<CollectionCard | undefined> {
  const c = await tmdb<RawCollection>(`/collection/${id}`).catch(() => undefined)
  if (!c) return undefined
  const today = new Date().toISOString().slice(0, 10)
  const parts = c.parts.filter((p) => p.release_date && p.release_date <= today).sort((a, b) => a.release_date!.localeCompare(b.release_date!))
    .map((p) => ({ tmdbId: p.id, title: p.title, year: p.release_date?.slice(0, 4), rating: p.vote_average, poster: img(p.poster_path, 'w185'), item: idx.best.get('movie:' + p.id) }))
  const have = parts.filter((p) => p.item).length
  if (parts.length < 2 || have < 2) return undefined
  return { id: c.id, name: c.name, poster: img(c.poster_path, 'w342'), backdrop: img(c.backdrop_path, 'w780'), total: parts.length, have, complete: have === parts.length, parts }
}
async function collections(idx: TmdbIndex): Promise<CollectionCard[]> {
  const all = await Promise.all(SAGAS.map((id) => collection(id, idx)))
  return all.filter((c): c is CollectionCard => !!c).sort((a, b) => Number(b.complete) - Number(a.complete) || b.have - a.have)
}

/** Deep genre browse: up to 400 TMDB titles by popularity, filtered to the catalogue. */
export async function genreItems(kind: Kind, genreId: number, idx: TmdbIndex, pages = 20): Promise<MediaItem[]> {
  const l = await list(kind === 'movie' ? '/discover/movie' : '/discover/tv', pages, { with_genres: String(genreId), sort_by: 'popularity.desc', 'vote_count.gte': '50' })
  const out: MediaItem[] = []; const seen = new Set<number>()
  for (const r of l) { const it = idx.best.get(kind + ':' + r.id); if (it && !seen.has(r.id)) { seen.add(r.id); out.push(it) } }
  return out
}
