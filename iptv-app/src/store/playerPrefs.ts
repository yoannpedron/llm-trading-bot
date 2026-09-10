import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** Player preferences that survive across titles and sessions. */
interface PlayerPrefs {
  volume: number
  muted: boolean
  speed: number
  /** preferred audio / subtitle language (ISO 639-1), remembered from the last explicit choice */
  audioLang?: string
  subLang?: string
  subSize: number       // percent
  subDelay: number      // ms, applied per session to loaded cues
  set: (p: Partial<PlayerPrefs>) => void
}
export const usePlayerPrefs = create<PlayerPrefs>()(persist((set) => ({
  volume: 1, muted: false, speed: 1, subSize: 100, subDelay: 0,
  set: (p) => set(p),
}), { name: 'iptv-player' }))
