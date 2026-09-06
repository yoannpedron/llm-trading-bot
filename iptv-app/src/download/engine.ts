/**
 * Sequential adaptive downloader for Xtream VOD files.
 *
 * Why sequential: the subscription allows one connection, so parallel ranges would be refused (458)
 * and could kill the running one. One TCP connection, successive `Range` requests.
 * Why adaptive: small chunks limit the loss on a cut, large chunks limit per-request overhead.
 * The chunk size doubles while transfers stay fast and halves on a slow or failed chunk.
 * Resume is exact (offset already written); a 458 (slot busy) waits and retries instead of failing.
 */
export interface Sink {
  write(offset: number, chunk: Uint8Array): Promise<void>
  close?(): Promise<void>
}
export interface Progress { received: number; total: number; speed: number; chunk: number; status: 'probing' | 'downloading' | 'waiting-slot' | 'retrying' | 'done' }
export interface DownloadOptions {
  url: string
  sink: Sink
  startAt?: number
  minChunk?: number
  maxChunk?: number
  /** bytes per second, 0 = unlimited */
  maxRate?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onProgress?: (p: Progress) => void
  /** seconds between retries on network errors; the last value repeats */
  retryDelays?: number[]
  /** seconds between polls while the server answers 458 (slot busy) */
  slotPoll?: number
  /** for tests */
  sleep?: (ms: number) => Promise<void>
}
export interface Probe { total: number; ranges: boolean; type?: string; /** final URL after the Xtream 302 to the content server */ finalUrl?: string }
export class SlotBusyError extends Error { constructor() { super('slot busy (458)'); this.name = 'SlotBusyError' } }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function probe(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Probe> {
  // GET with a 1-byte range: works on servers that refuse HEAD, and tells us whether ranges are honoured
  const r = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, signal })
  if (r.status === 458) throw new SlotBusyError()
  if (r.status === 206) {
    const cr = r.headers.get('content-range') ?? ''
    const total = +(cr.split('/')[1] ?? 0)
    await r.body?.cancel().catch(() => undefined)
    return { total, ranges: true, type: r.headers.get('content-type') ?? undefined, finalUrl: r.url && r.url !== url ? r.url : undefined }
  }
  if (r.ok) {
    const total = +(r.headers.get('content-length') ?? 0)
    await r.body?.cancel().catch(() => undefined)
    return { total, ranges: false, type: r.headers.get('content-type') ?? undefined }
  }
  throw new Error(`HTTP ${r.status}`)
}

export async function download(o: DownloadOptions): Promise<{ received: number; total: number }> {
  const f = o.fetchImpl ?? fetch, sleep = o.sleep ?? defaultSleep
  const minChunk = o.minChunk ?? 8 * 1024 * 1024, maxChunk = o.maxChunk ?? 128 * 1024 * 1024
  const delays = o.retryDelays ?? [1, 2, 4, 8, 15]
  const slotPoll = (o.slotPoll ?? 15) * 1000
  let offset = o.startAt ?? 0, chunk = minChunk, total = 0, ranges = true
  // Xtream answers 302 to a tokenised content-server URL: resolve it once, reuse it for every chunk (saves a round trip per chunk), fall back if the token dies
  let target = o.url
  let attempt = 0
  const startedAt = Date.now(); let receivedSinceStart = 0
  const report = (status: Progress['status'], speed = 0) => o.onProgress?.({ received: offset, total, speed, chunk, status })

  // ---- probe (with slot wait) ----
  for (;;) {
    o.signal?.throwIfAborted()
    try { report('probing'); const p = await probe(o.url, f, o.signal); total = p.total; ranges = p.ranges; if (p.finalUrl) target = p.finalUrl; break }
    catch (e) {
      if (e instanceof SlotBusyError) { report('waiting-slot'); await sleep(slotPoll); continue }
      if (attempt >= delays.length + 3) throw e
      report('retrying'); await sleep(delays[Math.min(attempt++, delays.length - 1)] * 1000)
    }
  }
  if (!ranges && offset > 0) offset = 0 // cannot resume without ranges
  attempt = 0

  // ---- main loop ----
  while (total === 0 || offset < total) {
    o.signal?.throwIfAborted()
    const end = total ? Math.min(offset + chunk, total) - 1 : undefined
    const t0 = Date.now()
    let got = 0
    try {
      let r = await f(target, { headers: ranges ? { Range: `bytes=${offset}-${end}` } : {}, signal: o.signal })
      if (target !== o.url && (r.status === 403 || r.status === 404 || r.status === 410)) { await r.body?.cancel().catch(() => undefined); target = o.url; r = await f(target, { headers: ranges ? { Range: `bytes=${offset}-${end}` } : {}, signal: o.signal }); if (r.url && r.url !== o.url) target = r.url }
      if (r.status === 458) throw new SlotBusyError()
      if (ranges && r.status !== 206) throw new Error(`expected 206, got ${r.status}`)
      if (!ranges && !r.ok) throw new Error(`HTTP ${r.status}`)
      if (!ranges && !total) total = +(r.headers.get('content-length') ?? 0)
      const reader = r.body!.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        await o.sink.write(offset, value)
        offset += value.length; got += value.length; receivedSinceStart += value.length
        const elapsed = (Date.now() - startedAt) / 1000
        const speed = elapsed > 0 ? receivedSinceStart / elapsed : 0
        report('downloading', speed)
        if (o.maxRate && speed > o.maxRate) await sleep(Math.min(1000, ((receivedSinceStart / o.maxRate) - elapsed) * 1000))
        if (ranges && end !== undefined && offset > end + 1) throw new Error('server sent more than requested')
      }
      if (ranges && end !== undefined && offset !== end + 1) throw new Error(`short chunk: ${offset} != ${end + 1}`)
      attempt = 0
      // adapt: fast chunk -> grow, slow chunk -> shrink
      const dt = (Date.now() - t0) / 1000
      if (dt < 6 && chunk < maxChunk) chunk = Math.min(maxChunk, chunk * 2)
      else if (dt > 20 && chunk > minChunk) chunk = Math.max(minChunk, Math.floor(chunk / 2))
      if (!ranges) break
    } catch (e) {
      if (o.signal?.aborted) throw e
      if (e instanceof SlotBusyError) { report('waiting-slot'); await sleep(slotPoll); continue }
      // network cut mid-chunk: keep what was written (offset already advanced), shrink, back off, resume
      chunk = Math.max(minChunk, Math.floor(chunk / 2))
      if (attempt >= delays.length + 5) throw e
      report('retrying'); await sleep(delays[Math.min(attempt++, delays.length - 1)] * 1000)
      if (!ranges) { offset = 0; receivedSinceStart = 0 }
    }
  }
  if (total && offset !== total) throw new Error(`incomplete: ${offset}/${total}`)
  await o.sink.close?.()
  report('done')
  return { received: offset, total }
}
