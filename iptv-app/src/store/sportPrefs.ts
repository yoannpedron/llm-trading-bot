import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface State {
  teams: string[]          // normalised team names
  competitions: string[]
  reminders: string[]      // match ids
  hideScores: boolean
  toggleTeam: (t: string) => void
  toggleCompetition: (c: string) => void
  toggleReminder: (id: string) => void
  set: (p: Partial<State>) => void
}
const tg = (a: string[], v: string) => (a.includes(v) ? a.filter((x) => x !== v) : [...a, v])
export const useSportPrefs = create<State>()(persist((set, get) => ({
  teams: [], competitions: [], reminders: [], hideScores: false,
  toggleTeam: (t) => set({ teams: tg(get().teams, t) }),
  toggleCompetition: (c) => set({ competitions: tg(get().competitions, c) }),
  toggleReminder: (id) => set({ reminders: tg(get().reminders, id) }),
  set: (p) => set(p),
}), { name: 'iptv-sport' }))
