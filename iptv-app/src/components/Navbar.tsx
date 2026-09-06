import { useMemo } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useSession } from '../store/session'
import { useCatalog } from '../store/catalog'
import { useSettings } from '../store/settings'
import { useProfile } from '../store/profile'
import { useT } from '../i18n'

const link = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-full text-sm font-medium transition ${isActive ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`

export default function Navbar() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const mode = useSession((s) => s.mode)
  const catalog = useCatalog((s) => s.catalog)
  const indicesOf = useCatalog((s) => s.indicesOf)
  const contentLangs = useProfile((s) => s.contentLangs)
  const showUnknown = useSettings((s) => s.showUnknownLang)
  // the viewer's counts (profile languages), not the provider's
  const counts = useMemo(() => catalog ? { movie: indicesOf('movie').length, series: indicesOf('series').length, live: catalog.counts.live } : undefined, [catalog, indicesOf, contentLangs, showUnknown])
  const refreshing = useCatalog((s) => s.refreshing)
  const source = useCatalog((s) => s.source)
  const t = useT()
  return (
    <header className="fixed inset-x-0 top-0 z-30 flex items-center gap-4 px-6 py-3 bg-gradient-to-b from-black/80 to-transparent">
      <NavLink to="/" className="font-display text-xl font-black tracking-[.14em] text-white mr-2">
        <span className="text-amber-400">▶</span>LUMEN
      </NavLink>
      <nav className="flex items-center gap-1">
        <NavLink to="/" end className={link}>{t('home')}</NavLink>
        <NavLink to="/movies" className={link}>{t('movies')}{counts ? ` · ${fmt(counts.movie)}` : ''}</NavLink>
        <NavLink to="/series" className={link}>{t('series')}{counts ? ` · ${fmt(counts.series)}` : ''}</NavLink>
        <NavLink to="/live" className={link}>{t('live')}{counts ? ` · ${fmt(counts.live)}` : ''}</NavLink>
        <NavLink to="/sport" className={link}>Matchs</NavLink>
        <NavLink to="/list" className={link}>{t('mylist')}</NavLink>
        <NavLink to="/downloads" className={link}>Hors ligne</NavLink>
      </nav>
      <form
        className="ml-auto"
        onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`) }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('search')}
          className="w-56 rounded-full bg-white/10 px-4 py-1.5 text-sm text-white placeholder:text-white/40 outline-none focus:bg-white/20 focus:w-72 transition-all"
        />
      </form>
      {refreshing && <span className="flex items-center gap-1.5 text-[11px] text-white/50" title={source === 'partial' ? 'Films en cours de téléchargement' : 'Mise à jour du catalogue'}><span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />{source === 'partial' ? 'Films…' : 'Mise à jour'}</span>}
      <NavLink to="/settings" className="text-xs text-white/60 hover:text-white">{mode === 'mock' ? 'Démo · ' : ''}Paramètres ⚙</NavLink>
    </header>
  )
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
