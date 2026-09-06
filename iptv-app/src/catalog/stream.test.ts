import { describe, expect, it } from 'vitest'
import { streamJsonArray } from './stream'
const toStream = (s: string, chunk = 7) => new ReadableStream<Uint8Array>({ start(c) { const b = new TextEncoder().encode(s); for (let i = 0; i < b.length; i += chunk) c.enqueue(b.slice(i, i + chunk)); c.close() } })
describe('streamJsonArray', () => {
  it('parses objects split across arbitrary chunk boundaries, with nested braces and escaped quotes', async () => {
    const data = [{ name: 'A "quoted" }{ name', n: 1, o: { x: [1, { y: '}' }] } }, { name: 'ÉŘ – ünïcode 🎬', n: 2 }, { name: 'C\\"', n: 3 }]
    const json = JSON.stringify(data)
    for (const chunk of [1, 3, 7, 50]) {
      const out: unknown[] = []
      for await (const b of streamJsonArray(toStream(json, chunk), 2)) out.push(...b)
      expect(out).toEqual(data)
    }
  })
  it('handles an empty array and whitespace', async () => {
    const out: unknown[] = []
    for await (const b of streamJsonArray(toStream(' \n[ ] '))) out.push(...b)
    expect(out).toEqual([])
  })
  it('streams 50k objects in batches without holding the whole text', async () => {
    const arr = Array.from({ length: 50_000 }, (_, i) => ({ num: i, name: 'EN - Film ' + i + ' (2020)', stream_id: i }))
    let batches = 0, n = 0
    for await (const b of streamJsonArray(toStream(JSON.stringify(arr), 65536), 5000)) { batches++; n += b.length }
    expect(n).toBe(50_000); expect(batches).toBe(10)
  })
})
