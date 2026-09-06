/**
 * Provider profile, learnt on the client at account setup and refined on every download.
 * Nothing leaves the device; no central server. Every provider behaves differently
 * (redirect + token, Range support, "busy" code, connection count, HLS VOD…), so the
 * download engine reads this profile to pick its strategy.
 */
export interface ProviderProfile {
  probedAt: number
  maxConnections: number
  redirect: boolean            // 302 to a tokenised content server
  ranges: boolean              // 206 on Range requests
  head: boolean                // HEAD accepted
  busyStatus?: number          // status seen on a second connection (458 on Xtream, 403/429/503 elsewhere)
  busyHtml?: boolean           // "busy" answered as a 200 HTML page
  hlsVod?: boolean             // VOD served as m3u8 playlists
  sampleContentType?: string
  /** learnt later */
  releaseSeconds?: number      // observed delay before active_cons drops after a transfer
  refSpeed?: number            // bytes/s observed
  tokenExpires?: boolean       // resolved URL stopped working mid-download
  notes: string[]
}

export interface ProbeInput {
  sampleUrl: string            // a VOD file url of this account
  apiUrl: string               // player_api.php with credentials
  fetchImpl?: typeof fetch
  /** allow the second-connection test (occupies the slot for ~1 s). Only when nobody is watching. */
  testBusy?: boolean
  signal?: AbortSignal
}

export const isVideoResponse = (r: Response) => /video|octet-stream|mpegurl|mp2t/i.test(r.headers.get('content-type') ?? '')

export async function probeProvider(i: ProbeInput): Promise<ProviderProfile> {
  const f = i.fetchImpl ?? fetch
  const notes: string[] = []
  const p: ProviderProfile = { probedAt: Date.now(), maxConnections: 1, redirect: false, ranges: false, head: false, notes }

  try {
    const r = await f(i.apiUrl, { signal: i.signal }); const j = (await r.json()) as { user_info?: { max_connections?: string; active_cons?: string } }
    p.maxConnections = Math.max(1, +(j.user_info?.max_connections ?? 1))
    if (i.testBusy && +(j.user_info?.active_cons ?? 0) > 0) { i.testBusy = false; notes.push('busy test skipped: a session was active') }
  } catch { notes.push('player_api unreadable') }

  // HEAD
  try { const h = await f(i.sampleUrl, { method: 'HEAD', signal: i.signal }); p.head = h.ok || h.status === 206; if (!p.head) notes.push(`HEAD -> ${h.status}`) } catch { notes.push('HEAD failed') }

  // Range 0-0 (also reveals redirect and content type)
  try {
    const r = await f(i.sampleUrl, { headers: { Range: 'bytes=0-0' }, signal: i.signal })
    p.redirect = !!r.url && r.url !== i.sampleUrl
    p.sampleContentType = r.headers.get('content-type') ?? undefined
    p.ranges = r.status === 206
    p.hlsVod = /mpegurl/i.test(p.sampleContentType ?? '') || /\.m3u8(\?|$)/.test(r.url || i.sampleUrl)
    if (r.status === 200 && !isVideoResponse(r)) { p.busyHtml = true; notes.push('sample answered HTML: busy or blocked') }
    if (!r.ok && r.status !== 206) { p.busyStatus = r.status; notes.push(`sample -> ${r.status}`) }
    await r.body?.cancel().catch(() => undefined)
  } catch { notes.push('Range probe failed') }

  // Second connection while one transfer runs: what does "busy" look like on this provider?
  if (i.testBusy && p.ranges && p.maxConnections === 1) {
    const ac = new AbortController()
    try {
      const first = await f(i.sampleUrl, { headers: { Range: 'bytes=0-8388607' }, signal: ac.signal })
      const reader = first.body?.getReader(); await reader?.read()
      const second = await f(i.sampleUrl, { headers: { Range: 'bytes=8388608-8388608' }, signal: i.signal })
      if (second.status === 206 || (second.ok && isVideoResponse(second))) notes.push('second connection accepted despite max_connections=1')
      else if (second.ok) { p.busyHtml = true; notes.push('busy = 200 HTML') }
      else p.busyStatus = second.status
      await second.body?.cancel().catch(() => undefined)
    } catch { notes.push('busy test failed') }
    finally { ac.abort() }
  }
  return p
}

/** Decide how the engine should behave for this provider. */
export function strategyFor(p: ProviderProfile | undefined): { parallel: number; isBusy: (r: Response) => boolean } {
  const busyStatus = p?.busyStatus ?? 458
  return {
    parallel: Math.max(1, Math.min(4, (p?.maxConnections ?? 1) - 1)) || 1,
    isBusy: (r) => r.status === busyStatus || r.status === 458 || r.status === 429 || r.status === 503 || (r.ok && !isVideoResponse(r)),
  }
}
