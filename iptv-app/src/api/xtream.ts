import type { RawCatalog, XtreamCategory, XtreamLive, XtreamSeries, XtreamVod } from '../types'

export interface XtreamCredentials { url: string; username: string; password: string }

export interface XtreamUserInfo {
  user_info: { username: string; auth: number; status: string; exp_date?: string; max_connections?: string; active_cons?: string; message?: string }
  server_info: { url: string; port: string; https_port?: string; server_protocol: string; timezone?: string }
}

export interface XtreamEpisode {
  id: string; episode_num: number; title: string; container_extension: string; season: number
  info?: { plot?: string; duration?: string; movie_image?: string; rating?: string | number; releasedate?: string; tmdb_id?: number }
}
export interface XtreamSeriesInfo {
  seasons: { season_number: number; name: string; episode_count: string | number; cover?: string; air_date?: string }[]
  info: XtreamSeries & { backdrop_path?: string[] }
  episodes: Record<string, XtreamEpisode[]>
}
export interface XtreamVodInfo {
  info: { tmdb_id?: string | number; name?: string; plot?: string; cast?: string; director?: string; genre?: string
    releasedate?: string; duration?: string; backdrop_path?: string[]; movie_image?: string; youtube_trailer?: string }
  movie_data: { stream_id: number; name: string; container_extension: string }
}

/** In dev everything goes through the Vite proxy (see vite.config.ts). */
export function proxied(base: string): string {
  if (import.meta.env.VITE_XTREAM_DIRECT === '1' || !import.meta.env.DEV) return base.replace(/\/+$/, '')
  const host = base.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `/xtream/${encodeURIComponent(host)}`
}

export class XtreamClient {
  private base: string
  creds: XtreamCredentials
  constructor(creds: XtreamCredentials) {
    this.creds = creds
    this.base = proxied(creds.url)
  }
  private api(params: Record<string, string | number>) {
    const q = new URLSearchParams({ username: this.creds.username, password: this.creds.password, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })
    return `${this.base}/player_api.php?${q}`
  }
  private async get<T>(params: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
    const r = await fetch(this.api(params), { signal })
    if (!r.ok) throw new Error(`Xtream ${r.status} ${r.statusText}`)
    return r.json() as Promise<T>
  }

  login(signal?: AbortSignal) { return this.get<XtreamUserInfo>({}, signal) }

  async catalog(signal?: AbortSignal, onProgress?: (step: string) => void): Promise<RawCatalog> {
    const step = <T,>(name: string, p: Promise<T>) => p.then((v) => { onProgress?.(name); return v })
    const [vodCategories, seriesCategories, liveCategories, vod, series, live] = await Promise.all([
      step('vod categories', this.get<XtreamCategory[]>({ action: 'get_vod_categories' }, signal)),
      step('series categories', this.get<XtreamCategory[]>({ action: 'get_series_categories' }, signal)),
      step('live categories', this.get<XtreamCategory[]>({ action: 'get_live_categories' }, signal)),
      step('movies', this.get<XtreamVod[]>({ action: 'get_vod_streams' }, signal)),
      step('series', this.get<XtreamSeries[]>({ action: 'get_series' }, signal)),
      step('live', this.get<XtreamLive[]>({ action: 'get_live_streams' }, signal)),
    ])
    return { vodCategories, seriesCategories, liveCategories, vod, series, live }
  }

  vodInfo(vodId: number) { return this.get<XtreamVodInfo>({ action: 'get_vod_info', vod_id: vodId }) }
  seriesInfo(seriesId: number) { return this.get<XtreamSeriesInfo>({ action: 'get_series_info', series_id: seriesId }) }

  /** Playable URLs. Live: HLS. VOD/series: progressive file. */
  liveUrl(streamId: number) { return `${this.base}/live/${this.creds.username}/${this.creds.password}/${streamId}.m3u8` }
  movieUrl(streamId: number, ext = 'mp4') { return `${this.base}/movie/${this.creds.username}/${this.creds.password}/${streamId}.${ext}` }
  episodeUrl(episodeId: string | number, ext = 'mp4') { return `${this.base}/series/${this.creds.username}/${this.creds.password}/${episodeId}.${ext}` }
}

/** Offline mode: sample of a real provider catalogue (3k movies / 500 series / 800 channels). */
export async function loadMockCatalog(): Promise<RawCatalog> {
  const [vod, series, live, vodCategories, seriesCategories, liveCategories] = await Promise.all([
    import('./mock/vod_streams.json'), import('./mock/series.json'), import('./mock/live_streams.json'),
    import('./mock/vod_categories.json'), import('./mock/series_categories.json'), import('./mock/live_categories.json'),
  ])
  return {
    vod: vod.default as unknown as XtreamVod[], series: series.default as unknown as XtreamSeries[], live: live.default as unknown as XtreamLive[],
    vodCategories: vodCategories.default as XtreamCategory[], seriesCategories: seriesCategories.default as XtreamCategory[], liveCategories: liveCategories.default as XtreamCategory[],
  }
}
