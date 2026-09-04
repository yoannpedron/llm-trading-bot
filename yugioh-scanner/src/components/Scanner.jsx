import { useState } from 'react';

import OcrReadout from './OcrReadout.jsx';
import ScanOverlay from './ScanOverlay.jsx';

function IconButton({ onClick, active, title, children, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={`grid h-10 w-10 place-items-center rounded-xl border transition disabled:opacity-30 ${
        active
          ? 'border-cyan/60 bg-cyan/20 text-cyan'
          : 'border-white/10 bg-white/5 text-ink hover:border-white/25 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

export default function Scanner({ scanner, locked, compact = false, diagnostics = true, autoScan = true }) {
  const {
    videoRef,
    cameraError,
    cameraReady,
    devices,
    switchCamera,
    torch,
    toggleTorch,
    modelReady,
    modelProgress,
    frameState,
    scanning,
    reading,
    crops,
    capture,
    rescan,
  } = scanner;

  // Le conteneur adopte le ratio du flux : pourcentages à l'écran et
  // pourcentages dans l'image capturée deviennent alors interchangeables, ce
  // dont dépend l'alignement des guides de visée.
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  return (
    <section className="flex flex-col gap-3">
      <div
        className="relative mx-auto w-full overflow-hidden rounded-3xl border border-white/10 bg-black shadow-[0_30px_90px_-30px_rgba(34,211,238,0.45)] transition-[max-width] duration-500"
        style={{
          aspectRatio: dimensions.width ? `${dimensions.width} / ${dimensions.height}` : '4 / 3',
          // Une carte est trouvée : on rétrécit l'aperçu pour que la révélation
          // tienne dans le même écran. On borne la *largeur* et non la hauteur,
          // sinon le ratio se casserait et les guides ne viseraient plus le même
          // endroit que le recadrage envoyé à l'OCR.
          maxWidth:
            compact && dimensions.width
              ? `calc(34vh * ${dimensions.width} / ${dimensions.height})`
              : undefined,
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="h-full w-full object-cover"
          onLoadedMetadata={(event) =>
            setDimensions({
              width: event.currentTarget.videoWidth,
              height: event.currentTarget.videoHeight,
            })
          }
        />

        {cameraReady && (
          <ScanOverlay
            width={dimensions.width}
            height={dimensions.height}
            state={frameState}
            scanning={scanning}
            locked={locked}
          />
        )}

        {!cameraReady && (
          <div className="absolute inset-0 grid place-items-center px-8 text-center">
            {cameraError ? (
              <p className="max-w-sm text-sm text-amber">{cameraError}</p>
            ) : (
              <p className="animate-pulse font-mono text-xs tracking-[0.2em] text-muted uppercase">
                Ouverture de la caméra…
              </p>
            )}
          </div>
        )}

        {/* Chargement du modèle : il se fait pendant que l'utilisateur vise,
            donc on l'annonce sans bloquer l'image. */}
        {!modelReady && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/10">
            <div
              className="h-full bg-cyan transition-[width] duration-300"
              style={{ width: `${Math.round(modelProgress * 100)}%` }}
            />
          </div>
        )}

        <div className="absolute top-3 right-3 flex gap-2">
          {torch.available && (
            <IconButton onClick={toggleTorch} active={torch.on} title="Lampe">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                <path d="M7 2h10l-1 6h3l-9 14 2-9H8z" />
              </svg>
            </IconButton>
          )}
          <IconButton
            onClick={switchCamera}
            disabled={devices.length < 2}
            title="Changer de caméra"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <path d="M9 3h6l1.5 2H20a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.5zm3 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10m0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6" />
            </svg>
          </IconButton>
          <IconButton onClick={rescan} title="Relancer la lecture">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Mode manuel : c'est ce bouton qui déclenche la lecture. */}
      {!autoScan && (
        <button
          type="button"
          onClick={capture}
          disabled={!cameraReady || scanning}
          className="h-12 rounded-2xl border border-cyan/40 bg-cyan/15 text-sm font-medium text-cyan transition hover:bg-cyan/25 disabled:opacity-40"
        >
          {scanning ? 'Lecture…' : 'Lire la carte'}
        </button>
      )}

      {diagnostics && <OcrReadout reading={reading} crops={crops} scanning={scanning} />}
    </section>
  );
}
