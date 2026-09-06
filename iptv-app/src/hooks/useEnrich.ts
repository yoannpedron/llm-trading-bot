import { useQuery } from '@tanstack/react-query'
import { enrich, hasTmdbKey, type Enriched } from '../api/tmdb'
import type { MediaItem } from '../types'
import { useProfile } from '../store/profile'

export const mediaOf = (item: MediaItem) => (item.kind === 'series' ? 'tv' : 'movie') as 'movie' | 'tv'

/** TMDB enrichment for a movie/series, cached forever in memory + IndexedDB. */
export function useEnrich(item?: MediaItem, enabled = true) {
  const lang = useProfile((s) => s.uiLang)
  return useQuery<Enriched | null>({
    queryKey: ['tmdb', lang, item?.kind, item?.tmdbId ?? item?.searchTitle, item?.year],
    queryFn: () => enrich(mediaOf(item!), item!.tmdbId, item!.searchTitle, item!.year),
    enabled: enabled && !!item && item.kind !== 'live' && hasTmdbKey(),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: 1,
  })
}
