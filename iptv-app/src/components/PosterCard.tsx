import { memo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MediaItem } from '../types'
import { useUi } from '../store/ui'
import { imgFor, useLite } from '../store/device'

interface Props { item: MediaItem; width: number; landscape?: boolean }

function PosterCardInner({ item, width, landscape }: Props) {
  const nav = useNavigate()
  const setFocused = useUi((s) => s.setFocused)
  const [broken, setBroken] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const lite = useLite()
  const h = landscape ? Math.round(width * 9 / 16) : Math.round(width * 1.5)
  const src = broken ? undefined : imgFor(item.poster, lite)
  return (
    <button
      type="button"
      className={`card-focus group relative shrink-0 overflow-hidden rounded-lg bg-white/[.06] text-left ring-1 ring-inset ring-white/[.06] ${lite ? '' : 'transition-transform duration-200 hover:scale-105 hover:z-10 hover:shadow-[0_14px_34px_rgba(0,0,0,.65)] focus-visible:scale-105'}`}
      style={{ width, height: h }}
      onMouseEnter={() => setFocused(item.id)}
      onFocus={() => setFocused(item.id)}
      onClick={() => nav(item.kind === 'live' ? `/watch/${item.id}` : `/details/${item.id}`)}
      title={item.rawName}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          onLoad={() => setLoaded(true)}
          className={`h-full w-full ${landscape ? 'object-contain p-4' : 'object-cover'} ${loaded || lite ? 'opacity-100' : 'opacity-0'} transition-opacity duration-300`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center p-3 text-center text-xs text-white/60">{item.title}</div>
      )}
      {item.rating ? <span className="absolute right-1.5 top-1.5 rounded bg-black/65 px-1 py-px text-[10px] font-semibold text-amber-400">★ {item.rating.toFixed(1)}</span> : null}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
        <p className="truncate text-xs font-semibold">{item.title}</p>
        <p className="text-[10px] text-white/60">{[item.year, item.lang, item.quality].filter(Boolean).join(' · ')}</p>
      </div>
    </button>
  )
}

export default memo(PosterCardInner)
