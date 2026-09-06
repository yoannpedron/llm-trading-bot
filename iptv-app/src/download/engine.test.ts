import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { download, probe, type Sink } from './engine'

const SIZE = 12 * 1024 * 1024
const DATA = randomBytes(SIZE)
const HASH = createHash('sha256').update(DATA).digest('hex')
let server: http.Server, base = ''
let mode: 'ok' | 'cut' | 'busy' | 'noranges' = 'ok'
let cuts = 0, busyLeft = 0, requests: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.headers.range ?? 'full')
    if (mode === 'busy' && busyLeft > 0) { busyLeft--; res.writeHead(458, 'Unknown'); res.end(); return }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    if (mode === 'noranges' || !m) { res.writeHead(200, { 'content-length': SIZE, 'content-type': 'video/mp4' }); res.end(DATA); return }
    const a = +m[1], b = m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${SIZE}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes', 'content-type': 'video/mp4' })
    if (mode === 'cut' && cuts > 0 && b - a > 1024 * 1024) { cuts--; res.write(DATA.subarray(a, a + 300_000)); setTimeout(() => res.destroy(), 20); return }
    res.end(DATA.subarray(a, b + 1))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/movie.mp4`
})
afterAll(() => server.close())

class MemSink implements Sink {
  buf = Buffer.alloc(SIZE); max = 0; writes = 0
  async write(offset: number, chunk: Uint8Array) { Buffer.from(chunk).copy(this.buf, offset); this.max = Math.max(this.max, offset + chunk.length); this.writes++ }
  hash() { return createHash('sha256').update(this.buf.subarray(0, this.max)).digest('hex') }
}
const fast = { minChunk: 512 * 1024, maxChunk: 4 * 1024 * 1024, sleep: async () => undefined, retryDelays: [0], slotPoll: 0 }

describe('download engine', () => {
  it('probes size and range support', async () => {
    mode = 'ok'
    expect(await probe(base)).toMatchObject({ total: SIZE, ranges: true })
  })
  it('downloads sequentially with growing chunks and byte-exact result', async () => {
    mode = 'ok'; requests = []
    const sink = new MemSink(); const chunks: number[] = []
    const r = await download({ url: base, sink, ...fast, onProgress: (p) => chunks.push(p.chunk) })
    expect(r).toEqual({ received: SIZE, total: SIZE })
    expect(sink.hash()).toBe(HASH)
    expect(Math.max(...chunks)).toBeGreaterThan(fast.minChunk) // adapted upwards
    expect(requests.every((x) => x.startsWith('bytes='))).toBe(true)
  })
  it('resumes exactly after connection cuts, without duplicated bytes', async () => {
    mode = 'cut'; cuts = 2; requests = []
    const sink = new MemSink()
    const r = await download({ url: base, sink, ...fast })
    expect(r.received).toBe(SIZE)
    expect(sink.hash()).toBe(HASH)
    expect(requests.length).toBeGreaterThan(3)
  })
  it('waits while the slot is busy (458) then completes', async () => {
    mode = 'busy'; busyLeft = 3
    const sink = new MemSink(); const statuses = new Set<string>()
    await download({ url: base, sink, ...fast, onProgress: (p) => statuses.add(p.status) })
    expect(statuses.has('waiting-slot')).toBe(true)
    expect(sink.hash()).toBe(HASH)
  })
  it('resumes from a given offset', async () => {
    mode = 'ok'; requests = []
    const sink = new MemSink(); DATA.copy(sink.buf, 0, 0, 5_000_000); sink.max = 5_000_000
    await download({ url: base, sink, ...fast, startAt: 5_000_000 })
    expect(requests[1]).toMatch(/^bytes=5000000-/)
    expect(sink.hash()).toBe(HASH)
  })
  it('falls back to one full stream when ranges are not supported', async () => {
    mode = 'noranges'
    const sink = new MemSink()
    const r = await download({ url: base, sink, ...fast })
    expect(r.received).toBe(SIZE)
    expect(sink.hash()).toBe(HASH)
  })
})
