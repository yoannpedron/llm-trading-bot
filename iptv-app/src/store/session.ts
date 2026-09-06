import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { XtreamCredentials } from '../api/xtream'

export type Mode = 'mock' | 'live'

interface SessionState {
  mode: Mode
  creds?: XtreamCredentials
  includeAdult: boolean
  setMock: () => void
  setLive: (c: XtreamCredentials) => void
  logout: () => void
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      mode: 'mock',
      creds: undefined,
      includeAdult: false,
      setMock: () => set({ mode: 'mock', creds: undefined }),
      setLive: (creds) => set({ mode: 'live', creds }),
      logout: () => set({ creds: undefined }),
    }),
    { name: 'iptv-session' },
  ),
)

export const envCreds = (): XtreamCredentials => ({
  url: import.meta.env.VITE_XTREAM_URL ?? '',
  username: import.meta.env.VITE_XTREAM_USER ?? '',
  password: import.meta.env.VITE_XTREAM_PASS ?? '',
})
