import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Link } from 'react-router-dom'
import type { MediaItem } from '../types'
import type { ItemList } from '../catalog/view'
import PosterCard from './PosterCard'

interface Props { title: string; items: MediaItem[] | ItemList; to?: string; width?: number; landscape?: boolean }

const GAP = 12

/** Horizontal virtualised row: only visible cards are mounted, whatever the row length. */
export default function Carousel({ title, items, to, width = 150, landscape }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({
    horizontal: true,
    count: items.length,
    getScrollElement: () => ref.current,
    estimateSize: () => width + GAP,
    overscan: 6,
  })
  const h = landscape ? Math.round(width * 9 / 16) : Math.round(width * 1.5)
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * (ref.current.clientWidth - width), behavior: 'smooth' })
  if (!items.length) return null
  return (
    <section className="group/row relative py-2">
      <div className="mb-2 flex items-baseline gap-3 px-8">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-xs text-white/40">{items.length}</span>
        {to && <Link to={to} className="text-xs text-white/50 hover:text-white">Tout voir →</Link>}
      </div>
      <button onClick={() => scroll(-1)} className="absolute left-0 top-10 z-20 h-[calc(100%-3rem)] w-8 bg-gradient-to-r from-black/70 opacity-0 transition group-hover/row:opacity-100">‹</button>
      <button onClick={() => scroll(1)} className="absolute right-0 top-10 z-20 h-[calc(100%-3rem)] w-8 bg-gradient-to-l from-black/70 opacity-0 transition group-hover/row:opacity-100">›</button>
      <div ref={ref} className="no-scrollbar overflow-x-auto px-8 py-2">
        <div className="relative" style={{ width: v.getTotalSize(), height: h }}>
          {v.getVirtualItems().map((vi) => (
            <div key={vi.key} className="absolute top-0" style={{ left: vi.start, width }}>
              {(() => { const it = items.at(vi.index); return it ? <PosterCard item={it} width={width} landscape={landscape} /> : null })()}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
