import { describe, expect, it } from 'vitest'
import { countryOf, parseEvent, themeOf } from './live'

describe('live helpers', () => {
  it('reads country from category prefix', () => {
    expect(countryOf('UK| SKY SPORT+ VIP')?.code).toBe('UK')
    expect(countryOf('BEE| DAZN PPV')?.name).toBe('Belgique')
    expect(countryOf('ICELAND LIVEY PPV')).toBeUndefined()
  })
  it('classifies themes', () => {
    expect(themeOf('AR| SHAHID PPV')).toBe('events')
    expect(themeOf('FR| SPORTS')).toBe('sport')
    expect(themeOf('US| KIDS')).toBe('kids')
    expect(themeOf('DE| GENERAL')).toBe('general')
  })
  it('parses dated PPV events with timezone', () => {
    const now = new Date('2026-09-06T08:00:00Z')
    const e = parseEvent('NEXT | ROMA - ATALANTA | Sat 05 Sep 18:35 GMT (IS) | 8K EXCLUSIVE | IS: LIVEY PPV 29', now)!
    expect(e.title).toBe('ROMA - ATALANTA')
    expect(e.start?.toISOString()).toBe('2026-09-05T18:35:00.000Z')
    expect(e.status).toBe('next') // prefix says NEXT and start is > 3 h ago: kept as announced
    const f = parseEvent('ENDED | AL NASSR FC VS. AL HILAL FC | Sat 05 Sep 17:45 +03 (SA) | 8K EXCLUSIVE | SA: SHAHID PPV 9', now)!
    expect(f.start?.toISOString()).toBe('2026-09-05T14:45:00.000Z')
    expect(f.status).toBe('ended')
    expect(f.country).toBe('SA')
    const g = parseEvent('NEXT | BUNDESLIIGA FRANKFURT - AUGSBURG | Sun 06 Sep 18:20 EEST (FI) | 8K EXCLUSIVE | FI: VIAPLAY PPV 123', now)!
    expect(g.status).toBe('next')
    expect(g.start?.toISOString()).toBe('2026-09-06T15:20:00.000Z')
  })
  it('parses ISO-dated events', () => {
    const e = parseEvent('(FLSP 201) | volleyball:  Lyon vs Dallas _ Women`s (Lyon vs Dallas) (2026-09-05 14:01:30)', new Date('2026-09-05T14:30:00Z'))!
    expect(e.status).toBe('live')
    expect(e.title).toContain('volleyball')
  })
  it('parses the field-based format with ISO or D-M-Y dates, competition and broadcaster suffix', () => {
    const now = new Date('2026-09-06T10:00:00Z')
    const a = parseEvent('Next | OM vs. Paris FC sur Ligue 1+ | Ligue 1+ | 2026-09-06 | 18:45 (GMT) | 8K EXCLUSIVE | FR: DAZN PPV 63', now)!
    expect(a).toMatchObject({ status: 'next', title: 'OM vs. Paris FC', competition: 'Ligue 1+', country: 'FR' })
    expect(a.start?.toISOString()).toBe('2026-09-06T18:45:00.000Z')
    const b = parseEvent('Next | Marseille vs. Paris FC | all | 06-09-2026 | 20:15 (GMT) | 8K EXCLUSIVE | BR: SOCCER PPV 119', now)!
    expect(b.start?.toISOString()).toBe('2026-09-06T20:15:00.000Z')
    expect(b.competition).toBeUndefined()
    const c = parseEvent('End | Monaco vs. Marseille | all | 05-09-2026 | 19:00 (GMT) | 8K EXCLUSIVE | BR: SOCCER PPV 56', now)!
    expect(c.status).toBe('ended')
  })
  it('parses the dateless live format', () => {
    const now = new Date('2026-09-06T10:00:00Z')
    const e = parseEvent('Live | Capitals @ Penguins | NHL.TV | 8K EXCLUSIVE | MA: DAZN PPV 11', now)!
    expect(e).toMatchObject({ status: 'live', title: 'Capitals @ Penguins', competition: 'NHL.TV', country: 'MA' })
    expect(e.start).toEqual(now)
  })
  it('ignores regular channels', () => {
    expect(parseEvent('FR| TF1 FHD')).toBeUndefined()
  })
})
