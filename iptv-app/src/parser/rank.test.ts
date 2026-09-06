import { describe, expect, it } from 'vitest'
import { importance } from './rank'
import type { Match } from '../api/sports'
const m = (competition: string, home: string, away: string, state: Match['state'] = 'pre'): Match => ({ id: 'x', kind: 'team', sport: 'football', competition, home, away, start: new Date(Date.now() + 5 * 3600e3), state, source: 'espn' })
describe('importance', () => {
  const o = { region: 'FR', favTeams: ['marseille'], favCompetitions: [], streams: 3 }
  it('ranks champions league above a foreign league, and own country above foreign', () => {
    expect(importance(m('UEFA Champions League', 'Villarreal', 'Dortmund'), o)).toBeGreaterThan(importance(m('English Premier League', 'Everton', 'Man United'), o))
    expect(importance(m('French Ligue 1', 'Troyes', 'Strasbourg'), o)).toBeGreaterThan(importance(m('English Premier League', 'Everton', 'Man United'), o))
  })
  it('favourite team beats everything, including a live non-favourite; a live favourite beats a scheduled favourite', () => {
    expect(importance(m('French Ligue 1', 'Marseille', 'Paris FC'), o)).toBeGreaterThan(importance(m('UEFA Champions League', 'Villarreal', 'Dortmund'), o))
    expect(importance(m('French Ligue 1', 'Marseille', 'Paris FC'), o)).toBeGreaterThan(importance(m('Dutch Eredivisie', 'Groningen', 'Twente', 'in'), o))
    expect(importance(m('French Ligue 1', 'Marseille', 'Paris FC', 'in'), o)).toBeGreaterThan(importance(m('French Ligue 1', 'Marseille', 'Paris FC'), o))
    expect(importance(m('MLS', 'Orlando', 'Atlanta', 'in'), o)).toBeGreaterThan(importance(m('MLS', 'Orlando', 'Atlanta'), o))
  })
})
