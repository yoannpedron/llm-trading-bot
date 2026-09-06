import { useQuery } from '@tanstack/react-query'
import { teamBadge } from '../api/teamBadge'
export function useBadge(name?: string) {
  return useQuery({ queryKey: ['badge', name?.toLowerCase()], queryFn: () => teamBadge(name!).then((u) => u ?? null), enabled: !!name && name.length >= 3, staleTime: Infinity, gcTime: 60 * 60 * 1000, retry: 0 }).data ?? undefined
}
