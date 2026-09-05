import { useCallback, useEffect, useRef, useState } from 'react';

import { loadCardIndex } from '../lib/cardIndex.js';
import { suggestSetCodes } from '../lib/match.js';
import { SCORE_SUR } from '../lib/verdictArt.js';
import { toContainerPoint } from '../lib/viewport.js';
import ChoixRegion from './ChoixRegion.jsx';

/** Taille de l'index d'illustrations, pour dire ce qu'on télécharge. */
const INDEX_OCTETS = 8_963_000;

/**
 * Poste de lecture.
 *
 * L'écran est celui d'un instrument : l'image occupe tout, le châssis se limite
 * à deux zones fixes — une ligne d'état en haut, les commandes en bas. Rien ne
 * se déplace d'un état à l'autre, ce qui permet de garder le pouce au même
 * endroit.
 *
 * Il n'y a plus de fenêtre de visée : la carte est identifiée par son
 * illustration, où qu'elle soit dans l'image et dans n'importe quel sens. Ce
 * que la détection a trouvé est dessiné par-dessus l'image — le contour de la
 * carte — pour que l'utilisateur voie ce que l'appareil voit, et comprenne
 * sans consigne pourquoi ça n'aboutit pas (carte coupée, trop loin).
 */

/**
 * Consigne à afficher, d'après ce que la boucle vient de voir.
 *
 * L'ordre des cas est celui de l'urgence : ce qui empêche toute lecture passe
 * avant ce qui la dégrade.
 */
export function consigne({ contour, lecture, modelReady, modelProgress = 0, frozenFrame, manuel, attempts = 0 }) {
  if (manuel) return 'Saisie du code';
  if (frozenFrame) return 'Carte identifiée';
  if (!modelReady) {
    // Neuf mégaoctets, une seule fois : on le dit, avec le compte, sinon
    // l'attente ressemble à une panne.
    const recus = Math.round((modelProgress * INDEX_OCTETS) / 1_000_000);
    const total = Math.round(INDEX_OCTETS / 1_000_000);
    return modelProgress >= 1
      ? 'Préparation de l’index…'
      : `Téléchargement de l’index — ${recus} sur ${total} Mo`;
  }
  if (attempts === 0) return 'Montrez une carte, entière dans l’image';
  if (!contour) return 'Aucune carte vue — montrez-la entière, sur un fond uni';
  if (!lecture?.id) return 'Carte repérée, identification…';
  if (lecture.score >= SCORE_SUR) return 'Carte reconnue';
  return 'Carte reconnue, confirmation sur l’image suivante…';
}

/**
 * Le contour trouvé, dessiné à sa place sur l'image affichée.
 *
 * Les coins sont en pixels de la vidéo native ; l'image est agrandie et
 * rognée par `object-fit: cover`, et `toContainerPoint` fait la traduction.
 * Un contour qui déborde de l'écran est tronqué par le SVG, ce qui est
 * exactement ce qui se passe à l'image.
 */
function Contour({ contour, conteneur, sur }) {
  if (!contour || !conteneur?.width) return null;
  const video = { width: contour.largeur, height: contour.hauteur };
  const points = contour.points
    .map((p) => toContainerPoint(p, video, conteneur))
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${conteneur.width} ${conteneur.height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polygon
        points={points}
        fill="none"
        stroke={sur ? 'var(--color-positif)' : 'var(--color-accent)'}
        strokeWidth={sur ? 3 : 2}
        strokeLinejoin="round"
        opacity={0.9}
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Saisie manuelle                                                      */
/* ------------------------------------------------------------------ */

/**
 * Saisie du code au clavier.
 *
 * Pour les cas où la caméra ne peut rien : pas de caméra, autorisation refusée,
 * code effacé ou abîmé, carte sous étui. La complétion pendant la frappe évite
 * la faute — on ne tape jamais le code en entier — et montre immédiatement
 * qu'un code n'existe pas.
 */
function SaisieManuelle({ onSubmit, onRefus, autoFocus }) {
  const [valeur, setValeur] = useState('');
  const [propositions, setPropositions] = useState([]);
  const [erreur, setErreur] = useState(null);
  const [enCours, setEnCours] = useState(false);
  // 'chargement' | 'prêt' | 'absent'. L'index pèse 1,4 Mo : son arrivée se voit.
  // Et s'il ne vient jamais, il faut le dire — se taire ferait passer une panne
  // de réseau pour un code inexistant, le faux négatif que ce projet refuse.
  const [index, setIndex] = useState('chargement');

  useEffect(() => {
    let vivant = true;
    loadCardIndex()
      .then(() => vivant && setIndex('prêt'))
      .catch(() => vivant && setIndex('absent'));
    return () => {
      vivant = false;
    };
  }, []);

  useEffect(() => {
    let annule = false;
    if (valeur.trim().length < 2) {
      setPropositions([]);
      return undefined;
    }
    loadCardIndex()
      .then((trouve) => !annule && setPropositions(suggestSetCodes(trouve, valeur)))
      .catch(() => !annule && setPropositions([]));
    return () => {
      annule = true;
    };
  }, [valeur]);

  const envoyer = async (code) => {
    const texte = String(code ?? valeur).trim();
    if (!texte || enCours) return;
    setEnCours(true);
    setErreur(null);
    try {
      const resolu = await onSubmit(texte);
      // Un échec de saisie manuelle est un geste délibéré qui n'a rien donné :
      // il mérite une trace au journal, contrairement aux échecs de la caméra,
      // qui se comptent par dizaines à la minute.
      if (resolu.status === 'no_code' || resolu.status === 'no_match') {
        onRefus?.(texte, resolu.status);
      }
      if (resolu.status === 'no_code') {
        setErreur('Ce n’est pas un code d’extension. Exemple : RA03-FR001.');
      } else if (resolu.status === 'no_match') {
        setErreur(
          resolu.reason === 'ambiguous'
            ? 'Ce code hésite entre deux cartes. Complétez-le.'
            : 'Aucune carte ne porte ce code.',
        );
      }
    } catch (cause) {
      setErreur(cause.message);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <form
      className="panneau w-full max-w-md p-3"
      onSubmit={(evenement) => {
        evenement.preventDefault();
        envoyer();
      }}
    >
      <label htmlFor="code-manuel" className="intitule">
        Code d’extension
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="code-manuel"
          type="text"
          value={valeur}
          onChange={(evenement) => {
            setValeur(evenement.target.value.toUpperCase());
            setErreur(null);
          }}
          autoFocus={autoFocus}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder="RA03-FR001"
          aria-describedby="aide-code"
          className="h-12 min-w-0 flex-1 rounded-controle border border-trait bg-champ px-3 font-mono text-courant tracking-[0.1em] text-encre uppercase outline-none transition-colors placeholder:text-tertiaire hover:border-trait-fort focus:border-accent"
        />
        <button
          type="submit"
          disabled={enCours || !valeur.trim()}
          className="h-12 shrink-0 rounded-controle bg-accent px-4 text-donnee font-semibold text-fond transition-colors hover:bg-accent/85 disabled:bg-champ disabled:text-tertiaire"
        >
          Chercher
        </button>
      </div>

      <p id="aide-code" className="mt-1.5 font-mono text-micro text-tertiaire">
        Inscrit en bas de la carte, à droite.
      </p>

      {propositions.length > 0 && (
        <ul className="mt-2 max-h-56 divide-y divide-trait overflow-y-auto rounded-controle border border-trait">
          {propositions.map((proposition) => (
            <li key={proposition.key}>
              <button
                type="button"
                onClick={() => {
                  setValeur(proposition.code);
                  envoyer(proposition.code);
                }}
                className="flex h-11 w-full items-center gap-3 px-3 text-left transition-colors hover:bg-relief"
              >
                <span className="donnee shrink-0 text-accent">{proposition.code}</span>
                <span className="truncate text-donnee text-second">{proposition.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div aria-live="polite">
        {index === 'chargement' && valeur.trim().length >= 2 && (
          <p className="mt-2 animate-pulse font-mono text-micro text-tertiaire">
            Chargement de l’index des cartes…
          </p>
        )}
        {index === 'absent' && (
          <p className="mt-2 font-mono text-micro text-alerte">
            Index injoignable : pas de proposition, la recherche fonctionne toujours.
          </p>
        )}
        {erreur && <p className="mt-2 text-donnee text-alerte">{erreur}</p>}
      </div>
    </form>
  );
}


/* ------------------------------------------------------------------ */
/* Poste de lecture                                                     */
/* ------------------------------------------------------------------ */

export default function SniperView({ sniper, onRefus, region, onRegion }) {
  const {
    attachVideo,
    ready,
    error,
    torch,
    toggleTorch,
    zoom,
    applyZoom,
    focusAt,
    modelReady,
    modelProgress,
    contour,
    lecture,
    attempts,
    failure,
    frozenFrame,
    submitCode,
    manualEntry,
    setManualEntry,
  } = sniper;

  // Dimensions affichées de la vidéo, pour placer le contour. Le <video> est
  // détruit et recréé : on passe par la même référence de rappel que le hook.
  const [conteneur, setConteneur] = useState(null);
  const videoElement = useRef(null);
  const rattacher = useCallback(
    (element) => {
      attachVideo(element);
      videoElement.current = element;
      setConteneur(element ? { width: element.clientWidth, height: element.clientHeight } : null);
    },
    [attachVideo],
  );
  useEffect(() => {
    const element = videoElement.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observateur = new ResizeObserver(() =>
      setConteneur({ width: element.clientWidth, height: element.clientHeight }),
    );
    observateur.observe(element);
    return () => observateur.disconnect();
  }, [ready]);

  // Le réglage de la langue, replié : on le change une fois, pas à chaque
  // carte. Le bouton de la barre dit toujours ce qui est en vigueur.
  const [reglageOuvert, setReglageOuvert] = useState(false);

  // Sans caméra, la saisie est le seul chemin : on l'ouvre sans attendre.
  const saisieVisible = manualEntry || Boolean(error);
  // Huit passes sans conclure : l'utilisateur a besoin d'aide, pas d'attendre.
  const enPeine = attempts >= 8 && !failure && !frozenFrame && !saisieVisible;
  const etat = consigne({
    contour,
    lecture,
    modelReady,
    modelProgress,
    frozenFrame,
    manuel: saisieVisible,
    attempts,
  });

  return (
    <div className="relative h-full w-full overflow-hidden bg-fond">
      <video
        ref={rattacher}
        playsInline
        muted
        autoPlay
        className="h-full w-full object-cover"
        onClick={(evenement) => {
          const cadre = evenement.currentTarget.getBoundingClientRect();
          focusAt(
            (evenement.clientX - cadre.left) / cadre.width,
            (evenement.clientY - cadre.top) / cadre.height,
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

      {/* --- Ligne d'état, en haut ------------------------------------------ */}
      <div className="pointer-events-none absolute inset-x-0 top-0">
        {!modelReady && (
          <div className="h-0.5 w-full bg-trait">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{ width: `${Math.round(modelProgress * 100)}%` }}
            />
          </div>
        )}
        <p
          aria-live="polite"
          data-passes={attempts}
          data-ms={lecture?.ms ?? ''}
          data-score={lecture?.score?.toFixed(2) ?? ''}
          className="border-b border-trait/60 bg-fond/85 px-4 py-2 text-center text-donnee font-medium text-encre"
        >
          {etat}
        </p>
      </div>

      {/* --- Ce que l'appareil voit -------------------------------------------- */}
      {ready && !saisieVisible && !frozenFrame && (
        <Contour
          contour={contour}
          conteneur={conteneur}
          sur={Boolean(lecture?.id) && lecture.score >= SCORE_SUR}
        />
      )}

      {/* Voile sombre pendant la saisie : le formulaire doit dominer l'image. */}
      {saisieVisible && <div className="pointer-events-none absolute inset-0 bg-fond/80" />}

      {!ready && !error && (
        <div className="absolute inset-0 grid place-items-center px-8">
          <p className="intitule animate-pulse">Ouverture de la caméra…</p>
        </div>
      )}

      {/* --- Commandes, en bas ----------------------------------------------- */}
      <div className="safe-bottom absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-4 pb-3">
        {error && (
          <p className="panneau w-full max-w-md border-alerte/40 px-3 py-2 text-donnee text-alerte">
            {error}
          </p>
        )}

        {failure && (
          <p className="panneau w-full max-w-md border-alerte/40 px-3 py-2 text-donnee text-alerte">
            Résolution indisponible : {failure}
          </p>
        )}

        {/*
          Aide au diagnostic, montrée seulement quand la lecture piétine. Elle
          réunit le conseil et ce que le moteur reçoit vraiment : voir la zone
          dit en un coup d'œil si le problème vient du cadrage, de la lumière ou
          de la mise au point. Un appui l'enregistre, ce qui alimente le banc de
          mesure en vrais recadrages (scripts/ocr-bench.mjs).
        */}
        {enPeine && (
          <div className="panneau w-full max-w-md p-3">
            <p className="text-donnee text-second">
              Rien de concluant depuis {attempts} images. La carte doit être entière dans l’image,
              posée sur un fond uni, sans reflet sur l’illustration. Rapprochez-vous : plus elle
              est grande à l’écran, mieux elle est reconnue.
            </p>
            {lecture && (
              <p className="mt-2 text-micro text-tertiaire">
                Dernière passe : score {lecture.score.toFixed(2)}, marge {lecture.marge.toFixed(2)},{' '}
                {lecture.ms} ms
              </p>
            )}
          </div>
        )}

        {saisieVisible && (
          <SaisieManuelle onSubmit={submitCode} onRefus={onRefus} autoFocus={manualEntry} />
        )}

        {/* Langue des cartes : décide des codes montrés et enregistrés. Le
            réglage se fait sans quitter le viseur, parce qu'on s'en aperçoit
            en dépouillant un classeur, pas dans un menu. */}
        {reglageOuvert && onRegion && (
          <div id="reglage-region" className="panneau w-full max-w-md p-3">
            <ChoixRegion region={region} onRegion={onRegion} id="choix-region-viseur" />
          </div>
        )}

        {zoom.available && !saisieVisible && (
          <div className="panneau flex w-full max-w-md items-center gap-3 px-3 py-2">
            <span className="intitule shrink-0">Zoom</span>
            <input
              type="range"
              min={zoom.min}
              max={zoom.max}
              step={zoom.step}
              value={zoom.value}
              onChange={(evenement) => applyZoom(Number(evenement.target.value))}
              className="h-8 flex-1 accent-[var(--color-accent)]"
              aria-label="Zoom de la caméra"
            />
            <span className="donnee w-10 shrink-0 text-right text-second">
              ×{(zoom.value / (zoom.min || 1)).toFixed(1)}
            </span>
          </div>
        )}

        {/* Barre de commandes : chaque élément absent laisse sa place aux
            autres, plutôt qu'un bouton grisé qui n'apprend rien. */}
        <div className="flex w-full max-w-md gap-2">
          {/* La lumière décide de la lisibilité d'une inscription de deux
              millimètres : la commande est proposée dès qu'une piste vidéo
              existe, et ne disparaît que si un essai réel échoue. */}
          {torch.available && !saisieVisible && (
            <button
              type="button"
              onClick={toggleTorch}
              aria-pressed={torch.on}
              title={
                torch.declaree
                  ? undefined
                  : 'Votre navigateur ne déclare pas la torche ; l’essai dira si elle répond.'
              }
              className={`flex h-12 flex-1 items-center justify-center gap-2 rounded-controle border text-donnee font-medium transition-colors ${
                torch.on
                  ? 'border-alerte bg-alerte text-fond'
                  : 'border-trait-fort bg-panneau text-second hover:text-encre'
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M7 2h10l-1 6h3l-9 14 2-9H8z" />
              </svg>
              {torch.on ? 'Torche allumée' : 'Torche'}
            </button>
          )}

          {onRegion && (
            <button
              type="button"
              onClick={() => setReglageOuvert((ouvert) => !ouvert)}
              aria-expanded={reglageOuvert}
              aria-controls="reglage-region"
              title="Langue de vos cartes"
              className={`h-12 flex-1 rounded-controle border text-donnee font-medium transition-colors ${
                reglageOuvert
                  ? 'border-accent bg-panneau text-encre'
                  : 'border-trait-fort bg-panneau text-second hover:text-encre'
              }`}
            >
              Région : <span className="donnee">{region}</span>
            </button>
          )}

          {!error && (
            <button
              type="button"
              onClick={() => setManualEntry((ouvert) => !ouvert)}
              aria-expanded={saisieVisible}
              className="h-12 flex-1 rounded-controle border border-trait-fort bg-panneau text-donnee font-medium text-second transition-colors hover:text-encre"
            >
              {saisieVisible ? 'Revenir au viseur' : 'Saisir le code'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
