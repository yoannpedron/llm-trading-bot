import { rarityProfile, sortRarities } from '../lib/rarity.js';

/**
 * Choix de la rareté.
 *
 * C'est le seul point où l'OCR ne peut rien : un même code d'extension peut
 * exister en plusieurs raretés (une Secret et une Ultimate dans la même série,
 * ou une réédition anniversaire en Common), et la différence tient à un reflet
 * qu'une caméra ne distingue pas d'un éclairage de pièce. Quand l'API n'en
 * renvoie qu'une, on valide sans rien demander ; sinon, on demande.
 */
export default function RarityPicker({ printings, selected, onSelect }) {
  if (!printings || printings.length <= 1) return null;

  return (
    <div className="glass rise rounded-2xl p-4">
      <p className="mb-1 font-mono text-[10px] tracking-[0.22em] text-muted uppercase">
        Plusieurs raretés pour ce code
      </p>
      <p className="mb-3 text-sm text-muted">
        La caméra ne voit pas l’holographie. Choisissez la version que vous avez en main.
      </p>

      <div className="flex flex-wrap gap-2">
        {sortRarities(printings).map((printing) => {
          const profile = rarityProfile(printing.rarity);
          const active = selected?.rarity === printing.rarity;

          return (
            <button
              key={`${printing.setCode}-${printing.rarity}`}
              type="button"
              onClick={() => onSelect(printing)}
              aria-pressed={active}
              className="rounded-xl px-3.5 py-2 text-left text-sm transition-all duration-200 hover:-translate-y-0.5"
              style={{
                background: active ? `${profile.glow}26` : 'rgba(255,255,255,.04)',
                border: `1px solid ${active ? profile.glow : 'rgba(255,255,255,.1)'}`,
                boxShadow: active ? `0 0 26px ${profile.glow}55` : 'none',
                color: active ? profile.accent : undefined,
              }}
            >
              <span className="block font-medium">{printing.rarity}</span>
              <span className="block font-mono text-[10px] text-muted">
                {printing.rarityCode} · {printing.setName}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
