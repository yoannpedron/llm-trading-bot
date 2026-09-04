import { useEffect, useRef, useState } from 'react';

const EURO = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const DOLLAR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD' });

/**
 * Compteur animé.
 *
 * Un prix qui monte jusqu'à sa valeur se lit mieux qu'un nombre qui apparaît :
 * l'oeil suit le mouvement et sait quand la valeur est arrêtée. L'animation
 * s'appuie sur `requestAnimationFrame` et se coupe si la valeur change en route.
 */
function useCountUp(value, duration = 650) {
  const [shown, setShown] = useState(value ?? 0);
  const fromRef = useRef(value ?? 0);

  useEffect(() => {
    if (typeof value !== 'number') return undefined;
    const from = fromRef.current;
    const start = performance.now();
    let frame = 0;

    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      // Sortie cubique : rapide au départ, s'installe en douceur.
      const eased = 1 - (1 - progress) ** 3;
      setShown(from + (value - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
      else fromRef.current = value;
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return shown;
}

function Stat({ label, value, format = EURO }) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
      <p className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{format.format(value)}</p>
    </div>
  );
}

export default function PricePanel({ price, loading, error, card, printing }) {
  const headline =
    typeof price?.prices?.trend === 'number'
      ? price.prices.trend
      : (price?.prices?.from ?? null);
  const animated = useCountUp(headline ?? 0);

  const fromCardmarket = price?.source === 'cardmarket';

  return (
    <div className="glass rise rounded-2xl p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] tracking-[0.22em] text-muted uppercase">Cote</p>
          <h3 className="text-lg font-semibold">{card?.name ?? '—'}</h3>
          {printing && (
            <p className="font-mono text-[11px] text-muted">
              {printing.setCode} · {printing.rarity}
            </p>
          )}
        </div>

        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] uppercase ${
            fromCardmarket
              ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
              : 'border-amber/40 bg-amber/10 text-amber'
          }`}
        >
          {fromCardmarket ? 'Cardmarket' : 'YGOPRODeck'}
        </span>
      </div>

      {loading && (
        <div className="flex items-center gap-3 py-6">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-cyan/30 border-t-cyan" />
          <span className="font-mono text-xs text-muted">Relevé de la cote…</span>
        </div>
      )}

      {!loading && error && <p className="py-4 text-sm text-amber">{error}</p>}

      {!loading && !error && price && (
        <>
          <div className="flex items-end gap-2">
            <span
              className="text-5xl font-bold tabular-nums"
              style={{ textShadow: '0 0 40px rgba(34,211,238,.45)' }}
            >
              {EURO.format(animated)}
            </span>
            <span className="pb-2 font-mono text-[11px] text-muted">
              {typeof price.prices.trend === 'number' ? 'tendance' : 'à partir de'}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="À partir de" value={price.prices.from} />
            <Stat label="Moy. 30 j" value={price.prices.avg30} />
            <Stat label="Moy. 7 j" value={price.prices.avg7} />
            <Stat label="Prix du tirage" value={price.prices.setPriceUsd} format={DOLLAR} />
            {typeof price.prices.available === 'number' && (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                <p className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">
                  En vente
                </p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">
                  {price.prices.available}
                </p>
              </div>
            )}
          </div>

          {price.note && <p className="mt-3 text-xs leading-relaxed text-muted">{price.note}</p>}

          <a
            href={price.productUrl ?? price.searchUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm transition hover:border-cyan/50 hover:bg-cyan/10"
          >
            Ouvrir sur Cardmarket
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14zM5 5h4v2H6v11h11v-3h2v5H4V5z" />
            </svg>
          </a>
        </>
      )}
    </div>
  );
}
