import { rarityTier } from '../lib/rarity.js';

const EURO = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

const TIER_COLOR = {
  common: '#94a3b8',
  rare: '#cbd5e1',
  super: '#34d399',
  ultra: '#fbbf24',
  secret: '#c084fc',
};

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
  const options = scan?.rarities ?? [];
  const price = rarity?.priceEur ?? detail?.prices?.cardmarket_eur ?? null;

  return (
    <section className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 rounded-t-3xl border-t border-white/12 bg-white/6 p-4 backdrop-blur-2xl sm:rounded-3xl sm:border">
      {/* En-tête : nom français et cote. */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-[0.22em] text-cyan uppercase">
            {scan?.matchedCode ?? '—'}
            {scan?.regional && <span className="ml-2 text-muted">variante régionale</span>}
          </p>
          <h2 className="truncate text-xl font-bold sm:text-2xl">
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
              color: TIER_COLOR[rarityTier(rarity.rarity)],
              background: `${TIER_COLOR[rarityTier(rarity.rarity)]}1f`,
            }}
          >
            {rarity.rarity}
          </span>
        )}
      </div>

      {/* Texte d'effet, dans sa propre zone de défilement. */}
      <div className="rail min-h-[64px] flex-1 overflow-y-auto rounded-2xl bg-black/35 p-3 text-sm leading-relaxed">
        {loading && <p className="animate-pulse text-muted">Chargement de la fiche…</p>}
        {!loading && error && <p className="text-amber">{error}</p>}
        {!loading && !error && (
          <p className="whitespace-pre-line">{detail?.desc ?? 'Texte indisponible.'}</p>
        )}
      </div>

      {/* Commandes. */}
      {needsChoice ? (
        <div>
          <p className="mb-2 text-sm text-muted">
            Ce code existe en {options.length} raretés. La caméra ne voit pas l’holographie —
            choisissez la vôtre.
          </p>
          <div className="rail flex gap-2 overflow-x-auto pb-1">
            {options.map((option) => {
              const tier = rarityTier(option.rarity);
              return (
                <button
                  key={`${option.setCode}-${option.rarity}-${option.setName}`}
                  type="button"
                  onClick={() => onRarity(option)}
                  className="h-14 shrink-0 rounded-2xl border px-4 text-left transition active:scale-[0.98]"
                  style={{
                    borderColor: `${TIER_COLOR[tier]}66`,
                    background: `${TIER_COLOR[tier]}14`,
                    color: TIER_COLOR[tier],
                  }}
                >
                  <span className="block text-sm font-semibold">{option.rarity}</span>
                  <span className="block max-w-[13rem] truncate font-mono text-[10px] text-muted">
                    {option.setName}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onValidate}
            disabled={saved}
            className="h-14 flex-1 rounded-2xl bg-cyan/25 text-base font-semibold text-cyan ring-1 ring-cyan/50 transition active:scale-[0.99] hover:bg-cyan/35 disabled:opacity-50"
          >
            {saved ? 'Ajoutée à la collection' : 'Valider'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Annuler et relancer le scan"
            className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-white/12 bg-white/5 transition active:scale-95 hover:border-amber/50 hover:text-amber"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" />
            </svg>
          </button>
        </div>
      )}
    </section>
  );
}
