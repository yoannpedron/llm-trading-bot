/** Badge lookup for teams the score sources don't track (TheSportsDB search, cached in IndexedDB, negative results cached too). */
const KEY = 'iptv-badges'
let dbp: Promise<IDBDatabase> | undefined
function db() { return (dbp ??= new Promise((res, rej) => { const r = indexedDB.open(KEY, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })) }
async function get(k: string): Promise<string | null | undefined> { try { const d = await db(); return await new Promise((res) => { const t = d.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined) }) } catch { return undefined } }
async function set(k: string, v: string | null) { try { const d = await db(); d.transaction('kv', 'readwrite').objectStore('kv').put(v, k) } catch { /* ignore */ } }

const inflight = new Map<string, Promise<string | undefined>>()
export function teamBadge(name: string): Promise<string | undefined> {
  const k = name.trim().toLowerCase()
  if (!k || k.length < 3) return Promise.resolve(undefined)
  let p = inflight.get(k)
  if (!p) {
    p = (async () => {
      const c = await get(k)
      if (c !== undefined) return c ?? undefined
      try {
        const r = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) })
        const d = (await r.json()) as { teams?: { strBadge?: string; strTeamBadge?: string }[] | null }
        const b = d.teams?.[0]?.strBadge ?? d.teams?.[0]?.strTeamBadge ?? null
        const url = b ? b + '/small' : null
        void set(k, url)
        return url ?? undefined
      } catch { return undefined }
    })()
    inflight.set(k, p)
  }
  return p
}
