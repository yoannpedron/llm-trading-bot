/**
 * Combinaison des signaux transversaux.
 *
 * ── Ce qu'on gaspillait ───────────────────────────────────────────────────
 * Six classements des mêmes actifs sont calculés à chaque cycle — celui du
 * modèle de langage, plus cinq facteurs mécaniques — et un seul décidait.
 * Les cinq autres ne servaient que de témoins.
 *
 * C'est une perte sèche : ils sont gratuits, instantanés, documentés depuis
 * trente ans, et déjà calculés. Les ignorer revient à réduire volontairement
 * l'étendue des paris, terme qui entre sous racine carrée dans le ratio
 * d'information.
 *
 * ── Pourquoi on ne peut PAS simplement les moyenner ───────────────────────
 * Deux obstacles, mesurés sur nos propres données.
 *
 * D'abord la redondance : le classement du modèle corrèle à +0,89 avec le
 * momentum 5 jours. Les moyenner double le poids de cette dimension unique au
 * détriment des facteurs réellement indépendants. Mais écarter l'un des deux
 * jetterait les 11 % de variance non partagée, qui sont précisément l'apport
 * propre du modèle.
 *
 * Ensuite l'antagonisme : momentum et retour à la moyenne sont de signes
 * exactement opposés. Les additionner ne produit pas un compromis, ça produit
 * zéro.
 *
 * ── Le protocole retenu ───────────────────────────────────────────────────
 *   1. z-score transversal, après écrêtage des extrêmes
 *   2. orthogonalisation symétrique de Löwdin
 *   3. combinaison à poids égaux sur les signaux devenus orthogonaux
 *
 * Le poids égal n'est pas un aveu de paresse. Sur un historique court,
 * optimiser les poids revient à optimiser du bruit : l'algorithme alloue le
 * plus à ce qui a le mieux marché par hasard. Une fois la covariance annulée
 * par l'orthogonalisation, le poids égal devient de surcroît théoriquement
 * fondé — c'est la solution optimale quand les signaux sont décorrélés et
 * qu'on n'a aucune raison fiable de les hiérarchiser.
 */

import { createLogger } from '../logger.js';

const log = createLogger('signaux');

/** Centile d'écrêtage. Au-delà, une valeur aberrante écrase tous les z-scores. */
const CENTILE_ECRETAGE = 0.01;

/**
 * z-score transversal, précédé d'un écrêtage.
 *
 * L'écrêtage n'est pas cosmétique : un seul actif à +12 σ suffit à comprimer
 * les 149 autres dans un mouchoir de poche, et le classement qui en sort ne
 * distingue plus rien. On ramène les queues aux centiles extrêmes AVANT de
 * standardiser.
 */
export function zscoreWinsorise(valeurs, { centile = CENTILE_ECRETAGE } = {}) {
  const finis = valeurs.filter(Number.isFinite);
  if (finis.length < 3) return valeurs.map(() => null);

  const tries = [...finis].sort((a, b) => a - b);
  const bas = tries[Math.floor(centile * (tries.length - 1))];
  const haut = tries[Math.ceil((1 - centile) * (tries.length - 1))];

  const ecretes = valeurs.map((v) => (Number.isFinite(v) ? Math.min(Math.max(v, bas), haut) : null));
  const utiles = ecretes.filter(Number.isFinite);
  const moyenne = utiles.reduce((a, b) => a + b, 0) / utiles.length;
  const ecartType = Math.sqrt(
    utiles.reduce((a, b) => a + (b - moyenne) ** 2, 0) / Math.max(utiles.length - 1, 1),
  );

  // Un signal constant sur toute la coupe ne porte aucune information
  // transversale : le renvoyer à zéro plutôt que de diviser par zéro.
  if (!(ecartType > 0)) return valeurs.map((v) => (Number.isFinite(v) ? 0 : null));

  return ecretes.map((v) => (Number.isFinite(v) ? (v - moyenne) / ecartType : null));
}

/**
 * Décomposition propre d'une matrice symétrique, par rotations de Jacobi.
 *
 * Choisie plutôt qu'une méthode plus rapide parce qu'elle est inconditionnellement
 * stable sur les matrices symétriques et que la nôtre fait six lignes. La
 * précision prime largement sur la vitesse à cette taille.
 */
export function jacobiEigen(A, { maxIterations = 100, tolerance = 1e-12 } = {}) {
  const n = A.length;
  const a = A.map((r) => Float64Array.from(r));
  // Vecteurs propres accumulés, initialisés à l'identité.
  const V = Array.from({ length: n }, (_, i) => Float64Array.from(
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ));

  for (let balayage = 0; balayage < maxIterations; balayage += 1) {
    // Somme des carrés hors diagonale : c'est elle qu'on annule.
    let horsDiag = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) horsDiag += a[i][j] ** 2;
    if (horsDiag < tolerance) break;

    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(a[p][q]) < 1e-15) continue;

        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p]; const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k]; const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = V[k][p]; const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  return { valeurs: Array.from({ length: n }, (_, i) => a[i][i]), vecteurs: V };
}

/**
 * Orthogonalisation symétrique de Löwdin.
 *
 * ── Pourquoi celle-ci et pas Gram-Schmidt ─────────────────────────────────
 * Gram-Schmidt est séquentiel : il garde le premier signal intact et transforme
 * les suivants en résidus. L'ordre de traitement décide donc de qui garde sa
 * substance. Pourquoi le modèle de langage conserverait-il toute sa structure,
 * reléguant le momentum — documenté depuis trente ans — au rang de reste
 * statistique ? Ce choix est arbitraire, et changer l'ordre change le résultat.
 *
 * Löwdin traite tous les signaux SIMULTANÉMENT, par une transformation
 * symétrique invariante à l'ordre. Elle cherche la base orthogonale la plus
 * PROCHE de la base d'origine au sens des moindres carrés : chaque signal est
 * déformé le moins possible, et la charge de la décorrélation est répartie
 * équitablement. Chacun conserve donc sa signification, purgée de la seule
 * redondance partagée.
 *
 *     S = Xᵀ X          matrice de chevauchement
 *     X_ortho = X · S^(-1/2)
 *
 * S^(-1/2) se calcule en diagonalisant S puis en appliquant l'inverse de la
 * racine carrée à ses valeurs propres.
 *
 * @param {number[][]} colonnes  un tableau par signal, chacun de longueur N
 */
export function lowdinOrthogonalise(colonnes, { plancherValeurPropre = 1e-8 } = {}) {
  const k = colonnes.length;
  if (k === 0) return { colonnes: [], degenere: false };
  if (k === 1) return { colonnes: [[...colonnes[0]]], degenere: false };

  const n = colonnes[0].length;

  // Matrice de chevauchement, normalisée par n pour rester une corrélation
  // quand les colonnes sont des z-scores.
  const S = Array.from({ length: k }, () => new Float64Array(k));
  for (let i = 0; i < k; i += 1) {
    for (let j = i; j < k; j += 1) {
      let somme = 0; let compte = 0;
      for (let t = 0; t < n; t += 1) {
        const a = colonnes[i][t]; const b = colonnes[j][t];
        if (Number.isFinite(a) && Number.isFinite(b)) { somme += a * b; compte += 1; }
      }
      const v = compte > 0 ? somme / compte : (i === j ? 1 : 0);
      S[i][j] = v; S[j][i] = v;
    }
  }

  const { valeurs, vecteurs } = jacobiEigen(S.map((r) => Array.from(r)));

  // Une valeur propre nulle signale deux signaux parfaitement colinéaires :
  // la racine inverse exploserait. On la plafonne et on le signale — c'est
  // une information sur la structure des signaux, pas un incident numérique.
  let degenere = false;
  const inverseRacine = valeurs.map((lambda) => {
    if (lambda <= plancherValeurPropre) { degenere = true; return 0; }
    return 1 / Math.sqrt(lambda);
  });

  if (degenere) {
    log.warn('Signaux colinéaires détectés : une direction du système ne porte aucune information propre.');
  }

  // S^(-1/2) = V · diag(1/√λ) · Vᵀ
  const T = Array.from({ length: k }, () => new Float64Array(k));
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      let somme = 0;
      for (let m = 0; m < k; m += 1) somme += vecteurs[i][m] * inverseRacine[m] * vecteurs[j][m];
      T[i][j] = somme;
    }
  }

  // ── X_ortho = X · T, avec imputation des manquants à zéro ───────────────
  // Une première version rejetait toute ligne où un seul signal manquait. Sur
  // six signaux et 150 actifs, un titre sans RSI exploitable disparaissait
  // entièrement du classement — écarté non pour sa qualité mais pour un trou
  // de données.
  //
  // Après standardisation, la moyenne transversale vaut zéro : imputer zéro
  // revient donc à dire « pour ce signal, cet actif est dans la moyenne »,
  // ce qui est l'hypothèse neutre exacte. On compte les imputations pour que
  // l'ampleur du remplissage reste visible plutôt que supposée négligeable.
  const sorties = Array.from({ length: k }, () => new Array(n).fill(null));
  let imputations = 0;
  let lignesRejetees = 0;

  for (let t = 0; t < n; t += 1) {
    let presents = 0;
    for (let i = 0; i < k; i += 1) if (Number.isFinite(colonnes[i][t])) presents += 1;

    // Un actif dont AUCUN signal n'est disponible n'a rien à apporter : on ne
    // lui fabrique pas un score à partir de six zéros, ce qui le placerait
    // artificiellement au milieu du classement.
    if (presents === 0) { lignesRejetees += 1; continue; }
    imputations += k - presents;

    for (let j = 0; j < k; j += 1) {
      let somme = 0;
      for (let i = 0; i < k; i += 1) {
        const v = colonnes[i][t];
        somme += (Number.isFinite(v) ? v : 0) * T[i][j];
      }
      sorties[j][t] = somme;
    }
  }

  return {
    colonnes: sorties,
    transformation: T,
    valeursPropres: valeurs,
    degenere,
    imputations,
    lignesRejetees,
  };
}

/**
 * Régime de marché, à partir de la dispersion transversale.
 *
 * ── Pourquoi conditionner, et pourquoi PAS sur la volatilité du marché ────
 * Momentum et retour à la moyenne ne se contredisent pas au hasard : ils
 * dominent dans des régimes différents. En marché calme, l'information se
 * diffuse lentement et la tendance persiste. En dislocation, les ventes
 * forcées créent des décotes que le rebond corrige — le retour à la moyenne
 * reprend la main.
 *
 * Les additionner sans condition les annule ; basculer selon le régime les
 * rend complémentaires.
 *
 * Le déclencheur est la DISPERSION TRANSVERSALE des rendements, pas la
 * volatilité de l'indice. Deux raisons : elle se calcule sur les données déjà
 * en mémoire, sans dépendance externe ; et surtout, moduler l'exposition selon
 * la volatilité du marché est précisément ce que la recherche invalide. Ici on
 * ne touche jamais à l'exposition — elle reste à 100 %. On choisit seulement
 * QUEL signal départage les actifs entre eux.
 *
 * La bascule est CONTINUE. Un basculement binaire ferait tourner tout le
 * portefeuille le jour où le seuil est franchi, pour un coût certain.
 */
export function poidsSelonRegime(dispersion, { seuilBas = 0.02, seuilHaut = 0.06 } = {}) {
  if (!Number.isFinite(dispersion)) return { stress: 0.5, regime: 'inconnu' };

  // Sigmoïde bornée : 0 = calme (momentum), 1 = dislocation (retour à la moyenne).
  const brut = (dispersion - seuilBas) / Math.max(seuilHaut - seuilBas, 1e-9);
  const stress = Math.min(1, Math.max(0, brut));

  return {
    stress,
    dispersion,
    regime: stress < 0.33 ? 'calme' : stress > 0.67 ? 'dislocation' : 'intermédiaire',
  };
}

/**
 * Combine les signaux en un score unique par actif.
 *
 * @param {Map<string, object>} signauxParActif  symbole → { nomSignal: valeur }
 * @param {object} options
 * @param {string[]} options.noms        signaux à combiner, dans un ordre stable
 * @param {number} options.stress        0 = calme, 1 = dislocation
 * @param {object} options.orientations  nom → +1 (garder) ou -1 (inverser)
 * @param {object} options.sensibiliteRegime  nom → poids en régime de stress
 */
export function combinerSignaux(signauxParActif, {
  noms,
  stress = 0.5,
  orientations = {},
  sensibiliteRegime = {},
} = {}) {
  const symboles = [...signauxParActif.keys()];
  if (symboles.length < 3 || !noms?.length) {
    return { scores: new Map(), note: 'pas assez d\'actifs ou de signaux' };
  }

  // 1. z-scores écrêtés, signal par signal.
  const colonnes = noms.map((nom) => {
    const brut = symboles.map((s) => {
      const v = signauxParActif.get(s)?.[nom];
      return Number.isFinite(v) ? v * (orientations[nom] ?? 1) : null;
    });
    return zscoreWinsorise(brut);
  });

  // 2. Orthogonalisation symétrique.
  const ortho = lowdinOrthogonalise(colonnes);

  // 3. Pondération par régime, puis somme.
  // Un signal « sensible au régime » voit son poids monter en dislocation ;
  // les autres restent constants. La somme des poids est renormalisée pour que
  // le score reste comparable d'un cycle à l'autre.
  const poids = noms.map((nom) => {
    const sensible = sensibiliteRegime[nom];
    if (sensible == null) return 1;
    // Interpolation linéaire entre le poids calme (1) et le poids de stress.
    return 1 + stress * (sensible - 1);
  });
  const total = poids.reduce((a, b) => a + Math.abs(b), 0) || 1;

  const scores = new Map();
  symboles.forEach((symbole, t) => {
    let somme = 0; let poidsUtilises = 0;
    ortho.colonnes.forEach((col, j) => {
      const v = col[t];
      if (!Number.isFinite(v)) return;
      somme += v * poids[j];
      poidsUtilises += Math.abs(poids[j]);
    });
    // Un actif dont la moitié des signaux manque ne doit pas être pénalisé
    // mécaniquement : on renormalise sur les signaux réellement disponibles.
    scores.set(symbole, poidsUtilises > 0 ? somme / poidsUtilises : null);
  });

  return {
    scores,
    poids: Object.fromEntries(noms.map((n, i) => [n, Number((poids[i] / total).toFixed(4))])),
    // Combien de valeurs ont dû être remplacées par la moyenne, et combien
    // d'actifs n'avaient aucun signal exploitable. Un taux d'imputation qui
    // grimpe signale une dégradation des données, pas du marché.
    imputations: ortho.imputations ?? 0,
    actifsSansSignal: ortho.lignesRejetees ?? 0,
    valeursPropres: ortho.valeursPropres,
    degenere: ortho.degenere,
    // Entropie de diversité : mesure si l'information se répartit sur plusieurs
    // dimensions indépendantes, ou si quelques-unes dominent. Elle plafonne
    // quand ajouter un signal n'apporte plus de direction nouvelle.
    entropieDiversite: entropieDiversite(ortho.valeursPropres),
  };
}

/**
 * Entropie de Shannon des valeurs propres normalisées.
 *
 * Élevée : l'information est répartie sur plusieurs dimensions indépendantes.
 * Faible : quelques directions dominent, les signaux sont redondants et en
 * ajouter un de plus ne rapportera rien.
 */
export function entropieDiversite(valeursPropres) {
  if (!valeursPropres?.length) return null;
  const positives = valeursPropres.filter((v) => v > 0);
  const somme = positives.reduce((a, b) => a + b, 0);
  if (!(somme > 0)) return null;

  let h = 0;
  for (const v of positives) {
    const p = v / somme;
    if (p > 0) h -= p * Math.log(p);
  }
  // Normalisée par l'entropie maximale : 1 = signaux parfaitement
  // complémentaires, 0 = un seul signal déguisé en plusieurs.
  return Number((h / Math.log(valeursPropres.length)).toFixed(4));
}

/**
 * Adaptateur : assemble les six signaux du cycle et produit le score combiné.
 *
 * ── Pourquoi il ressort déguisé en « facteur » ────────────────────────────
 * Le résultat est injecté dans la table des facteurs de référence, sous le nom
 * `combine`. Ce n'est pas un artifice : le carnet fantôme score déjà chaque
 * facteur contre les rendements réalisés et les compare au modèle par test
 * apparié. En s'y insérant, la combinaison hérite gratuitement de tout
 * l'appareil de mesure — aucune plomberie nouvelle, et surtout aucun
 * traitement de faveur : elle est jugée exactement comme les autres.
 *
 * @param {Array}  evaluations    évaluations du cycle, décision déjà posée
 * @param {Map}    rangsFacteurs  symbole → { nomFacteur: { score, ... } }
 * @param {object} listwise       résultat du classement par comparaison
 */
export function melangerSignaux(evaluations, rangsFacteurs, listwise) {
  const signaux = new Map();

  for (const e of evaluations) {
    if (!e?.evaluated) continue;
    const facteurs = rangsFacteurs?.get(e.symbol);
    const lambda = e.decision?.lambda;
    if (!Number.isFinite(lambda) && !facteurs) continue;

    const ligne = { llm: Number.isFinite(lambda) ? lambda : null };
    for (const [nom, info] of Object.entries(facteurs ?? {})) {
      ligne[nom] = Number.isFinite(info?.score) ? info.score : null;
    }
    signaux.set(e.symbol, ligne);
  }

  if (signaux.size < 3) {
    return { scores: new Map(), note: 'trop peu d\'actifs pour combiner' };
  }

  let noms = [...new Set(signaux.values().next().value ? Object.keys([...signaux.values()][0]) : [])];

  // ── Le modèle est ÉCARTÉ du mélange s'il n'a rien différencié ───────────
  // Le test global vérifie que le classement du modèle est distinguable d'un
  // tirage au sort. Quand il échoue, la bonne réponse n'est plus de tout
  // bloquer : les cinq facteurs mécaniques restent parfaitement exploitables,
  // et s'en priver reviendrait à laisser une défaillance du modèle paralyser
  // des formules qui, elles, n'ont pas failli.
  //
  // On retire donc la seule colonne fautive. Le bot continue de décider, avec
  // un signal de moins et en le disant.
  const modeleInutilisable = listwise?.test && listwise.test.significatif === false;
  if (modeleInutilisable && noms.includes('llm') && noms.length > 1) {
    noms = noms.filter((n) => n !== 'llm');
    log.warn(
      `Classement du modèle non distinguable du hasard (p = ${listwise.test.p?.toFixed(3)}) — `
      + `écarté du mélange, décision prise sur ${noms.length} facteur(s) mécanique(s).`,
    );
  }

  // Dispersion transversale du momentum court : elle sert d'indicateur de
  // régime. Choisie plutôt que la volatilité de l'indice parce qu'elle se lit
  // sur les données déjà en mémoire, et parce que moduler quoi que ce soit
  // d'après la volatilité du MARCHÉ est précisément ce que la recherche
  // invalide. Ici on ne touche jamais à l'exposition — on choisit seulement
  // quel signal départage les actifs.
  const momentums = [...signaux.values()].map((s) => s.momentumCourt).filter(Number.isFinite);
  let dispersion = null;
  if (momentums.length > 5) {
    const m = momentums.reduce((a, b) => a + b, 0) / momentums.length;
    dispersion = Math.sqrt(momentums.reduce((a, b) => a + (b - m) ** 2, 0) / (momentums.length - 1));
  }
  const regime = poidsSelonRegime(dispersion);

  const resultat = combinerSignaux(signaux, {
    noms,
    stress: regime.stress,
    // Le retour à la moyenne est remis dans le sens du momentum, sans quoi
    // les deux s'annulent. Sa sensibilité au régime est NÉGATIVE : en
    // dislocation, il reprend son sens propre et s'oppose au momentum.
    orientations: { reversal: -1 },
    sensibiliteRegime: { reversal: -1 },
  });

  return {
    ...resultat,
    regime,
    signauxUtilises: noms,
    modeleEcarte: Boolean(modeleInutilisable && !noms.includes('llm')),
    testGlobalListwise: listwise?.test?.significatif ?? null,
  };
}
