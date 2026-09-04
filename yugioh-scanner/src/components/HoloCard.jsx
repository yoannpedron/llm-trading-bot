import { useCallback, useEffect, useRef, useState } from 'react';

import { rarityTier } from '../lib/rarity.js';
import '../styles/holo.css';

/**
 * Zone supérieure : le visuel officiel, et rien d'autre.
 *
 * Aucun texte HTML par-dessus la carte — les inscriptions sont déjà dans
 * l'image, les redoubler ferait double emploi et salirait le rendu. Les seules
 * couches ajoutées sont des effets de lumière, dont l'intensité dépend de la
 * rareté choisie : l'OCR ne voit pas l'holographie, c'est la donnée qui décide.
 *
 * L'inclinaison suit le pointeur sur ordinateur et le doigt sur mobile ; à
 * défaut, l'accéléromètre prend le relais quand la plateforme le propose.
 */
export default function HoloCard({ image, imageSmall, name, rarity }) {
  const frameRef = useRef(null);
  const pointerRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Nouvelle carte : on repart de zéro, sinon l'ancienne image resterait
  // affichée « chargée » pendant que la nouvelle arrive.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [image]);

  const tier = rarityTier(rarity);
  const showFoil = tier !== 'common' && tier !== 'rare';
  const isSecret = tier === 'secret';

  const setVars = useCallback((x, y) => {
    const element = frameRef.current;
    if (!element) return;
    element.style.setProperty('--ygo-pointer-x', `${x}%`);
    element.style.setProperty('--ygo-pointer-y', `${y}%`);
    // L'inclinaison reste faible : au-delà, l'image se déforme plus qu'elle ne
    // brille, et sur un écran de téléphone cela donne le mal de mer.
    element.style.setProperty('--ygo-rotate-x', `${(y - 50) / -5}deg`);
    element.style.setProperty('--ygo-rotate-y', `${(x - 50) / 5}deg`);
    element.style.setProperty('--ygo-angle', `${210 + (x - 50) * 1.6}`);
  }, []);

  const handleMove = useCallback(
    (event) => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect) return;
      pointerRef.current = true;
      setVars(
        ((event.clientX - rect.left) / rect.width) * 100,
        ((event.clientY - rect.top) / rect.height) * 100,
      );
    },
    [setVars],
  );

  const handleLeave = useCallback(() => {
    pointerRef.current = false;
    setVars(50, 50);
  }, [setVars]);

  useEffect(() => {
    // iOS réclame un geste explicite pour l'accéléromètre : on ne le demande
    // pas, on écoute seulement quand la plateforme l'offre d'elle-même.
    const onOrientation = (event) => {
      if (pointerRef.current) return;
      const gamma = Math.max(-30, Math.min(30, event.gamma ?? 0));
      const beta = Math.max(-30, Math.min(30, (event.beta ?? 0) - 45));
      setVars(50 + gamma * 1.6, 50 + beta * 1.6);
    };
    window.addEventListener('deviceorientation', onOrientation);
    return () => window.removeEventListener('deviceorientation', onOrientation);
  }, [setVars]);

  return (
    <div
      ref={frameRef}
      // `revealed` déclenche l'arrivée et le balayage : au chargement de
      // l'image, pas au montage. Sinon l'animation joue sur un rectangle noir
      // et la carte apparaît ensuite sans cérémonie — c'est ce qu'on voyait.
      className={`ygo-card${loaded ? ' ygo-card--revealed' : ''}`}
      data-rarity={tier}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
    >
      <div className="ygo-card__inner">
        {/* Vignette basse définition (~15 Ko) : quelque chose à regarder
            pendant que le visuel complet (~150 Ko) arrive en 4G. */}
        {imageSmall && !loaded && !failed && (
          <img
            className="ygo-card__placeholder"
            src={imageSmall}
            alt=""
            aria-hidden="true"
            decoding="async"
          />
        )}

        {failed && (
          <div className="ygo-card__fallback">
            <span>{name}</span>
            <small>visuel indisponible</small>
          </div>
        )}

        <img
          className="ygo-card__front"
          src={image}
          alt={name}
          width="421"
          height="614"
          decoding="async"
          fetchPriority="high"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{ opacity: loaded ? 1 : 0, transition: 'opacity 320ms ease' }}
        />

        {showFoil && !isSecret && (
          <>
            <span data-layer className="ygo-card__foil ygo-card__foil--art" />
            <span data-layer className="ygo-card__foil ygo-card__foil--stars" />
          </>
        )}

        {isSecret && (
          <>
            <span data-layer className="ygo-card__foil ygo-card__foil--full" />
            <span data-layer className="ygo-card__diagonals" />
            <span data-layer className="ygo-card__sparkles" />
          </>
        )}

        <span data-layer className="ygo-card__glare" />
        <span data-layer className="ygo-card__sweep" />
      </div>
    </div>
  );
}
