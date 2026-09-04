import { useEffect, useRef, useState } from 'react';

import { RETICLE_RATIO } from '../lib/viewport.js';

/**
 * Le viseur.
 *
 * Flux plein écran assombri, sauf une fenêtre rectangulaire très allongée au
 * centre : on y place le code d'extension, rien d'autre. L'assombrissement est
 * obtenu par une ombre portée démesurée depuis la fenêtre elle-même — un seul
 * élément, aucun masque à recalculer au redimensionnement.
 *
 * Deux commandes seulement, larges et atteignables au pouce : la torche et le
 * zoom. Ce sont les deux choses qui décident vraiment de la lisibilité d'une
 * inscription de deux millimètres.
 */
export default function SniperView({ sniper }) {
  const {
    videoRef,
    ready,
    error,
    torch,
    toggleTorch,
    zoom,
    applyZoom,
    focusAt,
    modelReady,
    modelProgress,
    reading,
    attempts,
    failure,
    crop,
    sharpness,
    minSharpness,
    frozenFrame,
  } = sniper;

  const containerRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Le viseur est dessiné aux mêmes proportions que celles utilisées pour le
  // recadrage envoyé à l'OCR : les deux lisent `viewport.js`.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const width = Math.min(size.width * 0.82, 420);
  const height = width / RETICLE_RATIO;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-black">
      {/* Toucher l'image y fait la mise au point : sur une carte posée à plat,
          l'appareil vise souvent le fond plutôt que l'inscription. */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="h-full w-full object-cover"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          focusAt(
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height,
          );
        }}
      />

      {frozenFrame && (
        <img
          src={frozenFrame}
          alt="Image figée au moment de la lecture"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {ready && width > 0 && (
        <div className="pointer-events-none absolute inset-0">
          <div
            className="absolute rounded-xl shadow-[0_0_0_9999px_rgb(4_6_15/72%)]"
            style={{
              width,
              height,
              left: (size.width - width) / 2,
              top: (size.height - height) / 2,
              border: '2px solid rgb(34 211 238 / 90%)',
              boxShadow: '0 0 0 9999px rgb(4 6 15 / 72%), 0 0 30px rgb(34 211 238 / 45%)',
            }}
          />

          <p
            className="absolute left-1/2 -translate-x-1/2 text-center font-mono text-[11px] tracking-[0.18em] text-cyan uppercase"
            style={{ top: (size.height - height) / 2 - 28 }}
          >
            Placez le code ici · touchez pour la mise au point
          </p>

          <p
            className="absolute left-1/2 -translate-x-1/2 text-center font-mono text-xs text-white/70"
            style={{ top: (size.height + height) / 2 + 14 }}
          >
            {reading ? `« ${reading} »` : 'en attente de lecture…'}
          </p>

          {/* Netteté : la mise au point est la première cause d'échec sur une
              inscription de deux millimètres. L'indicateur dit à l'utilisateur
              s'il doit bouger, plutôt que de le laisser insister à l'aveugle. */}
          <div
            className="absolute left-1/2 flex w-40 -translate-x-1/2 items-center gap-2"
            style={{ top: (size.height + height) / 2 + 40 }}
          >
            <span className="font-mono text-[9px] tracking-[0.14em] text-white/50 uppercase">
              Net
            </span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
              <span
                className="block h-full rounded-full transition-[width,background-color] duration-200"
                style={{
                  width: `${Math.min(100, (sharpness / (minSharpness * 8)) * 100)}%`,
                  background: sharpness < minSharpness ? '#f59e0b' : '#22d3ee',
                }}
              />
            </span>
          </div>
        </div>
      )}

      {!ready && (
        <div className="absolute inset-0 grid place-items-center px-8 text-center">
          {error ? (
            <p className="max-w-sm text-sm text-amber">{error}</p>
          ) : (
            <p className="animate-pulse font-mono text-xs tracking-[0.2em] text-muted uppercase">
              Ouverture de la caméra…
            </p>
          )}
        </div>
      )}

      {/* Ce que le moteur reçoit vraiment, après binarisation. Un appui
          l'enregistre : c'est la seule façon d'obtenir de vrais recadrages
          pour les bancs de mesure (voir scripts/harness/real-crops.mjs). */}
      {crop && !frozenFrame && (
        <a
          href={crop}
          download={`viseur-${Date.now()}.png`}
          title="Enregistrer ce recadrage"
          className="absolute top-3 left-3 w-40"
        >
          <img
            src={crop}
            alt="Zone lue, après binarisation"
            className="w-full rounded-lg border border-white/20 bg-white"
          />
        </a>
      )}

      {!modelReady && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-white/10">
          <div
            className="h-full bg-cyan transition-[width] duration-300"
            style={{ width: `${Math.round(modelProgress * 100)}%` }}
          />
        </div>
      )}

      {/* Commandes : larges, en bas, sous le pouce. */}
      <div className="safe-bottom absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-5 pb-3">
        {failure && (
          <p className="rounded-xl bg-black/70 px-3 py-2 text-center text-xs text-amber backdrop-blur-md">
            Résolution indisponible : {failure}
          </p>
        )}

        {attempts >= 6 && !failure && !frozenFrame && (
          <p className="rounded-xl bg-black/60 px-3 py-2 text-center text-xs text-amber backdrop-blur-md">
            Rien de lisible. Rapprochez-vous, allumez la torche, et évitez que le vernis renvoie la
            lumière droit dans l’objectif.
          </p>
        )}

        {zoom.available && (
          <div className="flex w-full max-w-sm items-center gap-3 rounded-2xl bg-black/55 px-4 py-2 backdrop-blur-md">
            <span className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">Zoom</span>
            <input
              type="range"
              min={zoom.min}
              max={zoom.max}
              step={zoom.step}
              value={zoom.value}
              onChange={(event) => applyZoom(Number(event.target.value))}
              className="h-8 flex-1 accent-cyan"
              aria-label="Zoom de la caméra"
            />
            <span className="w-10 text-right font-mono text-xs tabular-nums">
              ×{(zoom.value / (zoom.min || 1)).toFixed(1)}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={toggleTorch}
          disabled={!torch.available}
          aria-pressed={torch.on}
          className={`flex h-16 w-full max-w-sm items-center justify-center gap-3 rounded-2xl text-base font-semibold transition active:scale-[0.99] disabled:opacity-35 ${
            torch.on
              ? 'bg-amber text-abyss'
              : 'border border-white/15 bg-black/55 text-white backdrop-blur-md'
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
            <path d="M7 2h10l-1 6h3l-9 14 2-9H8z" />
          </svg>
          {torch.available ? (torch.on ? 'Torche allumée' : 'Allumer la torche') : 'Torche indisponible'}
        </button>
      </div>
    </div>
  );
}
