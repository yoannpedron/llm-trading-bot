/**
 * "Official" rows: TMDB curated lists intersected with the provider catalogue by TMDB id,
 * plus cross-referenced rows (server × TMDB). Strict dedup: a title appears in one row only.
 * ~60 requests for the whole home page whatever the catalogue size.
 */
import { tmdb, img, details } from './tmdb'
import type { Kind, MediaItem } from '../types'
import { PREFIX_INFO, useProfile } from '../store/profile'
import { t } from '../i18n'
import type { CatalogView } from '../catalog/view'

export interface ListRow { key: string; kind: Kind; type: 'top10' | 'row' | 'wide' | 'collection'; name: string; sub?: string; items: MediaItem[]; collections?: CollectionCard[] }
export interface CollectionPart { tmdbId: number; title: string; year?: string; rating?: number; poster?: string; item?: MediaItem }
export interface CollectionCard { id: number; name: string; poster?: string; backdrop?: string; total: number; have: number; complete: boolean; parts: CollectionPart[] }

/**
 * Compact TMDB index: sorted numeric keys (tmdbId*2 + kindBit) + group ranges into a permutation of
 * catalogue indices, best (profile language) entry first. Typed arrays only: ~3 MB for 250k entries.
 */
export interface TmdbIndex {
  keys: Float64Array      // sorted, one per distinct (kind, tmdbId)
  starts: Uint32Array     // group g = perm[starts[g] .. starts[g+1])
  perm: Uint32Array       // catalogue indices, preferred language first
  view?: CatalogView
}
const KBIT: Record<string, number> = { movie: 0, series: 1 }
function keyOf(key: string): number { const c = key.indexOf(':'); const b = KBIT[key.slice(0, c)]; const id = +key.slice(c + 1); return b === undefined || !id ? -1 : id * 2 + b }
function groupOf(idx: TmdbIndex, key: string): number {
  const k = keyOf(key); if (k < 0) return -1
  let lo = 0, hi = idx.keys.length - 1
  while (lo <= hi) { const mid = (lo + hi) >> 1; const v = idx.keys[mid]; if (v === k) return mid; if (v < k) lo = mid + 1; else hi = mid - 1 }
  return -1
}
/** preferred provider entry index for a TMDB key */
export const bestIndex = (idx: TmdbIndex, key: string): number | undefined => { const g = groupOf(idx, key); return g < 0 ? undefined : idx.perm[idx.starts[g]] }
export const bestItem = (idx: TmdbIndex, key: string): MediaItem | undefined => { const i = bestIndex(idx, key); return i === undefined ? undefined : idx.view?.at(i) }
export const allIndices = (idx: TmdbIndex, key: string): number[] => { const g = groupOf(idx, key); return g < 0 ? [] : Array.from(idx.perm.subarray(idx.starts[g], idx.starts[g + 1])) }
export const allItems = (idx: TmdbIndex, key: string): MediaItem[] => allIndices(idx, key).map((i) => idx.view?.at(i)).filter((x): x is MediaItem => !!x)
/** language versions available on the server for a key */
export const versionsOf = (idx: TmdbIndex, key: string): string[] => { const v = idx.view; if (!v) return []; const out: string[] = []; for (const i of allIndices(idx, key)) { const l = v.langOf(i); if (l && !out.includes(l)) out.push(l) } return out }
export const is4K = (idx: TmdbIndex, key: string): boolean => { const v = idx.view; if (!v) return false; const q = v.column('qualities'); return allIndices(idx, key).some((i) => v.langOf(i) === '4K' || /^(4K|UHD|2160P)$/.test(q[i])) }
/** tmdb ids of a kind added since `t` (unix s), most recent first */
export function addedSince(idx: TmdbIndex, kind: Kind, t: number): number[] {
  const v = idx.view; if (!v) return []
  const bit = KBIT[kind]; const hits: { id: number; a: number }[] = []
  for (let g = 0; g < idx.keys.length; g++) {
    const k = idx.keys[g]; if (k % 2 !== bit) continue
    let a = 0; for (let p = idx.starts[g]; p < idx.starts[g + 1]; p++) { const x = v.added[idx.perm[p]]; if (x > a) a = x }
    if (a >= t) hits.push({ id: (k - bit) / 2, a })
  }
  return hits.sort((x, y) => y.a - x.a).map((h) => h.id)
}

/** Preference order = the profile's content languages, then multi-language packs, then anything. */
function prefOf(contentLangs: string[]): Record<string, number> {
  const p: Record<string, number> = {}
  contentLangs.forEach((l, i) => { p[l] = i; if (l === 'EN') p.ENG = i; if (l === 'FR') p.QFR = i + 0.5 })
  p.NF = contentLangs.length; p['4K'] = contentLangs.length; p.EX = contentLangs.length + 1
  return p
}

export function buildTmdbIndex(view: CatalogView, visible: (i: number) => boolean, contentLangs = useProfile.getState().contentLangs): TmdbIndex {
  const PREF = prefOf(contentLangs)
  const tmdb = view.tmdbIds, kinds = view.kinds, langs = view.column('langs')
  // 1. one sortable number per entry: (tmdbId*2 + kindBit) * 2^20 + index
  let m = 0
  for (let i = 0; i < view.n; i++) if (tmdb[i] && kinds[i] !== 2 && visible(i)) m++
  const packed = new Float64Array(m); let w = 0
  for (let i = 0; i < view.n && i < 1048576; i++) if (tmdb[i] && kinds[i] !== 2 && visible(i)) packed[w++] = (tmdb[i] * 2 + kinds[i]) * 1048576 + i
  packed.sort()
  // 2. group ranges
  const keys: number[] = [], starts: number[] = []
  const perm = new Uint32Array(m)
  let prev = -1
  for (let p = 0; p < m; p++) { const k = Math.floor(packed[p] / 1048576); perm[p] = packed[p] - k * 1048576; if (k !== prev) { keys.push(k); starts.push(p); prev = k } }
  starts.push(m)
  // 3. preferred language first inside each group (groups are tiny)
  const pref = (i: number) => PREF[langs[i]] ?? 9
  for (let g = 0; g < keys.length; g++) { const a = starts[g], b = starts[g + 1]; if (b - a > 1) perm.subarray(a, b).sort((x, y) => pref(x) - pref(y)) }
  return { keys: Float64Array.from(keys), starts: Uint32Array.from(starts), perm, view }
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

/** Cinematography hubs: TMDB original language ∩ catalogue. */
const HUBS: { key: string; name: string; iso: string; kind: Kind; genre?: number }[] = [
  { key: 'fr', name: 'Cinéma français', iso: 'fr', kind: 'movie' }, { key: 'ar', name: 'السينما العربية · Cinéma arabe', iso: 'ar', kind: 'movie' },
  { key: 'hi', name: 'Bollywood', iso: 'hi', kind: 'movie' }, { key: 'tr', name: 'Dizi · Séries turques', iso: 'tr', kind: 'series' },
  { key: 'ko', name: 'K-Drama', iso: 'ko', kind: 'series' }, { key: 'ja', name: 'Anime', iso: 'ja', kind: 'series', genre: 16 },
  { key: 'es', name: 'Cine español y latino', iso: 'es', kind: 'movie' }, { key: 'de', name: 'Deutsches Kino', iso: 'de', kind: 'movie' },
  { key: 'pl', name: 'Kino polskie', iso: 'pl', kind: 'movie' }, { key: 'it', name: 'Cinema italiano', iso: 'it', kind: 'movie' },
  { key: 'sv', name: 'Nordic noir', iso: 'sv|da|no', kind: 'series' }, { key: 'ta', name: 'Kollywood · Tamil', iso: 'ta', kind: 'movie' },
  { key: 'pt', name: 'Cinema brasileiro e português', iso: 'pt', kind: 'movie' }, { key: 'zh', name: 'Cinéma chinois et HK', iso: 'zh', kind: 'movie' },
]
const SAGA_POOL = [10, 1241, 86311, 9485, 263, 2344, 119, 87359, 645, 528, 8945, 748, 328, 31562, 1575, 2980, 8091, 9735, 1570, 84, 91361, 131295, 86066, 8650, 264]
const DECADES = [1970, 1980, 1990, 2000, 2010, 2020]

/** Deterministic daily seed so rotating rows change once a day, not on every reload. */
function daySeed() { const d = new Date(); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5) }
function pickDaily<T>(arr: T[], salt: number): T { return arr[(daySeed() * 7 + salt * 13) % arr.length] }

export interface Personal { lastWatched: MediaItem[]; seriesIds: number[] }

export async function homeRows(idx: TmdbIndex, personal?: Personal): Promise<ListRow[]> {
  const { contentLangs, region } = useProfile.getState()
  const isos = new Set(contentLangs.map((l) => PREFIX_INFO[l]?.iso).filter(Boolean))
  const myHubs = HUBS.filter((h) => h.iso.split('|').some((i) => isos.has(i)))
  const otherHubs = HUBS.filter((h) => !myHubs.includes(h))
  const hubOfDay = otherHubs.length ? pickDaily(otherHubs, 1) : undefined
  const genreOfDay = pickDaily(Object.entries(MOVIE_GENRES), 2)
  const decadeOfDay = pickDaily(DECADES, 3)
  const used = new Set<string>()
  const take = (kind: Kind, ids: number[], n: number): MediaItem[] => {
    const out: MediaItem[] = []
    for (const id of ids) { const k = kind + ':' + id; const it = bestItem(idx, k); if (it && !used.has(k)) { used.add(k); out.push(it); if (out.length >= n) break } }
    return out
  }
  const ids = (r: R[]) => r.map((x) => x.id)
  const dayAgo = Date.now() / 1000 - 86400, weekAgo = Date.now() / 1000 - 7 * 86400

  /* ---- personalised sources (from history) ---- */
  const last = personal?.lastWatched.filter((i) => i.tmdbId).slice(0, 3) ?? []
  const lastDetails = await Promise.all(last.map((i) => details(i.kind === 'series' ? 'tv' : 'movie', i.tmdbId!).catch(() => undefined)))
  const seed = lastDetails.find(Boolean)
  const seedItem = last[lastDetails.findIndex(Boolean)]
  const personIds = [...new Set(lastDetails.flatMap((d) => d ? [d.directorId, ...(d.castIds ?? []).slice(0, 2)] : []).filter((x): x is number => !!x))].slice(0, 3)

  const [trDay, now, airing, trT, popM, popT, genreRow, decadeRow, hubRows, hubDay, sagaDay, people, seriesAir] = await Promise.all([
    list('/trending/movie/day', 3), list('/movie/now_playing', 6, { region }), list('/tv/airing_today', 4), list('/trending/tv/day', 3),
    list('/movie/popular', 6), list('/tv/popular', 3),
    list('/discover/movie', 4, { with_genres: String(genreOfDay[1]), sort_by: 'popularity.desc', 'vote_count.gte': '300' }),
    list('/discover/movie', 4, { 'primary_release_date.gte': `${decadeOfDay}-01-01`, 'primary_release_date.lte': `${decadeOfDay + 9}-12-31`, sort_by: 'vote_count.desc' }),
    Promise.all(myHubs.map((h) => list(h.kind === 'movie' ? '/discover/movie' : '/discover/tv', 4, { with_original_language: h.iso, sort_by: 'popularity.desc', 'vote_count.gte': '50', ...(h.genre ? { with_genres: String(h.genre) } : {}) }))),
    hubOfDay ? list(hubOfDay.kind === 'movie' ? '/discover/movie' : '/discover/tv', 4, { with_original_language: hubOfDay.iso, sort_by: 'popularity.desc', 'vote_count.gte': '50', ...(hubOfDay.genre ? { with_genres: String(hubOfDay.genre) } : {}) }) : Promise.resolve([] as R[]),
    collection(pickDaily(SAGA_POOL, 4), idx),
    Promise.all(personIds.map((pid) => tmdb<{ id: number; name: string; cast: R[]; crew: R[] }>(`/person/${pid}/combined_credits`).then((c) => ({ pid, credits: c })).catch(() => undefined))),
    list('/tv/on_the_air', 5),
  ])

  const rows: ListRow[] = []
  // 1. temporal
  rows.push({ key: 'trend-day', kind: 'movie', type: 'top10', name: 'Tendances aujourd’hui', sub: 'Classement TMDB du jour, titres présents sur le serveur', items: take('movie', ids(trDay), 10) })
  rows.push({ key: 'now', kind: 'movie', type: 'wide', name: t('nowplaying'), sub: 'En salle cette semaine dans ton pays, déjà sur le serveur', items: take('movie', ids([...now].sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))), 16) })
  rows.push({ key: 'added-today', kind: 'movie', type: 'wide', name: 'Ajoutés aujourd’hui sur le serveur', sub: 'Les dernières 24 h, classés par popularité TMDB', items: take('movie', (() => { const today = addedSince(idx, 'movie', dayAgo); const set = new Set(today); return ids(popM).filter((i) => set.has(i)).concat(today) })(), 16) })
  rows.push({ key: 'airing', kind: 'series', type: 'wide', name: 'Nouveaux épisodes aujourd’hui', sub: 'Séries diffusées aujourd’hui, présentes sur le serveur', items: take('series', ids(airing), 16) })
  // 2. personalised
  if (seed && seedItem) {
    const sim = seed.similar.map((s) => s.id)
    rows.push({ key: 'because', kind: seedItem.kind, type: 'row', name: `Parce que tu as regardé ${seed.title}`, sub: 'Titres similaires selon TMDB', items: take(seedItem.kind, sim, 16) })
    if (seed.collection && seedItem.kind === 'movie') {
      const c = await collection(seed.collection.id, idx)
      const rest = c?.parts.filter((p) => p.item && !personal?.lastWatched.some((w) => w.id === p.item!.id)).map((p) => p.tmdbId) ?? []
      if (rest.length) rows.push({ key: 'saga-next', kind: 'movie', type: 'row', name: `La suite de ${seed.collection.name}`, sub: 'Films de la saga que tu n’as pas encore vus', items: take('movie', rest, 12) })
    }
  }
  for (const p of people) {
    if (!p) continue
    const name = p.credits.cast.concat(p.credits.crew).length ? (await tmdb<{ name: string }>(`/person/${p.pid}`).catch(() => ({ name: '' }))).name : ''
    const cr = [...p.credits.crew.filter((c) => c.job === 'Director'), ...p.credits.cast].sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
    const items = take('movie', ids(cr), 12)
    if (items.length >= 4 && name) rows.push({ key: 'person-' + p.pid, kind: 'movie', type: 'row', name: `Avec ${name}`, sub: 'Parce que tu as regardé un de ses films', items })
  }
  if (personal?.seriesIds.length) {
    const mine = new Set(personal.seriesIds)
    const items = take('series', ids(seriesAir).filter((i) => mine.has(i)), 12)
    if (items.length) rows.push({ key: 'my-series', kind: 'series', type: 'row', name: 'Nouveaux épisodes de tes séries', items })
  }
  // 3. daily rotation
  rows.push({ key: 'trend-tv', kind: 'series', type: 'top10', name: 'Séries tendance aujourd’hui', items: take('series', ids(trT), 10) })
  rows.push({ key: 'genre-day', kind: 'movie', type: 'row', name: `Genre du jour · ${genreOfDay[0]}`, sub: 'Change chaque jour', items: take('movie', ids(genreRow), 16) })
  rows.push({ key: 'decade-day', kind: 'movie', type: 'row', name: `Décennie du jour · années ${decadeOfDay}`, sub: 'Change chaque jour', items: take('movie', ids(decadeRow), 16) })
  if (sagaDay?.complete) rows.push({ key: 'saga-day', kind: 'movie', type: 'collection', name: `Saga du jour · ${sagaDay.name}`, sub: `${sagaDay.total} films, tous disponibles`, items: [], collections: [sagaDay] })
  if (hubOfDay) rows.push({ key: 'hub-day', kind: hubOfDay.kind, type: 'row', name: `Pays du jour · ${hubOfDay.name}`, sub: 'Change chaque jour', items: take(hubOfDay.kind, ids(hubDay), 16) })
  myHubs.forEach((h, i) => { const items = take(h.kind, ids(hubRows[i]), 16); if (items.length >= 4) rows.push({ key: 'hub-' + h.key, kind: h.kind, type: 'row', name: h.name, sub: t('inyourlang'), items }) })
  rows.push({ key: 'added-week', kind: 'movie', type: 'row', name: t('fresh'), sub: 'Sept derniers jours', items: take('movie', addedSince(idx, 'movie', weekAgo), 20) })
  rows.push({ key: '4k', kind: 'movie', type: 'row', name: t('fourk'), sub: 'Versions 4K/UHD du serveur, triées par popularité', items: take('movie', ids(popM).filter((i) => is4K(idx, 'movie:' + i)), 16) })
  rows.push({ key: 'pop-tv', kind: 'series', type: 'row', name: 'Séries populaires cette semaine', items: take('series', ids(popT), 16) })
  // polymorphic: a row only exists when this provider has enough titles for it
  return rows.filter((r) => r.type === 'collection' ? (r.collections?.length ?? 0) > 0 : r.items.length >= (r.type === 'top10' ? 5 : 6))
}

interface RawCollection { id: number; name: string; poster_path?: string | null; backdrop_path?: string | null; parts: { id: number; title: string; release_date?: string; vote_average?: number; poster_path?: string | null }[] }
export async function collection(id: number, idx: TmdbIndex): Promise<CollectionCard | undefined> {
  const c = await tmdb<RawCollection>(`/collection/${id}`).catch(() => undefined)
  if (!c) return undefined
  const today = new Date().toISOString().slice(0, 10)
  const parts = c.parts.filter((p) => p.release_date && p.release_date <= today).sort((a, b) => a.release_date!.localeCompare(b.release_date!))
    .map((p) => ({ tmdbId: p.id, title: p.title, year: p.release_date?.slice(0, 4), rating: p.vote_average, poster: img(p.poster_path, 'w185'), item: bestItem(idx, 'movie:' + p.id) }))
  const have = parts.filter((p) => p.item).length
  if (parts.length < 2 || have < 2) return undefined
  return { id: c.id, name: c.name, poster: img(c.poster_path, 'w342'), backdrop: img(c.backdrop_path, 'w780'), total: parts.length, have, complete: have === parts.length, parts }
}

/** Deep genre browse: up to 400 TMDB titles by popularity, filtered to the catalogue. */
export async function genreItems(kind: Kind, genreId: number, idx: TmdbIndex, pages = 20): Promise<MediaItem[]> {
  const l = await list(kind === 'movie' ? '/discover/movie' : '/discover/tv', pages, { with_genres: String(genreId), sort_by: 'popularity.desc', 'vote_count.gte': '50' })
  const out: MediaItem[] = []; const seen = new Set<number>()
  for (const r of l) { const it = bestItem(idx, kind + ':' + r.id); if (it && !seen.has(r.id)) { seen.add(r.id); out.push(it) } }
  return out
}
