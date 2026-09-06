/**
 * Device tier. Old phones and TV boxes get "lite": no trailers, no Ken Burns / crossfade,
 * no backdrop blur, smaller poster sizes, fewer overscan rows. Auto-detected, overridable in settings.
 */
import { useSettings } from './settings'

interface NavExt { deviceMemory?: number; hardwareConcurrency?: number; connection?: { saveData?: boolean; effectiveType?: string } }
export function detectLite(): { lite: boolean; why: string } {
  const n = navigator as unknown as NavExt
  const mem = n.deviceMemory, cores = n.hardwareConcurrency, c = n.connection
  if (mem !== undefined && mem <= 2) return { lite: true, why: `${mem} Go de RAM` }
  if (cores !== undefined && cores <= 2) return { lite: true, why: `${cores} cœur${cores > 1 ? 's' : ''} CPU` }
  if (c?.saveData) return { lite: true, why: 'économiseur de données actif' }
  if (c?.effectiveType && /2g|slow-2g/.test(c.effectiveType)) return { lite: true, why: `réseau ${c.effectiveType}` }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return { lite: true, why: 'animations réduites demandées par le système' }
  return { lite: false, why: [mem !== undefined ? `${mem} Go` : '', cores ? `${cores} cœurs` : ''].filter(Boolean).join(', ') || 'appareil non identifié' }
}
export const DETECTED = typeof navigator === 'undefined' ? { lite: false, why: '' } : detectLite()

export function isLite(): boolean { const p = useSettings.getState().perf; return p === 'lite' || (p === 'auto' && DETECTED.lite) }
/** reactive version for components */
export function useLite(): boolean { const p = useSettings((s) => s.perf); return p === 'lite' || (p === 'auto' && DETECTED.lite) }

/** TMDB image URLs carry their size: downgrade in lite mode (w342 posters instead of 600x900, w780 backdrops instead of original/w1280) */
export function imgFor(url: string | undefined, lite: boolean, kind: 'poster' | 'backdrop' = 'poster'): string | undefined {
  if (!url || !lite) return url
  if (!/image\.tmdb\.org\/t\/p\/|themoviedb\.org\/t\/p\//.test(url)) return url
  return url.replace(/\/t\/p\/[^/]+\//, kind === 'poster' ? '/t/p/w342/' : '/t/p/w780/')
}
