/**
 * Calibration des probabilités annoncées par le modèle.
 *
 * ── La question à laquelle ce fichier répond ──────────────────────────────
 * Le SPRT dit si le bot a un avantage directionnel. Il ne dit RIEN sur la
 * qualité du nombre que le modèle place à côté de sa décision. Or ce nombre
 * pilote le dimensionnement des positions : s'il ne veut rien dire, on
 * surdimensionne exactement quand il faudrait se retenir.
 *
 * Deux façons distinctes de se tromper, qu'un taux de réussite global confond :
 *
 *   • MAUVAISE CALIBRATION — le modèle annonce 0,8 et a raison 55 % du temps.
 *     Le classement des décisions est bon, l'échelle est fausse. Réparable :
 *     il suffit de recalibrer (une transformation monotone suffit).
 *
 *   • ABSENCE DE RÉSOLUTION — le modèle annonce 0,8 sur les bonnes comme sur
 *     les mauvaises. Aucune information n'est portée par la confiance. Pas
 *     réparable par recalibration : il faut cesser de s'en servir pour
 *     dimensionner.
 *
 * La décomposition de Murphy sépare rigoureusement les deux :
 *
 *     Brier = fiabilité − résolution + incertitude
 *
 * `fiabilité` mesure l'erreur de calibration (0 = parfait), `résolution` le
 * pouvoir discriminant (plus grand = mieux), `incertitude` est la variance de
 * base du phénomène et ne dépend pas du modèle. Le score d'habileté rapporte
 * le gain net à cette incertitude : s'il est négatif, la confiance du modèle
 * fait pire que d'annoncer bêtement le taux de réussite moyen.
 *
 * ── Pourquoi c'est indispensable ici et pas décoratif ─────────────────────
 * Les LLM sont notoirement surconfiants en verbalisé — les valeurs se massent
 * sur des nombres ronds et élevés (0,7 / 0,8 / 0,9), un artefact du RLHF qui
 * récompense l'assurance. Sans cette mesure, on prendrait cette assurance pour
 * de l'information.
 */

/** Bornes des tranches de confiance. Larges : on aura peu d'observations. */
const DEFAULT_BINS = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];

/**
 * @param {Array<{p: number, y: 0|1}>} pairs  prévision et réalisation binaire
 * @param {number[]} edges                    bornes des tranches
 */
export function calibration(pairs, edges = DEFAULT_BINS) {
  const clean = pairs.filter((d) => Number.isFinite(d.p) && (d.y === 0 || d.y === 1));
  const n = clean.length;

  if (n < 10) {
    return {
      n,
      note: `${n} observation(s) — au moins 10 sont nécessaires pour que la calibration ait un sens.`,
    };
  }

  const brier = clean.reduce((acc, d) => acc + (d.p - d.y) ** 2, 0) / n;
  const baseRate = clean.reduce((acc, d) => acc + d.y, 0) / n;
  const uncertainty = baseRate * (1 - baseRate);

  // ── Tranches ────────────────────────────────────────────────────────────
  const bins = [];
  let reliability = 0;
  let resolution = 0;
  let ece = 0;
  let maxGap = 0;

  for (let b = 0; b < edges.length - 1; b += 1) {
    const lo = edges[b];
    const hi = edges[b + 1];
    const subset = clean.filter((d) => d.p >= lo && d.p < hi);
    if (!subset.length) continue;

    const w = subset.length / n;
    const meanP = subset.reduce((a, d) => a + d.p, 0) / subset.length;
    const meanY = subset.reduce((a, d) => a + d.y, 0) / subset.length;
    const gap = meanP - meanY;

    reliability += w * gap ** 2;
    resolution += w * (meanY - baseRate) ** 2;
    ece += w * Math.abs(gap);
    if (Math.abs(gap) > Math.abs(maxGap)) maxGap = gap;

    bins.push({
      range: `${lo.toFixed(1)}–${Math.min(hi, 1).toFixed(1)}`,
      n: subset.length,
      annonce: round(meanP, 3),
      realise: round(meanY, 3),
      // Positif = surconfiance (annonce plus que la réalité). C'est le sens
      // qui compte : la surconfiance fait surdimensionner, l'inverse fait
      // seulement rater des occasions.
      ecart: round(gap, 3),
    });
  }

  // Score d'habileté de Brier : (résolution − fiabilité) / incertitude.
  const skill = uncertainty > 0 ? (resolution - reliability) / uncertainty : null;
  const slope = calibrationSlope(bins, n, baseRate);

  return {
    n,
    brier: round(brier, 4),
    ece: round(ece, 4),
    // ── Pente de calibration ────────────────────────────────────────────
    // Le nombre le plus utile de tout ce fichier, et celui que le biais moyen
    // masque complètement.
    //
    // Le biais moyen s'annule quand la surconfiance est SYMÉTRIQUE : annoncer
    // 0,87 pour 0,77 réalisé et 0,12 pour 0,21 réalisé donne un biais moyen
    // quasi nul, alors que les deux extrêmes sont exagérés de 10 points. On
    // conclurait « équilibré » sur un modèle nettement surconfiant.
    //
    // La pente regarde autre chose : de combien les fréquences réalisées
    // s'écartent de la moyenne, comparé à ce que le modèle annonçait.
    //   • k < 1 → le modèle exagère ses écarts (surconfiance)
    //   • k ≈ 1 → l'échelle est bonne
    //   • k > 1 → il n'ose pas assez (sous-confiance)
    // Elle donne aussi le correctif : diviser les écarts annoncés par 1/k.
    penteDeCalibration: slope == null ? null : round(slope, 3),
    // Le biais moyen reste exposé, mais il ne répond qu'à « promet-il trop en
    // moyenne ? » — pas à « son échelle est-elle juste ? ».
    biaisMoyen: round(clean.reduce((a, d) => a + (d.p - d.y), 0) / n, 4),
    ecartMax: round(maxGap, 3),
    decomposition: {
      fiabilite: round(reliability, 5),
      resolution: round(resolution, 5),
      incertitude: round(uncertainty, 5),
    },
    tauxDeBase: round(baseRate, 4),
    scoreHabilete: skill == null ? null : round(skill, 4),
    verdict: verdictFor({ skill, reliability, resolution, uncertainty, n, ece, slope }),
    bins,
  };
}

/**
 * Pente d'une régression pondérée des fréquences réalisées sur les annoncées.
 * Chaque tranche pèse son effectif : une tranche à 5 observations ne doit pas
 * décider de la pente autant qu'une tranche à 400.
 */
function calibrationSlope(bins, n, baseRate) {
  if (bins.length < 2) return null;

  const w = bins.map((b) => b.n / n);
  const meanP = bins.reduce((a, b, i) => a + w[i] * b.annonce, 0);
  let num = 0;
  let den = 0;
  bins.forEach((b, i) => {
    num += w[i] * (b.annonce - meanP) * (b.realise - baseRate);
    den += w[i] * (b.annonce - meanP) ** 2;
  });
  return den > 1e-9 ? num / den : null;
}

/**
 * Traduction en langage clair — c'est ce qui sera lu, pas les nombres.
 * L'ordre des tests importe : l'absence de résolution rend la question de la
 * calibration sans objet, il faut donc la trancher d'abord.
 */
function verdictFor({ skill, reliability, resolution, uncertainty, n, ece, slope }) {
  if (n < 30) return 'Trop peu d\'observations pour conclure — indicatif seulement.';

  // Une résolution qui n'atteint pas 1 % de l'incertitude est du bruit.
  if (uncertainty > 0 && resolution < uncertainty * 0.01) {
    return 'Confiance NON INFORMATIVE : le modèle annonce la même chose quand il a raison et quand il a tort. '
      + 'Ne pas s\'en servir pour dimensionner les positions.';
  }

  if (skill != null && skill < 0) {
    return 'Confiance NUISIBLE : elle fait pire qu\'un taux fixe égal à la moyenne. '
      + 'La mauvaise calibration coûte plus que ce que le pouvoir discriminant rapporte.';
  }

  if (reliability > resolution) {
    return 'Confiance MAL CALIBRÉE mais discriminante : le classement des décisions est exploitable, '
      + 'l\'échelle non. Une recalibration (isotone) récupérerait le signal.';
  }

  // La comparaison fiabilité/résolution ne suffit pas à déclarer l'échelle
  // saine : une résolution élevée peut dominer une erreur de calibration bien
  // réelle. On regarde donc aussi l'écart moyen et la pente, sans quoi on
  // annoncerait « raisonnablement calibrée » sur un modèle qui exagère
  // systématiquement de 10 points à ses deux extrémités.
  if (slope != null && slope < 0.8) {
    return `Confiance SURCONFIANTE mais discriminante : le classement est bon, l'échelle est dilatée `
      + `(pente ${slope.toFixed(2)}). Les écarts annoncés devraient être divisés par `
      + `${(1 / slope).toFixed(1)} avant de servir à dimensionner.`;
  }

  if (slope != null && slope > 1.25) {
    return `Confiance TROP PRUDENTE : les écarts réels dépassent les annoncés (pente ${slope.toFixed(2)}). `
      + 'Le signal est sous-exploité.';
  }

  if (ece > 0.05) {
    return `Confiance DISCRIMINANTE, calibration imparfaite : ${(ece * 100).toFixed(1)} points d'écart moyen `
      + 'entre annoncé et réalisé, sans biais de dilatation identifiable.';
  }

  return 'Confiance EXPLOITABLE : discriminante et bien calibrée.';
}

const round = (v, d) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

export { DEFAULT_BINS };
