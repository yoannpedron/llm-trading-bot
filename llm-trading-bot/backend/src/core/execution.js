/**
 * Contrôles d'exécution : QUAND acheter, et à quel prix on refuse de le faire.
 *
 * Ces deux filtres ne cherchent aucun signal. Ils réduisent une friction qu'on
 * paie à coup sûr, ce qui en fait le seul rendement du bot qui ne dépende
 * d'aucune prédiction.
 */

import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('execution');

/**
 * Heure de New York, sans dépendance externe.
 *
 * `Intl` connaît les règles de l'heure d'été américaine, qui ne coïncident pas
 * avec les européennes : recalculer un décalage fixe à la main produirait une
 * erreur d'une heure plusieurs semaines par an, exactement aux bornes de la
 * fenêtre qu'on cherche à respecter.
 */
export function heureNewYork(date = new Date()) {
  const parties = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);

  const get = (type) => parties.find((p) => p.type === type)?.value;
  return {
    heure: Number(get('hour')),
    minute: Number(get('minute')),
    jour: get('weekday'),
  };
}

/**
 * Sommes-nous dans la fenêtre où le spread est au plus bas ?
 *
 * Ne s'applique qu'aux OUVERTURES. Une sortie ne se reporte jamais : elle peut
 * répondre à un coupe-circuit, et retarder une protection pour économiser deux
 * points de base inverserait les priorités.
 */
export function fenetreExecution(date = new Date(), limites = config.risk) {
  const { heure, minute, jour } = heureNewYork(date);
  const debut = limites.executionStartHourET;
  const fin = limites.executionEndHourET;

  if (jour === 'Sat' || jour === 'Sun') {
    return { ouverte: false, heureET: `${heure}:${String(minute).padStart(2, '0')}`, raison: 'week-end' };
  }

  const ouverte = heure >= debut && heure < fin;
  return {
    ouverte,
    heureET: `${heure}:${String(minute).padStart(2, '0')}`,
    fenetre: `${debut}:00–${fin}:00 ET`,
    raison: ouverte
      ? 'milieu de séance, spread au plus bas'
      : heure < debut
        ? `ouverture trop récente (avant ${debut} h ET, le spread est 2 à 4 fois plus large)`
        : `trop proche de la clôture (après ${fin} h ET, la volatilité directionnelle remonte)`,
  };
}

/**
 * Le spread de cet actif est-il tolérable ?
 *
 * @param {number} spreadBps  spread courant, en points de base
 */
/**
 * Au-delà de ce spread, la cotation n'est plus une information sur le coût :
 * c'est un défaut de mesure.
 *
 * Le palier gratuit ne donne accès qu'au flux IEX, une place unique à environ
 * 2 % de part de marché. Ses cotations sont régulièrement larges ou périmées.
 * Mesuré en séance sur notre propre univers : META à 118 bps, AVGO à 88, TSLA
 * à 63 — pour des mégacapitalisations dont l'écart réel tient dans 1 à 5 bps.
 *
 * Un relevé à 118 bps sur META ne dit pas que META coûte cher. Il dit que le
 * flux est inexploitable sur cet actif. Traiter les deux cas de la même façon
 * reviendrait à retirer les plus grosses valeurs de l'univers pour une raison
 * fausse — et sans que rien ne le signale.
 */
const SPREAD_INVRAISEMBLABLE_BPS = 50;

export function spreadAcceptable(spreadBps, limites = config.risk) {
  // Spread inconnu : on laisse passer. Refuser sur une donnée manquante
  // reviendrait à écarter les actifs dont le fournisseur de cotation est
  // muet, ce qui n'est pas une information sur leur coût.
  if (spreadBps == null || !Number.isFinite(spreadBps)) {
    return { acceptable: true, spreadBps: null, raison: 'spread inconnu' };
  }

  const plafond = limites.maxSpreadBps;

  // ── Spread nul ou négatif : cotation cassée, pas cotation parfaite ───────
  // Un spread négatif signifie que la demande est passée sous l'offre. C'est
  // physiquement impossible sur un marché ordinaire : la valeur trahit une
  // cotation incomplète, typiquement une offre à zéro.
  //
  // Relevé en séance sur le flux IEX, le 16 août 2026 : META, AAPL et NVDA
  // renvoyaient tous les trois −20 000 bps. Sans cette branche, le filtre les
  // déclarait « sous le plafond de 7 » — il annonçait un spread excellent là
  // où il n'avait aucune cotation. Trois des plus grosses valeurs de
  // l'univers, avec un motif rassurant et faux.
  //
  // La DÉCISION ne change pas : on laisse passer, comme pour toute mesure
  // inexploitable. Ce qui change, c'est qu'on cesse de prétendre avoir mesuré.
  if (spreadBps <= 0) {
    return {
      acceptable: true,
      spreadBps,
      mesureDouteuse: true,
      raison: `spread ${spreadBps.toFixed(1)} bps impossible — cotation incomplète, aucune mesure exploitable`,
    };
  }

  // Mesure aberrante : on ne peut rien en conclure sur le coût. On laisse
  // passer et on le signale, plutôt que d'exclure un actif liquide sur une
  // cotation défaillante.
  if (spreadBps > SPREAD_INVRAISEMBLABLE_BPS) {
    return {
      acceptable: true,
      spreadBps,
      mesureDouteuse: true,
      raison: `spread ${spreadBps.toFixed(1)} bps invraisemblable — flux de cotation défaillant, non un coût réel`,
    };
  }

  const acceptable = spreadBps <= plafond;

  return {
    acceptable,
    spreadBps,
    plafond,
    // Le spread n'est payé QU'UNE FOIS sur l'aller-retour : on achète à l'ask
    // et on revend au bid, soit un écart total d'un spread plein. Je l'avais
    // doublé ici, en contradiction avec `roundTripCost` qui documente
    // explicitement la convention. Le seuil de décision était juste, le chiffre
    // affiché deux fois trop grand.
    coutAllerRetourBps: spreadBps,
    raison: acceptable
      ? `spread ${spreadBps.toFixed(2)} bps, sous le plafond de ${plafond}`
      : `spread ${spreadBps.toFixed(2)} bps > ${plafond} — l'aller-retour coûterait ${spreadBps.toFixed(1)} bps`,
  };
}

/**
 * Filtre les candidats à l'achat sur leur coût d'exécution.
 *
 * @param {Map<string, number>} spreads  symbole → spread en bps
 */
export function filtrerParSpread(candidats, spreads, limites = config.risk) {
  const retenus = new Set();
  const ecartes = new Map();

  for (const symbol of candidats) {
    const r = spreadAcceptable(spreads?.get(symbol), limites);
    if (r.acceptable) retenus.add(symbol);
    else ecartes.set(symbol, r);
  }

  if (ecartes.size) {
    log.info(
      `${ecartes.size} candidat(s) écarté(s) pour spread excessif : `
      + [...ecartes.entries()].map(([s, r]) => `${s} (${r.spreadBps.toFixed(1)} bps)`).join(', '),
    );
  }

  return { retenus, ecartes };
}
