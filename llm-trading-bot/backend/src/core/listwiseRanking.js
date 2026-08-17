/**
 * Classement transversal par comparaison.
 *
 * ── Ce que ce module remplace ─────────────────────────────────────────────
 * Le bot demandait au modèle de NOTER chaque actif isolément, puis triait les
 * notes. Mesuré sur l'API réelle : trois valeurs distinctes sur vingt réponses
 * — 35, 40, 45. Jamais 37, jamais 41.
 *
 * Transposé à 150 actifs, cela donne une cinquantaine d'ex æquo au sommet, et
 * le tri les laisse dans l'ordre d'arrivée. Le bot n'achetait pas les dix
 * meilleures actions sur cent cinquante : il achetait les dix premières du
 * fichier de configuration parmi les ex æquo. Toute la stratégie transversale
 * reposait sur l'ordre alphabétique.
 *
 * La garde de dispersion ne rattrapait rien : elle mesure la largeur de la
 * distribution des notes, pas le nombre d'actifs collés sur chacune. Trois
 * valeurs bien écartées lui suffisent.
 *
 * ── Le principe du remplacement ──────────────────────────────────────────
 * On cesse de demander des nombres. Le modèle reçoit dix actifs et les
 * ORDONNE : il ne produit aucune valeur numérique, donc plus rien à arrondir,
 * donc plus d'ex æquo. Quatre tours de lots re-tirés au hasard donnent un
 * réseau de comparaisons qui se recoupent, et le modèle de Plackett-Luce
 * reconstitue une force latente continue pour chaque actif.
 *
 * Vérifié sur données réelles : dix rangs distincts sur dix, et une
 * concordance de 0,95 à 0,99 entre trois ordres de présentation différents.
 *
 * ── Et c'est moins cher ──────────────────────────────────────────────────
 * 60 appels par cycle au lieu de 150.
 */

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { construireLots, positionsMoyennes, biaisDePosition } from './batching.js';
import {
  ajusterPlackettLuce, classementDepuisAjustement, calibrerNulle, testGlobal,
} from './plackettLuce.js';
import { pseudonymesUniques, trancheTaille } from '../llm/pseudonyms.js';
import {
  buildListwisePrompt, buildListwiseSchema, LISTWISE_SYSTEM_PROMPT, validerClassement,
} from '../llm/listwisePrompt.js';
import { anonymizeNews } from '../llm/anonymize.js';
import { sectorOf } from '../data/universe.js';

const log = createLogger('classement');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Traduit un rang en décision exploitable par le reste du moteur.
 *
 * ── Ce qu'on ne fait PAS ─────────────────────────────────────────────────
 * On ne fabrique aucune probabilité. Le modèle n'en a annoncé aucune : il a
 * produit un ordre. Inventer un « 62 % de chances de surperformer » à partir
 * d'une force latente reviendrait à réintroduire par la porte de derrière le
 * chiffre qu'on vient de supprimer, et le carnet de calibration mesurerait
 * alors nos conversions au lieu des convictions du modèle.
 *
 * ── Et pourquoi `confidence` reste NULLE ─────────────────────────────────
 * La tentation était d'y mettre le rang fractionnaire — il vit dans [0, 1] et
 * remplit le champ sans effort. C'est précisément le piège.
 *
 * Ce champ alimente le module de calibration, dont le rôle est de vérifier
 * qu'« annoncer 0,8 » correspond bien à « avoir raison 80 % du temps ». Lui
 * donner un rang produirait une courbe de calibration parfaitement lisible et
 * entièrement fausse : on mesurerait la position d'un actif dans une liste
 * comme si c'était une probabilité annoncée. Une mesure absente se voit ; une
 * mesure fausse mais crédible se propage.
 *
 * Le modèle n'annonce plus aucune probabilité depuis qu'il ordonne. Le champ
 * reste donc vide, et la calibration le signalera comme indisponible plutôt
 * que d'inventer un résultat. Le rang est publié à part, sous son vrai nom.
 *
 * Le poids reste égal quel que soit le rang. Dimensionner à proportion de la
 * force latente reviendrait à croire à un ordre que la précision du signal ne
 * soutient pas — l'écart-type d'un λ est du même ordre que l'écart entre deux
 * actifs voisins.
 */
/**
 * ── Pourquoi le sentiment de presse n'est plus « INDISPONIBLE » ───────────
 * Ce champ valait `INDISPONIBLE` en dur, et le dashboard affichait donc
 * « Presse : INDISPONIBLE » juste au-dessus de huit articles correctement
 * récupérés. Le lecteur en concluait que le flux d'actualités avait échoué.
 *
 * Il n'avait pas échoué. Ce qui a changé, c'est que le modèle CLASSE au lieu
 * de noter : il ne rend plus de sentiment par actif, il rend un ordre. La
 * presse est donc collectée, envoyée dans le prompt, et prise en compte dans
 * le classement — mais elle n'est plus résumée en un mot par titre.
 *
 * `NON_EVALUE` dit cela. `INDISPONIBLE` reste réservé au vrai cas où aucun
 * article n'a pu être récupéré, ce qui est une information différente et qui
 * mérite d'être distinguable.
 */
export function decisionDepuisRang(info, { test = null, articles = null } = {}) {
  const sentiment = articles == null
    ? 'NON_EVALUE'
    : (articles.length > 0 ? 'NON_EVALUE' : 'INDISPONIBLE');

  if (!info) {
    return {
      action: 'HOLD', confidence: null, sizePct: 0, rankFractional: null,
      justification: 'absent du classement transversal de ce cycle.',
      newsSentiment: sentiment, forecast: { edge: 0 },
    };
  }

  const significatif = test?.significatif !== false;
  const marge = Number.isFinite(info.se) ? ` ± ${info.se.toFixed(2)}` : '';

  return {
    // L'action réelle est décidée par la sélection transversale en aval ; ce
    // champ n'est qu'un avis de départ.
    action: 'HOLD',
    confidence: null,
    // Nom aligné sur la colonne déjà persistée par le carnet fantôme.
    rankFractional: info.fractional,
    sizePct: 1,
    justification:
      `Rang ${info.rank} sur ${info.total} (force ${info.lambda.toFixed(3)}${marge})`
      + (significatif ? '.' : ", classement non significatif à ce cycle."),
    newsSentiment: sentiment,
    // `edge` porte désormais la FORCE du classement, pas un écart de
    // probabilité. Les deux champs `rang` et `total` sont publiés à côté pour
    // que l'affichage n'ait plus à deviner l'échelle : un écart de probabilité
    // se lisait en points sur 100, une force de Plackett-Luce n'a pas d'unité.
    forecast: { edge: info.lambda, echelle: 'force' },
    lambda: info.lambda,
    se: info.se,
    rang: info.rank,
    total: info.total,
  };
}

/** Rendement sur n séances, tel qu'affiché au modèle. */
function rendement(candles, n) {
  if (!candles || candles.length < n + 1) return null;
  const fin = candles[candles.length - 1].close;
  const debut = candles[candles.length - 1 - n].close;
  return debut > 0 && fin > 0 ? fin / debut - 1 : null;
}

/** Situe le prix dans sa fourchette récente, sans l'interpréter. */
function contexteMarche(candles, indicators) {
  const out = {};
  if (!candles?.length) return out;

  const fenetre = candles.slice(-60);
  const closes = fenetre.map((c) => c.close).filter((v) => v > 0);
  if (closes.length >= 20 && indicators.price > 0) {
    const dessous = closes.filter((v) => v < indicators.price).length;
    out.range = `${Math.round((dessous / closes.length) * 100)}ᵉ centile de sa fourchette ${closes.length} séances`;
  }

  if (indicators.ema20 != null && indicators.ema50 > 0) {
    const ecart = ((indicators.ema20 - indicators.ema50) / indicators.ema50) * 100;
    out.trend = `écart EMA20/EMA50 ${ecart >= 0 ? '+' : ''}${ecart.toFixed(2)} %`;
  }
  return out;
}

/**
 * Prépare la fiche d'un actif, pseudonymisée.
 *
 * Le secteur et la tranche de taille sont donnés EN CLAIR. Ils n'identifient
 * personne — une vingtaine de sociétés partagent chaque case — et sans eux le
 * modèle ne peut pas pondérer un événement : une acquisition de 50 M$ n'a pas
 * le même sens pour une méga-capitalisation que pour une société dix fois plus
 * petite. C'est le contexte que le masquage détruisait sans nécessité.
 */
export function ficheActif(symbol, { snapshot, news, etiquette }) {
  const anonymise = config.news.anonymize
    ? anonymizeNews(news, symbol)
    : { articles: news?.articles ?? [] };

  return {
    symbol,
    etiquette,
    secteur: sectorOf(symbol),
    taille: trancheTaille(snapshot?.marketCap ?? null),
    indicateurs: snapshot?.indicators ?? {},
    rendement5j: rendement(snapshot?.candles, 5),
    contexte: contexteMarche(snapshot?.candles, snapshot?.indicators ?? {}),
    actualites: anonymise.articles,
  };
}

/**
 * Soumet un lot au modèle et retourne l'ordre validé.
 */
async function classerUnLot(lot, fiches, { provider }) {
  const membres = lot.membres.map((s) => fiches.get(s)).filter(Boolean);
  if (membres.length < 2) return null;

  const etiquettes = membres.map((m) => m.etiquette);
  const prompt = buildListwisePrompt(membres);

  const brut = await provider.decide(prompt, {
    schema: buildListwiseSchema(etiquettes),
    systemPrompt: LISTWISE_SYSTEM_PROMPT,
  });

  const parsed = typeof brut.raw === 'string' ? JSON.parse(brut.raw) : brut.raw;
  const valide = validerClassement(parsed, etiquettes);
  if (!valide.ok) {
    log.warn(`Lot ${lot.id} rejeté : ${valide.raison}`);
    return null;
  }

  // Retour aux symboles réels : le reste du moteur ne connaît pas les
  // pseudonymes, et ne doit pas les connaître.
  const parEtiquette = new Map(membres.map((m) => [m.etiquette, m.symbol]));
  const ordre = valide.ordre.map((e) => parEtiquette.get(e)).filter(Boolean);

  return {
    id: lot.id,
    tour: lot.tour,
    order: ordre,
    partiel: valide.partiel,
    separation: valide.separation,
    analyse: valide.analyse,
    tokens: brut.usage?.totalTokenCount ?? null,
  };
}

/**
 * Classe l'univers entier.
 *
 * @param {Map<string, object>} donnees  symbole → { snapshot, news }
 * @param {object} options
 * @returns {{ranks: Map, evaluations: Array, test: object, diagnostics: object}}
 */
export async function classerUnivers(donnees, {
  provider,
  taille = config.ranking.tailleLot,
  tours = config.ranking.tours,
  graine = Date.now(),
  cooldownMs = config.llm.cooldownMs,
  onProgress = null,
} = {}) {
  const symboles = [...donnees.keys()];
  const { lots } = construireLots(symboles, { taille, tours, graine });

  if (!lots.length) {
    return {
      ranks: new Map(), evaluations: [], test: null,
      diagnostics: { raison: 'aucun lot constructible', lots: 0, reussis: 0 },
    };
  }

  // Un pseudonyme par actif, garanti unique — deux actifs portant le même nom
  // dans un lot rendraient le classement inattribuable.
  const etiquettes = pseudonymesUniques(symboles);
  const fiches = new Map(
    symboles.map((s) => [s, ficheActif(s, { ...donnees.get(s), etiquette: etiquettes.get(s) })]),
  );

  const classements = [];
  const echecs = [];
  let separationsNulles = 0;

  for (let i = 0; i < lots.length; i += 1) {
    if (i > 0 && cooldownMs > 0) await sleep(cooldownMs);
    onProgress?.({ phase: 'classement', lot: i + 1, total: lots.length });

    try {
      const r = await classerUnLot(lots[i], fiches, { provider });
      if (r) {
        classements.push(r);
        if (r.separation === 'AUCUNE') separationsNulles += 1;
      } else {
        echecs.push({ lot: lots[i].id, raison: 'réponse invalide' });
      }
    } catch (err) {
      echecs.push({ lot: lots[i].id, raison: err.message });
      log.warn(`Lot ${lots[i].id} échoué : ${err.message}`);
    }
  }

  if (classements.length < 2) {
    return {
      ranks: new Map(), evaluations: [], test: null,
      diagnostics: { raison: `seulement ${classements.length} lot(s) exploitable(s)`, lots: lots.length, reussis: classements.length, echecs },
    };
  }

  // ── Reconstruction de la force latente ─────────────────────────────────
  const fit = ajusterPlackettLuce(classements);

  // ── Le classement porte-t-il une information ? ─────────────────────────
  // La nulle est simulée sur la STRUCTURE RÉELLE des lots : sous l'hypothèse
  // que le modèle ne différencie rien, toutes les permutations d'un lot sont
  // équiprobables. Aucun appel d'API, uniquement du calcul.
  //
  // L'approximation du χ² rejetait 23 % du temps à tort à cette taille — 150
  // paramètres pour 540 observations. Le bootstrap ramène le taux à 4 %.
  const nulle = calibrerNulle(classements.map((c) => c.order), {
    tirages: config.ranking.tiragesBootstrap,
  });
  const test = testGlobal(fit, { referenceNulle: nulle });

  const classement = classementDepuisAjustement(fit, { maxSelected: config.risk.maxPositions });

  // ── Diagnostic de biais de position ────────────────────────────────────
  // Attendu nul. Une corrélation marquée signifierait que le classement
  // mesure en partie l'ordre dans lequel on a posé la question.
  const positions = positionsMoyennes(lots);
  const biais = biaisDePosition(classement.ranks, positions);

  // Le reste du moteur consomme des `evaluations` : on lui en fabrique, avec
  // la force latente en guise d'écart. Aucun ex æquo par construction.
  const evaluations = classement.lignes.map((l) => ({
    symbol: l.symbol,
    evaluated: true,
    decision: {
      forecast: { edge: l.lambda },
      lambda: l.lambda,
      se: l.se,
    },
  }));

  const valeursDistinctes = new Set(classement.lignes.map((l) => l.lambda.toFixed(6))).size;

  // Décisions synthétisées : le reste du moteur — validation du risque,
  // journal, carnet fantôme — attend la forme produite par l'ancienne
  // notation. On la reconstitue à partir du rang, sans inventer de
  // probabilité que personne n'a annoncée.
  for (const e of evaluations) {
    const info = classement.ranks.get(e.symbol);
    // Les articles servent à distinguer « presse non résumée par actif » de
    // « aucune presse récupérée » — deux situations que le champ confondait.
    const articles = donnees.get(e.symbol)?.news?.articles ?? null;
    e.decision = { ...e.decision, ...decisionDepuisRang(info, { test, articles }) };
  }

  log.info(
    `Classement sur ${classement.lignes.length} actifs — ${classements.length}/${lots.length} lots, `
    + `${valeursDistinctes} valeurs distinctes, `
    + `test global p=${test.p?.toFixed(3) ?? 'n/d'} (${test.significatif ? 'DIFFÉRENCIE' : 'ne différencie pas'})`,
  );

  return {
    ranks: classement.ranks,
    evaluations,
    test,
    fit,
    classements,
    diagnostics: {
      lots: lots.length,
      reussis: classements.length,
      echecs,
      appelsConsommes: lots.length,
      valeursDistinctes,
      // Ce que le modèle dit lui-même de sa capacité à séparer les actifs.
      separationsNulles,
      partAveugle: classements.length ? separationsNulles / classements.length : null,
      connexe: fit.connexe,
      convergence: fit.converge,
      biaisDePosition: biais.correlation,
      wald: classement.wald,
    },
  };
}
