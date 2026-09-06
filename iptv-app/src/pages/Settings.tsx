import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { PREFIX_INFO, REGIONS, UI_LANGS, useProfile, type UiLang } from '../store/profile'
import { useSettings } from '../store/settings'
import { DETECTED } from '../store/device'
import { useSession } from '../store/session'
import { useCatalog } from '../store/catalog'
import { useHomeRows } from '../hooks/useHomeRows'
import { XtreamClient, type XtreamUserInfo } from '../api/xtream'
import { countryOf } from '../parser/live'
import { probeProvider } from '../download/profile'

type Tab = 'accounts' | 'languages' | 'categories' | 'data'
const TABS: [Tab, string][] = [['accounts', 'Comptes'], ['languages', 'Langues'], ['categories', 'Catégories'], ['data', 'Données']]

export default function Settings({ onboarding }: { onboarding?: boolean }) {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || (onboarding ? 'languages' : 'accounts')
  return (
    <div className="mx-auto max-w-4xl px-6 pb-24 pt-24 md:px-12">
      <h1 className="font-display text-4xl font-black tracking-tight">{onboarding ? 'Bienvenue' : 'Paramètres'}</h1>
      {!onboarding && (
        <div className="mt-6 flex gap-2 overflow-x-auto">
          {TABS.map(([k, l]) => <button key={k} onClick={() => setParams({ tab: k })} className={`h-9 shrink-0 rounded-full px-4 text-sm ${tab === k ? 'bg-white font-semibold text-black' : 'bg-white/10 hover:bg-white/20'}`}>{l}</button>)}
        </div>
      )}
      <div className="mt-8">
        {tab === 'accounts' && <Accounts />}
        {tab === 'languages' && <Languages onboarding={onboarding} />}
        {tab === 'categories' && <Categories />}
        {tab === 'data' && <Data />}
      </div>
    </div>
  )
}

const H = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 mt-8 font-display text-lg font-bold first:mt-0">{children}</h2>
const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`w-full rounded bg-white/10 px-3 py-2 text-sm outline-none focus:bg-white/15 ${p.className ?? ''}`} />

/* ---------------- Accounts ---------------- */
function Accounts() {
  const s = useSettings()
  const session = useSession()
  const nav = useNavigate()
  const [form, setForm] = useState({ label: '', url: '', username: '', password: '' })
  const [test, setTest] = useState<Record<string, XtreamUserInfo | 'error' | 'loading'>>({})
  const [key, setKey] = useState(s.tmdbKeyOverride ?? '')
  const catalog = useCatalog((c) => c.catalog)
  const probe = async (id: string, c: { url: string; username: string; password: string }) => {
    setTest((t) => ({ ...t, [id]: 'loading' }))
    try { const r = await new XtreamClient(c).login(); setTest((t) => ({ ...t, [id]: r })) } catch { setTest((t) => ({ ...t, [id]: 'error' })) }
  }
  /** Learn how this provider behaves (redirect, ranges, busy code, connections, HLS). Runs on the device only. */
  const analyse = async (id: string, c: { url: string; username: string; password: string }) => {
    const cl = new XtreamClient(c)
    const sample = catalog ? catalog.at(catalog.indicesOf('movie')[0] ?? -1) : undefined
    if (!sample) { alert('Charge d’abord le catalogue de ce compte.'); return }
    const me = await cl.login().catch(() => undefined)
    const p = await probeProvider({ sampleUrl: cl.movieUrl(sample.streamId, sample.ext), apiUrl: `${c.url}/player_api.php?username=${c.username}&password=${c.password}`, testBusy: +(me?.user_info.active_cons ?? 1) === 0 })
    s.setProfile(id, p)
  }
  useEffect(() => { s.accounts.forEach((a) => probe(a.id, a)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <H>Comptes Xtream</H>
      {s.accounts.length === 0 && <p className="text-sm text-white/50">Aucun compte. L'application tourne en mode démo sur un échantillon.</p>}
      <ul className="flex flex-col gap-2">
        {s.accounts.map((a) => {
          const r = test[a.id]; const info = r && typeof r === 'object' ? r.user_info : undefined
          const active = session.mode === 'live' && session.creds?.username === a.username && session.creds?.url === a.url
          const busy = info ? +(info.active_cons ?? 0) >= +(info.max_connections ?? 1) : false
          return (
            <li key={a.id} className={`rounded-lg p-3 ${active ? 'bg-amber-400/10 ring-1 ring-amber-400/40' : 'bg-white/5'}`}>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1"><b className="block truncate">{a.label || a.url}</b><span className="truncate font-mono text-xs text-white/50">{a.url} · {a.username}</span></div>
                {r === 'loading' && <span className="text-xs text-white/40">Test…</span>}
                {r === 'error' && <span className="text-xs text-red-400">Injoignable</span>}
                {info && (
                  <span className="flex items-center gap-2 text-xs">
                    <span className={`rounded px-2 py-0.5 ${info.status === 'Active' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>{info.status}</span>
                    <span className={`rounded px-2 py-0.5 ${busy ? 'bg-red-500/20 text-red-300' : 'bg-white/10'}`}>{busy ? 'Créneau occupé' : 'Créneau libre'} {info.active_cons}/{info.max_connections}</span>
                    {info.exp_date && <span className="text-white/40">expire {new Date(+info.exp_date * 1000).toLocaleDateString('fr-FR')}</span>}
                  </span>
                )}
                <button onClick={() => probe(a.id, a)} className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">Tester</button>
                <button onClick={() => void analyse(a.id, a)} className="rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">Analyser</button>
                {!active && <button onClick={() => { session.setLive({ url: a.url, username: a.username, password: a.password }); s.setActive(a.id); nav('/') }} className="rounded bg-white px-3 py-1 text-xs font-semibold text-black">Utiliser</button>}
                <button onClick={() => s.removeAccount(a.id)} className="text-xs text-white/40 hover:text-red-300">Supprimer</button>
              </div>
              {s.profiles[a.id] && (() => { const p = s.profiles[a.id]; return (
                <p className="mt-2 text-[11px] text-white/50">Profil fournisseur · {p.maxConnections} connexion{p.maxConnections > 1 ? 's' : ''} · {p.redirect ? 'redirection avec jeton' : 'accès direct'} · {p.ranges ? 'reprise par plages' : 'sans plages'} · {p.hlsVod ? 'VOD en HLS' : 'fichiers progressifs'} · occupé = {p.busyHtml ? 'page HTML' : p.busyStatus ?? 'inconnu'}{p.refSpeed ? ` · ${(p.refSpeed / 1e6).toFixed(1)} Mo/s observés` : ''}{p.releaseSeconds ? ` · libération ${p.releaseSeconds} s` : ''} · analysé le {new Date(p.probedAt).toLocaleDateString('fr-FR')}</p>) })()}
            </li>
          )
        })}
      </ul>
      <H>Ajouter un compte</H>
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (!form.url || !form.username) return; const id = s.addAccount({ ...form, url: form.url.replace(/\/+$/, '') }); probe(id, form); setForm({ label: '', url: '', username: '', password: '' }) }}>
        <Input placeholder="Nom (ex. Salon)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <Input placeholder="http://serveur:port" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <Input placeholder="Utilisateur" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <Input placeholder="Mot de passe" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <div className="flex gap-2 sm:col-span-2"><button className="h-10 rounded-lg bg-white px-5 text-sm font-semibold text-black">Ajouter</button><button type="button" onClick={() => { session.setMock(); nav('/') }} className={`h-10 rounded-lg px-5 text-sm ${session.mode === 'mock' ? 'bg-white/25' : 'bg-white/10'}`}>Mode démo</button></div>
      </form>
      <H>Clé TMDB</H>
      <div className="flex gap-2"><Input placeholder="Laisser vide pour utiliser la clé du fichier .env" value={key} onChange={(e) => setKey(e.target.value)} /><button onClick={() => { s.set({ tmdbKeyOverride: key || undefined }); location.reload() }} className="shrink-0 rounded-lg bg-white/10 px-4 text-sm">Enregistrer</button></div>
    </div>
  )
}

/* ---------------- Languages ---------------- */
function Languages({ onboarding }: { onboarding?: boolean }) {
  const nav = useNavigate()
  const p = useProfile()
  const catalog = useCatalog((s) => s.catalog)
  const rebuild = useCatalog((s) => s.rebuildIndex)
  const [uiLang, setUiLang] = useState<UiLang>(p.uiLang)
  const [langs, setLangs] = useState<string[]>(p.contentLangs)
  const [region, setRegion] = useState(p.region)
  const [kids, setKids] = useState(p.kids)
  const available = useMemo(() => {
    const c = new Map<string, number>()
    if (catalog) { const langs = catalog.column('langs'); for (let i = 0; i < catalog.n; i++) { const l = langs[i]; if (l && catalog.kinds[i] !== 2 && PREFIX_INFO[l]) c.set(l, (c.get(l) ?? 0) + 1) } }
    return [...c.entries()].sort((a, b) => b[1] - a[1])
  }, [catalog])
  const toggle = (l: string) => setLangs((ls) => ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l])
  const move = (l: string, d: -1 | 1) => setLangs((ls) => { const i = ls.indexOf(l); const j = i + d; if (j < 0 || j >= ls.length) return ls; const c = [...ls]; [c[i], c[j]] = [c[j], c[i]]; return c })
  const save = () => { const cl = langs.length ? langs : ['EN']; p.set({ uiLang, contentLangs: cl, region, kids, onboarded: true }); rebuild(cl); nav('/') }
  return (
    <div>
      <H>Langue de l'interface et des fiches</H>
      <div className="flex flex-wrap gap-2">{(Object.keys(UI_LANGS) as UiLang[]).map((l) => <button key={l} onClick={() => setUiLang(l)} className={`h-10 rounded-full px-4 text-sm font-medium ${uiLang === l ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20'}`}>{UI_LANGS[l].name}</button>)}</div>
      <H>Langues de contenu, par ordre de préférence</H>
      <p className="mb-3 text-sm text-white/50">La première est la version audio proposée par défaut. Les chiffres sont les titres disponibles sur ce serveur.</p>
      <ol className="mb-3 flex flex-col gap-1.5">
        {langs.map((l, i) => <li key={l} className="flex items-center gap-2 rounded-lg bg-amber-400/10 px-3 py-1.5 text-sm ring-1 ring-amber-400/30"><span className="w-5 text-xs text-white/50">{i + 1}</span><span className="text-lg">{PREFIX_INFO[l]?.flag}</span><span className="flex-1">{PREFIX_INFO[l]?.name ?? l}</span><button onClick={() => move(l, -1)} className="px-2 text-white/60">↑</button><button onClick={() => move(l, 1)} className="px-2 text-white/60">↓</button><button onClick={() => toggle(l)} className="px-2 text-white/60">✕</button></li>)}
      </ol>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {available.filter(([l]) => !langs.includes(l)).map(([l, n]) => <button key={l} onClick={() => toggle(l)} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-left text-sm hover:bg-white/10"><span className="text-lg">{PREFIX_INFO[l].flag}</span><span className="flex-1 truncate">{PREFIX_INFO[l].name}</span><span className="text-xs text-white/40 tabular-nums">{n.toLocaleString('fr-FR')}</span></button>)}
      </div>
      <H>Pays pour les sorties cinéma</H>
      <div className="flex flex-wrap gap-2">{REGIONS.map((r) => <button key={r} onClick={() => setRegion(r)} className={`h-9 rounded-full px-3.5 text-sm ${region === r ? 'bg-white font-semibold text-black' : 'bg-white/10 hover:bg-white/20'}`}>{r}</button>)}</div>
      <H>Mode enfant</H>
      <label className="flex cursor-pointer items-center gap-3 rounded-lg bg-white/5 p-3"><input type="checkbox" checked={kids} onChange={(e) => setKids(e.target.checked)} className="h-5 w-5 accent-amber-400" /><span className="text-sm">Limiter l'accueil aux rangées animation, famille et anime.</span></label>
      <div className="mt-10 flex gap-3"><button onClick={save} className="h-11 rounded-lg bg-white px-6 font-semibold text-black">Enregistrer</button>{!onboarding && <button onClick={() => nav(-1)} className="h-11 rounded-lg bg-white/10 px-6">Annuler</button>}</div>
    </div>
  )
}

/* ---------------- Categories ---------------- */
function Categories() {
  const s = useSettings()
  const catalog = useCatalog((c) => c.catalog)
  const rebuild = useCatalog((c) => c.rebuildIndex)
  const contentLangs = useProfile((p) => p.contentLangs)
  const { data: rows } = useHomeRows()
  const [kind, setKind] = useState<'movie' | 'series' | 'live'>('movie')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string>()
  const langs = useMemo(() => { const c = new Map<string, number>(); if (catalog) { const L = catalog.column('langs'); for (let i = 0; i < catalog.n; i++) { const l = L[i]; if (l && catalog.kinds[i] !== 2 && PREFIX_INFO[l]) c.set(l, (c.get(l) ?? 0) + 1) } } return [...c.entries()].sort((a, b) => b[1] - a[1]) }, [catalog])
  const cats = useMemo(() => (catalog?.categories ?? []).filter((c) => c.kind === kind && (!q || c.rawName.toLowerCase().includes(q.toLowerCase()))).map((c) => ({ c, n: catalog?.byCategory[kind + ':' + c.id]?.length ?? 0, country: countryOf(c.rawName) })), [catalog, kind, q])
  const ordered = useMemo(() => { const pos = (k: string) => { const i = s.rowOrder.indexOf(k); return i < 0 ? 1e6 : i }; return [...(rows ?? [])].sort((a, b) => pos(a.key) - pos(b.key)) }, [rows, s.rowOrder])
  const moveRow = (k: string, d: -1 | 1) => { const keys = ordered.map((r) => r.key); const i = keys.indexOf(k); const j = i + d; if (j < 0 || j >= keys.length) return; [keys[i], keys[j]] = [keys[j], keys[i]]; s.setRowOrder(keys) }
  const apply = () => rebuild(contentLangs)
  return (
    <div>
      <H>Rangées de l'accueil</H>
      <p className="mb-3 text-sm text-white/50">Masquer, épingler en tête, renommer, réordonner. Les rangées personnalisées apparaissent après un premier visionnage.</p>
      <ul className="flex flex-col gap-1.5">
        {ordered.map((r) => {
          const hidden = s.hiddenRows.includes(r.key), pinned = s.pinnedRows.includes(r.key)
          return (
            <li key={r.key} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${hidden ? 'bg-white/[.03] opacity-50' : 'bg-white/5'}`}>
              {editing === r.key ? <Input autoFocus defaultValue={s.renamedRows[r.key] ?? r.name} onBlur={(e) => { s.renameRow(r.key, e.target.value.trim()); setEditing(undefined) }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} className="flex-1" /> : <span className="flex-1 truncate">{pinned && <span className="mr-1 text-amber-400">★</span>}{s.renamedRows[r.key] || r.name}<span className="ml-2 text-xs text-white/40">{r.items.length || r.collections?.length}</span></span>}
              <button onClick={() => moveRow(r.key, -1)} className="px-1.5 text-white/60">↑</button><button onClick={() => moveRow(r.key, 1)} className="px-1.5 text-white/60">↓</button>
              <button onClick={() => setEditing(r.key)} className="rounded bg-white/10 px-2 py-0.5 text-xs">Renommer</button>
              <button onClick={() => s.toggleRow(r.key, 'pinnedRows')} className={`rounded px-2 py-0.5 text-xs ${pinned ? 'bg-amber-400 text-black' : 'bg-white/10'}`}>Épingler</button>
              <button onClick={() => s.toggleRow(r.key, 'hiddenRows')} className={`rounded px-2 py-0.5 text-xs ${hidden ? 'bg-white text-black' : 'bg-white/10'}`}>{hidden ? 'Afficher' : 'Masquer'}</button>
            </li>
          )
        })}
      </ul>
      <H>Masquer par langue</H>
      <p className="mb-3 text-sm text-white/50">Retire d'un geste tout le contenu d'une langue du catalogue, de l'accueil et de la recherche.</p>
      <div className="flex flex-wrap gap-2">{langs.map(([l, n]) => { const off = s.hiddenLangs.includes(l); return <button key={l} onClick={() => { s.toggleLang(l); setTimeout(apply) }} className={`h-9 rounded-full px-3 text-sm ${off ? 'bg-red-500/20 text-red-200 line-through' : 'bg-white/10 hover:bg-white/20'}`}>{PREFIX_INFO[l]?.flag ?? ''} {PREFIX_INFO[l]?.name ?? l} <span className="opacity-50 tabular-nums">{n.toLocaleString('fr-FR')}</span></button> })}</div>
      <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg bg-white/5 p-3"><input type="checkbox" checked={s.hidePpv} onChange={(e) => { s.set({ hidePpv: e.target.checked }); setTimeout(apply) }} className="h-5 w-5 accent-amber-400" /><span className="text-sm">Masquer les flux événementiels PPV dans le live (l'agenda sport reste disponible)</span></label>
      <H>Catégories du serveur</H>
      <div className="mb-3 flex gap-2">{(['movie', 'series', 'live'] as const).map((k) => <button key={k} onClick={() => setKind(k)} className={`h-8 rounded-full px-3 text-xs ${kind === k ? 'bg-white font-semibold text-black' : 'bg-white/10'}`}>{{ movie: 'Films', series: 'Séries', live: 'Live' }[k]}</button>)}<Input placeholder="Filtrer" value={q} onChange={(e) => setQ(e.target.value)} className="!w-48" /></div>
      <ul className="max-h-[50vh] overflow-y-auto rounded-lg bg-white/5">
        {cats.map(({ c, n, country }) => { const off = s.hiddenCategories.includes(kind + ':' + c.id); return (
          <li key={c.id} className={`flex items-center gap-2 border-b border-white/5 px-3 py-1.5 text-sm ${off ? 'opacity-40' : ''}`}>
            <span className="w-6 text-center">{country?.flag ?? (c.lang ? <span className="rounded bg-white/10 px-1 text-[10px]">{c.lang}</span> : '')}</span>
            <span className={`flex-1 truncate ${off ? 'line-through' : ''}`}>{c.name}</span><span className="text-xs text-white/40 tabular-nums">{n}</span>
            <button onClick={() => { s.toggleCategory(kind + ':' + c.id); setTimeout(apply) }} className="rounded bg-white/10 px-2 py-0.5 text-xs">{off ? 'Afficher' : 'Masquer'}</button>
          </li>) })}
      </ul>
    </div>
  )
}

/* ---------------- Data ---------------- */
function Data() {
  const s = useSettings()
  const qc = useQueryClient()
  const { mode, creds, includeAdult } = useSession()
  const load = useCatalog((c) => c.load)
  const catalog = useCatalog((c) => c.catalog)
  const [usage, setUsage] = useState<{ usage?: number; quota?: number }>({})
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => { navigator.storage?.estimate?.().then(setUsage).catch(() => undefined) }, [])
  const mb = (n?: number) => n === undefined ? '?' : (n / 1e6).toFixed(1) + ' Mo'
  const clearTmdb = () => { indexedDB.deleteDatabase('iptv-tmdb'); qc.clear(); location.reload() }
  const download = () => { const blob = new Blob([s.exportJson()], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `lumen-settings-${new Date().toISOString().slice(0, 10)}.json`; a.click() }
  return (
    <div>
      <H>Affichage</H>
      <p className="text-sm text-white/60">Appareil détecté : {DETECTED.why || 'inconnu'} → mode {DETECTED.lite ? 'léger' : 'complet'} conseillé. Le mode léger coupe les bandes-annonces, le flou et les animations, charge des affiches plus petites.</p>
      <div className="mt-3 grid max-w-md grid-cols-3 rounded-lg bg-white/10 p-0.5 text-sm">
        {([['auto', 'Automatique'], ['full', 'Complet'], ['lite', 'Léger']] as const).map(([k, l]) => <button key={k} onClick={() => s.set({ perf: k })} className={`rounded-md py-1.5 ${s.perf === k ? 'bg-white font-semibold text-black' : 'hover:bg-white/10'}`}>{l}</button>)}
      </div>
      <H>Catalogue</H>
      <p className="text-sm text-white/60">{catalog ? `${catalog.n.toLocaleString('fr-FR')} entrées chargées le ${new Date(catalog.generatedAt).toLocaleString('fr-FR')}` : 'Aucun catalogue'}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={() => load(mode, creds, includeAdult, true)} className="h-10 rounded-lg bg-white px-5 text-sm font-semibold text-black">Rafraîchir maintenant</button>
        <label className="flex items-center gap-2 text-sm">Rafraîchissement automatique toutes les<select value={s.autoRefreshHours} onChange={(e) => s.set({ autoRefreshHours: +e.target.value })} className="rounded bg-white/10 px-2 py-1">{[0, 6, 12, 24, 48].map((h) => <option key={h} value={h}>{h === 0 ? 'jamais' : h + ' h'}</option>)}</select></label>
      </div>
      <H>Cache TMDB</H>
      <p className="text-sm text-white/60">Stockage utilisé par l'application : {mb(usage.usage)} sur {mb(usage.quota)} disponibles. Le cache TMDB évite de recharger les fiches déjà vues.</p>
      <button onClick={clearTmdb} className="mt-3 h-10 rounded-lg bg-white/10 px-5 text-sm hover:bg-white/20">Vider le cache TMDB</button>
      <H>Sauvegarde des réglages</H>
      <p className="text-sm text-white/60">Comptes, langues, catégories masquées, ma liste, progression et historique dans un fichier JSON.</p>
      <div className="mt-3 flex gap-3">
        <button onClick={download} className="h-10 rounded-lg bg-white/10 px-5 text-sm hover:bg-white/20">Exporter</button>
        <button onClick={() => file.current?.click()} className="h-10 rounded-lg bg-white/10 px-5 text-sm hover:bg-white/20">Importer</button>
        <input ref={file} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; f.text().then((t) => { try { s.importJson(t) } catch { alert('Fichier invalide') } }) }} />
      </div>
    </div>
  )
}
