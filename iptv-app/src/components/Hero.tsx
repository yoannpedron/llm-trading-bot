import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import type { MediaItem } from '../types'
import { useEnrich } from '../hooks/useEnrich'
import { useUi } from '../store/ui'

interface Props { item?: MediaItem; compact?: boolean }

/**
 * Hero block for the focused item: swaps the global backdrop and shows the
 * TMDB logo (falls back to a text title), synopsis and meta with a fade.
 */
export default function Hero({ item, compact }: Props) {
  const { data } = useEnrich(item)
  const setBackdrop = useUi((s) => s.setBackdrop)

  useEffect(() => {
    if (!item) return
    const bd = data?.backdrop ?? item.backdrop ?? (item.kind === 'live' ? undefined : item.poster)
    if (bd) setBackdrop(bd)
  }, [data?.backdrop, item, setBackdrop])

  if (!item) return <div className={compact ? 'h-48' : 'h-[62vh]'} />

  const title = data?.title ?? item.title
  const meta = [
    data?.year ?? item.year,
    data?.runtime ? `${data.runtime} min` : undefined,
    data?.seasons ? `${data.seasons} saison${data.seasons > 1 ? 's' : ''}` : undefined,
    data?.rating ? `★ ${data.rating.toFixed(1)}` : item.rating ? `★ ${item.rating.toFixed(1)}` : undefined,
    item.lang, item.quality,
  ].filter(Boolean)
  const genres = data?.genres.length ? data.genres : item.genre?.split(/\s*[/,]\s*/) ?? []

  return (
    <div className={`relative flex flex-col justify-end px-8 ${compact ? 'h-72 pt-20' : 'h-[62vh] pt-24 pb-8'}`}>
      <AnimatePresence mode="wait">
        <motion.div
          key={item.id}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.35 }}
          className="max-w-2xl"
        >
          {data?.logo ? (
            <img src={data.logo} alt={title} className="mb-4 max-h-32 max-w-[420px] object-contain drop-shadow-[0_4px_24px_rgba(0,0,0,.8)]" />
          ) : (
            <h1 className="text-shadow mb-3 text-4xl font-black leading-tight md:text-5xl">{title}</h1>
          )}
          {data?.tagline && <p className="mb-2 text-sm italic text-white/60">{data.tagline}</p>}
          <p className="mb-2 text-sm text-white/70">
            {meta.join('  ·  ')}
            {genres.length > 0 && <span className="ml-3 text-white/50">{genres.slice(0, 4).join(', ')}</span>}
          </p>
          {!compact && (
            <p className="text-shadow line-clamp-3 text-sm leading-relaxed text-white/85">{data?.overview ?? item.plot}</p>
          )}
          {!compact && (
            <div className="mt-5 flex gap-3">
              <Link to={`/watch/${item.id}`} className="rounded-full bg-white px-6 py-2 font-semibold text-black hover:bg-white/90">▶ Lecture</Link>
              {item.kind !== 'live' && (
                <Link to={`/details/${item.id}`} className="rounded-full bg-white/15 px-6 py-2 font-semibold backdrop-blur hover:bg-white/25">Plus d'infos</Link>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
