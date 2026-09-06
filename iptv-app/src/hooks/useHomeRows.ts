import { useQuery } from '@tanstack/react-query'
import { hasTmdbKey } from '../api/tmdb'
import { genreItems, homeRows } from '../api/tmdbLists'
import { useCatalog } from '../store/catalog'
import type { Kind } from '../types'
import { useProfile } from '../store/profile'
import { useHistory } from '../store/history'
import { useSettings } from '../store/settings'

export function useHomeRows() {
  const idx = useCatalog((s) => s.tmdbIndex)
  const gen = useCatalog((s) => s.catalog?.generatedAt)
  const { uiLang, contentLangs, region } = useProfile()
  const history = useHistory((s) => s.items)
  const item = useCatalog((s) => s.item)
  const showUnknown = useSettings((s) => s.showUnknownLang)
  const lastWatched = history.slice(0, 5).map((h) => item(h.id)).filter((x): x is NonNullable<typeof x> => !!x)
  const seriesIds = history.map((h) => item(h.id)).filter((x) => x?.kind === 'series' && x.tmdbId).map((x) => x!.tmdbId!)
  const day = new Date().toISOString().slice(0, 10)
  return useQuery({ queryKey: ['home-rows', gen, uiLang, contentLangs.join(), region, day, lastWatched.map((i) => i.id).join(), showUnknown], queryFn: () => homeRows(idx, { lastWatched, seriesIds }), enabled: !!gen && hasTmdbKey(), staleTime: 30 * 60 * 1000 })
}

export function useGenre(kind: Kind, genreId?: number) {
  const idx = useCatalog((s) => s.tmdbIndex)
  const gen = useCatalog((s) => s.catalog?.generatedAt)
  return useQuery({ queryKey: ['genre', kind, genreId, gen], queryFn: () => genreItems(kind, genreId!, idx), enabled: !!gen && !!genreId && hasTmdbKey(), staleTime: 30 * 60 * 1000 })
}
