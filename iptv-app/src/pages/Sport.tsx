import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCatalog } from '../store/catalog'
import { countryOf, parseEvent, type LiveEvent } from '../parser/live'
import type { MediaItem } from '../types'

/** Sport agenda: dated PPV/event streams parsed from their names, live first, then upcoming with countdown. */
export default function Sport() {
  const catalog = useCatalog((s) => s.catalog)!
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t) }, [])
  const [cc, setCc] = useState('')
  const [q, setQ] = useState('')

  const events = useMemo(() => {
    const catName = new Map(catalog.categories.filter((c) => c.kind === 'live').map((c) => [c.id, c.rawName]))
    const out: (LiveEvent & { item: MediaItem; flag: string; ccode: string })[] = []
    for (const it of catalog.items) {
      if (it.kind !== 'live') continue
      const e = parseEvent(it.rawName, now)
      if (!e || !e.start) continue
      const co = countryOf(catName.get(it.categoryId) ?? '')
      out.push({ ...e, item: it, flag: co?.flag ?? '🌐', ccode: co?.code ?? e.country ?? '??' })
    }
    return out
  }, [catalog, now])

  const countries = useMemo(() => [...new Map(events.map((e) => [e.ccode, e.flag])).entries()].sort(), [events])
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return events.filter((e) => (!cc || e.ccode === cc) && (!n || e.title.toLowerCase().includes(n)))
  }, [events, cc, q])
  const live = filtered.filter((e) => e.status === 'live').sort((a, b) => a.start!.getTime() - b.start!.getTime())
  const next = filtered.filter((e) => e.status === 'next').sort((a, b) => a.start!.getTime() - b.start!.getTime())
  const ended = filtered.filter((e) => e.status === 'ended').sort((a, b) => b.start!.getTime() - a.start!.getTime()).slice(0, 40)

  return (
    <div className="mx-auto max-w-5xl px-6 pb-24 pt-20 md:px-12">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">Agenda sport</h1>
        <span className="text-sm text-white/40 tabular-nums">{events.length.toLocaleString('fr-FR')} événements détectés dans les noms de flux</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Équipe, compétition…" className="ml-auto w-56 rounded-full bg-white/10 px-4 py-1.5 text-sm outline-none focus:bg-white/20" />
      </div>
      <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto">
        <button onClick={() => setCc('')} className={`h-8 shrink-0 rounded-full px-3 text-xs ${!cc ? 'bg-white font-semibold text-black' : 'bg-white/10'}`}>Tous</button>
        {countries.map(([c, f]) => <button key={c} onClick={() => setCc(c)} className={`h-8 shrink-0 rounded-full px-3 text-xs ${cc === c ? 'bg-white font-semibold text-black' : 'bg-white/10'}`}>{f} {c}</button>)}
      </div>
      <Section title="En direct" items={live} now={now} live />
      <Section title="À venir" items={next} now={now} />
      <Section title="Terminés récemment" items={ended} now={now} dim />
    </div>
  )
}

function Section({ title, items, now, live, dim }: { title: string; items: (LiveEvent & { item: MediaItem; flag: string })[]; now: Date; live?: boolean; dim?: boolean }) {
  if (!items.length) return null
  const days = items.map((e) => e.start!.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))
  return (
    <section className={`mt-8 ${dim ? 'opacity-60' : ''}`}>
      <h2 className="mb-3 font-display text-lg font-bold">{live && <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500 align-middle" />}{title} <span className="text-sm font-normal text-white/40">{items.length}</span></h2>
      <ol className="flex flex-col gap-1.5">
        {items.map((e, i) => {
          const day = days[i]
          const head = day !== days[i - 1] ? <li key={'d' + day} className="mt-2 text-[11px] uppercase tracking-[.08em] text-white/40">{day}</li> : null
          return (
            <>{head}
              <li key={e.item.id}>
                <Link to={`/watch/${e.item.id}`} className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2 hover:bg-white/10">
                  <span className="w-12 text-sm tabular-nums text-white/70">{e.start!.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="text-lg">{e.flag}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                  {e.status === 'live' ? <span className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-bold tracking-wide">DIRECT</span> : e.status === 'next' ? <span className="text-xs text-white/50 tabular-nums">{countdown(e.start!, now)}</span> : null}
                  <span className="hidden max-w-[180px] truncate text-[11px] text-white/40 sm:block">{e.provider}</span>
                </Link>
              </li>
            </>
          )
        })}
      </ol>
    </section>
  )
}
function countdown(d: Date, now: Date) { const m = Math.max(0, Math.round((d.getTime() - now.getTime()) / 60000)); return m < 60 ? `dans ${m} min` : m < 1440 ? `dans ${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}` : `dans ${Math.floor(m / 1440)} j` }
