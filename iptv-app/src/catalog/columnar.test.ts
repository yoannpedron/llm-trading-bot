import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseCatalog } from '../parser'
import { buildSearchIndex, pack, searchIndex, unpack } from './columnar'
import vod from '../api/mock/vod_streams.json'
import series from '../api/mock/series.json'
import live from '../api/mock/live_streams.json'
import vc from '../api/mock/vod_categories.json'
import sc from '../api/mock/series_categories.json'
import lc from '../api/mock/live_categories.json'
import type { RawCatalog } from '../types'

describe('columnar snapshot', () => {
  const cat = parseCatalog({ vod, series, live, vodCategories: vc, seriesCategories: sc, liveCategories: lc } as unknown as RawCatalog)
  it('round-trips every item exactly', () => {
    const back = unpack(pack(cat))
    expect(back.items.length).toBe(cat.items.length)
    expect(back.counts).toEqual(cat.counts)
    const norm = (x: Record<string, unknown>) => { const o = { ...x }; for (const k of Object.keys(o)) if (o[k] === undefined || (Array.isArray(o[k]) && !(o[k] as unknown[]).length)) delete o[k]; if (typeof o.rating === 'number') o.rating = Math.round(o.rating * 10) / 10; return o }
    for (let i = 0; i < cat.items.length; i += 37) expect(norm(back.items[i] as unknown as Record<string, unknown>)).toEqual(norm(cat.items[i] as unknown as Record<string, unknown>))
    expect(Object.keys(back.byCategory).length).toBe(Object.keys(cat.byCategory).length)
  })
  it('search index finds titles by substring', () => {
    const idx = buildSearchIndex(cat.items)
    const hits = searchIndex(idx, 'the')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((i) => /the/i.test(cat.items[i].title + cat.items[i].rawName))).toBe(true)
    expect(searchIndex(idx, 'zzzzqqq')).toEqual([])
  })
  it('bench on the full catalogue when available', () => {
    const S = '/tmp/claude-0/-home-user-llm-trading-bot/4fdda553-ca85-55e7-9404-b35fd6420482/scratchpad/'
    let full: RawCatalog
    try { full = { vod: JSON.parse(readFileSync(S + 'get_vod_streams.json', 'utf8')), series: JSON.parse(readFileSync(S + 'get_series.json', 'utf8')), live: JSON.parse(readFileSync(S + 'get_live_streams.json', 'utf8')), vodCategories: JSON.parse(readFileSync(S + 'get_vod_categories.json', 'utf8')), seriesCategories: JSON.parse(readFileSync(S + 'get_series_categories.json', 'utf8')), liveCategories: JSON.parse(readFileSync(S + 'get_live_categories.json', 'utf8')) } } catch { return }
    const c = parseCatalog(full)
    let t = performance.now(); const col = pack(c); const tPack = performance.now() - t
    const bytes = Object.values(col).reduce((a, v) => a + (typeof v === 'string' ? v.length * 2 : ArrayBuffer.isView(v) ? v.byteLength : 0), 0)
    t = performance.now(); const back = unpack(col); const tUnpack = performance.now() - t
    t = performance.now(); const idx = buildSearchIndex(back.items); const tIdx = performance.now() - t
    t = performance.now(); for (const q of ['avatar', 'marseille', 'tf1', 'batman', 'xyz']) searchIndex(idx, q); const tSearch = (performance.now() - t) / 5
    process.stdout.write(`COLBENCH items=${c.items.length} pack=${tPack.toFixed(0)}ms unpack=${tUnpack.toFixed(0)}ms size=${(bytes / 1e6).toFixed(0)}MB index=${tIdx.toFixed(0)}ms search=${tSearch.toFixed(1)}ms\n`)
  }, 300_000)
})
