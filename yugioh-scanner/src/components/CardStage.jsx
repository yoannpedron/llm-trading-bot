import { useEffect, useMemo, useRef, useState } from 'react';

import { rarityProfile } from '../lib/rarity.js';

/**
 * Révélation de la carte en haute définition.
 *
 * Trois couches se superposent à l'image :
 *
 *  - un **voile holographique** (dégradé conique en fusion « color-dodge »)
 *    dont l'opacité vient du profil de rareté : l'OCR ne voit pas les reflets,
 *    c'est donc la rareté renvoyée par l'API qui décide de l'intensité ;
 *  - un **éclat** qui suit le pointeur, pour que la carte réagisse à la main ;
 *  - un **balayage** qui traverse la carte à l'arrivée, une seule fois.
 *
 * L'inclinaison suit la souris sur ordinateur et l'accéléromètre sur téléphone,
 * la première ayant la priorité dès qu'on touche la carte.
 */
export default function CardStage({ card, rarity, via, animations = true, holo = true }) {
  const profile = rarityProfile(rarity);
  const frameRef = useRef(null);
  const pointerRef = useRef(false);

  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [glare, setGlare] = useState({ x: 50, y: 50 });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const preview = card.images?.[0]?.small ?? null;

  // Les étincelles sont tirées une fois par carte : recalculer à chaque rendu
  // les ferait sauter d'un endroit à l'autre pendant l'animation.
  const sparks = useMemo(
    () =>
      profile.sparkle && animations
        ? Array.from({ length: 16 }, (_, index) => {
            const angle = (index / 16) * Math.PI * 2 + Math.random();
            const distance = 120 + Math.random() * 190;
            return {
              id: index,
              x: `${Math.cos(angle) * distance}px`,
              y: `${Math.sin(angle) * distance}px`,
              delay: `${Math.random() * 0.35}s`,
              size: 3 + Math.random() * 4,
            };
          })
        : [],
    [profile.sparkle, animations, card.id],
  );

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [card.id]);

  useEffect(() => {
    // iOS exige un geste explicite pour l'accéléromètre : on ne le réclame pas,
    // on écoute simplement quand la plateforme le propose spontanément.
    const onOrientation = (event) => {
      if (pointerRef.current) return;
      const gamma = Math.max(-30, Math.min(30, event.gamma ?? 0));
      const beta = Math.max(-30, Math.min(30, (event.beta ?? 0) - 45));
      setTilt({ x: -beta / 2.4, y: gamma / 2.4 });
      setGlare({ x: 50 + gamma * 1.4, y: 50 + beta * 1.4 });
    };

    window.addEventListener('deviceorientation', onOrientation);
    return () => window.removeEventListener('deviceorientation', onOrientation);
  }, []);

  const handleMove = (event) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    pointerRef.current = true;
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    setGlare({ x, y });
    setTilt({ x: (y - 50) / -3.2, y: (x - 50) / 3.2 });
  };

  const handleLeave = () => {
    pointerRef.current = false;
    setTilt({ x: 0, y: 0 });
    setGlare({ x: 50, y: 50 });
  };

  return (
    <div className="relative flex flex-col items-center">
      {/* Aura de rareté, derrière la carte. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 h-[86%] w-[86%] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[70px]"
        style={{
          background: `radial-gradient(circle, ${profile.glow} 0%, transparent 70%)`,
          animation: animations ? 'halo-breathe 4.5s ease-in-out infinite' : undefined,
        }}
      />

      {sparks.map((spark) => (
        <span
          key={spark.id}
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 rounded-full"
          style={{
            '--spark-x': spark.x,
            '--spark-y': spark.y,
            width: spark.size,
            height: spark.size,
            background: profile.accent,
            boxShadow: `0 0 12px ${profile.accent}`,
            animation: `spark-out 1.15s ease-out ${spark.delay} both`,
          }}
        />
      ))}

      <div
        ref={frameRef}
        onPointerMove={handleMove}
        onPointerLeave={handleLeave}
        className="relative w-full max-w-[380px] touch-none select-none"
        style={{ perspective: '1400px' }}
      >
        <div
          className="relative transition-transform duration-200 ease-out will-change-transform"
          style={{
            transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
            transformStyle: 'preserve-3d',
            animation: animations
              ? 'card-arrive 0.85s cubic-bezier(0.16, 1, 0.3, 1) both'
              : undefined,
          }}
        >
          <div
            className="relative overflow-hidden rounded-[4.5%]"
            style={{
              boxShadow: `0 34px 80px -20px ${profile.glow}88, 0 0 0 1px ${profile.accent}44`,
            }}
          >
            {/* Aperçu flou pendant le chargement du visuel pleine résolution :
                la carte apparaît tout de suite, puis se précise. */}
            {preview && !loaded && (
              <img
                src={preview}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full scale-105 object-cover blur-lg"
              />
            )}

            <img
              src={card.image}
              alt={card.name}
              width="421"
              height="614"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={`block w-full transition-opacity duration-500 ${
                loaded ? 'opacity-100' : 'opacity-0'
              }`}
            />

            {/* Visuel injoignable : sans ce repli, le voile holographique
                s'appliquerait à un cadre vide et donnerait un aplat coloré. */}
            {failed && (
              <div className="grid aspect-[421/614] w-full place-items-center bg-abyss-soft px-6 text-center">
                <div>
                  <p className="text-sm font-medium">{card.name}</p>
                  <p className="mt-1 text-xs text-muted">Visuel indisponible hors ligne</p>
                </div>
              </div>
            )}

            {holo && !failed && (
              <div
                aria-hidden
                className="foil pointer-events-none absolute inset-0"
                style={{ opacity: profile.foil, animationDuration: `${profile.sweep}s` }}
              />
            )}

            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 transition-opacity"
              style={{
                background: `radial-gradient(circle at ${glare.x}% ${glare.y}%, rgba(255,255,255,.42), transparent 46%)`,
                mixBlendMode: 'overlay',
              }}
            />

            {animations && (
              <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                <div
                  className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/60 to-transparent"
                  style={{ animation: 'shine-sweep 1.5s cubic-bezier(0.22,1,0.36,1) 0.35s both' }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <span
          className="rounded-full px-3 py-1 font-mono text-[11px] tracking-[0.14em] uppercase"
          style={{
            color: profile.accent,
            background: `${profile.glow}1f`,
            border: `1px solid ${profile.glow}55`,
          }}
        >
          {rarity ?? 'Rareté inconnue'}
        </span>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-[11px] text-muted">
          {profile.label}
        </span>
        {via && (
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-[11px] text-muted">
            {via === 'set' ? 'trouvée par le code' : 'trouvée par le titre'}
          </span>
        )}
      </div>
    </div>
  );
}
