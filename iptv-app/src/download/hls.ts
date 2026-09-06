/**
 * HLS VOD downloader: master playlist -> best variant -> every segment appended sequentially to one file,
 * with a byte index so playback can rebuild a local playlist (#EXT-X-BYTERANGE) over a single blob URL.
 * AES-128 encrypted playlists are refused (keys would have to be fetched at playback time).
 */
import type { Sink, Progress } from './engine'

export interface HlsIndex { segments: { offset: number; length: number; duration: number }[]; init?: { offset: number; length: number }; targetDuration: number; codecs?: string }
export interface HlsOptions { url: string; sink: Sink; fetchImpl?: typeof fetch; signal?: AbortSignal; onProgress?: (p: Progress) => void; isBusy?: (r: Response) => boolean; sleep?: (ms: number) => Promise<void>; startIndex?: HlsIndex; startOffset?: number }

const resolve = (base: string, rel: string) => new URL(rel, base).toString()

export function parseMaster(text: string, base: string): { url: string; bandwidth: number; codecs?: string }[] {
  const out: { url: string; bandwidth: number; codecs?: string }[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i])
    if (m) { const bw = +(/BANDWIDTH=(\d+)/.exec(m[1])?.[1] ?? 0); const codecs = /CODECS="([^"]+)"/.exec(m[1])?.[1]; const u = lines[i + 1]?.trim(); if (u && !u.startsWith('#')) out.push({ url: resolve(base, u), bandwidth: bw, codecs }) }
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth)
}
export function parseMedia(text: string, base: string): { segments: { url: string; duration: number }[]; init?: string; targetDuration: number; encrypted: boolean; live: boolean } {
  const segments: { url: string; duration: number }[] = []
  let dur = 0, init: string | undefined, target = 10, encrypted = false
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8))
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) target = +l.slice(22)
    else if (l.startsWith('#EXT-X-MAP:')) init = resolve(base, /URI="([^"]+)"/.exec(l)?.[1] ?? '')
    else if (l.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/.test(l)) encrypted = true
    else if (l && !l.startsWith('#')) { segments.push({ url: resolve(base, l), duration: dur }); dur = 0 }
  }
  return { segments, init, targetDuration: target, encrypted, live: !/#EXT-X-ENDLIST/.test(text) }
}

export async function downloadHls(o: HlsOptions): Promise<{ received: number; total: number; index: HlsIndex }> {
  const f = o.fetchImpl ?? fetch, sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const text = await (await f(o.url, { signal: o.signal })).text()
  let mediaUrl = o.url, codecs: string | undefined
  if (/#EXT-X-STREAM-INF/.test(text)) { const v = parseMaster(text, o.url); if (!v.length) throw new Error('empty master playlist'); mediaUrl = v[0].url; codecs = v[0].codecs }
  const media = parseMedia(mediaUrl === o.url ? text : await (await f(mediaUrl, { signal: o.signal })).text(), mediaUrl)
  if (media.encrypted) throw new Error('playlist chiffrée (AES-128) : téléchargement non pris en charge')
  if (media.live) throw new Error('playlist live sans fin : pas un fichier VOD')
  const index: HlsIndex = o.startIndex ?? { segments: [], targetDuration: media.targetDuration, codecs }
  let offset = o.startOffset ?? 0
  const totalSegs = media.segments.length + (media.init ? 1 : 0)
  const doneSegs = index.segments.length + (index.init ? 1 : 0)
  const estTotal = () => (doneSegs + index.segments.length ? Math.round(offset / Math.max(1, index.segments.length + (index.init ? 1 : 0)) * totalSegs) : 0)
  const grab = async (url: string): Promise<Uint8Array> => {
    for (let attempt = 0; ; attempt++) {
      o.signal?.throwIfAborted()
      try {
        const r = await f(url, { signal: o.signal })
        if (o.isBusy?.(r) || r.status === 458) { o.onProgress?.({ received: offset, total: estTotal(), speed: 0, chunk: 0, status: 'waiting-slot' }); await sleep(15_000); continue }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return new Uint8Array(await r.arrayBuffer())
      } catch (e) { if (o.signal?.aborted || attempt >= 6) throw e; o.onProgress?.({ received: offset, total: estTotal(), speed: 0, chunk: 0, status: 'retrying' }); await sleep(Math.min(15_000, 1000 * 2 ** attempt)) }
    }
  }
  const t0 = Date.now(); let got = 0
  if (media.init && !index.init) { const b = await grab(media.init); await o.sink.write(offset, b); index.init = { offset, length: b.length }; offset += b.length }
  for (let i = index.segments.length; i < media.segments.length; i++) {
    const s = media.segments[i]; const b = await grab(s.url)
    await o.sink.write(offset, b); index.segments.push({ offset, length: b.length, duration: s.duration }); offset += b.length; got += b.length
    o.onProgress?.({ received: offset, total: estTotal(), speed: got / Math.max(0.001, (Date.now() - t0) / 1000), chunk: b.length, status: 'downloading' })
  }
  await o.sink.close?.()
  o.onProgress?.({ received: offset, total: offset, speed: 0, chunk: 0, status: 'done' })
  return { received: offset, total: offset, index }
}

/** Local playlist over one blob URL, for hls.js. */
export function localPlaylist(index: HlsIndex, blobUrl: string): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:4', `#EXT-X-TARGETDURATION:${Math.ceil(index.targetDuration)}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
  if (index.init) lines.push(`#EXT-X-MAP:URI="${blobUrl}",BYTERANGE="${index.init.length}@${index.init.offset}"`)
  for (const s of index.segments) lines.push(`#EXTINF:${s.duration.toFixed(3)},`, `#EXT-X-BYTERANGE:${s.length}@${s.offset}`, blobUrl)
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}
