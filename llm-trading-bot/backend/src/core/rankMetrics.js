/**
 * Mesures fondées sur le RANG, et non sur le niveau des probabilités.
 *
 * ── Pourquoi un fichier séparé de calibration.js ──────────────────────────
 * `calibration.js` répond à « 0,70 veut-il dire 70 % ? ». C'est une question
 * sur le NIVEAU. Le bot ne s'en sert plus pour décider : depuis le passage au
 * classement transversal et au poids égal, seul l'ORDRE des prévisions pilote
 * quoi que ce soit.
 *
 * Il faut donc mesurer la propriété dont dépend réellement la stratégie, et
 * c'est une propriété différente. Un modèle peut être massivement mal calibré
 * en niveau — annoncer 0,80 partout — tout en ordonnant correctement les
 * actifs entre eux. Dans ce cas `calibration.js` affiche un désastre et la
 * stratégie fonctionne. L'inverse existe aussi : des probabilités
 * impeccablement calibrées en moyenne mais dont l'ordre, un jour donné, ne
 * distingue rien.
 *
 * Deux mesures ici, qui répondent à deux questions distinctes :
 *
 *   • RANK IC — « l'ordre annoncé correspond-il à l'ordre réalisé ? »
 *     C'est la corrélation de rang, calculée TRANSVERSALEMENT (à l'intérieur
 *     d'une même journée), puis moyennée. C'est le nombre qui décide si le
 *     module de classement a une raison d'exister.
 *
 *   • RCE — « un rang meilleur donne-t-il un résultat meilleur ? »
 *     Le Rank IC peut être positif tout en cachant des inversions locales :
 *     par exemple un modèle excellent aux extrêmes et inversé au milieu. Le
 *     RCE mesure exactement ces violations de monotonie.
 */

/**
 * Corrélation de rang de Spearman entre prévision et réalisation, calculée
 * jour par jour puis agrégée.
 *
 * ── Pourquoi transversalement et pas sur tout l'échantillon ───────────────
 * Mélanger les jours introduirait le facteur marché : un jour où tout monte,
 * toutes les réalisations sont positives, et une corrélation calculée sur le
 * paquet mesurerait surtout « le modèle était-il haussier les jours de
 * hausse ? ». Ce n'est pas de la sélection de titres, c'est du market timing —
 * une autre compétence, qu'on ne teste pas ici.
 *
 * À l'intérieur d'un même jour, le facteur marché est commun à tous les actifs
 * et disparaît du classement. Ce qui reste est la capacité à départager.
 *
 * ── Pourquoi la moyenne des IC quotidiens, et pas un IC global ────────────
 * Parce que la dispersion des IC quotidiens EST l'information : un IC moyen de
 * 0,05 obtenu avec un écart-type de 0,40 n'est pas distinguable de zéro. Le
 * t-stat le dit, la moyenne seule ne le dit pas.
 *
 * @param {Array<{day: string, symbol: string, predicted: number, realized: number}>} rows
 * @param {object} [options]
 * @param {number} [options.minPerDay=3] actifs minimum pour qu'un jour compte
 */
export function rankIC(rows, { minPerDay = 3, horizon = 3 } = {}) {
  const byDay = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.predicted) || !Number.isFinite(r.realized)) continue;
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }

  const daily = [];
  let discarded = 0;

  for (const [day, group] of [...byDay.entries()].sort()) {
    if (group.length < minPerDay) {
      discarded += 1;
      continue;
    }
    const rho = spearman(
      group.map((g) => g.predicted),
      group.map((g) => g.realized),
    );
    // Un jour où le modèle a répondu la même chose partout ne produit pas de
    // corrélation définie. Le compter comme 0 diluerait mécaniquement l'IC
    // moyen vers zéro : c'est une abstention, pas un échec.
    if (rho == null) {
      discarded += 1;
      continue;
    }
    daily.push({ day, n: group.length, ic: round(rho, 4) });
  }

  const T = daily.length;
  if (T < 5) {
    return {
      jours: T,
      joursEcartes: discarded,
      note: `${T} jour(s) exploitable(s) — au moins 5 sont nécessaires pour un IC interprétable.`,
      quotidien: daily,
    };
  }

  const ics = daily.map((d) => d.ic);
  const mean = ics.reduce((a, b) => a + b, 0) / T;
  const sd = Math.sqrt(ics.reduce((a, b) => a + (b - mean) ** 2, 0) / (T - 1));

  // Le t-stat suppose des IC quotidiens indépendants. Ils le sont bien plus que
  // les décisions individuelles — un classement d'un jour ne partage pas de
  // fenêtre de rendement avec celui du lendemain SI l'horizon est d'un jour.
  // Sur un horizon de 3 jours les fenêtres se chevauchent encore, et le t-stat
  // est optimiste du même facteur que celui corrigé ailleurs dans le SPRT.
  const t = sd > 0 ? (mean * Math.sqrt(T)) / sd : null;

  // ── Ampleur exploitable (Grinold), et pourquoi elle se calcule ainsi ────
  //
  // IR ≈ IC × √BR. Tout est dans BR — le nombre de paris INDÉPENDANTS par an.
  // Une première version comptait BR = 252 jours × N actifs et annonçait un IR
  // de 16, ce qu'aucun gérant n'a jamais approché. Deux fautes s'y cumulaient,
  // toutes deux dans le sens flatteur :
  //
  //   • 252 jours par an alors que l'horizon est de h jours. Une prévision à
  //     3 jours ne peut pas être renouvelée 252 fois par an indépendamment :
  //     il y a 252/h occasions distinctes, pas 252.
  //
  //   • N actifs traités comme N paris. Les actions d'un même marché
  //     co-varient ; parier sur douze d'entre elles n'est pas douze paris.
  //     La correction de Buckle donne l'ampleur EFFECTIVE :
  //
  //         N_eff = N / (1 + (N − 1) ρ)
  //
  //     où ρ est la corrélation moyenne entre actifs. À ρ = 0,3 et N = 150,
  //     N_eff tombe à 3,3 : l'univers de 150 titres vaut trois paris et demi,
  //     pas cent cinquante. C'est brutal, et c'est le fait le plus important
  //     de tout ce fichier.
  //
  // ρ est ESTIMÉ sur les données, pas supposé : on mesure la corrélation
  // moyenne des rendements excédentaires entre actifs.
  //
  // Même corrigé, le résultat reste un PLAFOND jamais atteint : il suppose un
  // transfert parfait du signal vers le portefeuille, alors qu'une contrainte
  // long-only à trois positions en ampute couramment plus de la moitié.
  const rho = averagePairwiseCorrelation(rows);
  const N = daily.reduce((a, d) => a + d.n, 0) / T;
  const nEff = rho == null ? N : N / (1 + (N - 1) * Math.max(rho, 0));
  const periodesParAn = 252 / Math.max(horizon, 1);
  const irPlafond = mean * Math.sqrt(periodesParAn * nEff);

  return {
    jours: T,
    joursEcartes: discarded,
    icMoyen: round(mean, 4),
    icEcartType: round(sd, 4),
    tStat: round(t, 2),
    // Un IC de 0,03 est déjà exploitable en gestion quantitative. La barre à
    // battre n'est pas « fort », c'est « distinguable de zéro ».
    significatif: t != null && Math.abs(t) > 2,
    ampleur: {
      actifsParJour: round(N, 1),
      correlationMoyenne: round(rho, 3),
      actifsEffectifs: round(nEff, 2),
      periodesParAn: round(periodesParAn, 1),
    },
    // Nommé « plafond » et non « attendu » : c'est le maximum théorique dans
    // des conditions qui ne sont pas réunies, pas une prévision de résultat.
    irPlafondAnnuel: round(irPlafond, 2),
    verdict: verdictIC({ mean, t, T }),
    quotidien: daily,
  };
}

/**
 * Corrélation moyenne des rendements excédentaires entre actifs.
 *
 * On construit le panneau actif × jour, on ne garde que les actifs présents sur
 * assez de jours communs, et on moyenne les corrélations deux à deux. Renvoie
 * null si l'échantillon ne permet pas de l'estimer — auquel cas l'appelant
 * retombe sur l'hypothèse d'indépendance, qu'il faut alors savoir optimiste.
 */
function averagePairwiseCorrelation(rows, { minCommon = 10 } = {}) {
  const bySymbol = new Map();
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, new Map());
    bySymbol.get(r.symbol).set(r.day, r.realized);
  }
  const symbols = [...bySymbol.keys()];
  if (symbols.length < 2) return null;

  const correlations = [];
  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const a = bySymbol.get(symbols[i]);
      const b = bySymbol.get(symbols[j]);
      const xs = [];
      const ys = [];
      for (const [day, v] of a) {
        if (b.has(day)) { xs.push(v); ys.push(b.get(day)); }
      }
      if (xs.length < minCommon) continue;
      const c = pearson(xs, ys);
      if (c != null) correlations.push(c);
    }
  }
  if (!correlations.length) return null;
  return correlations.reduce((x, y) => x + y, 0) / correlations.length;
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx < 1e-15 || dy < 1e-15) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * Erreur de calibration de rang.
 *
 * ── Ce qu'elle mesure, et pourquoi l'ECE ne suffit pas ────────────────────
 * L'ECE compare une probabilité annoncée à une fréquence réalisée : elle exige
 * que 0,70 corresponde à 70 %. Cette exigence est hors sujet ici. Ce que la
 * stratégie demande est plus faible et plus utile :
 *
 *     un actif mieux classé doit, en moyenne, mieux se comporter.
 *
 * Rien de plus. Peu importe de combien. Le RCE mesure les écarts à cette seule
 * exigence : on regroupe les décisions par tranche de rang, on calcule le
 * résultat moyen de chaque tranche, et on mesure de combien cette courbe
 * s'écarte de la courbe croissante la plus proche.
 *
 * La projection isotone (algorithme PAVA) donne cette courbe croissante la plus
 * proche au sens des moindres carrés pondérés. L'écart à cette projection est
 * donc exactement « la part du comportement qui contredit l'ordre annoncé ».
 *
 *   • RCE = 0 → l'ordre est respecté en moyenne, la stratégie a un fondement.
 *   • RCE élevé → il existe des inversions : mieux classé ≠ meilleur résultat.
 *
 * Un Rank IC positif avec un RCE élevé signale le cas le plus traître : le
 * modèle est bon aux extrémités du classement et faux au milieu. La réponse
 * n'est alors pas d'abandonner, mais de ne prendre que les extrêmes — ce que
 * fait déjà le filtre « strictement au-dessus de la médiane ».
 *
 * @param {Array<{rank: number, realized: number}>} pairs  rank ∈ [0,1], 1 = meilleur
 * @param {object} [options]
 * @param {number} [options.buckets=5]
 */
export function rankCalibrationError(pairs, { buckets = 5 } = {}) {
  const clean = pairs.filter(
    (p) => Number.isFinite(p.rank) && Number.isFinite(p.realized) && p.rank >= 0 && p.rank <= 1,
  );
  if (clean.length < buckets * 4) {
    return {
      n: clean.length,
      note: `${clean.length} observation(s) — il en faut au moins ${buckets * 4} pour ${buckets} tranches de rang.`,
    };
  }

  const groups = [];
  for (let b = 0; b < buckets; b += 1) {
    const lo = b / buckets;
    const hi = (b + 1) / buckets;
    const subset = clean.filter((p) => (b === buckets - 1 ? p.rank >= lo && p.rank <= hi : p.rank >= lo && p.rank < hi));
    if (!subset.length) continue;
    groups.push({
      tranche: `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)} %`,
      n: subset.length,
      rangMoyen: round(subset.reduce((a, p) => a + p.rank, 0) / subset.length, 3),
      resultatMoyen: subset.reduce((a, p) => a + p.realized, 0) / subset.length,
    });
  }

  if (groups.length < 2) return { n: clean.length, note: 'Rangs trop concentrés pour être découpés.' };

  const fitted = isotonic(groups.map((g) => g.resultatMoyen), groups.map((g) => g.n));
  const total = groups.reduce((a, g) => a + g.n, 0);
  const rce = groups.reduce((a, g, i) => a + (g.n / total) * Math.abs(g.resultatMoyen - fitted[i]), 0);

  // Monotonie stricte observée : le cas idéal, où aucune correction n'est
  // nécessaire parce que la courbe monte déjà.
  const monotone = groups.every((g, i) => i === 0 || g.resultatMoyen >= groups[i - 1].resultatMoyen - 1e-12);

  // Écart entre la tranche haute et la tranche basse : c'est le rendement que
  // la stratégie de classement cherche à capturer. Le RCE dit si l'on peut s'y
  // fier ; cet écart dit s'il vaut la peine.
  const spread = groups[groups.length - 1].resultatMoyen - groups[0].resultatMoyen;

  return {
    n: clean.length,
    rce: round(rce, 5),
    monotone,
    ecartHautBas: round(spread, 5),
    tranches: groups.map((g, i) => ({
      ...g,
      resultatMoyen: round(g.resultatMoyen, 5),
      apresProjection: round(fitted[i], 5),
    })),
    verdict: verdictRCE({ rce, monotone, spread }),
  };
}

/**
 * Régression isotone par PAVA (pool adjacent violators).
 *
 * On parcourt la suite ; dès qu'une valeur descend, on la fusionne avec la
 * précédente en une moyenne pondérée, et on remonte tant que la fusion crée à
 * son tour une violation. Le résultat est la suite croissante la plus proche au
 * sens des moindres carrés pondérés — c'est un résultat classique, pas une
 * heuristique.
 */
function isotonic(values, weights) {
  const blocks = values.map((v, i) => ({ sum: v * weights[i], w: weights[i] }));
  const stack = [];

  for (const block of blocks) {
    stack.push({ ...block });
    while (stack.length > 1) {
      const b = stack[stack.length - 1];
      const a = stack[stack.length - 2];
      if (a.sum / a.w <= b.sum / b.w) break;
      stack.pop();
      stack.pop();
      stack.push({ sum: a.sum + b.sum, w: a.w + b.w });
    }
  }

  // Ré-étalement des blocs fusionnés sur les positions d'origine.
  const out = [];
  for (const block of stack) {
    const mean = block.sum / block.w;
    let remaining = block.w;
    while (remaining > 0 && out.length < values.length) {
      out.push(mean);
      remaining -= weights[out.length - 1];
    }
  }
  return out;
}

/**
 * Spearman = Pearson appliqué aux rangs. Renvoie null si l'une des deux séries
 * est constante — cas fréquent quand le modèle répond à l'identique partout.
 */
function spearman(xs, ys) {
  const rx = ranksOf(xs);
  const ry = ranksOf(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx < 1e-12 || dy < 1e-12) return null;
  return num / Math.sqrt(dx * dy);
}

/** Rangs moyens, ex æquo partagés — indispensable ici : le modèle produit
 *  beaucoup de valeurs identiques et les départager par l'ordre d'arrivée
 *  fabriquerait de la corrélation à partir de rien. */
function ranksOf(values) {
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j += 1;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[indexed[k].i] = shared;
    i = j + 1;
  }
  return out;
}

function verdictIC({ mean, t, T }) {
  if (T < 20) return `${T} jours seulement — la mesure n'est pas encore stable, à lire comme une tendance.`;
  if (t == null) return 'IC non calculable : le modèle ne différencie pas les actifs.';
  if (Math.abs(t) < 2) {
    return `IC moyen ${(mean * 100).toFixed(1)} % mais t = ${t.toFixed(2)} : INDISTINGUABLE DE ZÉRO. `
      + 'Le classement n\'est pas encore justifié par les données.';
  }
  if (mean < 0) {
    return `IC NÉGATIF et significatif (t = ${t.toFixed(2)}) : le modèle ordonne les actifs À L'ENVERS. `
      + 'C\'est une information exploitable, mais elle contredit la stratégie en place.';
  }
  return `IC moyen ${(mean * 100).toFixed(1)} %, t = ${t.toFixed(2)} : le classement porte de l'information. `
    + 'C\'est le seuil habituel d\'exploitabilité en gestion quantitative.';
}

/**
 * L'ordre des tests compte. « Aucun signal » et « signal inversé » se
 * ressemblent numériquement — écart haut-bas nul contre négatif — et sont deux
 * diagnostics opposés : le premier dit que le modèle ne sait rien, le second
 * qu'il sait quelque chose et le dit à l'envers. Les confondre annoncerait une
 * inversion là où il n'y a que du bruit.
 */
const SPREAD_NUL = 1e-9;

function verdictRCE({ rce, monotone, spread }) {
  if (Math.abs(spread) < SPREAD_NUL) {
    return 'AUCUNE information de rang : la tranche la mieux classée se comporte comme la moins bien classée. '
      + 'Le classement ne distingue rien — ce n\'est pas une inversion, c\'est une absence de signal.';
  }
  if (monotone && spread > 0) {
    return 'Ordre RESPECTÉ : le résultat moyen croît avec le rang annoncé, sans inversion. '
      + 'La sélection par classement repose sur quelque chose de réel.';
  }
  if (spread < 0) {
    return 'Ordre INVERSÉ aux extrémités : la tranche la mieux classée fait moins bien que la moins bien classée. '
      + 'Le classement ne doit pas servir à sélectionner en l\'état.';
  }
  return `Ordre GLOBALEMENT respecté mais avec des inversions (RCE ${(rce * 100).toFixed(2)} pts). `
    + 'Le classement est fiable aux extrémités, moins au milieu — ce qui plaide pour ne retenir que le haut du panier.';
}

const round = (v, d) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
