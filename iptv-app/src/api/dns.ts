/**
 * DNS rescue. ISPs often block IPTV providers by poisoning their DNS resolver: the hostname stops
 * resolving while the server itself is perfectly reachable. We resolve the name ourselves over
 * DNS-over-HTTPS (Cloudflare, Google, Quad9, in parallel) and talk to the IP directly.
 * Limits: this defeats DNS blocking only; an IP-level block needs a VPN, and HTTPS providers with
 * virtual hosting may refuse a bare IP (Xtream servers are almost always plain HTTP on a port).
 */
export interface Resolver { name: string; url: (host: string) => string; headers?: Record<string, string> }
export const RESOLVERS: Resolver[] = [
  { name: 'Cloudflare 1.1.1.1', url: (h) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=A`, headers: { accept: 'application/dns-json' } },
  { name: 'Google 8.8.8.8', url: (h) => `https://dns.google/resolve?name=${encodeURIComponent(h)}&type=A` },
  { name: 'Quad9 9.9.9.9', url: (h) => `https://dns.quad9.net:5053/dns-query?name=${encodeURIComponent(h)}&type=A`, headers: { accept: 'application/dns-json' } },
]
interface DnsJson { Status: number; Answer?: { name: string; type: number; data: string; TTL: number }[] }

export const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')

/** one resolver → IPv4 list (empty on NXDOMAIN) */
export async function resolveWith(r: Resolver, host: string, timeoutMs = 4000): Promise<string[]> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(r.url(host), { headers: r.headers, signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as DnsJson
    return (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data)
  } finally { clearTimeout(t) }
}
/** first resolver that answers with at least one address */
export async function resolve(host: string): Promise<string[]> {
  if (isIp(host)) return [host]
  return Promise.any(RESOLVERS.map((r) => resolveWith(r, host).then((ips) => { if (!ips.length) throw new Error('empty'); return ips }))).catch(() => [])
}
/** every resolver, for the diagnostics screen */
export async function resolveAll(host: string): Promise<{ resolver: string; ips: string[]; error?: string; ms: number }[]> {
  return Promise.all(RESOLVERS.map(async (r) => { const t0 = performance.now(); try { const ips = await resolveWith(r, host); return { resolver: r.name, ips, ms: Math.round(performance.now() - t0) } } catch (e) { const msg = e instanceof Error ? (e.name === 'AbortError' || /abort/i.test(e.message) ? 'délai dépassé (4 s), résolveur injoignable' : e.message) : String(e); return { resolver: r.name, ips: [], error: msg, ms: Math.round(performance.now() - t0) } } }))
}

/** `http://host:port/...` → same URL on `ip` */
export function withHost(url: string, ip: string): string {
  try { const u = new URL(url); u.hostname = ip; return u.toString().replace(/\/$/, '') } catch { return url }
}
export function hostOf(url: string): string { try { return new URL(url).hostname } catch { return url.replace(/^https?:\/\//, '').split(/[/:]/)[0] } }

/** does the Xtream API answer on this base? (auth reply, 3 s) */
export async function reachable(base: string, username: string, password: string, viaProxy?: (b: string) => string): Promise<boolean> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000)
  try {
    const b = viaProxy ? viaProxy(base) : base
    const r = await fetch(`${b}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, { signal: ctl.signal })
    if (!r.ok) return false
    const j = (await r.json()) as { user_info?: { auth?: number } }
    return !!j.user_info
  } catch { return false } finally { clearTimeout(t) }
}

/** the "is my DNS lying" test: name fails through the browser but resolves over DoH and the IP answers */
export async function findRescue(url: string, username: string, password: string, viaProxy?: (b: string) => string): Promise<{ ip: string; base: string } | undefined> {
  const host = hostOf(url)
  if (isIp(host)) return undefined
  const ips = await resolve(host)
  for (const ip of ips) { const base = withHost(url, ip); if (await reachable(base, username, password, viaProxy)) return { ip, base } }
  return undefined
}
