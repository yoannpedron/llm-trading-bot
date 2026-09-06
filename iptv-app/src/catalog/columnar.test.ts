import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseCatalog } from '../parser'
import { ColumnarBuilder, ExtrasReader, bytesOf, cloneColumnar, searchBytes } from './columnar'
import { CatalogView } from './view'
import vod from '../api/mock/vod_streams.json'
import series from '../api/mock/series.json'
import live from '../api/mock/live_streams.json'
import vc from '../api/mock/vod_categories.json'
import sc from '../api/mock/series_categories.json'
import lc from '../api/mock/live_categories.json'
import type { RawCatalog } from '../types'

let lastBuilder: ColumnarBuilder
const build = (cat: ReturnType<typeof parseCatalog>) => { const b = new ColumnarBuilder(); for (const it of cat.items) b.push(it); lastBuilder = b; return b.build(cat.categories) }
const norm = (x: Record<string, unknown>) => { const o = { ...x }; delete o.plot; delete o.cast; delete o.director; delete o.genre; for (const k of Object.keys(o)) if (o[k] === undefined || (Array.isArray(o[k]) && !(o[k] as unknown[]).length)) delete o[k]; if (typeof o.rating === 'number') o.rating = Math.round(o.rating * 10) / 10; return o }

describe('columnar snapshot (v2, UTF-8 bytes)', () => {
  const cat = parseCatalog({ vod, series, live, vodCategories: vc, seriesCategories: sc, liveCategories: lc } as unknown as RawCatalog)
  const view = new CatalogView(build(cat))
  it('round-trips every item exactly through the lazy view', () => {
    expect(view.n).toBe(cat.items.length)
    expect(view.counts).toEqual(cat.counts)
    for (let i = 0; i < cat.items.length; i += 37) expect(norm(view.at(i) as unknown as Record<string, unknown>)).toEqual(norm(cat.items[i] as unknown as Record<string, unknown>))
    expect(Object.keys(view.byCategory).length).toBe(Object.keys(cat.byCategory).length)
    expect(view.item(cat.items[5].id)).toBe(view.at(5))
    const xr = new ExtrasReader(lastBuilder.buildExtras())
    for (let i = 0; i < cat.items.length; i += 53) { const it = cat.items[i]; const ex = xr.of((it.kind === 'movie' ? 0 : it.kind === 'series' ? 1 : 2) * 4294967296 + it.streamId); expect(ex.plot).toBe(it.plot); expect(ex.cast).toBe(it.cast); expect(ex.genre).toBe(it.genre) }
    expect(view.at(0)?.poster).toBe(cat.items[0].poster)
  })
  it('search works on the bytes and respects entry boundaries', () => {
    const hits = searchBytes(view.search, 'The')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((i) => /the/i.test(cat.items[i].title + cat.items[i].rawName))).toBe(true)
    expect(new Set(hits).size).toBe(hits.length)
    expect(searchBytes(view.search, 'zzzzqqq')).toEqual([])
  })
  it('clone is independent', () => {
    const c = cloneColumnar(build(cat)); expect(bytesOf(c)).toBeGreaterThan(0)
    const v2 = new CatalogView(c); expect(v2.at(3)).toEqual(view.at(3))
  })
  it('bench on the full catalogue when available', () => {
    const S = '/tmp/claude-0/-home-user-llm-trading-bot/4fdda553-ca85-55e7-9404-b35fd6420482/scratchpad/'
    let full: RawCatalog
    try { full = { vod: JSON.parse(readFileSync(S + 'get_vod_streams.json', 'utf8')), series: JSON.parse(readFileSync(S + 'get_series.json', 'utf8')), live: JSON.parse(readFileSync(S + 'get_live_streams.json', 'utf8')), vodCategories: JSON.parse(readFileSync(S + 'get_vod_categories.json', 'utf8')), seriesCategories: JSON.parse(readFileSync(S + 'get_series_categories.json', 'utf8')), liveCategories: JSON.parse(readFileSync(S + 'get_live_categories.json', 'utf8')) } } catch { return }
    const c = parseCatalog(full)
    let t = performance.now(); const col = build(c); const tPack = performance.now() - t
    t = performance.now(); const v = new CatalogView(col); const tView = performance.now() - t
    t = performance.now(); for (let i = 0; i < v.n; i += 1000) v.at(i); const tAt = (performance.now() - t) / (v.n / 1000)
    t = performance.now(); for (const q of ['avatar', 'marseille', 'tf1', 'batman', 'xyz']) searchBytes(v.search, q); const tSearch = (performance.now() - t) / 5
    process.stdout.write(`COLBENCH items=${c.items.length} build=${tPack.toFixed(0)}ms view=${tView.toFixed(0)}ms bytes=${(bytesOf(col) / 1e6).toFixed(0)}MB at=${(tAt * 1000).toFixed(1)}us search=${tSearch.toFixed(1)}ms\n`)
  }, 300_000)
})
