import { rarityProfile, sortRarities } from '../lib/rarity.js';

const EURO = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

function PriceBadge({ amount }) {
  return (
    <span className="shrink-0 rounded-xl border border-emerald-400/40 bg-emerald-400/12 px-3 py-1.5 text-right">
      <span className="block font-mono text-[9px] tracking-[0.16em] text-emerald-300/80 uppercase">
        Cardmarket
      </span>
      <span className="block text-lg leading-tight font-bold tabular-nums text-emerald-200">
        {typeof amount === 'number' ? EURO.format(amount) : '—'}
      </span>
    </span>
  );
}

function EffectText({ detail, loading, error }) {
  return (
    <div className="rail max-h-44 min-h-16 shrink-0 overflow-y-auto rounded-2xl bg-black/35 p-3 text-sm leading-relaxed">
      {loading && <p className="animate-pulse text-muted">Chargement de la fiche…</p>}
      {!loading && error && <p className="text-amber">{error}</p>}
      {!loading && !error && (
        <p className="whitespace-pre-line">{detail?.desc ?? 'Texte indisponible.'}</p>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  if (value === null || value === undefined) return null;
  return (
    <span className="rounded-lg bg-white/6 px-2 py-1 font-mono text-[11px] tabular-nums">
      <span className="text-muted">{label}</span> {value}
    </span>
  );
}

/**
 * Zone inférieure : les données, en français.
 *
 * Le texte d'effet peut faire dix lignes comme trois : il défile dans sa propre
 * zone plutôt que de repousser les commandes hors de l'écran. Sur un téléphone,
 * le bouton de validation doit rester atteignable au pouce quelle que soit la
 * carte scannée.
 */
export default function DataPanel({
  scan,
  detail,
  loading,
  error,
  rarity,
  onRarity,
  onValidate,
  onCancel,
  saved,
}) {
  const needsChoice = scan?.status === 'needs_user_selection' && !rarity;
  // Du plus commun au plus rare : l'ordre des chances et des prix.
  const options = sortRarities(scan?.rarities ?? []);
  const price = rarity?.priceEur ?? detail?.prices?.cardmarket_eur ?? null;
  // Une correspondance approchée a corrigé la lecture : c'est le visuel qui
  // confirme, pas le code. On le dit, plutôt que d'afficher la même
  // assurance qu'une lecture exacte.
  const approximate = scan?.method === 'fuzzy';

  const RescanButton = ({ wide = false }) => (
    <button
      type="button"
      onClick={onCancel}
      aria-label="Ce n'est pas ma carte : relancer le scan"
      className={`flex h-14 shrink-0 items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white/5 px-4 text-sm font-medium text-muted transition active:scale-95 hover:border-amber/50 hover:text-amber ${
        wide ? 'w-full' : ''
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
        <path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" />
      </svg>
      Pas ma carte
    </button>
  );

  return (
    <section className="rail flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-t-3xl border-t border-white/12 bg-white/6 p-4 backdrop-blur-2xl sm:rounded-3xl sm:border">
      {/* En-tête : nom français et cote. */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-[0.22em] text-cyan uppercase">
            {scan?.matchedCode ?? '—'}
            {scan?.regional && <span className="ml-2 text-muted">variante régionale</span>}
          </p>
          {approximate && (
            <p className="text-[11px] leading-snug text-amber">
              Lecture approchée (« {scan.read} ») — vérifiez le visuel
            </p>
          )}
          <h2 className="line-clamp-2 text-xl leading-tight font-bold sm:text-2xl">
            {detail?.name ?? scan?.card?.name ?? 'Carte inconnue'}
          </h2>
          <p className="mt-0.5 font-mono text-[11px] text-muted">
            {detail?.subtitle ?? ''}
          </p>
        </div>
        <PriceBadge amount={price} />
      </header>

      {/* Statistiques. */}
      <div className="flex flex-wrap gap-1.5">
        {detail?.attribute && <Stat label="ATTR" value={detail.attribute} />}
        {detail?.level !== undefined && detail?.level !== null && (
          <Stat label="NIV" value={detail.level} />
        )}
        {detail?.linkval && <Stat label="LIEN" value={detail.linkval} />}
        <Stat label="ATK" value={detail?.atk} />
        <Stat label="DEF" value={detail?.def} />
        {rarity && (
          <span
            className="rounded-lg px-2 py-1 font-mono text-[11px]"
            style={{
              color: rarityProfile(rarity.rarity).accent,
              background: `${rarityProfile(rarity.rarity).glow}1f`,
            }}
          >
            {rarity.rarity}
          </span>
        )}
      </div>

      {/* Texte d'effet, dans sa propre zone de défilement. Hauteur bornée :
          il ne doit pas repousser les commandes hors de l'écran — et quand une
          rareté est à choisir, ce choix passe avant le texte. */}
      {!needsChoice && <EffectText detail={detail} loading={loading} error={error} />}

      {/* Commandes. */}
      {needsChoice ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Ce code existe en {options.length} raretés. La caméra ne voit pas l’holographie —
            choisissez la vôtre.
          </p>
          {/* Grille plutôt que rail : sept raretés coupées au bord de l'écran
              ne se devinent pas, et rien n'indiquait qu'il fallait faire
              défiler. */}
          <div className="grid grid-cols-2 gap-2">
            {options.map((option) => {
              const profile = rarityProfile(option.rarity);
              return (
                <button
                  key={`${option.setCode}-${option.rarity}-${option.setName}`}
                  type="button"
                  onClick={() => onRarity(option)}
                  className="min-h-14 rounded-2xl border px-3 py-2 text-left transition active:scale-[0.98]"
                  style={{
                    borderColor: `${profile.glow}66`,
                    background: `${profile.glow}14`,
                    color: profile.accent,
                  }}
                >
                  <span className="block text-sm leading-tight font-semibold">{option.rarity}</span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-muted">
                    {profile.label} · {option.setName}
                  </span>
                </button>
              );
            })}
          </div>
          {/* Sans cette sortie, une mauvaise carte à plusieurs raretés
              obligeait à en choisir une pour pouvoir annuler. */}
          <RescanButton wide />
          <EffectText detail={detail} loading={loading} error={error} />
        </div>
      ) : saved ? (
        <div className="flex flex-col gap-2">
          <p className="text-center text-sm text-emerald-300">Ajoutée à la collection</p>
          {/* Le geste suivant est toujours le même : scanner la carte
              d'après. Il ne doit pas se chercher dans un coin. */}
          <button
            type="button"
            onClick={onCancel}
            className="h-14 w-full rounded-2xl bg-cyan/25 text-base font-semibold text-cyan ring-1 ring-cyan/50 transition active:scale-[0.99] hover:bg-cyan/35"
          >
            Carte suivante
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onValidate}
            className="h-14 flex-1 rounded-2xl bg-cyan/25 text-base font-semibold text-cyan ring-1 ring-cyan/50 transition active:scale-[0.99] hover:bg-cyan/35"
          >
            Valider
          </button>
          <RescanButton />
        </div>
      )}
    </section>
  );
}
