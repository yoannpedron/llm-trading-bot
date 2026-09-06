import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MediaItem } from '../types'
import type { ItemList } from '../catalog/view'
import PosterCard from './PosterCard'
import { useLite } from '../store/device'

interface Props { items: MediaItem[] | ItemList; landscape?: boolean; minWidth?: number; /** rendered inside the scroll container, above the grid (dynamic rows) */ header?: ReactNode }
const GAP = 14

/** Row-virtualised grid: scales to 200k+ items with a constant DOM size. */
export default function VirtualGrid({ items, landscape, minWidth = 150, header }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [headH, setHeadH] = useState(0)
  const lite = useLite()
  const [cols, setCols] = useState(6)
  const [cardW, setCardW] = useState(minWidth)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width - 64
      const c = Math.max(2, Math.floor((w + GAP) / (minWidth + GAP)))
      setCols(c)
      setCardW(Math.floor((w - GAP * (c - 1)) / c))
    })
    ro.observe(el)
    const hr = new ResizeObserver(([e]) => setHeadH(e.contentRect.height))
    if (headRef.current) hr.observe(headRef.current)
    return () => { ro.disconnect(); hr.disconnect() }
  }, [minWidth])

  const rowH = (landscape ? Math.round(cardW * 9 / 16) : Math.round(cardW * 1.5)) + GAP
  const rows = Math.ceil(items.length / cols)
  const v = useVirtualizer({ count: rows, getScrollElement: () => ref.current, estimateSize: () => rowH, overscan: lite ? 1 : 3, scrollMargin: headH })
  useEffect(() => v.measure(), [rowH, v])

  return (
    <div ref={ref} className="h-full overflow-y-auto px-8 pb-12 pt-4">
      {header && <div ref={headRef}>{header}</div>}
      {items.length === 0 ? (
        <p className="py-20 text-center text-white/40">Aucun contenu</p>
      ) : (
        <div className="relative" style={{ height: v.getTotalSize() }}>
          {v.getVirtualItems().map((row) => (
            <div key={row.key} className="absolute left-0 flex" style={{ top: row.start - headH, gap: GAP }}>
              {Array.from({ length: cols }, (_, c) => items.at(row.index * cols + c)).filter((x): x is MediaItem => !!x).map((it) => (
                <PosterCard key={it.id} item={it} width={cardW} landscape={landscape} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
