import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { XtreamCredentials } from '../api/xtream'

export type Mode = 'mock' | 'live'

export interface Rescue { host: string; ip: string; at: number }
interface SessionState {
  mode: Mode
  creds?: XtreamCredentials
  includeAdult: boolean
  /** DNS rescue in force for a provider host (name blocked by the ISP resolver, IP reachable) */
  rescue?: Rescue
  setRescue: (r?: Rescue) => void
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
      logout: () => set({ creds: undefined, rescue: undefined }),
      setRescue: (rescue) => set({ rescue }),
    }),
    { name: 'iptv-session' },
  ),
)

export const envCreds = (): XtreamCredentials => ({
  url: import.meta.env.VITE_XTREAM_URL ?? '',
  username: import.meta.env.VITE_XTREAM_USER ?? '',
  password: import.meta.env.VITE_XTREAM_PASS ?? '',
})

/** credentials with the rescued IP substituted for the blocked hostname, when a rescue is active for that host (24 h) */
export function effectiveCreds(creds?: XtreamCredentials, rescue = useSession.getState().rescue): XtreamCredentials | undefined {
  if (!creds) return creds
  if (!rescue || Date.now() - rescue.at > 24 * 3600e3) return creds
  try { const u = new URL(creds.url); if (u.hostname !== rescue.host) return creds; u.hostname = rescue.ip; return { ...creds, url: u.toString().replace(/\/$/, '') } } catch { return creds }
}
