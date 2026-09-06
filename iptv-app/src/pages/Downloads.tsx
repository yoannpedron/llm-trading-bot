import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useDownloads, type Dl } from '../download/store'
import { opfsAvailable, usage } from '../download/opfs'
import { useCatalog } from '../store/catalog'

const mb = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' Go' : (n / 1e6).toFixed(0) + ' Mo'
const rate = (n?: number) => !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' Mo/s' : (n / 1e3).toFixed(0) + ' ko/s'

/** Downloads: one at a time (one subscription slot), resumable, playable offline. */
export default function Downloads() {
  const dl = useDownloads()
  const client = useCatalog((s) => s.client)
  const [u, setU] = useState({ usage: 0, quota: 0 })
  useEffect(() => { void usage().then(setU); const t = setInterval(() => void usage().then(setU), 5000); return () => clearInterval(t) }, [])
  const list = Object.values(dl.items).sort((a, b) => b.createdAt - a.createdAt)
  const active = list.find((d) => d.status === 'downloading' || d.status === 'waiting-slot')
  return (
    <div className="mx-auto max-w-2xl px-5 pb-28 pt-20">
      <h1 className="font-display text-4xl font-black tracking-tight">Téléchargements</h1>
      <p className="mt-0.5 text-sm text-white/50">{mb(u.usage)} utilisés · {mb(u.quota - u.usage)} disponibles · {active ? 'créneau utilisé par le téléchargement' : 'créneau libre'}</p>
      {!opfsAvailable() && <p className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-200">Ce navigateur ne permet pas le stockage de gros fichiers. Utilise Chrome, Edge ou l'application Android.</p>}
      {!client && <p className="mt-4 rounded-xl bg-amber-400/10 p-3 text-sm text-amber-200">Mode démo : rien à télécharger. Connecte un compte Xtream.</p>}
      <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">Limite de débit<select value={dl.maxRate} onChange={(e) => dl.set({ maxRate: +e.target.value })} className="rounded bg-white/10 px-2 py-1">{[[0, 'aucune'], [2e6, '2 Mo/s'], [5e6, '5 Mo/s'], [10e6, '10 Mo/s'], [25e6, '25 Mo/s']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={dl.wifiOnly} onChange={(e) => dl.set({ wifiOnly: e.target.checked })} className="accent-amber-400" />Wi-Fi uniquement</label>
      </div>
      <ul className="mt-6 flex flex-col gap-2">
        {list.map((d) => <Item key={d.id} d={d} />)}
        {!list.length && <li className="rounded-xl bg-white/5 p-6 text-center text-sm text-white/50">Aucun téléchargement. Ouvre une fiche et appuie sur « Télécharger ».</li>}
      </ul>
      <p className="mt-8 text-xs text-white/40">Un seul téléchargement à la fois : l'abonnement n'autorise qu'une connexion. Une fois le fichier complet, la lecture se fait depuis l'appareil et le créneau reste libre pour un autre écran.</p>
    </div>
  )
}

function Item({ d }: { d: Dl }) {
  const dl = useDownloads()
  const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 0
  const eta = d.speed && d.total ? Math.round((d.total - d.received) / d.speed) : 0
  const label: Record<Dl['status'], string> = { queued: 'En attente', downloading: rate(d.speed) + (eta ? ` · ${Math.floor(eta / 60)} min restantes` : ''), 'waiting-slot': 'Créneau occupé, reprise automatique', paused: 'En pause', done: 'Disponible hors ligne', error: 'Erreur : ' + (d.error ?? '') }
  return (
    <li className="rounded-xl bg-white/5 p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1"><b className="block truncate">{d.title}</b><span className="text-xs text-white/50">{d.total ? `${mb(d.received)} / ${mb(d.total)}` : ''} {label[d.status]}{d.strategy && d.status !== 'done' ? ` · ${d.strategy}` : ''}</span></div>
        {d.status === 'done' && <Link to={`/watch/${d.id.split('#')[0]}?local=${encodeURIComponent(d.id)}`} className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-black">▶ Lire</Link>}
        {(d.status === 'downloading' || d.status === 'waiting-slot' || d.status === 'queued') && <button onClick={() => dl.pause(d.id)} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">Pause</button>}
        {(d.status === 'paused' || d.status === 'error') && <button onClick={() => dl.resume(d.id)} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">Reprendre</button>}
        <button onClick={() => void dl.cancel(d.id)} className="text-xs text-white/40 hover:text-red-300">Supprimer</button>
      </div>
      {d.status !== 'done' && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className={`h-full ${d.status === 'waiting-slot' ? 'bg-amber-400' : 'bg-white'}`} style={{ width: pct + '%' }} /></div>}
    </li>
  )
}
