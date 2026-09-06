import { describe, expect, it } from 'vitest'
import { linkStreams, splitTeams, teamSimilarity } from './match'
import type { Match } from '../api/sports'
import type { MediaItem } from '../types'
import { parseEvent } from './live'

const m = (id: string, home: string, away: string, start: string): Match => ({ id, sport: 'football', competition: 'Test', home, away, start: new Date(start), state: 'pre', source: 'espn' })
const item = (rawName: string): MediaItem => ({ id: 'live:' + rawName.length + Math.random(), kind: 'live', rawName, title: rawName, searchTitle: rawName, tags: [], isAdult: false, streamId: 1, categoryId: '1' })

describe('team matching', () => {
  it('splits titles', () => {
    expect(splitTeams('ROMA - ATALANTA')).toEqual(['ROMA', 'ATALANTA'])
    expect(splitTeams('FC KAISERSLAUTERN VS. SV DARMSTADT 98')).toEqual(['FC KAISERSLAUTERN', 'SV DARMSTADT 98'])
    expect(splitTeams('KENT STATE VS. SOUTH CAROLINA')).toEqual(['KENT STATE', 'SOUTH CAROLINA'])
    expect(splitTeams('LAGUNA SECA GP - TRÄNING')).toEqual(['LAGUNA SECA GP', 'TRÄNING'])
  })
  it('scores similar names high and different names low', () => {
    expect(teamSimilarity("BORUSSIA M'GLADBACH", 'Borussia Mönchengladbach')).toBeGreaterThan(0.7)
    expect(teamSimilarity('TSG HOFFENHEIM', 'TSG Hoffenheim')).toBe(1)
    expect(teamSimilarity('MAN UTD', 'Manchester United')).toBe(1)
    expect(teamSimilarity('ROMA', 'AS Roma')).toBeGreaterThanOrEqual(0.8)
    expect(teamSimilarity('ROMA', 'Atalanta')).toBe(0)
  })
  it('links streams to fixtures within the time window, both orientations', () => {
    const now = new Date('2026-09-05T10:00:00Z')
    const fixtures = [m('a', 'Everton', 'Manchester United', '2026-09-05T18:35:00Z'), m('b', 'Atalanta', 'AS Roma', '2026-09-05T18:35:00Z'), m('c', 'AS Roma', 'Lazio', '2026-09-05T13:00:00Z')]
    const ev = ['NEXT | ROMA - ATALANTA | Sat 05 Sep 18:35 GMT (IS) | 8K | IS: LIVEY PPV 29', 'NEXT | MANCHESTER UNITED VS. EVERTON | Sat 05 Sep 21:35 +03 (SA) | 8K | SA: SHAHID PPV 9', 'NEXT | SOMETHING - ELSE | Sat 05 Sep 18:35 GMT (IS) | 8K | IS: LIVEY PPV 30']
      .map((raw) => ({ item: item(raw), event: parseEvent(raw, now)! }))
    const r = linkStreams(ev, fixtures)
    expect(r.linked.get('b')?.streams.length).toBe(1)
    expect(r.linked.get('a')?.streams.length).toBe(1)
    expect(r.linked.has('c')).toBe(false)
    expect(r.unmatched.length).toBe(1)
  })
})
