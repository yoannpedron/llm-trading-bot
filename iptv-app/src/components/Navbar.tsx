import { NavLink, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useSession } from '../store/session'
import { useCatalog } from '../store/catalog'

const link = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-full text-sm font-medium transition ${isActive ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`

export default function Navbar() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const mode = useSession((s) => s.mode)
  const counts = useCatalog((s) => s.catalog?.counts)
  return (
    <header className="fixed inset-x-0 top-0 z-30 flex items-center gap-4 px-6 py-3 bg-gradient-to-b from-black/80 to-transparent">
      <NavLink to="/" className="text-xl font-black tracking-tight text-white mr-2">
        <span className="text-red-500">▶</span> LUMEN
      </NavLink>
      <nav className="flex items-center gap-1">
        <NavLink to="/" end className={link}>Accueil</NavLink>
        <NavLink to="/movies" className={link}>Films{counts ? ` · ${fmt(counts.movie)}` : ''}</NavLink>
        <NavLink to="/series" className={link}>Séries{counts ? ` · ${fmt(counts.series)}` : ''}</NavLink>
        <NavLink to="/live" className={link}>Live TV{counts ? ` · ${fmt(counts.live)}` : ''}</NavLink>
      </nav>
      <form
        className="ml-auto"
        onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`) }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher…"
          className="w-56 rounded-full bg-white/10 px-4 py-1.5 text-sm text-white placeholder:text-white/40 outline-none focus:bg-white/20 focus:w-72 transition-all"
        />
      </form>
      <NavLink to="/login" className="text-xs text-white/60 hover:text-white">
        {mode === 'mock' ? 'Mode démo' : 'Connecté'} ⚙
      </NavLink>
    </header>
  )
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))
