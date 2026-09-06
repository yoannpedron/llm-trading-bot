import { useQuery } from '@tanstack/react-query'
import { useCatalog } from '../store/catalog'
import type { MediaItem } from '../types'
import type { Extra } from '../catalog/columnar'

/** provider plot / cast / director / genre for one item, read on demand by the catalogue worker */
export function useExtra(item?: MediaItem): Extra {
  const extra = useCatalog((s) => s.extra)
  const q = useQuery<Extra>({ queryKey: ['extra', item?.id], queryFn: () => extra(item!), enabled: !!item, staleTime: 10 * 60_000, gcTime: 60_000 })
  return q.data ?? EMPTY
}
const EMPTY: Extra = {}
