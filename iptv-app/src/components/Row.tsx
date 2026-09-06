import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useNavigate } from 'react-router-dom'
import type { MediaItem } from '../types'
import type { ListRow } from '../api/tmdbLists'
import PosterCard from './PosterCard'
import { useUi } from '../store/ui'
import { useEnrich } from '../hooks/useEnrich'

const GAP = 12
export const POSTER_W = 150, WIDE_W = 300, TOP_W = 150 + 70

/** Horizontal virtualised row with three card treatments: poster, wide (backdrop + logo), Top 10 (giant number). */
export default function Row({ row, to }: { row: ListRow; to?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const w = row.type === 'wide' ? WIDE_W : row.type === 'top10' ? TOP_W : POSTER_W
  const h = row.type === 'wide' ? Math.round(WIDE_W * 9 / 16) : Math.round(POSTER_W * 1.5)
  const v = useVirtualizer({ horizontal: true, count: row.items.length, getScrollElement: () => ref.current, estimateSize: () => w + GAP, overscan: 4 })
  const scroll = (d: 1 | -1) => ref.current?.scrollBy({ left: d * (ref.current.clientWidth - w), behavior: 'smooth' })
  if (!row.items.length) return null
  return (
    <section className="group/row relative">
      <div className="mb-2.5 flex items-baseline gap-3 px-6 md:px-12">
        <h2 className="font-display text-lg font-bold tracking-tight">{row.name}</h2>
        <span className="text-[10.5px] uppercase tracking-[.08em] text-white/40">{row.kind === 'live' ? 'Serveur' : 'TMDB'}</span>
        {to && <a href={to} className="ml-auto text-xs text-white/50 hover:text-white">Tout voir →</a>}
      </div>
      <button onClick={() => scroll(-1)} aria-label="Précédent" className="absolute left-0 top-10 z-20 hidden h-[calc(100%-3rem)] w-12 bg-gradient-to-r from-black/80 text-2xl opacity-0 transition group-hover/row:opacity-100 md:block">‹</button>
      <button onClick={() => scroll(1)} aria-label="Suivant" className="absolute right-0 top-10 z-20 hidden h-[calc(100%-3rem)] w-12 bg-gradient-to-l from-black/80 text-2xl opacity-0 transition group-hover/row:opacity-100 md:block">›</button>
      <div ref={ref} className="no-scrollbar overflow-x-auto px-6 py-2 md:px-12">
        <div className="relative" style={{ width: v.getTotalSize(), height: h }}>
          {v.getVirtualItems().map((vi) => {
            const it = row.items[vi.index]
            return (
              <div key={vi.key} className="absolute top-0" style={{ left: vi.start, width: w }}>
                {row.type === 'wide' ? <WideCard item={it} /> : row.type === 'top10' ? <TopCard item={it} n={vi.index + 1} /> : <PosterCard item={it} width={POSTER_W} />}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function TopCard({ item, n }: { item: MediaItem; n: number }) {
  return (
    <div className="flex items-end">
      <span className="relative z-10 -mr-5 w-[70px] select-none text-right font-display text-[120px] font-black leading-[.72] tracking-[-.08em] text-[#08080a] tabular-nums [-webkit-text-stroke:2px_rgba(255,255,255,.55)]">{n}</span>
      <PosterCard item={item} width={POSTER_W} />
    </div>
  )
}

function WideCard({ item }: { item: MediaItem }) {
  const nav = useNavigate()
  const setFocused = useUi((s) => s.setFocused)
  const { data } = useEnrich(item)
  const bd = data?.backdrop ?? item.backdrop ?? item.poster
  const fresh = data?.year && data.year >= new Date().getFullYear()
  return (
    <button type="button" onMouseEnter={() => setFocused(item.id)} onFocus={() => setFocused(item.id)} onClick={() => nav(`/details/${item.id}`)} title={item.rawName}
      className="card-focus group relative block overflow-hidden rounded-[10px] bg-white/5 text-left transition duration-200 hover:z-10 hover:scale-105 hover:shadow-[0_12px_30px_rgba(0,0,0,.6)]" style={{ width: WIDE_W, height: Math.round(WIDE_W * 9 / 16) }}>
      {bd && <img src={bd} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent" />
      {fresh && <span className="absolute left-2 top-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide">NOUVEAU</span>}
      {(data?.rating ?? item.rating) ? <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-amber-400 backdrop-blur">★ {(data?.rating ?? item.rating)!.toFixed(1)}</span> : null}
      {data?.logo ? (
        <img src={data.logo} alt={data.title} className="absolute bottom-3 left-3 max-h-[40%] max-w-[55%] object-contain object-left-bottom drop-shadow-[0_2px_8px_rgba(0,0,0,.8)]" />
      ) : (
        <span className="absolute bottom-3 left-3 right-3 font-display text-base font-bold leading-tight text-shadow">{data?.title ?? item.title}</span>
      )}
    </button>
  )
}
