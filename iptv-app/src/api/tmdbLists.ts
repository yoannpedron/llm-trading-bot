/**
 * "Official" rows: TMDB curated lists (trending, now playing, popular, top rated,
 * discover by genre) intersected with the provider catalogue by TMDB id.
 * ~40 requests for the whole home page whatever the catalogue size.
 */
import { tmdb } from './tmdb'
import type { Kind, MediaItem } from '../types'

export interface ListRow { key: string; kind: Kind; type: 'top10' | 'row' | 'wide'; name: string; items: MediaItem[] }
export type TmdbIndex = Map<string, MediaItem>   // `${kind}:${tmdbId}` -> best provider entry

const PREF: Record<string, number> = { FR: 0, QFR: 1, EN: 2, ENG: 2, NF: 3, '4K': 3, EX: 4 }

/** One entry per TMDB id, preferring FR then EN versions. */
export function buildTmdbIndex(items: MediaItem[]): TmdbIndex {
  const idx: TmdbIndex = new Map()
  for (const it of items) {
    if (!it.tmdbId || it.kind === 'live') continue
    const k = it.kind + ':' + it.tmdbId
    const cur = idx.get(k)
    if (!cur || (PREF[it.lang ?? ''] ?? 9) < (PREF[cur.lang ?? ''] ?? 9)) idx.set(k, it)
  }
  return idx
}

interface Page { results: { id: number }[] }
async function ids(path: string, pages: number, params: Record<string, string> = {}): Promise<number[]> {
  const res = await Promise.all(Array.from({ length: pages }, (_, i) => tmdb<Page>(path, { ...params, page: String(i + 1) }).catch(() => ({ results: [] }))))
  return res.flatMap((p) => p.results.map((r) => r.id))
}
function pick(list: number[], kind: Kind, idx: TmdbIndex, n: number): MediaItem[] {
  const out: MediaItem[] = []; const seen = new Set<number>()
  for (const id of list) {
    if (seen.has(id)) continue
    const it = idx.get(kind + ':' + id)
    if (it) { seen.add(id); out.push(it); if (out.length >= n) break }
  }
  return out
}

export const MOVIE_GENRES: Record<string, number> = {
  Action: 28, Aventure: 12, Animation: 16, Comédie: 35, Crime: 80, Documentaire: 99, Drame: 18, Familial: 10751, Fantastique: 14,
  Histoire: 36, Horreur: 27, Musique: 10402, Mystère: 9648, Romance: 10749, 'Science-Fiction': 878, Thriller: 53, Guerre: 10752, Western: 37,
}
export const TV_GENRES: Record<string, number> = {
  'Action & Aventure': 10759, Animation: 16, Comédie: 35, Crime: 80, Documentaire: 99, Drame: 18, Familial: 10751, Mystère: 9648,
  'Science-Fiction & Fantastique': 10765, 'Guerre & Politique': 10768, Western: 37,
}

export async function homeRows(idx: TmdbIndex): Promise<ListRow[]> {
  const [trM, nowM, popM, topM, trT, popT, topT, ...genres] = await Promise.all([
    ids('/trending/movie/week', 3), ids('/movie/now_playing', 5, { region: 'FR' }), ids('/movie/popular', 3), ids('/movie/top_rated', 3),
    ids('/trending/tv/week', 3), ids('/tv/popular', 3), ids('/tv/top_rated', 3),
    ...['Action', 'Comédie', 'Thriller', 'Science-Fiction', 'Horreur', 'Animation', 'Crime', 'Drame', 'Familial', 'Aventure'].map((g) =>
      ids('/discover/movie', 3, { with_genres: String(MOVIE_GENRES[g]), sort_by: 'popularity.desc', 'vote_count.gte': '300' }).then((l) => [g, l] as const)),
  ])
  const rows: ListRow[] = [
    { key: 'top-movie', kind: 'movie', type: 'top10', name: 'Top 10 films cette semaine', items: pick(trM, 'movie', idx, 10) },
    { key: 'now', kind: 'movie', type: 'wide', name: 'Dernières sorties cinéma', items: pick(nowM, 'movie', idx, 20) },
    { key: 'pop-movie', kind: 'movie', type: 'wide', name: 'Populaires en ce moment', items: pick(popM, 'movie', idx, 20) },
    { key: 'top-tv', kind: 'series', type: 'top10', name: 'Top 10 séries cette semaine', items: pick(trT, 'series', idx, 10) },
    { key: 'rated-movie', kind: 'movie', type: 'row', name: 'Les mieux notés de tous les temps', items: pick(topM, 'movie', idx, 24) },
    { key: 'pop-tv', kind: 'series', type: 'row', name: 'Séries populaires', items: pick(popT, 'series', idx, 24) },
    ...genres.map(([g, l]) => ({ key: 'g-' + g, kind: 'movie' as Kind, type: 'row' as const, name: g, items: pick(l, 'movie', idx, 24) })),
    { key: 'rated-tv', kind: 'series', type: 'row', name: 'Séries les mieux notées', items: pick(topT, 'series', idx, 24) },
  ]
  return rows.filter((r) => r.items.length >= 4)
}

/** Deep genre browse: up to 400 TMDB titles by popularity, filtered to the catalogue. */
export async function genreItems(kind: Kind, genreId: number, idx: TmdbIndex, pages = 20): Promise<MediaItem[]> {
  const l = await ids(kind === 'movie' ? '/discover/movie' : '/discover/tv', pages, { with_genres: String(genreId), sort_by: 'popularity.desc', 'vote_count.gte': '50' })
  return pick(l, kind, idx, 1000)
}
