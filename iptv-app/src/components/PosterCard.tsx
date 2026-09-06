import { memo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MediaItem } from '../types'
import { useUi } from '../store/ui'

interface Props { item: MediaItem; width: number; landscape?: boolean }

function PosterCardInner({ item, width, landscape }: Props) {
  const nav = useNavigate()
  const setFocused = useUi((s) => s.setFocused)
  const [broken, setBroken] = useState(false)
  const h = landscape ? Math.round(width * 9 / 16) : Math.round(width * 1.5)
  const src = broken ? undefined : item.poster
  return (
    <button
      type="button"
      className="card-focus group relative shrink-0 overflow-hidden rounded-lg bg-white/5 text-left transition-transform duration-200 hover:scale-105 hover:z-10 focus-visible:scale-105"
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
          className={`h-full w-full ${landscape ? 'object-contain p-4' : 'object-cover'}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center p-3 text-center text-xs text-white/60">{item.title}</div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
        <p className="truncate text-xs font-semibold">{item.title}</p>
        <p className="text-[10px] text-white/60">{[item.year, item.lang, item.quality].filter(Boolean).join(' · ')}</p>
      </div>
    </button>
  )
}

export default memo(PosterCardInner)
