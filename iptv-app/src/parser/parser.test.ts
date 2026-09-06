import { describe, expect, it } from 'vitest'
import { cleanTitle, cleanCategory, parseCatalog } from './index'
import vod from '../api/mock/vod_streams.json'
import series from '../api/mock/series.json'
import live from '../api/mock/live_streams.json'
import vodCategories from '../api/mock/vod_categories.json'
import seriesCategories from '../api/mock/series_categories.json'
import liveCategories from '../api/mock/live_categories.json'
import type { RawCatalog } from '../types'

describe('cleanTitle', () => {
  it('strips language prefix and year', () => {
    const p = cleanTitle('FR - Le Dormeur éveillé  (2021)')
    expect(p).toMatchObject({ lang: 'FR', year: 2021, title: 'Le Dormeur éveillé', searchTitle: 'Le Dormeur éveillé' })
  })
  it('moves trailing actor credits into tags', () => {
    const p = cleanTitle('EN - The Postman (1997) KEVIN COSTNER')
    expect(p.searchTitle).toBe('The Postman')
    expect(p.tags).toContain('KEVIN COSTNER')
  })
  it('handles sub/dub notes after the year', () => {
    const p = cleanTitle('EN - Shock Treatment, Traitement De Choc (1973) ALAIN DELON (FRENCH ENG-SUB)')
    expect(p.year).toBe(1973)
    expect(p.searchTitle).toBe('Shock Treatment, Traitement De Choc')
  })
  it('extracts Turkish episode numbering', () => {
    expect(cleanTitle('Kızılcık Şerbeti 58. Bölüm  @showtv')).toMatchObject({ season: 1, episode: 58, title: 'Kızılcık Şerbeti' })
    expect(cleanTitle('TESKILAT BOLUM 18')).toMatchObject({ episode: 18, title: 'TESKILAT' })
  })
  it('extracts season/episode', () => {
    expect(cleanTitle('EN - The Office S02E05 720p')).toMatchObject({ season: 2, episode: 5, quality: '720P', title: 'The Office' })
    expect(cleanTitle('Breaking Bad 1x03')).toMatchObject({ season: 1, episode: 3 })
  })
  it('cleans live channel names incl. superscript quality', () => {
    expect(cleanTitle('FR| TF1 FHD')).toMatchObject({ lang: 'FR', title: 'TF1', quality: 'FHD' })
    expect(cleanTitle('VO| GAMETOON ᴴᴰ')).toMatchObject({ title: 'GAMETOON', quality: 'HD' })
    expect(cleanTitle('SL| SLOVENIA ⱽᴵᴾ ᴿᴬᵂ').title).toBe('SLOVENIA')
  })
  it('keeps trailing country note as tag for series', () => {
    const p = cleanTitle('4K - The New Pope (2020) (IT)')
    expect(p).toMatchObject({ lang: '4K', year: 2020, title: 'The New Pope' })
    expect(p.tags).toContain('IT')
  })
  it('flags adult content', () => {
    expect(cleanTitle('[X][LegalPorno] Something').isAdult).toBe(true)
    expect(cleanTitle('EN - Toy Story (1995)').isAdult).toBe(false)
  })
  it('removes emojis and dots', () => {
    expect(cleanTitle('⚽ beIN.SPORT.1 HD').title).toBe('beIN SPORT 1')
  })
  it('keeps non-latin titles intact', () => {
    expect(cleanTitle('AR - فيلم شكة دبوس').title).toBe('فيلم شكة دبوس')
  })
  it('never returns an empty title', () => {
    for (const x of [...vod, ...series, ...live]) expect(cleanTitle(x.name).title.length).toBeGreaterThan(0)
  })
})

describe('cleanCategory', () => {
  it('parses |FR| prefix', () => {
    expect(cleanCategory('|FR| NETFLIX 2026')).toEqual({ lang: 'FR', name: 'NETFLIX 2026' })
    expect(cleanCategory('UK| SKY SPORT+ VIP')).toEqual({ lang: 'UK', name: 'SKY SPORT+ VIP' })
  })
})

describe('parseCatalog on the mock sample', () => {
  const raw = { vod, series, live, vodCategories, seriesCategories, liveCategories } as unknown as RawCatalog
  const cat = parseCatalog(raw)
  it('routes into the three kinds', () => {
    expect(cat.counts.movie).toBeGreaterThan(2500)
    expect(cat.counts.series).toBeGreaterThan(500) // 500 + SxxExx episodes mis-filed as VOD
    expect(cat.counts.live).toBe(800)
  })
  it('reclassifies SxxExx VOD entries as series', () => {
    const misfiled = cat.items.filter((i) => i.id.startsWith('movie:') && i.kind === 'series')
    expect(misfiled.length).toBeGreaterThan(0)
    expect(misfiled.every((i) => i.season !== undefined)).toBe(true)
  })
  it('keeps tmdb ids as numbers', () => {
    const withTmdb = cat.items.filter((i) => i.tmdbId)
    expect(withTmdb.length / cat.items.length).toBeGreaterThan(0.5)
    expect(withTmdb.every((i) => Number.isInteger(i.tmdbId))).toBe(true)
  })
  it('indexes by category', () => {
    for (const c of cat.categories) expect(cat.byCategory[c.kind + ':' + c.id].length).toBeGreaterThan(0)
  })
  it('excludes adult content by default', () => {
    expect(cat.items.some((i) => i.isAdult)).toBe(false)
  })
})
