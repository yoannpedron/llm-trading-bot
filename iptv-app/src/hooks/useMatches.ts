import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchMatches, type Match, norm } from '../api/sports'
import { linkStreams, type Linked } from '../parser/match'
import { countryOf, parseEvent, type LiveEvent } from '../parser/live'
import { useCatalog } from '../store/catalog'
import { useProfile, PREFIX_INFO } from '../store/profile'
import type { MediaItem } from '../types'

export interface StreamSource { item: MediaItem; country?: string; flag: string; lang?: string; quality?: string; rank: number }
export interface MatchCard extends Linked { sources: StreamSource[] }

/** Scoreboards refreshed every 30 s while something is live, every 5 min otherwise. */
export function useMatches() {
  const catalog = useCatalog((s) => s.catalog)
  const { contentLangs, region } = useProfile()
  const q = useQuery({ queryKey: ['matches'], queryFn: fetchMatches, staleTime: 25_000, refetchInterval: (query) => (query.state.data?.some((m) => m.state === 'in') ? 30_000 : 300_000) })

  const events = useMemo(() => {
    const now = new Date()
    const catName = new Map((catalog?.categories ?? []).filter((c) => c.kind === 'live').map((c) => [c.id, c.rawName]))
    const out: { item: MediaItem; event: LiveEvent; country?: string }[] = []
    if (!catalog) return out
    const cats = catalog.column('categoryIds')
    for (const i of catalog.indicesOf('live')) {
      const raw = catalog.rawNameOf(i)
      if (!/^\s*(next|live|end|ended)\s*\|/i.test(raw)) continue
      const e = parseEvent(raw, now)
      if (!e || !e.start || e.status === 'ended') continue
      const it = catalog.at(i); if (!it) continue
      out.push({ item: it, event: e, country: countryOf(catName.get(cats[i]) ?? '')?.code ?? e.country })
    }
    return out
  }, [catalog])

  const result = useMemo(() => {
    const matches = q.data ?? []
    const { linked, unmatched } = linkStreams(events, matches)
    const countryOfItem = new Map(events.map((e) => [e.item.id, e.country]))
    const prefIso = new Set(contentLangs.map((l) => PREFIX_INFO[l]?.iso))
    const rank = (it: MediaItem): number => {
      const cc = countryOfItem.get(it.id)
      let r = 0
      if (cc === region || (region === 'GB' && cc === 'UK')) r += 40
      const iso = cc ? countryIso(cc) : undefined
      if (iso && prefIso.has(iso)) r += 30
      if (/8K|4K|UHD/.test(it.rawName)) r += 8; else if (/FHD|1080/.test(it.rawName)) r += 5
      return r
    }
    const cards: MatchCard[] = [...linked.values()].map((l) => ({ ...l, sources: l.streams.map((item) => ({ item, country: countryOfItem.get(item.id), flag: flagOf(countryOfItem.get(item.id)), lang: item.lang, quality: item.quality, rank: rank(item) })).sort((a, b) => b.rank - a.rank) }))
    const linkedIds = new Set(cards.flatMap((c) => c.streams.map((s) => s.id)))
    return { cards, matches, unmatched: unmatched.filter((u) => !linkedIds.has(u.item.id)) }
  }, [q.data, events, contentLangs, region])

  return { ...q, ...result, events }
}

const CC_ISO: Record<string, string> = { FR: 'fr', BE: 'fr', BEE: 'fr', CA: 'fr', CH: 'fr', UK: 'en', US: 'en', AU: 'en', NZ: 'en', IE: 'en', AR: 'ar', SA: 'ar', DE: 'de', AT: 'de', ES: 'es', LAT: 'es', MXC: 'es', IT: 'it', PL: 'pl', NL: 'nl', PT: 'pt', BR: 'pt', TR: 'tr', SE: 'sv', SWE: 'sv', NO: 'no', DK: 'da', FI: 'fi', GR: 'el', RU: 'ru', IN: 'hi', ASIA: 'hi' }
export const countryIso = (cc: string) => CC_ISO[cc]
export function flagOf(cc?: string) { return cc ? (countryOf(cc + '|')?.flag ?? '🌐') : '🌐' }
export const teamKey = (name: string) => norm(name)
export type { Match }
