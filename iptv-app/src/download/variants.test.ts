/** Provider variants simulated locally: busy as 403, busy as HTML 200, several connections, HLS VOD, token expiry. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { download, type Sink } from './engine'
import { probeProvider, strategyFor } from './profile'
import { downloadHls, localPlaylist } from './hls'

const SIZE = 6 * 1024 * 1024, DATA = randomBytes(SIZE), HASH = createHash('sha256').update(DATA).digest('hex')
let server: http.Server, base = ''
let variant = 'xtream'
let active = 0, maxConn = 1, busyStatus = 458, tokenUses = 0
const SEG = 256 * 1024
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/player_api.php') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ user_info: { max_connections: String(maxConn), active_cons: String(active) } })); return }
    if (url.pathname === '/master.m3u8') { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2"\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nhigh/index.m3u8\n'); return }
    if (url.pathname.endsWith('/index.m3u8')) { const n = Math.ceil(SIZE / SEG); res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n' + Array.from({ length: n }, (_, i) => `#EXTINF:4.000,\nseg${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST\n'); return }
    const seg = /seg(\d+)\.ts$/.exec(url.pathname)
    if (seg) { const i = +seg[1]; res.setHeader('content-type', 'video/mp2t'); res.end(DATA.subarray(i * SEG, Math.min(SIZE, (i + 1) * SEG))); return }
    if (variant === 'redirect' && url.pathname === '/movie.mp4') { res.writeHead(302, { location: `${base.replace('/movie.mp4', '')}/cdn/tok${tokenUses}/movie.mp4` }); res.end(); return }
    if (variant === 'redirect' && /\/cdn\/tok(\d+)\//.test(url.pathname) && +/tok(\d+)/.exec(url.pathname)![1] !== tokenUses) { res.writeHead(403); res.end('expired'); return }
    if (req.method === 'HEAD') { if (variant === 'nohead') { res.writeHead(405); res.end(); return } res.writeHead(200, { 'content-length': SIZE, 'accept-ranges': 'bytes', 'content-type': 'video/mp4' }); res.end(); return }
    if (active >= maxConn) { if (variant === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>busy</html>') } else { res.writeHead(busyStatus); res.end() } return }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    active++; res.on('close', () => { active-- })
    if (!m) { res.writeHead(200, { 'content-length': SIZE, 'content-type': 'video/mp4' }); res.end(DATA); return }
    const a = +m[1], b = m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${SIZE}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes', 'content-type': 'video/mp4' })
    setTimeout(() => res.end(DATA.subarray(a, b + 1)), 30)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/movie.mp4`
})
afterAll(() => server.close())
const api = () => base.replace('/movie.mp4', '/player_api.php')
class MemSink implements Sink { buf = Buffer.alloc(SIZE); max = 0; async write(o: number, c: Uint8Array) { Buffer.from(c).copy(this.buf, o); this.max = Math.max(this.max, o + c.length) } hash() { return createHash('sha256').update(this.buf.subarray(0, this.max)).digest('hex') } }
const fast = { minChunk: 512 * 1024, maxChunk: 2 * 1024 * 1024, sleep: async () => undefined, retryDelays: [0], slotPoll: 0 }

describe('provider variants', () => {
  it('probes an Xtream-like provider: no HEAD, ranges, busy = 458, one connection', async () => {
    variant = 'nohead'; maxConn = 1; busyStatus = 458
    const p = await probeProvider({ sampleUrl: base, apiUrl: api(), testBusy: true })
    expect(p).toMatchObject({ maxConnections: 1, head: false, ranges: true, busyStatus: 458 })
    expect(strategyFor(p).parallel).toBe(1)
  })
  it('busy signalled as 403 on another provider: engine waits then completes', async () => {
    variant = 'x'; maxConn = 1; busyStatus = 403
    const p = await probeProvider({ sampleUrl: base, apiUrl: api(), testBusy: true }); expect(p.busyStatus).toBe(403)
    active = 1; setTimeout(() => { active = 0 }, 150)
    const sink = new MemSink(); const st = new Set<string>()
    await download({ url: base, sink, ...fast, isBusy: strategyFor(p).isBusy, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))), slotPoll: 0.05, onProgress: (x) => st.add(x.status) })
    expect(st.has('waiting-slot')).toBe(true); expect(sink.hash()).toBe(HASH)
  })
  it('busy signalled as a 200 HTML page: detected by content, not by status', async () => {
    variant = 'html'; maxConn = 1
    active = 1; setTimeout(() => { active = 0 }, 150)
    const sink = new MemSink(); const st = new Set<string>()
    await download({ url: base, sink, ...fast, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))), slotPoll: 0.05, onProgress: (x) => st.add(x.status) })
    expect(st.has('waiting-slot')).toBe(true); expect(sink.hash()).toBe(HASH)
  })
  it('account with 3 connections: two parallel regions, byte-exact', async () => {
    variant = 'x'; maxConn = 3; busyStatus = 458
    const p = await probeProvider({ sampleUrl: base, apiUrl: api() }); const s = strategyFor(p); expect(s.parallel).toBe(2)
    const sink = new MemSink(); let regions: unknown[] = []
    const r = await download({ url: base, sink, ...fast, parallel: s.parallel, isBusy: s.isBusy, onRegions: (x) => { regions = x } })
    expect(r.received).toBe(SIZE); expect(sink.hash()).toBe(HASH); expect(regions.length).toBe(2)
  })
  it('redirect with a token that expires: engine falls back to the original URL', async () => {
    variant = 'redirect'; maxConn = 1; tokenUses = 0
    const sink = new MemSink(); let n = 0
    const f: typeof fetch = (u, init) => { n++; if (n === 4) tokenUses++; return fetch(u, init) } // rotate the token mid-download
    await download({ url: base, sink, ...fast, fetchImpl: f })
    expect(sink.hash()).toBe(HASH)
  })
  it('HLS VOD: best variant, all segments in order, local playlist rebuilt', async () => {
    const hls = base.replace('/movie.mp4', '/master.m3u8')
    const sink = new MemSink()
    const r = await downloadHls({ url: hls, sink })
    expect(sink.hash()).toBe(HASH); expect(r.index.segments.length).toBe(Math.ceil(SIZE / SEG)); expect(r.index.codecs).toBeUndefined() // best variant had no CODECS attribute
    const pl = localPlaylist(r.index, 'blob:x')
    expect(pl).toContain('#EXT-X-BYTERANGE:262144@0'); expect(pl).toContain('#EXT-X-ENDLIST')
  })
})
