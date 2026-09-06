import { useQuery } from '@tanstack/react-query'
import { hasTmdbKey } from '../api/tmdb'
import { genreItems, homeRows } from '../api/tmdbLists'
import { useCatalog } from '../store/catalog'
import type { Kind } from '../types'
import { useProfile } from '../store/profile'

export function useHomeRows() {
  const idx = useCatalog((s) => s.tmdbIndex)
  const gen = useCatalog((s) => s.catalog?.generatedAt)
  const { uiLang, contentLangs, region } = useProfile()
  return useQuery({ queryKey: ['home-rows', gen, uiLang, contentLangs.join(), region], queryFn: () => homeRows(idx), enabled: !!gen && hasTmdbKey(), staleTime: 30 * 60 * 1000 })
}

export function useGenre(kind: Kind, genreId?: number) {
  const idx = useCatalog((s) => s.tmdbIndex)
  const gen = useCatalog((s) => s.catalog?.generatedAt)
  return useQuery({ queryKey: ['genre', kind, genreId, gen], queryFn: () => genreItems(kind, genreId!, idx), enabled: !!gen && !!genreId && hasTmdbKey(), staleTime: 30 * 60 * 1000 })
}
