import { useCallback, useEffect, useRef, useState } from 'react';

import { chime, vibrate } from './feedback.js';
import { recognize, recognizeNumber, shutdown, spliceNumber, warmUp } from './ocr.js';
import { cropVariants, echelleDeLecture, grabFrame } from './preprocess.js';
import { scanCode } from './scanApi.js';
import { reticleRect, toVideoRect } from './viewport.js';
import { ReadingVote } from './vote.js';

/** Intervalle entre deux lectures. Une douchette de supermarché ne fait pas mieux. */
const SCAN_INTERVAL_MS = 280;

/**
 * Nombre de binarisations essayées par tour.
 *
 * Il y en a quatre — Otsu, Sauvola, et leurs polarités inverses — mais les
 * essayer toutes sur la *même* image coûte quatre passes d'OCR pour une image
 * qui, si elle est mauvaise, le restera pour les quatre. On en essaie donc deux
 * par tour en faisant tourner le point de départ : les quatre sont couvertes en
 * deux tours, sur deux images différentes, avec un reflet qui a bougé entre les
 * deux.
 */
/**
 * Temps que l'on s'autorise, par tour, à essayer des binarisations.
 *
 * La boucle essaie les variantes dans l'ordre de leur efficacité mesurée et
 * s'arrête au premier succès. Ce budget borne ce qu'on dépense quand aucune ne
 * réussit : au-delà, mieux vaut reprendre une image fraîche, où le reflet et
 * la mise au point auront bougé, que continuer à travailler une image qui ne
 * donne rien.
 *
 * Réglé sur la mesure (`scripts/ocr-bench.mjs`) : une reconnaissance Sauvola
 * coûte 50 ms, une reconnaissance Otsu 230 à 361 ms. 450 ms laissent donc
 * passer les deux Sauvola et une Otsu — l'ordre exact dans lequel elles
 * paient.
 */
const TICK_BUDGET_MS = 450;

/**
 * Ordre d'essai des binarisations, et ce que chacune coûte.
 *
 * Établi par `scripts/ocr-bench.mjs` sur les trois recadrages réels de
 * `scripts/fixtures/`, et non par intuition :
 *
 *     binarisation   reconnaissance   cartes retrouvées
 *     sauvola             50 ms             2/3
 *     otsu               230-361 ms         0/3
 *
 * Otsu ne lit AUCUNE carte réelle et coûte cinq à sept fois plus cher, parce
 * que Tesseract passe son temps à tenter de segmenter du bruit. Il reste
 * excellent sur une image très propre — la caméra simulée du banc — donc on
 * le garde, en dernier et seulement s'il reste du budget.
 *
 * L'ancienne boucle prenait deux variantes par tour en faisant tourner le
 * point de départ : un tour sur deux commençait donc par Otsu, et dépensait
 * l'essentiel de son temps sur la binarisation qui ne rend rien.
 */
const ORDRE_VARIANTES = ['sauvola', 'sauvola-inverse', 'otsu', 'otsu-inverse'];

/** Ce qu'on calcule d'emblée ; le reste n'est produit qu'en cas d'échec. */
const VARIANTES_RAPIDES = ['sauvola', 'sauvola-inverse'];

/**
 * Qualité d'une résolution, du plus sûr au plus douteux.
 *
 * Sert à décider si une seconde lecture mérite de remplacer la première : on ne
 * remplace jamais une correspondance sûre par une approchée.
 */
const RANG_METHODE = { exact: 3, region: 3, fuzzy: 1 };
const qualite = (resolu) =>
  resolu?.status === 'matched' ? (RANG_METHODE[resolu.method] ?? 1) : 0;


/**
 * Netteté minimale sous laquelle on ne lance même pas l'OCR.
 *
 * Très bas volontairement : il ne s'agit pas de juger de la qualité mais
 * d'écarter une image sans contenu — objectif obturé, cadre vide, mise au point
 * partie à l'infini. Le reste est affaire de l'utilisateur, à qui l'indicateur
 * de netteté donne le retour dont il a besoin.
 *
 * Mesuré sur trois cadrages réels : 0,172 net, 0,123 dégradé, 0,046 très
 * dégradé mais encore lisible. Le seuil passe donc sous les trois.
 */
const MIN_SHARPNESS = 0.015;

/**
 * Le viseur.
 *
 * Le téléphone est braqué sur une seule inscription — le code d'extension — et
 * ne cherche rien d'autre. Deux garde-fous évitent les fausses alertes :
 *
 * - une correspondance **exacte ou régionale** est acceptée d'emblée : le code
 *   lu existe, il n'y a rien à confirmer ;
 * - une correspondance **approchée** doit sortir deux fois de suite. C'est ce
 *   qui empêche un reflet passager de figer l'écran sur une carte au hasard.
 */
export function useSniper() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackRef = useRef(null);
  const busyRef = useRef(false);
  const abortRef = useRef(null);
  const voteRef = useRef(new ReadingVote());

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  /**
   * Torche.
   *
   * `available` était calculé sur le seul `getCapabilities().torch`. Or
   * plusieurs navigateurs mobiles ne déclarent pas la capacité tant qu'aucune
   * contrainte n'a été appliquée, et cachaient donc le bouton sur des appareils
   * dont la lampe fonctionne parfaitement. On propose désormais la commande dès
   * qu'une piste vidéo existe, et l'on ne la retire QUE si un essai réel
   * échoue — c'est la lumière qui décide de la lisibilité d'une inscription de
   * deux millimètres, elle mérite le bénéfice du doute.
   */
  const [torch, setTorch] = useState({ available: false, on: false, declaree: false });

  /**
   * La torche reste allumée d'une carte à l'autre.
   *
   * On dépouille un classeur : la rallumer à chaque carte est une corvée, et
   * `rescan()` remontait l'état complet du hook. La préférence survit donc au
   * verrouillage et se réapplique à la piste.
   */
  const torcheVoulueRef = useRef(false);
  const [zoom, setZoom] = useState({ available: false, value: 1, min: 1, max: 1, step: 0.1 });

  const [modelReady, setModelReady] = useState(false);
  const [modelProgress, setModelProgress] = useState(0);

  const [reading, setReading] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [failure, setFailure] = useState(null);
  const [crop, setCrop] = useState(null);
  const [sharpness, setSharpness] = useState(0);
  const [result, setResult] = useState(null);
  const [frozenFrame, setFrozenFrame] = useState(null);
  /**
   * Saisie manuelle ouverte.
   *
   * L'état vit ici, et pas dans le composant, pour deux raisons.
   *
   * Il **suspend la boucle de lecture** : sans cela elle continue pendant qu'on
   * tape, verrouille sur la carte visée et démonte le formulaire au milieu d'un
   * mot. Vu en test navigateur — le champ disparaissait entre deux frappes.
   *
   * Il **survit au résultat** : `rescan()` n'y touche pas, donc valider une
   * carte tapée à la main ramène au formulaire, pas au viseur. Qui saisit un
   * code en saisit dix.
   */
  const [manualEntry, setManualEntry] = useState(false);
  /**
   * Le même état, lisible depuis la lecture en cours.
   *
   * Suspendre la boucle empêche le *prochain* tour, pas celui qui est déjà
   * parti : une passe d'OCR dure près d'une seconde et se termine en posant un
   * résultat, ce qui démonterait le formulaire qu'on vient d'ouvrir. L'état de
   * React n'est pas lisible depuis cette fonction — elle est mémoïsée sans
   * dépendances pour ne pas relancer la boucle à chaque rendu — d'où la
   * référence.
   */
  const manualRef = useRef(false);
  manualRef.current = manualEntry;

  /* --- modèle OCR : chauffé pendant que l'utilisateur vise ---------------- */

  useEffect(() => {
    let alive = true;
    warmUp((progress) => alive && setModelProgress(progress))
      .then(() => alive && setModelReady(true))
      .catch(() => alive && setModelReady(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => void shutdown(), []);

  /* --- caméra ------------------------------------------------------------- */

  /**
   * Rattache le flux à l'élément <video>, à chaque fois qu'il apparaît.
   *
   * C'est une **référence de rappel**, et non une `useRef` passée telle quelle,
   * parce que `<SniperView>` est démonté puis remonté à chaque aller-retour :
   * onglet Collection, écran de résultat, « Pas ma carte ». React fabrique
   * alors un nouvel élément vide, tandis que l'effet qui ouvre la caméra ne se
   * rejoue pas — ses dépendances n'ont pas changé.
   *
   * Sans cela, le viseur ne fonctionnait **qu'une fois par chargement de
   * page** : après le premier résultat, ou une simple visite à la collection,
   * l'image restait noire et plus aucune lecture n'aboutissait, sans le
   * moindre message. Mesuré : `srcObject` absent, `videoWidth` à zéro, vidéo
   * en pause. C'est la boucle principale de l'application ; le test navigateur
   * ne le voyait pas parce qu'il ne scannait qu'une carte.
   */
  const attachVideo = useCallback((element) => {
    videoRef.current = element;
    const stream = streamRef.current;
    if (!element || !stream) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    // `play()` rejette quand l'élément est retiré entre-temps : sans filet,
    // l'exception remonte dans le rendu de React.
    element.play().catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stream = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            // On demande le maximum : le viseur recadre ensuite dans l'image
            // native, donc chaque pixel supplémentaire va directement à l'OCR.
            // Le navigateur retombe seul sur ce que le capteur sait faire.
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
        });
        if (cancelled) return stream.getTracks().forEach((track) => track.stop());

        streamRef.current = stream;
        // Le rattachement passe par `attachVideo` : l'élément <video> est
        // détruit et recréé à chaque aller-retour vers la Collection ou vers
        // l'écran de résultat, et cet effet-ci ne se rejoue jamais.
        attachVideo(videoRef.current);
        if (cancelled) return;

        const track = stream.getVideoTracks()[0];
        trackRef.current = track;
        const capabilities = track?.getCapabilities?.() ?? {};

        // Déclarée par la plateforme, ou simplement possible : dans les deux
        // cas on montre la commande.
        setTorch({
          available: true,
          on: false,
          declaree: Boolean(capabilities.torch),
        });

        // La torche voulue avant un rescan est rallumée sur la nouvelle piste.
        if (torcheVoulueRef.current) {
          await track
            .applyConstraints({ advanced: [{ torch: true }] })
            .then(() => setTorch((etat) => ({ ...etat, on: true })))
            .catch(() => {});
        }

        // Mise au point continue. À dix centimètres d'une inscription de deux
        // millimètres, c'est la première cause d'échec, très loin devant le
        // seuil de binarisation ou le choix de la police.
        if (capabilities.focusMode?.includes('continuous')) {
          await track
            .applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
            .catch(() => {});
        }

        if (capabilities.zoom) {
          const { min = 1, max = 1, step = 0.1 } = capabilities.zoom;
          // On ne force **pas** de zoom au démarrage. Sur la plupart des
          // téléphones il est numérique : le capteur suréchantillonne puis
          // ré-encode, ce qui rend l'image plus molle. Or le viseur recadre déjà
          // lui-même dans l'image native — zoomer reviendrait à agrandir une
          // première fois pour découper ensuite dans un agrandissement.
          // Le curseur reste là pour qui en a besoin.
          setZoom({ available: max > min, value: min, min, max, step: step || 0.1 });
        }

        setReady(true);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setReady(false);
        setError(
          cause?.name === 'NotAllowedError'
            ? 'Accès à la caméra refusé. Autorisez-la dans les réglages du navigateur, puis rechargez.'
            : `Caméra indisponible : ${cause?.message ?? 'raison inconnue'}`,
        );
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      trackRef.current = null;
    };
  }, [attachVideo]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      torcheVoulueRef.current = next;
      setTorch((current) => ({ ...current, on: next, available: true }));
    } catch {
      // L'appareil n'en a pas, ou la refuse : on retire la commande plutôt que
      // de laisser un bouton qui ne fait rien. C'est le seul chemin qui
      // conclut à l'absence de torche — un essai, pas une déclaration.
      torcheVoulueRef.current = false;
      setTorch({ available: false, on: false, declaree: false });
    }
  }, [torch.on]);

  /**
   * Mise au point sur un point de l'image, en fractions [0, 1].
   * Sur une carte posée à plat, l'appareil fait souvent le point sur le fond :
   * pouvoir désigner l'endroit règle le problème en un geste.
   */
  const focusAt = useCallback(async (x, y) => {
    const track = trackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ pointsOfInterest: [{ x, y }], focusMode: 'single-shot' }],
      });
    } catch {
      // Tous les appareils ne l'exposent pas ; l'absence n'est pas une erreur.
    }
  }, []);

  const applyZoom = useCallback(async (value) => {
    const track = trackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: value }] });
      setZoom((current) => ({ ...current, value }));
    } catch {
      setZoom((current) => ({ ...current, available: false }));
    }
  }, []);

  /* --- boucle de lecture --------------------------------------------------- */

  const readOnce = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    busyRef.current = true;
    try {
      const container = { width: video.clientWidth, height: video.clientHeight };
      const rect = toVideoRect(
        reticleRect(container),
        { width: video.videoWidth, height: video.videoHeight },
        container,
      );

      const still = grabFrame(video);
      // Agrandissement visant une bande d'environ 110 px, où Tesseract lit le
      // mieux. Le réglage précédent visait 240 px : mesuré, c'était à la fois
      // le plus lent et le moins fiable. Voir `echelleDeLecture`.
      const scale = echelleDeLecture(rect.height);
      const variants = cropVariants(still, rect, { scale, only: VARIANTES_RAPIDES });

      setSharpness(variants.sharpness);

      // Image sans contenu exploitable : l'OCR n'y trouverait rien et coûterait
      // une seconde. On rend la main tout de suite, l'indicateur de netteté
      // disant à l'utilisateur ce qu'il y a à corriger.
      if (variants.sharpness < MIN_SHARPNESS) {
        setReading('image trop floue');
        setAttempts((count) => count + 1);
        return;
      }

      // Les binarisations dans l'ordre de leur efficacité mesurée, tant qu'il
      // reste du budget. On s'arrête au premier succès : dans le cas courant,
      // c'est la première, et le tour aura coûté une seule reconnaissance.
      const debut = Date.now();
      let disponibles = variants;

      for (const label of ORDRE_VARIANTES) {
        if (Date.now() - debut > TICK_BUDGET_MS) break;

        let variant = disponibles.find((entry) => entry.label === label);
        if (!variant) {
          // Les variantes lentes ne sont produites que si les rapides ont
          // échoué : les calculer d'avance serait payer pour rien neuf tours
          // sur dix.
          disponibles = cropVariants(still, rect, { scale, only: ORDRE_VARIANTES });
          variant = disponibles.find((entry) => entry.label === label);
        }
        if (!variant) continue;

        // La vignette de ce qui part au moteur : sans elle, un échec de lecture
        // ne dit pas si le problème vient du cadrage, de la lumière ou du seuil.
        setCrop(variant.canvas.toDataURL('image/png'));

        const { text, confidence } = await recognize('setCode', variant.canvas);
        const trimmed = text.trim();
        // On affiche aussi les lectures vides : « rien » et « quelque chose
        // d'illisible » n'appellent pas le même geste de la part de l'utilisateur.
        setReading(trimmed || `rien lu (${variant.label}, conf. ${Math.round(confidence)})`);
        if (!trimmed) continue;

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        // Une panne de résolution — index absent, API injoignable — doit se voir.
        // Avalée, elle se manifeste seulement par un viseur qui ne verrouille
        // jamais, ce qui n'oriente vers rien.
        const resoudre = (texte) =>
          scanCode(texte, controller.signal).catch((cause) => {
            if (cause.name !== 'AbortError') setFailure(cause.message);
            return null;
          });

        let resolved = await resoudre(trimmed);
        if (resolved) setFailure(null);

        // Seconde passe : on relit le numéro en chiffres seuls et l'on
        // réessaie. Elle se déclenche non seulement sur un échec, mais aussi
        // sur une correspondance APPROCHÉE — c'est justement le cas où la
        // lecture est douteuse. Une première version ne la lançait que sur
        // « aucune correspondance », et un rapprochement approché vers la
        // MAUVAISE carte court-circuitait la correction qui aurait donné la
        // bonne : « CMAMA-FRIIZ » se rapprochait de MAMA-112 et l'affaire
        // était close, alors que relire « 113 » donnait la carte exacte.
        //
        // Dans le cas courant — lecture exacte du premier coup — elle ne se
        // déclenche pas et ne coûte donc rien.
        if (qualite(resolved) < 3) {
          const chiffres = await recognizeNumber(variant.canvas).catch(() => '');
          const corrige = spliceNumber(trimmed, chiffres);
          if (corrige) {
            setReading(`${trimmed} → ${corrige}`);
            const secondEssai = await resoudre(corrige);
            // À qualité égale, la lecture corrigée l'emporte, et ce n'est pas
            // un pari : elle a le MÊME préfixe et des chiffres lus avec un
            // alphabet où une lettre est impossible. Elle est donc meilleure
            // par construction. On ne descend jamais en dessous, en revanche —
            // le test compare les rangs, il ne fait pas confiance à l'ordre.
            if (qualite(secondEssai) >= qualite(resolved)) resolved = secondEssai;
          }
        }

        if (!resolved) continue;
        if (resolved.status === 'no_code' || resolved.status === 'no_match') continue;

        // Exact ou régional : le code lu existe tel quel, rien à confirmer.
        // Approché : il faut une deuxième lecture, sur une autre image.
        const certain = resolved.method === 'exact' || resolved.method === 'region';
        const { accepted } = voteRef.current.cast(resolved.matchedCode, { certain });
        if (!accepted) return;
        // La saisie manuelle a pu s'ouvrir pendant cette passe : verrouiller
        // maintenant démonterait le formulaire sous les doigts.
        if (manualRef.current) return;

        setFrozenFrame(still.toDataURL('image/jpeg', 0.9));
        setResult(resolved);
        // Le bip de la douchette : on sait que c'est lu sans quitter la carte
        // des yeux. Les deux échouent en silence là où ils ne sont pas offerts.
        chime();
        vibrate();
        return;
      }

      setAttempts((count) => count + 1);
    } catch (cause) {
      // Sans ce filet, une exception ici remonte dans la boucle et l'arrête
      // définitivement — le viseur reste affiché mais ne lit plus rien, sans
      // que rien ne l'indique.
      if (cause?.name !== 'AbortError') setFailure(cause?.message ?? String(cause));
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!ready || result || manualEntry) return undefined;

    let stopped = false;
    let timer = 0;

    const tick = async () => {
      if (!stopped && !busyRef.current) await readOnce();
      if (!stopped) timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };

    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [ready, result, manualEntry, readOnce]);

  /**
   * Saisie manuelle : même résolution que le viseur, même écran de résultat.
   *
   * Pour les cas où la caméra ne peut pas — pas de caméra, code abîmé ou
   * effacé, carte sous étui. Rend la réponse pour que le formulaire dise
   * « code inconnu » sans quitter l'écran.
   */
  const submitCode = useCallback(async (typed) => {
    const text = String(typed ?? '').trim().toUpperCase();
    if (!text) return { status: 'no_code' };
    abortRef.current?.abort();
    const resolved = await scanCode(text);
    if (resolved.status === 'no_code' || resolved.status === 'no_match') return resolved;
    voteRef.current.reset();
    setFrozenFrame(null);
    setResult({ ...resolved, source: `${resolved.source ?? 'local'}:manual` });
    chime();
    vibrate();
    return resolved;
  }, []);

  /** Relance la visée : l'image se dégèle et la boucle repart. */
  const rescan = useCallback(() => {
    abortRef.current?.abort();
    // `manualEntry` n'est volontairement pas remis à zéro : voir sa déclaration.
    voteRef.current.reset();
    setResult(null);
    setFrozenFrame(null);
    setReading('');
    setAttempts(0);
    setFailure(null);
  }, []);

  return {
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
    reading,
    attempts,
    failure,
    crop,
    sharpness,
    minSharpness: MIN_SHARPNESS,
    result,
    frozenFrame,
    rescan,
    submitCode,
    manualEntry,
    setManualEntry,
  };
}
