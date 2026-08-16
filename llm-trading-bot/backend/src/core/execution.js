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
export function spreadAcceptable(spreadBps, limites = config.risk) {
  // Spread inconnu : on laisse passer. Refuser sur une donnée manquante
  // reviendrait à écarter les actifs dont le fournisseur de cotation est
  // muet, ce qui n'est pas une information sur leur coût.
  if (spreadBps == null || !Number.isFinite(spreadBps)) {
    return { acceptable: true, spreadBps: null, raison: 'spread inconnu' };
  }

  const plafond = limites.maxSpreadBps;
  const acceptable = spreadBps <= plafond;

  return {
    acceptable,
    spreadBps,
    plafond,
    // Ce qu'il en coûterait réellement : le spread se paie à l'aller ET au
    // retour.
    coutAllerRetourBps: spreadBps * 2,
    raison: acceptable
      ? `spread ${spreadBps.toFixed(2)} bps, sous le plafond de ${plafond}`
      : `spread ${spreadBps.toFixed(2)} bps > ${plafond} — l'aller-retour coûterait ${(spreadBps * 2).toFixed(1)} bps`,
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
