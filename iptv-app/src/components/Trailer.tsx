import { useEffect, useState } from 'react'

interface Props { videoKey: string; delayMs?: number; onEnd?: () => void }

/**
 * Muted, auto-playing YouTube trailer (Netflix-style hero preview).
 * Mounted after `delayMs` so a quick scroll past the hero never loads the iframe.
 */
export default function Trailer({ videoKey, delayMs = 2500, onEnd }: Props) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setTimeout(() => setReady(true), delayMs)
    return () => clearTimeout(t)
  }, [videoKey, delayMs])
  useEffect(() => {
    if (!ready || !onEnd) return
    const t = setTimeout(onEnd, 60_000)
    return () => clearTimeout(t)
  }, [ready, onEnd])
  if (!ready) return null
  const src = `https://www.youtube-nocookie.com/embed/${videoKey}?autoplay=1&mute=1&controls=0&loop=0&modestbranding=1&rel=0&playsinline=1&iv_load_policy=3&start=3`
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden animate-[fadein_1.2s_ease_both]">
      {/* oversize the iframe so the 16:9 video covers the hero without letterboxing */}
      <iframe
        src={src}
        title="Bande-annonce"
        allow="autoplay; encrypted-media"
        className="absolute left-1/2 top-1/2 h-[max(100%,56.25vw)] w-[max(100%,177.78vh)] -translate-x-1/2 -translate-y-1/2 scale-[1.35]"
      />
    </div>
  )
}
