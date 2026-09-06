/**
 * Columnar catalogue, v2: every string column is stored as UTF-8 bytes plus a Uint32Array of entry offsets.
 * Nothing is decoded until an entry is read, so a 300k catalogue costs ~80 MB of bytes instead of
 * ~250 MB of UTF-16 strings and objects. The very same buffers are persisted to IndexedDB and transferred
 * (zero-copy) between the worker and the UI thread.
 */
import type { Category, Kind, MediaItem } from '../types'

export const TAGSEP = '\u001e'
export const STRING_COLS = ['rawNames', 'titles', 'searchTitles', 'langs', 'qualities', 'tags', 'categoryIds', 'posters', 'backdrops', 'exts', 'epg'] as const
export type StrName = (typeof STRING_COLS)[number]
/** heavy, rarely read columns: persisted separately and never loaded on the UI thread */
export const EXTRA_COLS = ['plots', 'casts', 'directors', 'genres'] as const
export type ExtraName = (typeof EXTRA_COLS)[number]
/** entry i = dict[pre[i]] + bytes[offsets[i] .. offsets[i+1]); `pre`/`dict` only for URL-like columns (shared prefixes stored once) */
export interface StrCol { bytes: Uint8Array; offsets: Uint32Array; pre?: Uint16Array; dict?: string[] }
export interface Extras { v: 2; ids: Float64Array /* kind*2^32+streamId */; cols: Record<ExtraName, StrCol> }
export interface Extra { plot?: string; cast?: string; director?: string; genre?: string }

export interface Columnar {
  v: 2
  n: number
  generatedAt: number
  kinds: Uint8Array            // 0 movie, 1 series, 2 live
  streamIds: Uint32Array
  years: Uint16Array           // 0 = none
  seasons: Uint8Array; episodes: Uint16Array
  tmdbIds: Uint32Array; ratings: Uint8Array /* x10 */; added: Uint32Array
  flags: Uint8Array            // bit0 adult, bit1 tvArchive
  strs: Record<StrName, StrCol>
  /** case-folded "title rawName\n" per entry, searched directly in the bytes */
  search: StrCol
  categories: Category[]
}
const KIND: Kind[] = ['movie', 'series', 'live']
export const NUM_COLS = ['kinds', 'streamIds', 'years', 'seasons', 'episodes', 'tmdbIds', 'ratings', 'added', 'flags'] as const

/** growable UTF-8 column writer */
class StrWriter {
  private buf = new Uint8Array(1 << 16)
  private len = 0
  private off: number[] = [0]
  private enc = new TextEncoder()
  private pre?: number[]; private dict?: string[]; private dictIdx?: Map<string, number>
  constructor(prefixed = false) { if (prefixed) { this.pre = []; this.dict = ['']; this.dictIdx = new Map([['', 0]]) } }
  push(s: string) {
    if (this.pre) {
      // split a URL at its last '/', the prefix goes to a shared dictionary (65k max)
      const cut = s.lastIndexOf('/') + 1; const p = cut > 8 ? s.slice(0, cut) : ''
      let id = this.dictIdx!.get(p)
      if (id === undefined) { if (this.dict!.length < 65535) { id = this.dict!.length; this.dict!.push(p); this.dictIdx!.set(p, id) } else id = 0 }
      this.pre.push(id); if (id) s = s.slice(cut)
    }
    if (s) {
      for (;;) {
        const r = this.enc.encodeInto(s, this.buf.subarray(this.len))
        if (r.read >= s.length) { this.len += r.written; break }
        this.len += r.written; s = s.slice(r.read)
        const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + s.length * 3 + 64)); nb.set(this.buf); this.buf = nb
      }
    }
    this.off.push(this.len)
  }
  build(): StrCol { const c: StrCol = { bytes: this.buf.slice(0, this.len), offsets: Uint32Array.from(this.off) }; if (this.pre) { c.pre = Uint16Array.from(this.pre); c.dict = this.dict!.slice() } return c }
}
class NumWriter<T extends Uint8Array | Uint16Array | Uint32Array> {
  private arr: T; private len = 0; private mk: (n: number) => T
  constructor(mk: (n: number) => T) { this.mk = mk; this.arr = mk(1 << 14) }
  push(v: number) { if (this.len === this.arr.length) { const nb = this.mk(this.arr.length * 2); nb.set(this.arr); this.arr = nb } this.arr[this.len++] = v }
  build(): T { return this.arr.slice(0, this.len) as T }
}

/** Builds the columnar form incrementally while lists stream in: no object array, bounded memory. */
export class ColumnarBuilder {
  n = 0
  private kinds = new NumWriter((n) => new Uint8Array(n)); private streamIds = new NumWriter((n) => new Uint32Array(n)); private years = new NumWriter((n) => new Uint16Array(n))
  private seasons = new NumWriter((n) => new Uint8Array(n)); private episodes = new NumWriter((n) => new Uint16Array(n)); private tmdbIds = new NumWriter((n) => new Uint32Array(n))
  private ratings = new NumWriter((n) => new Uint8Array(n)); private added = new NumWriter((n) => new Uint32Array(n)); private flags = new NumWriter((n) => new Uint8Array(n))
  private strs = Object.fromEntries(STRING_COLS.map((k) => [k, new StrWriter(k === 'posters' || k === 'backdrops')])) as Record<StrName, StrWriter>
  private xs = Object.fromEntries(EXTRA_COLS.map((k) => [k, new StrWriter()])) as Record<ExtraName, StrWriter>
  private ids: number[] = []
  private search = new StrWriter()
  push(it: MediaItem) {
    this.kinds.push(KIND.indexOf(it.kind)); this.streamIds.push(it.streamId); this.years.push(it.year ?? 0); this.seasons.push(it.season ?? 0); this.episodes.push(it.episode ?? 0)
    this.tmdbIds.push(it.tmdbId ?? 0); this.ratings.push(Math.min(255, Math.round((it.rating ?? 0) * 10))); this.added.push(it.added ?? 0); this.flags.push((it.isAdult ? 1 : 0) | (it.tvArchive ? 2 : 0))
    const S = this.strs
    S.rawNames.push(it.rawName); S.titles.push(it.title); S.searchTitles.push(it.searchTitle === it.title ? '' : it.searchTitle); S.langs.push(it.lang ?? ''); S.qualities.push(it.quality ?? '')
    S.tags.push(it.tags.join(TAGSEP)); S.categoryIds.push(it.categoryId); S.posters.push(it.poster ?? ''); S.backdrops.push(it.backdrop ?? ''); S.exts.push(it.ext ?? '')
    S.epg.push(it.epgChannelId ?? '')
    const X = this.xs; X.plots.push(it.plot ?? ''); X.casts.push(it.cast ?? ''); X.directors.push(it.director ?? ''); X.genres.push(it.genre ?? '')
    this.ids.push(KIND.indexOf(it.kind) * 4294967296 + it.streamId)
    this.search.push((it.title + ' ' + it.rawName).toLowerCase() + '\n')
    this.n++
  }
  build(categories: Category[]): Columnar {
    return { v: 2, n: this.n, generatedAt: Date.now(), kinds: this.kinds.build(), streamIds: this.streamIds.build(), years: this.years.build(), seasons: this.seasons.build(), episodes: this.episodes.build(), tmdbIds: this.tmdbIds.build(), ratings: this.ratings.build(), added: this.added.build(), flags: this.flags.build(),
      strs: Object.fromEntries(STRING_COLS.map((k) => [k, this.strs[k].build()])) as Record<StrName, StrCol>, search: this.search.build(), categories }
  }
  buildExtras(): Extras { return { v: 2, ids: Float64Array.from(this.ids), cols: Object.fromEntries(EXTRA_COLS.map((k) => [k, this.xs[k].build()])) as Record<ExtraName, StrCol> } }
}
/** one item's extras, by id (`kind*2^32+streamId`) */
export class ExtrasReader {
  private map?: Map<number, number>
  private x: Extras
  constructor(x: Extras) { this.x = x }
  of(id: number): Extra {
    if (!this.map) { this.map = new Map(); const ids = this.x.ids; for (let i = 0; i < ids.length; i++) this.map.set(ids[i], i) }
    const i = this.map.get(id); if (i === undefined) return {}
    const u = (k: ExtraName) => { const v = entry(this.x.cols[k], i); return v === '' ? undefined : v }
    return { plot: u('plots'), cast: u('casts'), director: u('directors'), genre: u('genres') }
  }
}

/** every ArrayBuffer of a catalogue, for postMessage transfer */
export function buffersOf(col: Columnar): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  for (const k of NUM_COLS) out.push(col[k].buffer as ArrayBuffer)
  for (const k of STRING_COLS) { const c = col.strs[k]; out.push(c.bytes.buffer as ArrayBuffer, c.offsets.buffer as ArrayBuffer); if (c.pre) out.push(c.pre.buffer as ArrayBuffer) }
  out.push(col.search.bytes.buffer as ArrayBuffer, col.search.offsets.buffer as ArrayBuffer)
  return [...new Set(out)]
}
/** deep copy (memcpy of the typed arrays) so one copy can be transferred while the other is persisted */
export function cloneColumnar(col: Columnar): Columnar {
  const c = { ...col, strs: {} as Record<StrName, StrCol>, search: { bytes: col.search.bytes.slice(), offsets: col.search.offsets.slice() } } as Columnar
  for (const k of NUM_COLS) (c as unknown as Record<string, unknown>)[k] = col[k].slice()
  for (const k of STRING_COLS) { const o = col.strs[k]; c.strs[k] = { bytes: o.bytes.slice(), offsets: o.offsets.slice(), pre: o.pre?.slice(), dict: o.dict?.slice() } }
  return c
}
export function bytesOf(col: Columnar): number { return buffersOf(col).reduce((a, b) => a + b.byteLength, 0) }

const dec = new TextDecoder()
/** decode one entry */
export function entry(c: StrCol, i: number): string { const a = c.offsets[i], b = c.offsets[i + 1]; const p = c.pre ? c.dict![c.pre[i]] : ''; return a === b ? p : p + dec.decode(c.bytes.subarray(a, b)) }
/** decode a whole column into an array (used only for small, hot columns such as langs / categoryIds) */
export function entries(c: StrCol): string[] {
  const n = c.offsets.length - 1; const out: string[] = new Array(n)
  let ascii = true; for (let i = 0; i < c.bytes.length; i++) if (c.bytes[i] & 0x80) { ascii = false; break }
  if (ascii && !c.pre) { const s = dec.decode(c.bytes); for (let i = 0; i < n; i++) out[i] = s.slice(c.offsets[i], c.offsets[i + 1]) }
  else for (let i = 0; i < n; i++) out[i] = entry(c, i)
  return out
}

/** approximate byte frequency in lower-cased titles (space and vowels are common, digits and non-ASCII rare) */
const FREQ = new Uint8Array(256).fill(1)
for (const [ch, f] of Object.entries({ ' ': 9, e: 9, a: 8, i: 7, o: 7, n: 7, r: 7, t: 7, s: 7, l: 6, u: 5, d: 5, c: 5, m: 5, h: 4, p: 4, g: 4, b: 3, y: 3, f: 3, v: 3, k: 3, w: 3, '-': 3, '.': 3, ':': 3, '|': 3, '[': 2, ']': 2, '(': 2, ')': 2, '1': 3, '2': 3, '0': 3, x: 2, z: 2, q: 2, j: 2 })) FREQ[ch.charCodeAt(0)] = f
for (let i = 0x80; i < 0xc0; i++) FREQ[i] = 4 // UTF-8 continuation bytes are shared by many characters
/** Substring search straight in the case-folded UTF-8 bytes: no strings are created for non-matching entries. */
export function searchBytes(c: StrCol, needle: string, limit = 200): number[] {
  const out: number[] = []
  const q = new TextEncoder().encode(needle.toLowerCase()); if (!q.length) return out
  const b = c.bytes, L = q.length, end = b.length - L
  // anchor on the rarest byte of the needle so indexOf (native, vectorised) does most of the work
  let anchor = 0; for (let j = 1; j < L; j++) if (FREQ[q[j]] < FREQ[q[anchor]]) anchor = j
  const ab = q[anchor]
  let from = 0
  while (out.length < limit) {
    const hit = b.indexOf(ab, from + anchor); if (hit < 0) break
    const at = hit - anchor; if (at > end) break
    let ok = true; for (let j = 0; j < L; j++) if (j !== anchor && b[at + j] !== q[j]) { ok = false; break }
    if (!ok) { from = at + 1; continue }
    let lo = 0, hi = c.offsets.length - 2
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c.offsets[mid] <= at) lo = mid; else hi = mid - 1 }
    out.push(lo); from = c.offsets[lo + 1]
  }
  return out
}

/* ---- IndexedDB persistence (one record; structured clone keeps typed arrays as-is) ---- */
const DB = 'iptv-catalog', STORE = 'snap'
function open(): Promise<IDBDatabase> { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }) }
export async function saveSnapshot(key: string, col: Columnar): Promise<void> { const d = await open(); await new Promise<void>((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(col, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error) }); d.close() }
export async function loadSnapshot(key: string): Promise<Columnar | undefined> { try { const d = await open(); const v = await new Promise<Columnar | undefined>((res) => { const r = d.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined) }); d.close(); return v?.v === 2 ? v : undefined } catch { return undefined } }
export async function saveExtras(key: string, x: Extras): Promise<void> { const d = await open(); await new Promise<void>((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(x, key + '|x'); t.oncomplete = () => res(); t.onerror = () => rej(t.error) }); d.close() }
export async function loadExtras(key: string): Promise<Extras | undefined> { try { const d = await open(); const v = await new Promise<Extras | undefined>((res) => { const r = d.transaction(STORE).objectStore(STORE).get(key + '|x'); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined) }); d.close(); return v?.v === 2 ? v : undefined } catch { return undefined } }
export async function clearSnapshots(): Promise<void> { try { const d = await open(); await new Promise<void>((res) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).clear(); t.oncomplete = () => res(); t.onerror = () => res() }); d.close() } catch { /* ignore */ } }
