/// <reference lib="webworker" />
import { parseCatalog } from '../parser'
import type { Catalog, RawCatalog } from '../types'

export type WorkerIn = { type: 'parse'; raw: RawCatalog; includeAdult?: boolean }
export type WorkerOut = { type: 'done'; catalog: Catalog } | { type: 'error'; message: string }

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  try {
    const catalog = parseCatalog(e.data.raw, { includeAdult: e.data.includeAdult })
    ;(self as unknown as Worker).postMessage({ type: 'done', catalog } satisfies WorkerOut)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ type: 'error', message: String(err) } satisfies WorkerOut)
  }
}
