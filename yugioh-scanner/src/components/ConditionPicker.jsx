import { CONDITIONS } from '../lib/condition.js';

/**
 * Choix de l'état de conservation.
 *
 * À la différence de la rareté, l'état ne se déduit d'aucune donnée : ni
 * YGOPRODeck ni la fiche Cardmarket ne le connaissent pour *votre* exemplaire.
 * L'échelle proposée est celle de Cardmarket, et le choix sert à deux choses :
 * filtrer les offres réelles côté Cardmarket, et pondérer la cote affichée
 * quand ce filtre n'a pas pu être appliqué.
 */
export default function ConditionPicker({ value, onSelect, estimated }) {
  return (
    <div className="glass rise rounded-2xl p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] tracking-[0.22em] text-muted uppercase">
          État de la carte
        </p>
        {estimated && (
          <span className="rounded-full border border-amber/40 bg-amber/10 px-2 py-0.5 font-mono text-[10px] text-amber">
            cote estimée
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {CONDITIONS.map((condition) => {
          const active = value === condition.code;
          return (
            <button
              key={condition.code}
              type="button"
              onClick={() => onSelect(condition.code)}
              aria-pressed={active}
              title={`${condition.label} — ${condition.hint}`}
              className={`h-11 min-w-[3.25rem] rounded-xl border px-3 text-sm font-medium transition ${
                active
                  ? 'border-cyan bg-cyan/20 text-cyan shadow-[0_0_22px_rgba(34,211,238,.35)]'
                  : 'border-white/10 bg-white/[0.04] text-muted hover:border-white/25 hover:text-ink'
              }`}
            >
              {condition.code}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-muted">
        {CONDITIONS.find((entry) => entry.code === value)?.label ?? '—'} —{' '}
        {CONDITIONS.find((entry) => entry.code === value)?.hint ?? ''}
      </p>
    </div>
  );
}
