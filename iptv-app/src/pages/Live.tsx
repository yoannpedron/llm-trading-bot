import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCatalog } from '../store/catalog'
import { countryOf, themeOf, THEME_LABEL, type Theme } from '../parser/live'
import VirtualGrid from '../components/VirtualGrid'
import { useProfile } from '../store/profile'

/** Live TV by country (flags) and theme, built from the provider's category prefixes. */
export default function Live() {
  const catalog = useCatalog((s) => s.catalog)!
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const region = useProfile((s) => s.region)
  const cc = params.get('cc') ?? ''
  const theme = (params.get('theme') ?? '') as Theme | ''

  const cats = useMemo(() => catalog.categories.filter((c) => c.kind === 'live').map((c) => ({ c, country: countryOf(c.rawName), theme: themeOf(c.rawName), n: catalog.byCategory['live:' + c.id]?.length ?? 0 })), [catalog])
  const countries = useMemo(() => {
    const m = new Map<string, { code: string; name: string; flag: string; n: number }>()
    for (const x of cats) { const k = x.country?.code ?? '??'; const cur = m.get(k) ?? { code: k, name: x.country?.name ?? 'Autres', flag: x.country?.flag ?? '🌐', n: 0 }; cur.n += x.n; m.set(k, cur) }
    const arr = [...m.values()].sort((a, b) => b.n - a.n)
    const mine = arr.findIndex((c) => c.code === region || (region === 'GB' && c.code === 'UK'))
    if (mine > 0) arr.unshift(...arr.splice(mine, 1))
    return arr
  }, [cats, region])
  const themes = useMemo(() => {
    const m = new Map<Theme, number>()
    for (const x of cats) if (!cc || (x.country?.code ?? '??') === cc) m.set(x.theme, (m.get(x.theme) ?? 0) + x.n)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [cats, cc])
  const items = useMemo(() => {
    const sel = cats.filter((x) => (!cc || (x.country?.code ?? '??') === cc) && (!theme || x.theme === theme))
    const needle = q.trim().toLowerCase()
    const out = sel.flatMap((x) => (catalog.byCategory['live:' + x.c.id] ?? []).map((i) => catalog.items[i]))
    return needle ? out.filter((i) => i.title.toLowerCase().includes(needle)) : out
  }, [cats, cc, theme, q, catalog])

  return (
    <div className="flex h-screen flex-col pt-20">
      <div className="flex items-baseline gap-3 px-6 md:px-12">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">Live TV</h1>
        <span className="text-sm text-white/40 tabular-nums">{items.length.toLocaleString('fr-FR')} chaînes</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chaîne…" className="ml-auto w-48 rounded-full bg-white/10 px-4 py-1.5 text-sm outline-none focus:bg-white/20" />
      </div>
      <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-6 md:px-12">
        <button onClick={() => setParams({ theme })} className={`h-9 shrink-0 rounded-full px-3.5 text-sm ${!cc ? 'bg-white font-semibold text-black' : 'bg-white/10 hover:bg-white/20'}`}>🌐 Tous les pays</button>
        {countries.map((c) => (
          <button key={c.code} onClick={() => setParams({ cc: c.code, theme })} className={`h-9 shrink-0 rounded-full px-3.5 text-sm ${cc === c.code ? 'bg-white font-semibold text-black' : 'bg-white/10 hover:bg-white/20'}`}>{c.flag} {c.name} <span className="opacity-50 tabular-nums">{c.n}</span></button>
        ))}
      </div>
      <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-6 pb-2 md:px-12">
        <button onClick={() => setParams(cc ? { cc } : {})} className={`h-8 shrink-0 rounded-full px-3 text-xs ${!theme ? 'bg-white/25 font-semibold' : 'bg-white/5 hover:bg-white/15'}`}>Tout</button>
        {themes.map(([t, n]) => (
          <button key={t} onClick={() => setParams({ ...(cc ? { cc } : {}), theme: t })} className={`h-8 shrink-0 rounded-full px-3 text-xs ${theme === t ? 'bg-white/25 font-semibold' : 'bg-white/5 hover:bg-white/15'}`}>{THEME_LABEL[t]} <span className="opacity-50 tabular-nums">{n}</span></button>
        ))}
      </div>
      <div className="min-h-0 flex-1"><VirtualGrid items={items} landscape minWidth={200} /></div>
    </div>
  )
}
