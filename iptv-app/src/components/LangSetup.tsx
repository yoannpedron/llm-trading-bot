import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PREFIX_INFO, UI_LANGS, useProfile, type UiLang } from '../store/profile'
import { COUNTRIES, countryOf } from '../store/countries'
import { useCatalog } from '../store/catalog'

/**
 * Country → interface language + content languages, with the counts this provider really has.
 * Used at first launch (Welcome) and in Settings › Langues.
 */
export default function LangSetup({ onboarding }: { onboarding?: boolean }) {
  const nav = useNavigate()
  const p = useProfile()
  const catalog = useCatalog((s) => s.catalog)
  const rebuild = useCatalog((s) => s.rebuildIndex)
  const [country, setCountry] = useState<string | undefined>(p.country)
  const [uiLang, setUiLang] = useState<UiLang>(p.uiLang)
  const [langs, setLangs] = useState<string[]>(p.country ? p.contentLangs : [])
  const [kids, setKids] = useState(p.kids)
  const [moreUi, setMoreUi] = useState(false)

  /** titles per language on this server (films + series) */
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    if (catalog) { const L = catalog.column('langs'); for (let i = 0; i < catalog.n; i++) { const l = L[i]; if (l && catalog.kinds[i] !== 2 && PREFIX_INFO[l]) c.set(l, (c.get(l) ?? 0) + 1) } }
    return c
  }, [catalog])
  const available = useMemo(() => [...counts.entries()].sort((a, b) => b[1] - a[1]), [counts])

  const pick = (code: string) => {
    const c = countryOf(code)!
    setCountry(code); setUiLang(c.ui)
    // the country's languages first (only those the server has), then nothing else: the user adds more explicitly
    const mine = c.langs.filter((l) => counts.get(l))
    setLangs(mine.length ? mine : c.langs.slice(0, 1))
  }
  const toggle = (l: string) => setLangs((ls) => ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l])
  const move = (l: string, d: -1 | 1) => setLangs((ls) => { const i = ls.indexOf(l); const j = i + d; if (j < 0 || j >= ls.length) return ls; const c = [...ls]; [c[i], c[j]] = [c[j], c[i]]; return c })
  const total = langs.reduce((a, l) => a + (counts.get(l) ?? 0), 0)
  const save = () => {
    const cl = langs.length ? langs : ['EN']
    p.set({ uiLang, contentLangs: cl, region: country ?? p.region, country, kids, onboarded: true })
    rebuild(cl); nav('/')
  }

  return (
    <div>
      <H>{onboarding ? 'Ton pays' : 'Pays'}</H>
      <p className="mb-3 text-sm text-white/50">Il règle la langue de l'application, les langues du contenu et les sorties cinéma. Tout est modifiable ensuite.</p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
        {COUNTRIES.map((c) => (
          <button key={c.code} onClick={() => pick(c.code)} className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm ${country === c.code ? 'bg-white font-semibold text-black' : 'bg-white/5 hover:bg-white/10'}`}>
            <span className="text-xl leading-none">{c.flag}</span><span className="truncate">{c.name}</span>
          </button>
        ))}
      </div>

      {country && (
        <>
          <H>Langues du contenu</H>
          <p className="mb-3 text-sm text-white/50">Films et séries affichés dans ces langues, la première en version audio par défaut. Les chiffres sont les titres réellement présents sur ce serveur.</p>
          <ol className="mb-3 flex flex-col gap-1.5">
            {langs.map((l, i) => (
              <li key={l} className="flex items-center gap-2 rounded-lg bg-amber-400/10 px-3 py-1.5 text-sm ring-1 ring-amber-400/30">
                <span className="w-5 text-xs text-white/50">{i + 1}</span><span className="text-lg">{PREFIX_INFO[l]?.flag}</span><span className="flex-1">{PREFIX_INFO[l]?.name ?? l}</span>
                <span className="text-xs text-white/50 tabular-nums">{(counts.get(l) ?? 0).toLocaleString('fr-FR')}</span>
                <button onClick={() => move(l, -1)} className="px-1 text-white/60">↑</button><button onClick={() => move(l, 1)} className="px-1 text-white/60">↓</button>
                <button onClick={() => toggle(l)} className="rounded bg-white/10 px-2 py-0.5 text-xs">Retirer</button>
              </li>
            ))}
          </ol>
          <p className="mb-2 text-xs uppercase tracking-wide text-white/40">Ajouter une langue</p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
            {available.filter(([l]) => !langs.includes(l)).map(([l, n]) => (
              <button key={l} onClick={() => toggle(l)} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-1.5 text-left text-sm hover:bg-white/10">
                <span className="text-lg">{PREFIX_INFO[l].flag}</span><span className="flex-1 truncate">{PREFIX_INFO[l].name}</span><span className="text-xs text-white/40 tabular-nums">{n.toLocaleString('fr-FR')}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm text-white/60">Ton catalogue : <b className="text-white">{total.toLocaleString('fr-FR')}</b> films et séries.</p>

          <H>Langue de l'application</H>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(UI_LANGS) as UiLang[]).filter((l) => moreUi || l === uiLang || l === 'en').map((l) => <button key={l} onClick={() => setUiLang(l)} className={`h-9 rounded-full px-4 text-sm font-medium ${uiLang === l ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20'}`}>{UI_LANGS[l].name}</button>)}
            {!moreUi && <button onClick={() => setMoreUi(true)} className="h-9 rounded-full px-3 text-sm text-white/50 hover:text-white">Autres…</button>}
          </div>

          <H>Mode enfant</H>
          <label className="flex cursor-pointer items-center gap-3 rounded-lg bg-white/5 p-3"><input type="checkbox" checked={kids} onChange={(e) => setKids(e.target.checked)} className="h-5 w-5 accent-amber-400" /><span className="text-sm">Limiter l'accueil à l'animation et au familial, jamais de contenu adulte.</span></label>

          <div className="mt-10 flex gap-3">
            <button onClick={save} className="h-11 rounded-lg bg-white px-6 font-semibold text-black">{onboarding ? 'Commencer' : 'Enregistrer'}</button>
            {!onboarding && <button onClick={() => nav(-1)} className="h-11 rounded-lg bg-white/10 px-6">Annuler</button>}
          </div>
        </>
      )}
    </div>
  )
}
const H = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 mt-8 font-display text-lg font-bold first:mt-0">{children}</h2>
