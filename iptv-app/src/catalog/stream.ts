/**
 * Incremental parsing of a huge JSON array while it downloads: bytes are decoded as they arrive,
 * top-level objects are located with a tiny state machine, then parsed in batches.
 * Parse CPU overlaps network time instead of adding to it, and peak memory stays bounded.
 */
export async function* streamJsonArray<T>(body: ReadableStream<Uint8Array>, batchSize = 2000): AsyncGenerator<T[]> {
  const reader = body.getReader(); const dec = new TextDecoder()
  let buf = '', depth = 0, inStr = false, esc = false, started = false, objStart = -1, pos = 0
  let batch: string[] = []
  for (;;) {
    const { value, done } = await reader.read()
    buf += dec.decode(value ?? new Uint8Array(), { stream: !done })
    let i = pos
    for (; i < buf.length; i++) {
      const ch = buf[i]
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
      if (ch === '"') { inStr = true; continue }
      if (!started) { if (ch === '[') started = true; continue }
      if (ch === '{') { if (depth === 0) objStart = i; depth++ }
      else if (ch === '}') { depth--; if (depth === 0 && objStart >= 0) { batch.push(buf.slice(objStart, i + 1)); objStart = -1; if (batch.length >= batchSize) { yield JSON.parse('[' + batch.join(',') + ']') as T[]; batch = [] } } }
    }
    // keep only the unfinished object (if any) in the buffer
    if (depth === 0) { buf = ''; pos = 0 }
    else if (objStart >= 0) { buf = buf.slice(objStart); pos = buf.length; objStart = 0 }
    else pos = buf.length
    if (done) break
  }
  if (batch.length) yield JSON.parse('[' + batch.join(',') + ']') as T[]
}

/** Fetch a Xtream list with streaming parse; retries when the server answers with an empty or invalid body (seen: 2-byte replies under load). */
export async function fetchList<T>(url: string, onBatch: (items: T[]) => void, signal?: AbortSignal, tries = 3): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    let count = 0
    try {
      const r = await fetch(url, { signal })
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      for await (const b of streamJsonArray<T>(r.body)) { count += b.length; onBatch(b) }
      if (count === 0 && attempt < tries) { await new Promise((res) => setTimeout(res, 1500 * attempt)); continue }
      return count
    } catch (e) {
      if (signal?.aborted || attempt >= tries) throw e
      await new Promise((res) => setTimeout(res, 1500 * attempt))
    }
  }
}
