import { useEffect, useState } from 'react';

import { loadCardIndex } from '../lib/cardIndex.js';
import { suggestSetCodes } from '../lib/match.js';
import { TOTAL_OCTETS } from '../lib/ocr.js';
import { RETICLE_RATIO } from '../lib/viewport.js';

/**
 * Poste de lecture.
 *
 * L'écran est celui d'un instrument : l'image occupe tout, le châssis se limite
 * à trois zones fixes — une ligne d'état en haut, la fenêtre de visée au
 * centre, les commandes en bas. Rien ne se déplace d'un état à l'autre, ce qui
 * permet de garder le pouce au même endroit pendant qu'on cherche le cadrage.
 *
 * CE QUI A CHANGÉ, ET POURQUOI
 *
 *  - **On ne savait pas quoi faire.** Le viseur affichait le texte brut de
 *    l'OCR — « rien lu (otsu, conf. 0) » — c'est-à-dire un diagnostic de
 *    développeur là où il fallait une consigne. Une ligne d'état dit maintenant
 *    le geste à faire ; la lecture brute reste, en dessous et en petit, parce
 *    qu'elle distingue « rien » de « illisible » et qu'elle est ce qu'on lit
 *    dans une capture d'écran de panne.
 *  - **Le cadre était un néon arrondi.** Il est devenu une fenêtre à angles
 *    marqués, comme une mire d'appareil de mesure : le trait est fin, ce sont
 *    les quatre équerres qui portent le repère.
 *  - **La netteté était une barre continue.** Une jauge continue invite à
 *    chercher le maximum ; ce qui compte est de franchir un seuil. Elle est
 *    donc segmentée, avec le seuil marqué.
 *  - **La torche occupait un bouton de 64 px, grisé quand elle n'existe pas.**
 *    Les commandes forment maintenant une barre de largeur fixe où chaque
 *    élément absent laisse sa place aux autres.
 */

/** Nombre de segments de la jauge de netteté. */
const SEGMENTS = 12;

/**
 * Consigne à afficher, d'après ce que la boucle vient de voir.
 *
 * L'ordre des cas est celui de l'urgence : ce qui empêche toute lecture passe
 * avant ce qui la dégrade.
 */
export function consigne({
  reading,
  sharpness,
  minSharpness,
  modelReady,
  modelProgress = 0,
  frozenFrame,
  manuel,
}) {
  if (manuel) return 'Saisie du code';
  if (frozenFrame) return 'Code identifié';
  if (!modelReady) {
    // Trente et un mégaoctets, une seule fois : on le dit, avec le compte,
    // sinon l'attente ressemble à une panne.
    const recus = Math.round((modelProgress * TOTAL_OCTETS) / 1_000_000);
    const total = Math.round(TOTAL_OCTETS / 1_000_000);
    return modelProgress >= 1
      ? 'Démarrage du moteur de lecture'
      : `Téléchargement du moteur de lecture — ${recus} sur ${total} Mo, une seule fois`;
  }
  if (!reading) return 'Cadrez le code dans la fenêtre';
  if (reading === 'image trop floue' || sharpness < minSharpness) {
    return 'Trop flou — touchez le code pour la mise au point';
  }
  if (reading.startsWith('rien lu')) return 'Illisible — rapprochez-vous ou allumez la torche';
  if (/[A-Z0-9]{2,5}-[A-Z0-9]{2,6}/.test(reading)) return 'Code repéré, vérification';
  return 'Lecture en cours';
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
/* Jauge de netteté                                                     */
/* ------------------------------------------------------------------ */

function Nettete({ valeur, seuil }) {
  // L'échelle s'arrête à huit fois le seuil : au-delà, la mise au point est
  // acquise et la graduation n'apprend plus rien.
  const remplis = Math.round(Math.min(1, valeur / (seuil * 8)) * SEGMENTS);
  const segmentSeuil = Math.round((1 / 8) * SEGMENTS);
  const suffisant = valeur >= seuil;

  return (
    <div
      className="flex items-center gap-2"
      role="meter"
      aria-label="Netteté de l’image"
      aria-valuenow={remplis}
      aria-valuemin={0}
      aria-valuemax={SEGMENTS}
      aria-valuetext={suffisant ? 'suffisante' : 'insuffisante'}
    >
      <span className="intitule">Netteté</span>
      <span className="flex gap-px" aria-hidden>
        {Array.from({ length: SEGMENTS }, (_, rang) => (
          <span
            key={rang}
            className={`h-2.5 w-1 ${
              rang < remplis
                ? suffisant
                  ? 'bg-positif'
                  : 'bg-alerte'
                : rang === segmentSeuil
                  ? 'bg-trait-fort'
                  : 'bg-trait'
            }`}
          />
        ))}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Poste de lecture                                                     */
/* ------------------------------------------------------------------ */

export default function SniperView({ sniper, onRefus }) {
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
    modelProvider,
    reading,
    attempts,
    failure,
    crop,
    sharpness,
    minSharpness,
    frozenFrame,
    submitCode,
    manualEntry,
    setManualEntry,
  } = sniper;

  // Sans caméra, la saisie est le seul chemin : on l'ouvre sans attendre.
  const saisieVisible = manualEntry || Boolean(error);
  // Six passes sans rien lire : l'utilisateur a besoin d'aide, pas d'attendre.
  const enPeine = attempts >= 6 && !failure && !frozenFrame && !saisieVisible;
  const etat = consigne({
    reading,
    sharpness,
    minSharpness,
    modelReady,
    modelProgress,
    frozenFrame,
    manuel: saisieVisible,
  });

  return (
    <div className="relative h-full w-full overflow-hidden bg-fond">
      <video
        ref={attachVideo}
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
          className="border-b border-trait/60 bg-fond/85 px-4 py-2 text-center text-donnee font-medium text-encre"
        >
          {etat}
        </p>
      </div>

      {/* --- Fenêtre de visée ------------------------------------------------ */}
      {ready && !saisieVisible && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          {/*
            La mire est seule dans le flux, et les afficheurs qui la suivent
            sont posés SOUS elle en position absolue. C'est ce qui garantit
            qu'elle tombe exactement au centre du conteneur — donc au même
            endroit que le rectangle calculé par `viewport.reticleRect`, qui
            décide de ce que reçoit l'OCR. Placés dans le flux, ils
            repoussaient la mire vers le haut de la moitié de leur hauteur, et
            l'utilisateur cadrait à côté de ce qui était réellement lu.
          */}
          <div
            className="relative w-[82%] max-w-[420px] border border-accent/70"
            style={{ aspectRatio: `${RETICLE_RATIO} / 1` }}
          >
            {/* Équerres d'angle : le repère d'une mire, pas un cadre lumineux. */}
            {[
              'left-0 top-0 border-l-2 border-t-2',
              'right-0 top-0 border-r-2 border-t-2',
              'left-0 bottom-0 border-l-2 border-b-2',
              'right-0 bottom-0 border-r-2 border-b-2',
            ].map((position) => (
              <span key={position} className={`absolute h-3 w-3 border-accent ${position}`} />
            ))}

            <div className="absolute inset-x-0 top-full mt-3 flex flex-col items-center gap-2">
              <p className="max-w-full truncate px-4 font-mono text-micro text-encre/70">
                {reading ? `« ${reading} »` : 'en attente de lecture'}
              </p>
              <Nettete valeur={sharpness} seuil={minSharpness} />
            </div>
          </div>
        </div>
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
              Rien de lisible depuis {attempts} essais. Rapprochez-vous, allumez la torche, et
              évitez que le vernis renvoie la lumière droit dans l’objectif.
            </p>
            {crop && (
              <a
                href={crop}
                download={`viseur-${attempts}.png`}
                className="mt-2 block"
                title="Enregistrer ce recadrage"
              >
                <span className="intitule">Zone transmise au moteur</span>
                <img
                  src={crop}
                  alt="Zone lue, telle que transmise au moteur"
                  className="mt-1 w-full rounded-controle border border-trait bg-white"
                />
              </a>
            )}
            {modelProvider && (
              <p className="mt-2 text-micro text-tertiaire">
                Moteur : PP-OCRv6 sur {modelProvider === 'webgpu' ? 'WebGPU' : 'WebAssembly'}
              </p>
            )}
          </div>
        )}

        {saisieVisible && (
          <SaisieManuelle onSubmit={submitCode} onRefus={onRefus} autoFocus={manualEntry} />
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
