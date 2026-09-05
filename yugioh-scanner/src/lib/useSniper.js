import { useCallback, useEffect, useRef, useState } from 'react';

import { loadCardIndex } from './cardIndex.js';
import { chime, vibrate } from './feedback.js';
import { identifier, shutdownArt, warmUpArt } from './identifierClient.js';
import { grabFrame } from './preprocess.js';
import { scanCode } from './scanApi.js';
import { lireTirage } from './lireTirage.js';
import { AntiDoublon } from './serie.js';
import { assezGrande, tiragesDuCode } from './tirage.js';
import { SCORE_PROPOSE, VoteArt, resultatDepuisArt, tiragesDistincts } from './verdictArt.js';

/**
 * Pause entre deux passes d'identification.
 *
 * Une passe dure de 300 ms à 2 s selon l'appareil, dans un worker. Cette
 * pause ne sert qu'à laisser respirer l'interface entre deux images.
 */
const SCAN_INTERVAL_MS = 80;

/**
 * Plus grand côté de l'image transmise à l'identification.
 *
 * La détection travaille à 448 px de large et l'empreinte lit l'illustration à
 * 96×96 : au-delà de 1 600 px, l'image native ne sert qu'à l'affinage des
 * coins, et coûte en copie. Mesuré sur le banc à 1080×1920.
 */
const COTE_MAX = 1600;

/**
 * Le viseur.
 *
 * La carte est identifiée par son ILLUSTRATION, n'importe où dans l'image,
 * dans n'importe quel sens : plus de fenêtre de visée sur une inscription de
 * deux millimètres. Chaque image de la caméra part au worker d'identification
 * (`identifier.js`), qui rend le contour de la carte, la carte la plus
 * ressemblante et un score. La décision d'accepter revient à `VoteArt` : un
 * score sûr suffit, un score moyen demande une deuxième image d'accord.
 *
 * Le code d'extension n'identifie plus la carte ; il reste disponible en
 * saisie manuelle, pour les cas où la caméra ne peut pas.
 */
/** Tentatives de lecture du code, au plus, pour une carte laissée devant l'objectif. */
const RELECTURES_MAX = 6;

/**
 * Lit le code de tirage sur l'image figée. Ne rejette jamais : une lecture
 * qui échoue (moteur indisponible, carte trop petite) rend un tirage nul
 * avec sa raison — le viseur ne doit pas s'arrêter pour ça.
 */
async function lireTirageSurImage(still, coins, resolved) {
  try {
    if (!coins) return { tirage: null, raison: 'contour inconnu' };
    const distincts = new Set((resolved.printings ?? []).map((p) => p.setCode));
    if (distincts.size < 2) return { tirage: resolved.printings?.[0] ?? null, raison: 'tirage unique' };
    if (!assezGrande(coins, still.height)) return { tirage: null, raison: 'carte trop petite' };
    const image = still.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, still.width, still.height);
    const lu = await lireTirage(image, coins, resolved.printings);
    console.debug(`[viseur] tirage : ${lu.tirage?.setCode ?? '—'} (lu « ${lu.lecture} », similarité ${Math.round(lu.similarite)}, ${lu.ms} ms${lu.raison ? `, ${lu.raison}` : ''})`);
    return lu;
  } catch (cause) {
    console.debug(`[viseur] tirage non lu : ${cause?.message ?? cause}`);
    return { tirage: null, raison: cause?.message ?? 'lecture impossible' };
  }
}

/** Le résultat restreint au tirage lu (toutes ses raretés), ou annoté de la raison. */
export function avecTirageLu(resolved, lu) {
  if (!lu?.tirage) return { ...resolved, lectureTirage: lu?.raison ?? 'code illisible' };
  const printings = tiragesDuCode(resolved.printings, lu.tirage);
  const rarities = tiragesDistincts(printings);
  return {
    ...resolved,
    matchedCode: lu.tirage.setCode,
    lectureTirage: 'lu',
    printings,
    rarities,
    status: rarities.length > 1 ? 'needs_user_selection' : 'resolved',
  };
}

/**
 * @param {{serie?: boolean, onSerie?: (resolved: object, lecture: Promise<object>) => void}} options
 *   `serie` : la carte reconnue est remise à `onSerie` (qui l'ajoute au
 *   classeur) et le viseur continue, sans écran de résultat ; `lecture` est
 *   la promesse de la lecture du code de tirage sur l'image, tenue à
 *   `{tirage, raison}` — le tirage est nul si le code ne s'est pas lu.
 */
export function useSniper({ serie = false, onSerie = null } = {}) {
  const serieRef = useRef(serie);
  const onSerieRef = useRef(onSerie);
  serieRef.current = serie;
  onSerieRef.current = onSerie;
  const antiDoublonRef = useRef(new AntiDoublon());
  /** Suivi de la lecture du code pour la carte ajoutée en dernier (relectures). */
  const relectureRef = useRef(null);
  /** Lecture du code lancée sur la première image sûre, avant le verrouillage. */
  const preLectureRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackRef = useRef(null);
  const busyRef = useRef(false);
  const abortRef = useRef(null);
  const voteRef = useRef(new VoteArt());

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
  /** Contour de la carte dans la dernière image, en pixels vidéo, avec les dimensions de l'image. */
  const [contour, setContour] = useState(null);
  /** Dernière lecture : carte la plus ressemblante, score, marge, temps. */
  const [lecture, setLecture] = useState(null);

  const [attempts, setAttempts] = useState(0);
  const [failure, setFailure] = useState(null);
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
   * Cartes proposées quand la passe n'est pas assez sûre pour trancher : les
   * trois meilleures, avec leur nom, à toucher. Renouvelées seulement quand
   * la première change, pour ne pas bouger sous le doigt.
   */
  const [propositions, setPropositions] = useState([]);
  const propositionsRef = useRef([]);
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

  /**
   * L'index d'illustrations (8,8 Mo, une fois) part au worker ; l'index des
   * cartes se charge en même temps, pour que le résultat soit immédiat.
   */
  useEffect(() => {
    let alive = true;
    loadCardIndex().catch(() => {});
    warmUpArt((progress) => alive && setModelProgress(progress))
      .then(() => alive && setModelReady(true))
      .catch((cause) => {
        // Sans index, le viseur n'identifiera jamais : on le dit, au lieu de
        // laisser une boucle chercher dans le vide.
        if (alive) setFailure(`Index d’illustrations indisponible : ${cause?.message ?? cause}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => void shutdownArt(), []);

  /* --- caméra ------------------------------------------------------------- */

  /**
   * Allume ou éteint la torche, et **vérifie que ça a marché**.
   *
   * Le piège : `applyConstraints` résout sans erreur sur la plupart des
   * navigateurs même quand la contrainte est ignorée. Une contrainte placée
   * dans `advanced` est explicitement « au mieux » selon la spécification —
   * le navigateur a le droit de la passer sous silence. Résultat observé :
   * le bouton passait en « Torche allumée », et la lampe restait éteinte.
   *
   * On essaie donc les deux formes, et surtout on relit `getSettings().torch`
   * pour savoir ce qui s'est réellement produit. Si le réglage ne suit pas, on
   * le dit au lieu de mentir sur l'état.
   *
   * @returns {Promise<boolean>} l'état réellement obtenu
   */
  const appliquerTorche = useCallback(async (track, voulu) => {
    const essais = [
      // Forme obligatoire : le navigateur doit refuser explicitement s'il ne
      // sait pas faire, ce qui nous renseigne.
      { torch: voulu },
      // Forme « au mieux », la plus largement acceptée.
      { advanced: [{ torch: voulu }] },
    ];

    for (const contrainte of essais) {
      try {
        await track.applyConstraints(contrainte);
      } catch {
        continue;
      }
      // La seule preuve qui vaille : ce que la piste déclare après coup.
      const obtenu = track.getSettings?.().torch;
      if (obtenu === voulu) return true;
      // `undefined` : la plateforme n'expose pas le réglage. On accorde le
      // bénéfice du doute à la forme obligatoire, qui n'a pas levé.
      if (obtenu === undefined && contrainte.torch !== undefined) return true;
    }
    return false;
  }, []);


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
          const rallumee = await appliquerTorche(track, true);
          if (rallumee) setTorch((etat) => ({ ...etat, on: true }));
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
  }, [attachVideo, appliquerTorche]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;

    const next = !torch.on;
    const obtenu = await appliquerTorche(track, next);

    if (obtenu) {
      torcheVoulueRef.current = next;
      setTorch((current) => ({ ...current, on: next, available: true }));
      return;
    }

    // L'appareil n'en a pas, ou la refuse. On retire la commande plutôt que de
    // laisser un bouton qui prétend agir. C'est le seul chemin qui conclut à
    // l'absence de torche — un essai vérifié, pas une déclaration.
    torcheVoulueRef.current = false;
    setTorch({ available: false, on: false, declaree: false });
    setFailure(
      'Votre navigateur n’expose pas la lampe. Sur iPhone, Safari ne la donne à aucun site ; ' +
        'sur Android, Chrome et Edge la donnent, Firefox non.',
    );
  }, [torch.on, appliquerTorche]);

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
      const still = grabFrame(video);
      // L'image transmise : au plus COTE_MAX sur le grand côté. Une copie
      // par passe, transférée au worker (pas recopiée).
      const facteur = Math.min(1, COTE_MAX / Math.max(still.width, still.height));
      let source = still;
      if (facteur < 1) {
        source = document.createElement('canvas');
        source.width = Math.round(still.width * facteur);
        source.height = Math.round(still.height * facteur);
        source.getContext('2d').drawImage(still, 0, 0, source.width, source.height);
      }
      const image = source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, source.width, source.height);

      const t0 = performance.now();
      const r = await identifier(image);
      setAttempts((count) => count + 1);
      // Trace de chaque passe : c'est ce qu'on lit dans une capture de
      // console quand « ça ne reconnaît pas » — la seule mesure sur l'appareil réel.
      console.debug(
        `[viseur] passe ${image.width}×${image.height} : ${Math.round(performance.now() - t0)} ms (détection ${r.ms?.quad ?? '?'}, total ${r.ms?.total ?? '?'}), contour ${r.quad ? 'oui' : 'non'}, meilleure ${r.candidats?.[0]?.id ?? '—'} à ${(r.candidats?.[0]?.score ?? 0).toFixed(2)}`,
      );
      // Le contour, en pixels de la vidéo native : l'écran le dessine à sa place.
      setContour(
        r.quad ? { points: r.quad.map((p) => ({ x: p.x / facteur, y: p.y / facteur })), largeur: still.width, hauteur: still.height } : null,
      );

      const verdict = voteRef.current.cast(r.candidats);
      setLecture({ id: verdict.id, score: verdict.score, marge: verdict.marge, zone: verdict.zone, ms: r.ms?.total ?? 0 });
      // Présence de la carte ajoutée en dernier : c'est ce qui décide qu'une
      // carte revue est la même (toujours là) ou un deuxième exemplaire.
      // Vue = la meilleure carte de la passe, même quand la passe n'est pas
      // assez sûre pour verrouiller : une passe moyenne sur la même carte ne
      // veut pas dire qu'elle a quitté le champ.
      const vue = (r.candidats?.[0]?.score ?? 0) >= SCORE_PROPOSE ? r.candidats[0].id : null;
      antiDoublonRef.current.voir(vue);
      if (verdict.zone === 'proposer') {
        const actuelles = propositionsRef.current;
        if (actuelles[0]?.id !== verdict.propositions[0]?.id) {
          const index = await loadCardIndex();
          const nommees = verdict.propositions
            .map((p) => {
              const position = index.byPasscode.get(p.id);
              return position === undefined ? null : { id: p.id, score: p.score, nom: index.cards[position].name };
            })
            .filter(Boolean);
          propositionsRef.current = nommees;
          setPropositions(nommees);
        }
      } else if (verdict.zone === 'sure' && propositionsRef.current.length) {
        propositionsRef.current = [];
        setPropositions([]);
      }
      if (!verdict.accepted) {
        // Première image sûre : le code est déjà lu sur cette image, pour
        // que la deuxième lecture (au verrouillage) puisse la confirmer —
        // deux images différentes, pas deux fois la même.
        if (verdict.zone === 'sure' && verdict.suite === 1 && r.quad) {
          const coinsPre = r.quad.map((p) => ({ x: p.x / facteur, y: p.y / facteur }));
          if (assezGrande(coinsPre, still.height)) {
            const index = await loadCardIndex();
            const resolu = resultatDepuisArt(index, r.candidats[0].id, { score: verdict.score, marge: verdict.marge, sens: r.sens, quad: r.quad });
            if (resolu.status !== 'no_match') preLectureRef.current = { id: resolu.card.id, promesse: lireTirageSurImage(still, coinsPre, resolu) };
          }
        }
        return;
      }
      // La saisie manuelle a pu s'ouvrir pendant cette passe : verrouiller
      // maintenant démonterait le formulaire sous les doigts.
      if (manualRef.current) return;

      const index = await loadCardIndex();
      const resolved = resultatDepuisArt(index, verdict.id, { score: verdict.score, marge: verdict.marge, sens: r.sens, quad: r.quad });
      if (resolved.status === 'no_match') return;
      setFailure(null);

      // Le code de tirage, lu sur la carte quand elle est assez proche : la
      // carte est déjà connue, le code n'a plus qu'à être reconnu parmi ses
      // propres tirages. Lancé sans attendre : le moteur OCR se charge à la
      // première lecture (31 Mo), la carte s'affiche avant.
      const coinsStill = r.quad ? r.quad.map((p) => ({ x: p.x / facteur, y: p.y / facteur })) : null;

      // Deux images ont déjà été jugées sûres : le code est lu sur les deux
      // (la première lecture est partie avant le verrouillage), la première
      // qui rend un tirage l'emporte.
      const pre = preLectureRef.current;
      preLectureRef.current = null;
      const lecturesInitiales = async () => {
        if (pre && pre.id === resolved.card.id) {
          const premiere = await pre.promesse;
          if (premiere?.tirage) return premiere;
        }
        return lireTirageSurImage(still, coinsStill, resolved);
      };

      if (serieRef.current && onSerieRef.current) {
        // La même carte encore devant l'objectif n'est pas un doublon. Tant
        // que le code n'est pas confirmé, on relit sur les images suivantes,
        // et l'entrée est corrigée après coup.
        if (antiDoublonRef.current.dejaVu(resolved.card.id)) {
          const suivi = relectureRef.current;
          if (suivi && suivi.id === resolved.card.id && !suivi.enCours && !suivi.lu && suivi.essais < RELECTURES_MAX && coinsStill && assezGrande(coinsStill, still.height)) {
            suivi.essais += 1;
            suivi.enCours = true;
            const relecture = lireTirageSurImage(still, coinsStill, resolved);
            relecture.then((lu) => {
              suivi.enCours = false;
              if (lu?.tirage) suivi.lu = true;
            });
            suivi.corriger?.(relecture);
          }
          return;
        }
        antiDoublonRef.current.noter(resolved.card.id);
        const lecture = lecturesInitiales();
        const corriger = onSerieRef.current(resolved, lecture);
        const suivi = { id: resolved.card.id, corriger: typeof corriger === 'function' ? corriger : null, essais: 1, enCours: true, lu: false };
        relectureRef.current = suivi;
        lecture.then((lu) => {
          suivi.enCours = false;
          if (lu?.tirage) suivi.lu = true;
        });
        chime();
        vibrate();
        return;
      }

      const lecture = lecturesInitiales();
      setFrozenFrame(still.toDataURL('image/jpeg', 0.9));
      setResult({ ...resolved, lectureTirage: coinsStill && assezGrande(coinsStill, still.height) ? 'en cours' : 'carte trop petite' });
      lecture.then((lu) => {
        setResult((courant) => (courant && courant.card?.id === resolved.card.id ? avecTirageLu(courant, lu) : courant));
      });
      // Le bip de la douchette : on sait que c'est lu sans quitter la carte
      // des yeux. Les deux échouent en silence là où ils ne sont pas offerts.
      chime();
      vibrate();
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
    if (!ready || !modelReady || result || manualEntry) return undefined;

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
  }, [ready, modelReady, result, manualEntry, readOnce]);

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

  /**
   * L'utilisateur a touché une des cartes proposées : on verrouille dessus,
   * même écran de résultat, avec la source qui dit que c'est son choix.
   */
  const choisir = useCallback(async (id) => {
    const proposition = propositionsRef.current.find((p) => p.id === id);
    if (!proposition) return;
    const index = await loadCardIndex();
    const resolved = resultatDepuisArt(index, id, { score: proposition.score, marge: 0, sens: null, quad: null });
    if (resolved.status === 'no_match') return;
    propositionsRef.current = [];
    setPropositions([]);
    setFrozenFrame(null);
    setResult({ ...resolved, source: 'local:art:choix' });
    chime();
    vibrate();
  }, []);

  /** Affiche l'écran de résultat pour une carte donnée (« Préciser le tirage » après un ajout en série). */
  const montrer = useCallback((resolved) => {
    abortRef.current?.abort();
    setFrozenFrame(null);
    setResult(resolved);
  }, []);

  /** Relance la visée : l'image se dégèle et la boucle repart. */
  const rescan = useCallback(() => {
    abortRef.current?.abort();
    // `manualEntry` n'est volontairement pas remis à zéro : voir sa déclaration.
    voteRef.current.reset();
    setResult(null);
    setFrozenFrame(null);
    setContour(null);
    setLecture(null);
    propositionsRef.current = [];
    setPropositions([]);
    preLectureRef.current = null;
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
    contour,
    lecture,
    propositions,
    choisir,
    attempts,
    failure,
    result,
    frozenFrame,
    rescan,
    montrer,
    submitCode,
    manualEntry,
    setManualEntry,
  };
}
