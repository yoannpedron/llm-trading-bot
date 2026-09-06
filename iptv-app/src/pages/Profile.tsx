import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PREFIX_INFO, REGIONS, UI_LANGS, useProfile, type UiLang } from '../store/profile'
import { useCatalog } from '../store/catalog'

/** Language / region profile. Drives TMDB locale, version preference, hubs and the "now playing" region. */
export default function Profile({ onboarding }: { onboarding?: boolean }) {
  const nav = useNavigate()
  const p = useProfile()
  const catalog = useCatalog((s) => s.catalog)
  const rebuild = useCatalog((s) => s.rebuildIndex)
  const [uiLang, setUiLang] = useState<UiLang>(p.uiLang)
  const [langs, setLangs] = useState<string[]>(p.contentLangs)
  const [region, setRegion] = useState(p.region)
  const [kids, setKids] = useState(p.kids)

  /** Provider prefixes actually present, with counts, so the choice reflects this server. */
  const available = useMemo(() => {
    const c = new Map<string, number>()
    for (const it of catalog?.items ?? []) if (it.lang && it.kind !== 'live' && PREFIX_INFO[it.lang]) c.set(it.lang, (c.get(it.lang) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => b[1] - a[1])
  }, [catalog])

  const toggle = (l: string) => setLangs((ls) => ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l])
  const save = () => { p.set({ uiLang, contentLangs: langs.length ? langs : ['EN'], region, kids, onboarded: true }); rebuild(langs.length ? langs : ['EN']); nav('/') }

  return (
    <div className="mx-auto max-w-3xl px-6 pb-24 pt-24 md:px-12">
      <h1 className="font-display text-4xl font-black tracking-tight">{onboarding ? 'Bienvenue' : 'Profil'}</h1>
      <p className="mt-2 text-white/60">Choisis tes langues : l'accueil, les fiches et les versions proposées s'adaptent. Modifiable à tout moment.</p>

      <h2 className="mb-3 mt-10 font-display text-lg font-bold">Langue de l'interface et des fiches</h2>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(UI_LANGS) as UiLang[]).map((l) => (
          <button key={l} onClick={() => setUiLang(l)} className={`h-10 rounded-full px-4 text-sm font-medium ${uiLang === l ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20'}`}>{UI_LANGS[l].name}</button>
        ))}
      </div>

      <h2 className="mb-1 mt-10 font-display text-lg font-bold">Langues de contenu, par ordre de préférence</h2>
      <p className="mb-3 text-sm text-white/50">La première est la version audio proposée par défaut. Les chiffres sont les titres disponibles sur ce serveur.</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {langs.map((l, i) => <span key={l} className="inline-flex h-8 items-center gap-2 rounded-full bg-amber-400 px-3 text-sm font-semibold text-black"><span className="text-xs opacity-60">{i + 1}</span>{PREFIX_INFO[l]?.flag} {PREFIX_INFO[l]?.name ?? l}<button onClick={() => toggle(l)} aria-label="Retirer" className="ml-1 opacity-70">✕</button></span>)}
        {!langs.length && <span className="text-sm text-white/40">Aucune sélection</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {available.filter(([l]) => !langs.includes(l)).map(([l, n]) => (
          <button key={l} onClick={() => toggle(l)} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-left text-sm hover:bg-white/10">
            <span className="text-lg">{PREFIX_INFO[l].flag}</span><span className="flex-1 truncate">{PREFIX_INFO[l].name}</span><span className="text-xs text-white/40 tabular-nums">{n.toLocaleString('fr-FR')}</span>
          </button>
        ))}
      </div>

      <h2 className="mb-3 mt-10 font-display text-lg font-bold">Pays pour les sorties cinéma</h2>
      <div className="flex flex-wrap gap-2">
        {REGIONS.map((r) => <button key={r} onClick={() => setRegion(r)} className={`h-9 rounded-full px-3.5 text-sm ${region === r ? 'bg-white text-black font-semibold' : 'bg-white/10 hover:bg-white/20'}`}>{r}</button>)}
      </div>

      <h2 className="mb-3 mt-10 font-display text-lg font-bold">Mode enfant</h2>
      <label className="flex cursor-pointer items-center gap-3 rounded-lg bg-white/5 p-3"><input type="checkbox" checked={kids} onChange={(e) => setKids(e.target.checked)} className="h-5 w-5 accent-amber-400" /><span className="text-sm">Limiter l'accueil aux rangées animation, famille et anime. Le contenu adulte n'est jamais affiché, quel que soit le mode.</span></label>

      <div className="mt-12 flex gap-3">
        <button onClick={save} className="h-11 rounded-lg bg-white px-6 font-semibold text-black">Enregistrer</button>
        {!onboarding && <button onClick={() => nav(-1)} className="h-11 rounded-lg bg-white/10 px-6">Annuler</button>}
      </div>
    </div>
  )
}
