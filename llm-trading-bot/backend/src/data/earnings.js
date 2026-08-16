/**
 * Calendrier des publications de résultats, et fenêtre d'exclusion.
 *
 * ── Pourquoi ce filtre rapporte plus que n'importe quel signal ────────────
 * Détenir une action à travers sa publication de résultats n'est pas un pari
 * neutre, c'est un tirage à queues épaisses. La probabilité d'un saut de prix
 * atteint 13 % autour d'une date d'annonce, soit dix fois la normale, avec une
 * amplitude moyenne de l'ordre de 2,5 % dans un sens ou dans l'autre.
 *
 * Il existe bien une prime de risque associée à l'annonce — environ 15 points
 * de base — et sur un portefeuille très large, la détenir a une espérance
 * positive. Mais sur dix lignes, cette prime de 15 bps est intégralement
 * engloutie par une variance de 250 bps. On encaisse tout le risque pour une
 * fraction de la compensation.
 *
 * Et surtout : notre signal est technique. Il lit des prix, pas des comptes.
 * Il n'a strictement aucune capacité à prévoir une surprise sur les bénéfices,
 * donc rien à gagner à être exposé au moment où elle tombe. C'est du bruit
 * pur, ajouté à un signal faible.
 *
 * ── La fenêtre : [−5, +1] séances ────────────────────────────────────────
 * Elle est asymétrique, et les deux bornes ont des raisons différentes.
 *
 * Les cinq séances AVANT : la volatilité implicite monte continûment à
 * l'approche de l'annonce, les fourchettes s'élargissent, la liquidité se
 * retire des carnets et le comportement spéculatif domine. On exécuterait dans
 * une microstructure dégradée, en payant un spread anormal — exactement ce
 * qu'on cherche à éviter.
 *
 * Le jour même et le lendemain : c'est là qu'est le trou de cotation. On
 * laisse la découverte des prix absorber le choc avant de redevenir éligible.
 *
 * ── Ce que ce filtre NE fait pas ─────────────────────────────────────────
 * Il n'empêche pas de conserver une position déjà ouverte qui approche de ses
 * résultats — cette décision-là est prise ailleurs, dans le moteur, parce
 * qu'elle met en balance le coût de sortie contre le risque d'événement. Ici
 * on ne filtre que l'ÉLIGIBILITÉ À L'ACHAT, où l'abstention est gratuite.
 */

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getJson } from '../utils/http.js';

const log = createLogger('resultats');

/** Séances d'exclusion avant l'annonce. */
export const SEANCES_AVANT = 5;

/** Séances d'exclusion à partir de l'annonce incluse. */
export const SEANCES_APRES = 1;

/**
 * Marge en jours CALENDAIRES autour de la fenêtre en séances.
 *
 * On raisonne en séances mais on ne dispose ici que de dates calendaires. Cinq
 * séances peuvent couvrir neuf jours calendaires quand un week-end et un jour
 * férié s'intercalent. Convertir avec une marge suffisante est plus sûr que de
 * reconstruire un calendrier boursier complet pour un filtre dont le rôle est
 * d'être prudent.
 */
const JOURS_PAR_SEANCE = 1.45;

const MS_PAR_JOUR = 86_400_000;

/** Cache : le calendrier ne change pas plusieurs fois par jour. */
let cache = { at: 0, dates: new Map(), ok: false };
const TTL_MS = 6 * 3600 * 1000;

const jour = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Récupère les dates de publication sur une fenêtre glissante.
 *
 * Une seule requête couvre tout l'univers : l'API renvoie le calendrier du
 * marché entier sur la période, on n'interroge donc pas symbole par symbole.
 */
export async function chargerCalendrier({ force = false } = {}) {
  if (!force && cache.ok && Date.now() - cache.at < TTL_MS) return cache;

  if (!config.news.finnhubKey) {
    // ── Absence de source ≠ panne de source ───────────────────────────────
    // La distinction est ce qui empêche le filtre de transformer une erreur de
    // configuration en arrêt silencieux du bot.
    //
    // Une panne est temporaire : s'abstenir une journée ne coûte presque rien
    // et évite une mauvaise surprise. Une source jamais configurée est un état
    // PERMANENT : bloquer reviendrait à ne plus jamais rien acheter, en
    // affichant « prudence » là où il n'y a qu'un réglage manquant.
    //
    // On laisse donc passer, mais bruyamment. La protection est absente et
    // doit se voir — un filtre de risque qu'on croit actif alors qu'il ne
    // l'est pas est pire que pas de filtre du tout.
    log.warn(
      'FILTRE RÉSULTATS INACTIF : aucune clé Finnhub. Les positions peuvent être '
      + 'ouvertes à la veille d\'une publication. Renseigner FINNHUB_API_KEY (palier gratuit) pour l\'activer.',
    );
    cache = { at: Date.now(), dates: new Map(), ok: false, configure: false, raison: 'aucune source configurée' };
    return cache;
  }

  // Fenêtre large : on veut voir arriver les annonces avant qu'elles n'entrent
  // dans la zone d'exclusion, et garder celles qui viennent de passer.
  const debut = new Date(Date.now() - 10 * MS_PAR_JOUR);
  const fin = new Date(Date.now() + 40 * MS_PAR_JOUR);

  try {
    const qs = new URLSearchParams({
      from: jour(debut),
      to: jour(fin),
      token: config.news.finnhubKey,
    });
    const data = await getJson(`https://finnhub.io/api/v1/calendar/earnings?${qs}`, {
      timeoutMs: 15000,
      retries: 1,
    });

    const dates = new Map();
    for (const e of data?.earningsCalendar ?? []) {
      if (!e?.symbol || !e?.date) continue;
      const liste = dates.get(e.symbol) ?? [];
      liste.push(e.date);
      dates.set(e.symbol, liste);
    }

    cache = { at: Date.now(), dates, ok: true };
    log.info(`Calendrier des résultats : ${dates.size} sociétés entre ${jour(debut)} et ${jour(fin)}.`);
    return cache;
  } catch (err) {
    log.error(`Calendrier des résultats indisponible : ${err.message}`);
    // Source configurée mais injoignable : panne temporaire, on s'abstient.
    cache = { at: Date.now(), dates: new Map(), ok: false, configure: true, raison: err.message };
    return cache;
  }
}

/**
 * L'actif est-il dans sa fenêtre d'exclusion ?
 *
 * @returns {{exclu: boolean, date?: string, joursRestants?: number, raison: string}}
 */
export function fenetreResultats(symbol, calendrier = cache, maintenant = new Date()) {
  // ── Panne : on EXCLUT ───────────────────────────────────────────────────
  // La source existe mais ne répond pas. Bloquer coûte une journée
  // d'abstention — quasi rien avec une détention de 21 séances, le classement
  // de demain sera presque identique. Autoriser coûte, dans le pire cas, une
  // position ouverte la veille d'un saut de 2,5 %. On bloque.
  if (!calendrier?.ok && calendrier?.configure !== false) {
    return { exclu: true, raison: `calendrier des résultats indisponible (${calendrier?.raison ?? 'inconnu'})` };
  }

  // ── Jamais configuré : on LAISSE PASSER, sans faire semblant ────────────
  // Bloquer indéfiniment ne protégerait de rien, ça arrêterait le bot. Le
  // drapeau `protectionAbsente` remonte jusqu'au tableau de bord pour que
  // l'absence de filtre soit visible plutôt que supposée.
  if (calendrier?.configure === false) {
    return { exclu: false, protectionAbsente: true, raison: 'filtre résultats inactif (aucune source configurée)' };
  }

  const dates = calendrier.dates.get(symbol);
  if (!dates?.length) return { exclu: false, raison: 'aucune publication annoncée' };

  const avant = SEANCES_AVANT * JOURS_PAR_SEANCE;
  const apres = SEANCES_APRES * JOURS_PAR_SEANCE;

  // ── On compare des DATES, pas des instants ──────────────────────────────
  // La version précédente divisait un écart de millisecondes par 86 400 000,
  // ce qui rendait la frontière dépendante de l'heure d'exécution : une action
  // publiant la veille donnait −1,33 jour à 8 h du matin — donc exclue — et
  // −1,54 à 13 h — donc éligible. Le même titre, le même jour, deux verdicts
  // opposés selon l'heure du cycle.
  //
  // En ramenant les deux dates à minuit UTC, « hier » vaut exactement −1,
  // toujours.
  const aujourdhui = Date.parse(`${jour(maintenant)}T00:00:00Z`);

  for (const d of dates) {
    const annonce = Date.parse(`${d}T00:00:00Z`);
    if (Number.isNaN(annonce)) continue;

    const ecartJours = Math.round((annonce - aujourdhui) / MS_PAR_JOUR);

    // Positif = l'annonce est à venir ; négatif = elle est passée.
    if (ecartJours <= avant && ecartJours >= -apres) {
      return {
        exclu: true,
        date: d,
        joursRestants: Math.round(ecartJours),
        raison: ecartJours >= 0
          ? `publication de résultats dans ${Math.max(Math.round(ecartJours), 0)} jour(s)`
          : `résultats publiés il y a ${Math.abs(Math.round(ecartJours))} jour(s)`,
      };
    }
  }

  return { exclu: false, raison: 'hors fenêtre de publication' };
}

/**
 * Filtre un univers entier. Retourne les éligibles et le détail des exclusions,
 * pour que le tableau de bord puisse expliquer une abstention au lieu de la
 * subir.
 */
export async function filtrerResultats(symbols) {
  const calendrier = await chargerCalendrier();
  const eligibles = [];
  const exclus = new Map();

  for (const symbol of symbols) {
    const r = fenetreResultats(symbol, calendrier);
    if (r.exclu) exclus.set(symbol, r);
    else eligibles.push(symbol);
  }

  if (exclus.size) {
    log.info(
      `${exclus.size} actif(s) écarté(s) pour cause de résultats : `
      + [...exclus.keys()].slice(0, 12).join(', ') + (exclus.size > 12 ? '…' : ''),
    );
  }

  return {
    eligibles,
    exclus,
    calendrierDisponible: calendrier.ok,
    // Vrai quand le filtre est purement décoratif : aucune source configurée.
    protectionAbsente: calendrier.configure === false,
  };
}

/** Réinitialise le cache. Réservé aux tests. */
export function _resetCache() {
  cache = { at: 0, dates: new Map(), ok: false };
}
