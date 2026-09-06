/** Origin Private File System storage: large files, no quota prompt on Chromium, playable via File → object URL. */
import type { Sink } from './engine'

export const opfsAvailable = () => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory

async function dir() { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle('downloads', { create: true }) }

export async function openSink(name: string, startAt = 0): Promise<Sink & { handle: FileSystemFileHandle }> {
  const d = await dir()
  const handle = await d.getFileHandle(name, { create: true })
  const w = await handle.createWritable({ keepExistingData: startAt > 0 })
  if (startAt > 0) await w.seek(startAt)
  let pos = startAt
  return {
    handle,
    async write(offset, chunk) { if (offset !== pos) { await w.seek(offset); pos = offset } await w.write(new Uint8Array(chunk)); pos += chunk.length },
    async close() { await w.close() },
  }
}
export async function sizeOf(name: string): Promise<number> { try { const d = await dir(); const f = await (await d.getFileHandle(name)).getFile(); return f.size } catch { return 0 } }
export async function fileOf(name: string): Promise<File | undefined> { try { const d = await dir(); return await (await d.getFileHandle(name)).getFile() } catch { return undefined } }
export async function remove(name: string) { try { const d = await dir(); await d.removeEntry(name) } catch { /* ignore */ } }
export async function usage() { try { const e = await navigator.storage.estimate(); return { usage: e.usage ?? 0, quota: e.quota ?? 0 } } catch { return { usage: 0, quota: 0 } } }
