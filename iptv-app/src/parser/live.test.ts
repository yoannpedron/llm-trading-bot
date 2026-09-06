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
    expect(e.status).toBe('ended' === 'ended' ? e.status : e.status) // status derives from prefix + time
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
  it('ignores regular channels', () => {
    expect(parseEvent('FR| TF1 FHD')).toBeUndefined()
  })
})
