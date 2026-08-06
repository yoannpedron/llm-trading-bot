/**
 * Phase calendaire intra-mensuelle (Turn-of-the-Month).
 *
 * ── Pourquoi ce module existe, et pourquoi il n'y a PAS de stratégie ──────
 * L'effet TOM directionnel sur SPY est aujourd'hui statistiquement
 * invalidable : rendement moyen tombé à ~0,12 % par occurrence pour un
 * écart-type monté à ~2,4 %, soit ~384 mois (32 ans) d'observations pour le
 * distinguer du bruit à 95 %. Coder une stratégie qu'on ne pourra jamais
 * évaluer n'aurait aucun sens.
 *
 * En revanche le MÉCANISME est établi, et de façon causale : le passage au
 * règlement T+1 en mai 2024 a déplacé le pic de vente institutionnelle de T-4
 * à T-3, chirurgicalement. Ce n'est pas de la psychologie de foule, c'est de la
 * plomberie de règlement-livraison.
 *
 * On se contente donc d'INFORMER le LLM de la phase courante. Ça ne coûte
 * aucun appel supplémentaire, et le carnet fantôme mesurera ensuite si cette
 * information change quoi que ce soit à la qualité des décisions. Si non, on
 * supprime quinze lignes.
 *
 * Repère : T = dernier jour de BOURSE du mois (pas le dernier jour calendaire).
 *   PreTOM  = [T-9, T-3]  liquidation institutionnelle (dash-for-cash)
 *   TOM     = [T-1, T+3]  rebond post-liquidation + flux entrants
 *
 * La fenêtre académique originale (Nathan et al.) est [T-9, T-4], calibrée sous
 * le régime de règlement T+2. On l'étend à T-3 parce que le passage à T+1 a
 * décalé le pic d'un jour : une institution ayant besoin de cash à la fin du
 * mois dispose désormais d'un jour de flexibilité supplémentaire. Garder la
 * borne à T-4 exclurait précisément le jour où la pression est maximale.
 */

/** Jours fériés boursiers américains (NYSE), format YYYY-MM-DD. */
const US_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

const iso = (d) => d.toISOString().slice(0, 10);

function isTradingDay(date) {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6 && !US_HOLIDAYS.has(iso(date));
}

/** Liste ordonnée des jours de bourse d'un mois donné. */
function tradingDaysOfMonth(year, month) {
  const days = [];
  const cursor = new Date(Date.UTC(year, month, 1));
  while (cursor.getUTCMonth() === month) {
    if (isTradingDay(cursor)) days.push(iso(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Position d'une date dans le cycle intra-mensuel.
 *
 * @returns {{offset:number, phase:string, label:string, note:string}}
 *   `offset` négatif = jours de bourse avant la fin du mois (T-1 = dernier jour)
 *   `offset` positif = n-ième jour de bourse du nouveau mois
 */
export function calendarPhase(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const today = iso(d);

  const current = tradingDaysOfMonth(d.getUTCFullYear(), d.getUTCMonth());
  const indexInMonth = current.indexOf(today);

  // Jour férié ou week-end : aucune phase exploitable.
  if (indexInMonth === -1) {
    return { offset: null, phase: 'NEUTRAL', label: 'hors séance', note: '' };
  }

  const daysFromEnd = current.length - indexInMonth; // 1 = dernier jour du mois
  const offset = indexInMonth < 3 ? indexInMonth + 1 : -daysFromEnd;

  // Fenêtre TOM : les 3 premiers jours du mois, plus le dernier du précédent.
  if (offset >= 1 && offset <= 3) {
    return {
      offset,
      phase: 'TOM',
      label: `T+${offset}`,
      note:
        'Fenêtre Turn-of-the-Month. Le rebond post-liquidation se combine aux flux ' +
        'entrants inélastiques (salaires, plans de retraite, dividendes réinvestis). ' +
        'Historiquement haussière, mais l\'effet s\'accumule surtout en overnight ' +
        '(clôture→ouverture) et non en séance.',
    };
  }
  if (offset === -1) {
    return {
      offset,
      phase: 'TOM',
      label: 'T-1',
      note:
        'Dernier jour de bourse du mois. Fin de la pression vendeuse institutionnelle ' +
        'et habillage de portefeuille de dernière minute.',
    };
  }

  // Fenêtre PreTOM : liquidation pour lever du cash réglé.
  if (offset <= -3 && offset >= -9) {
    const peak = offset === -3 || offset === -4;
    return {
      offset,
      phase: 'PRE_TOM',
      label: `T${offset}`,
      note:
        'Fenêtre PreTOM. Les institutions liquident pour disposer de liquidités réglées ' +
        'en fin de mois, en ciblant prioritairement les titres récemment perdants. ' +
        'Une baisse observée ici peut être NON-INFORMATIONNELLE : elle reflète un besoin ' +
        'de trésorerie, pas une dégradation des fondamentaux.' +
        (peak ? ' Pic de liquidation attendu (déplacé de T-4 vers T-3 depuis le règlement T+1 en mai 2024).' : ''),
    };
  }

  return {
    offset,
    phase: 'NEUTRAL',
    label: offset > 0 ? `T+${offset}` : `T${offset}`,
    note: 'Hors fenêtre de fin de mois. Aucun flux calendaire structurel attendu.',
  };
}

/** Bloc prêt à insérer dans le prompt. Vide si la phase n'apporte rien. */
export function calendarPromptBlock(date = new Date()) {
  const phase = calendarPhase(date);
  if (phase.phase === 'NEUTRAL') return '';
  return `## CONTEXTE CALENDAIRE\nJour de bourse ${phase.label}, phase ${phase.phase}.\n${phase.note}`;
}
