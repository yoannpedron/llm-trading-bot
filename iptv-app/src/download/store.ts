import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { download, type Progress } from './engine'
import { openSink, remove, sizeOf } from './opfs'
import { strategyFor, type ProviderProfile } from './profile'
import { downloadHls, type HlsIndex } from './hls'
import type { Region } from './engine'
import { useSettings } from '../store/settings'
import { useSession } from '../store/session'

export type DlStatus = 'queued' | 'downloading' | 'waiting-slot' | 'paused' | 'done' | 'error'
export interface Dl {
  id: string            // media id (movie:123 or series:45#ep789)
  title: string
  url: string
  file: string          // OPFS file name
  ext: string
  total: number
  received: number
  status: DlStatus
  speed?: number
  chunk?: number
  error?: string
  createdAt: number
  finishedAt?: number
  regions?: Region[]
  hls?: HlsIndex
  strategy?: string
}
interface State {
  items: Record<string, Dl>
  maxRate: number       // bytes/s, 0 = unlimited
  wifiOnly: boolean
  add: (d: Pick<Dl, 'id' | 'title' | 'url' | 'ext'>) => void
  pause: (id: string) => void
  resume: (id: string) => void
  cancel: (id: string) => Promise<void>
  set: (p: Partial<Pick<State, 'maxRate' | 'wifiOnly'>>) => void
  /** internal */
  _tick: () => void
}

const controllers = new Map<string, AbortController>()
let running: string | undefined

export const useDownloads = create<State>()(persist((set, get) => ({
  items: {}, maxRate: 0, wifiOnly: false,
  add: (d) => {
    if (get().items[d.id]) return
    const file = d.id.replace(/[^a-z0-9]+/gi, '_') + '.' + (d.ext === 'm3u8' ? 'ts' : d.ext)
    set({ items: { ...get().items, [d.id]: { ...d, file, total: 0, received: 0, status: 'queued', createdAt: Date.now() } } })
    get()._tick()
  },
  pause: (id) => { controllers.get(id)?.abort(); controllers.delete(id); patch(set, get, id, { status: 'paused', speed: 0 }); if (running === id) running = undefined; get()._tick() },
  resume: (id) => { patch(set, get, id, { status: 'queued', error: undefined }); get()._tick() },
  cancel: async (id) => { controllers.get(id)?.abort(); controllers.delete(id); if (running === id) running = undefined; const it = get().items[id]; if (it) await remove(it.file); const items = { ...get().items }; delete items[id]; set({ items }); get()._tick() },
  set: (p) => set(p),
  _tick: () => {
    // one download at a time: the subscription has one connection
    if (running) return
    const next = Object.values(get().items).filter((d) => d.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!next) return
    if (get().wifiOnly && (navigator as unknown as { connection?: { type?: string } }).connection?.type === 'cellular') return
    running = next.id
    const ac = new AbortController(); controllers.set(next.id, ac)
    void (async () => {
      try {
        const profile = currentProfile()
        const strat = strategyFor(profile)
        const isHls = next.ext === 'm3u8' || !!profile?.hlsVod
        const startAt = isHls ? (next.received || 0) : (next.regions?.length ? 0 : await sizeOf(next.file))
        const sink = await openSink(next.file, startAt)
        let last = 0
        const onProgress = (p: Progress) => {
          const now = Date.now(); if (now - last < 500 && p.status === 'downloading') return; last = now
          patch(set, get, next.id, { received: p.received, total: p.total, speed: p.speed, chunk: p.chunk, status: p.status === 'waiting-slot' ? 'waiting-slot' : 'downloading' })
        }
        const t0 = Date.now()
        if (isHls) {
          patch(set, get, next.id, { strategy: 'HLS segments' })
          const r = await downloadHls({ url: next.url, sink, signal: ac.signal, isBusy: strat.isBusy, onProgress, startIndex: next.hls, startOffset: next.received || 0 })
          patch(set, get, next.id, { hls: r.index })
        } else {
          patch(set, get, next.id, { strategy: strat.parallel > 1 ? `${strat.parallel} connexions` : '1 connexion, séquentiel' })
          const r = await download({ url: next.url, sink, startAt, maxRate: get().maxRate, signal: ac.signal, isBusy: strat.isBusy, parallel: strat.parallel, regions: next.regions, onRegions: (regions) => patch(set, get, next.id, { regions: regions.map((x) => ({ ...x })) }), onProgress })
          const secs = (Date.now() - t0) / 1000
          if (secs > 5 && profile) learn({ refSpeed: Math.round(r.received / secs) })
        }
        patch(set, get, next.id, { status: 'done', speed: 0, finishedAt: Date.now(), regions: undefined })
      } catch (e) {
        if (!ac.signal.aborted) patch(set, get, next.id, { status: 'error', error: e instanceof Error ? e.message : String(e), speed: 0 })
      } finally {
        controllers.delete(next.id); if (running === next.id) running = undefined; get()._tick()
      }
    })()
  },
}), { name: 'iptv-downloads', partialize: (s) => ({ items: Object.fromEntries(Object.entries(s.items).map(([k, v]) => [k, { ...v, status: v.status === 'downloading' || v.status === 'waiting-slot' || v.status === 'queued' ? 'paused' : v.status, speed: 0 }])), maxRate: s.maxRate, wifiOnly: s.wifiOnly }) }))

function currentProfile(): ProviderProfile | undefined {
  const { accounts, activeAccountId, profiles } = useSettings.getState(); const creds = useSession.getState().creds
  const acc = accounts.find((a) => a.id === activeAccountId) ?? accounts.find((a) => a.username === creds?.username && a.url === creds?.url)
  return acc ? profiles[acc.id] : undefined
}
function learn(patch: Partial<ProviderProfile>) {
  const { accounts, activeAccountId } = useSettings.getState(); const creds = useSession.getState().creds
  const acc = accounts.find((a) => a.id === activeAccountId) ?? accounts.find((a) => a.username === creds?.username && a.url === creds?.url)
  if (acc) useSettings.getState().learn(acc.id, patch)
}
function patch(set: (p: Partial<State>) => void, get: () => State, id: string, p: Partial<Dl>) { const it = get().items[id]; if (it) set({ items: { ...get().items, [id]: { ...it, ...p } } }) }
