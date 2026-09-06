import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import type { MediaItem } from '../types'
import { useEnrich } from '../hooks/useEnrich'
import { useUi } from '../store/ui'
import { useMyList } from '../store/mylist'
import { useCatalog } from '../store/catalog'
import Trailer from './Trailer'

interface Props { items: MediaItem[] }
const SLIDE_MS = 14_000

/** Home hero: rotates through featured titles, backdrop crossfade, logo, muted trailer after a beat. */
export default function HeroShow({ items }: Props) {
  const [idx, setIdx] = useState(0)
  const [trailerOn, setTrailerOn] = useState(true)
  const item = items[idx % Math.max(items.length, 1)]
  const { data } = useEnrich(item)
  const setBackdrop = useUi((s) => s.setBackdrop)
  const list = useMyList()
  const extra = useCatalog((s) => s.extra)
  const next = useCallback(() => { setIdx((i) => (i + 1) % items.length); setTrailerOn(true) }, [items.length])

  useEffect(() => {
    if (!item) return
    const bd = data?.backdrop ?? item.backdrop ?? item.poster
    if (bd) setBackdrop(bd)
  }, [data?.backdrop, item, setBackdrop])

  useEffect(() => {
    if (items.length < 2) return
    const t = setTimeout(next, SLIDE_MS + (data?.trailer ? 20_000 : 0))
    return () => clearTimeout(t)
  }, [idx, items.length, next, data?.trailer])

  if (!item) return <div className="h-[70vh]" />
  const title = data?.title ?? item.title
  const meta = [data?.year ?? item.year, data?.runtime ? fmtRuntime(data.runtime) : undefined, data?.seasons ? `${data.seasons} saison${data.seasons > 1 ? 's' : ''}` : undefined].filter(Boolean)
  const rating = data?.rating ?? item.rating
  const genres = data?.genres.slice(0, 3) ?? []
  const inList = list.ids.includes(item.id)

  return (
    <section className="relative h-[min(88vh,820px)] min-h-[520px] overflow-hidden">
      {data?.trailer && trailerOn && <Trailer videoKey={data.trailer} onEnd={() => setTrailerOn(false)} />}
      <div className="absolute inset-0 bg-gradient-to-t from-[#08080a] via-[#08080a]/60 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 px-6 pb-12 md:px-12 md:pb-16">
        <AnimatePresence mode="wait">
          <motion.div key={item.id} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.45 }} className="max-w-2xl">
            {data?.logo ? (
              <img src={data.logo} alt={title} className="mb-4 max-h-36 max-w-[min(70vw,420px)] object-contain object-left-bottom drop-shadow-[0_8px_28px_rgba(0,0,0,.7)]" />
            ) : (
              <h1 className="mb-3 font-display text-5xl font-black leading-[.95] tracking-tight text-shadow md:text-6xl">{title}</h1>
            )}
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/80 tabular-nums">
              {meta.map((m) => <span key={String(m)}>{m}</span>)}
              {rating ? <span className="font-semibold text-amber-400">★ {rating.toFixed(1)}</span> : null}
              {genres.length > 0 && <span className="text-white/50">{genres.join(' · ')}</span>}
              <span className="rounded border border-white/30 px-1.5 text-[11px] font-semibold text-white/80">{item.lang}{item.quality ? ` · ${item.quality}` : ''}</span>
            </div>
            <p className="mb-4 line-clamp-2 max-w-xl text-sm leading-relaxed text-white/85 text-shadow md:line-clamp-3 md:text-[15px]">{data?.overview ?? (item ? extra(item).plot : '')}</p>
            <div className="flex items-center gap-2.5">
              <Link to={`/watch/${item.id}`} className="inline-flex h-11 items-center gap-2 rounded-lg bg-white px-6 font-semibold text-black hover:bg-white/90">▶ Lecture</Link>
              <Link to={`/details/${item.id}`} className="inline-flex h-11 items-center gap-2 rounded-lg bg-white/15 px-5 font-semibold backdrop-blur hover:bg-white/25">ⓘ Infos</Link>
              <button onClick={() => list.toggle(item.id)} aria-label="Ma liste" className={`inline-flex h-11 w-11 items-center justify-center rounded-lg text-xl backdrop-blur ${inList ? 'bg-amber-400 text-black' : 'bg-white/15 hover:bg-white/25'}`}>{inList ? '✓' : '+'}</button>
            </div>
          </motion.div>
        </AnimatePresence>
        {items.length > 1 && (
          <div className="mt-5 flex gap-1.5">
            {items.map((it, k) => (
              <button key={it.id} onClick={() => { setIdx(k); setTrailerOn(true) }} aria-label={it.title} className={`h-[3px] w-6 rounded-full transition ${k === idx ? 'bg-white' : 'bg-white/30 hover:bg-white/60'}`} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

export function fmtRuntime(min: number) { const h = Math.floor(min / 60), m = min % 60; return h ? `${h} h ${m ? m + ' min' : ''}`.trim() : `${m} min` }
