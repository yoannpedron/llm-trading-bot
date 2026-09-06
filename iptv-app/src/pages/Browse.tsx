import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Kind } from '../types'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import VirtualGrid from '../components/VirtualGrid'
import Hero from '../components/Hero'

const LABEL: Record<Kind, string> = { movie: 'Films', series: 'Séries', live: 'Live TV' }

/** Category sidebar (virtualised, 800+ entries) + virtual grid for the selected one. */
export default function Browse({ kind }: { kind: Kind }) {
  const catalog = useCatalog((s) => s.catalog)!
  const itemsOf = useCatalog((s) => s.itemsOf)
  const item = useCatalog((s) => s.item)
  const focusedId = useUi((s) => s.focusedId)
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState('')
  const cat = params.get('cat') ?? ''

  const cats = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return catalog.categories.filter((c) => c.kind === kind && (!f || c.rawName.toLowerCase().includes(f)))
  }, [catalog, kind, filter])

  const items = useMemo(() => itemsOf(kind, cat || undefined), [itemsOf, kind, cat])
  const current = catalog.categories.find((c) => c.kind === kind && c.id === cat)
  const focused = focusedId ? item(focusedId) : undefined

  const sideRef = useRef<HTMLDivElement>(null)
  const sv = useVirtualizer({ count: cats.length, getScrollElement: () => sideRef.current, estimateSize: () => 36, overscan: 10 })
  useEffect(() => { const i = cats.findIndex((c) => c.id === cat); if (i >= 0) sv.scrollToIndex(i, { align: 'center' }) }, [cat, cats, sv])

  return (
    <div className="flex h-screen flex-col">
      <Hero item={focused && focused.kind === kind ? focused : undefined} compact />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-white/10 bg-black/40 backdrop-blur">
          <div className="p-3">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filtrer ${cats.length} catégories`} className="w-full rounded bg-white/10 px-3 py-1.5 text-sm outline-none" />
          </div>
          <button onClick={() => setParams({})} className={`px-4 py-2 text-left text-sm ${!cat ? 'bg-white/15' : 'hover:bg-white/5'}`}>
            Tout · {catalog.counts[kind]}
          </button>
          <div ref={sideRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="relative" style={{ height: sv.getTotalSize() }}>
              {sv.getVirtualItems().map((vi) => {
                const c = cats[vi.index]
                const n = catalog.byCategory[kind + ':' + c.id]?.length ?? 0
                return (
                  <button
                    key={c.id}
                    onClick={() => setParams({ cat: c.id })}
                    className={`absolute left-0 flex w-full items-center gap-2 px-4 text-left text-sm ${c.id === cat ? 'bg-white/15' : 'hover:bg-white/5'}`}
                    style={{ top: vi.start, height: 36 }}
                  >
                    {c.lang && <span className="rounded bg-white/10 px-1 text-[10px] text-white/70">{c.lang}</span>}
                    <span className="truncate">{c.name}</span>
                    <span className="ml-auto text-xs text-white/40">{n}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="px-8 pt-3 text-xl font-semibold">
            {LABEL[kind]}{current ? ` › ${current.name}` : ''} <span className="text-sm text-white/40">{items.length}</span>
          </h2>
          <div className="min-h-0 flex-1">
            <VirtualGrid items={items} landscape={kind === 'live'} minWidth={kind === 'live' ? 200 : 150} />
          </div>
        </div>
      </div>
    </div>
  )
}
