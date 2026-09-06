export type Kind = 'movie' | 'series' | 'live'

export interface ParsedTitle {
  /** Human title with prefixes, year and tech noise removed */
  title: string
  /** Title suitable for a TMDB query (also strips trailing actor names / notes) */
  searchTitle: string
  year?: number
  lang?: string
  quality?: string
  season?: number
  episode?: number
  /** Tokens removed from the name (MULTI, VOSTFR, 4K, actor credits…) */
  tags: string[]
  isAdult: boolean
}

export interface Category {
  id: string
  kind: Kind
  rawName: string
  name: string
  lang?: string
}

export interface MediaItem extends ParsedTitle {
  id: string
  kind: Kind
  rawName: string
  streamId: number
  categoryId: string
  tmdbId?: number
  poster?: string
  backdrop?: string
  rating?: number
  added?: number
  ext?: string
  plot?: string
  cast?: string
  director?: string
  genre?: string
  epgChannelId?: string
  tvArchive?: boolean
}

export interface Catalog {
  items: MediaItem[]
  categories: Category[]
  /** index into `items`, per category id */
  byCategory: Record<string, number[]>
  counts: Record<Kind, number>
  generatedAt: number
}

/* ---- raw Xtream shapes (subset) ---- */
export interface XtreamCategory { category_id: string | number; category_name: string; parent_id?: number }
export interface XtreamVod {
  num: number; name: string; stream_id: number; stream_icon?: string; rating?: string | number
  tmdb?: string | number | null; added?: string; is_adult?: string | number
  category_id: string | number; container_extension?: string
}
export interface XtreamSeries {
  num: number; name: string; series_id: number; cover?: string; plot?: string; cast?: string
  director?: string; genre?: string; releaseDate?: string; release_date?: string; rating?: string | number
  backdrop_path?: string[] | string; tmdb?: string | number | null; category_id: string | number; last_modified?: string
}
export interface XtreamLive {
  num: number; name: string; stream_id: number; stream_icon?: string; epg_channel_id?: string
  added?: string; is_adult?: string | number; category_id: string | number; tv_archive?: number
}
export interface RawCatalog {
  vodCategories: XtreamCategory[]; seriesCategories: XtreamCategory[]; liveCategories: XtreamCategory[]
  vod: XtreamVod[]; series: XtreamSeries[]; live: XtreamLive[]
}
