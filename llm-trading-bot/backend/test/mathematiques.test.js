/**
 * Identités mathématiques — ce que le code DOIT satisfaire par construction.
 *
 * ── Pourquoi ces tests plutôt qu'une relecture ────────────────────────────
 * Relire une formule ne prouve rien : une erreur de signe, un indice décalé
 * ou une racine oubliée se lisent comme du code correct. Ce qui prouve, c'est
 * de vérifier numériquement les propriétés que chaque objet mathématique doit
 * satisfaire quelles que soient les données.
 *
 * Une décomposition en valeurs propres DOIT reconstruire sa matrice. Une
 * orthogonalisation DOIT produire des colonnes orthonormées. Une entropie
 * normalisée DOIT valoir 1 sur une distribution uniforme. Ces égalités ne
 * dépendent d'aucune donnée de marché — elles tiennent, ou le code est faux.
 *
 * Les tests fonctionnels du reste de la suite vérifient des COMPORTEMENTS
 * (« une position trop jeune n'est pas vendue »). Ceux-ci vérifient des
 * IDENTITÉS, et c'est une garantie d'une autre nature : elles ne peuvent pas
 * être satisfaites par accident.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = process.env.DATA_DIR || `${process.cwd()}/data`;
process.env.GEMINI_API_KEY = '';
process.env.SYMBOLS = 'AAPL,MSFT';

const { zscoreWinsorise, jacobiEigen, lowdinOrthogonalise, entropieDiversite, combinerSignaux,
  poidsSelonRegime } = await import('../src/core/signalBlend.js');
const { ajusterPlackettLuce, statistiqueWald } = await import('../src/core/plackettLuce.js');
const { exitRank, ageEnSeances } = await import('../src/core/ranking.js');
const { rankIC } = await import('../src/core/rankMetrics.js');
const { RiskManager } = await import('../src/core/riskManager.js');

/** Générateur déterministe : un test d'identité doit être reproductible. */
let graine = 424242;
const alea = () => { graine = (graine * 1103515245 + 12345) & 0x7fffffff; return graine / 0x7fffffff; };
const normal = () => {
  const u = Math.max(alea(), 1e-12); const v = alea();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

describe('z-score écrêté', () => {
  test('produit une moyenne nulle et un écart-type unitaire', () => {
    const z = zscoreWinsorise(Array.from({ length: 400 }, () => normal() * 3 + 7)).filter(Number.isFinite);
    const m = z.reduce((a, b) => a + b, 0) / z.length;
    const sd = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / (z.length - 1));
    assert.ok(Math.abs(m) < 1e-9, `moyenne ${m}`);
    assert.ok(Math.abs(sd - 1) < 1e-6, `écart-type ${sd}`);
  });

  test('une valeur aberrante ne comprime pas les autres', () => {
    // Sans écrêtage, un seul actif à +50 σ écrase les 149 autres dans un
    // mouchoir de poche et le classement ne distingue plus rien.
    const brut = Array.from({ length: 200 }, () => normal());
    brut[0] = 1e6;
    const max = Math.max(...zscoreWinsorise(brut).filter(Number.isFinite).map(Math.abs));
    assert.ok(max < 6, `|z| maximal ${max}`);
  });

  test('un signal constant vaut zéro, jamais NaN', () => {
    // Diviser par un écart-type nul propagerait des NaN dans tout le mélange.
    assert.ok(zscoreWinsorise(Array(50).fill(3)).every((v) => v === 0));
  });

  test('l\'ordre des valeurs est préservé', () => {
    const brut = Array.from({ length: 200 }, () => normal());
    const z = zscoreWinsorise(brut);
    const paires = brut.map((v, i) => [v, z[i]]).sort((a, b) => a[0] - b[0]);
    assert.ok(paires.every((p, i) => i === 0 || p[1] >= paires[i - 1][1] - 1e-12));
  });
});

describe('décomposition de Jacobi', () => {
  const k = 6;
  const A = Array.from({ length: k }, () => Array.from({ length: k }, () => normal()));
  // Symétrique définie positive : M = AᵀA + I
  const M = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => {
    let s = i === j ? 1 : 0;
    for (let t = 0; t < k; t += 1) s += A[t][i] * A[t][j];
    return s;
  }));
  const { valeurs, vecteurs } = jacobiEigen(M.map((r) => [...r]));

  test('les vecteurs propres sont orthonormés (VᵀV = I)', () => {
    let max = 0;
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        let s = 0;
        for (let t = 0; t < k; t += 1) s += vecteurs[t][i] * vecteurs[t][j];
        max = Math.max(max, Math.abs(s - (i === j ? 1 : 0)));
      }
    }
    assert.ok(max < 1e-9, `écart maximal ${max}`);
  });

  test('l\'équation aux valeurs propres tient (MV = VΛ)', () => {
    let max = 0;
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        let mv = 0;
        for (let t = 0; t < k; t += 1) mv += M[i][t] * vecteurs[t][j];
        max = Math.max(max, Math.abs(mv - valeurs[j] * vecteurs[i][j]));
      }
    }
    assert.ok(max < 1e-8, `écart maximal ${max}`);
  });

  test('la trace est conservée et le spectre positif', () => {
    const trM = M.reduce((a, r, i) => a + r[i], 0);
    const trL = valeurs.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(trM - trL) < 1e-9, `${trM} vs ${trL}`);
    assert.ok(valeurs.every((v) => v > 0), 'une matrice définie positive n\'a pas de valeur propre négative');
  });
});

describe('orthogonalisation de Löwdin', () => {
  const n = 300; const k = 5;
  // Colonnes délibérément corrélées : c'est le cas que Löwdin doit traiter.
  const commun = Array.from({ length: n }, () => normal());
  const colonnes = Array.from({ length: k }, () => {
    const propre = Array.from({ length: n }, () => normal());
    return commun.map((c, i) => 0.7 * c + 0.7 * propre[i]);
  }).map((c) => zscoreWinsorise(c));

  test('les colonnes de sortie sont orthonormées', () => {
    const { colonnes: Z } = lowdinOrthogonalise(colonnes);
    let max = 0;
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        let s = 0; let c = 0;
        for (let t = 0; t < n; t += 1) {
          if (Number.isFinite(Z[i][t]) && Number.isFinite(Z[j][t])) { s += Z[i][t] * Z[j][t]; c += 1; }
        }
        max = Math.max(max, Math.abs(s / c - (i === j ? 1 : 0)));
      }
    }
    assert.ok(max < 1e-6, `écart maximal ${max}`);
  });

  test('la transformation est SYMÉTRIQUE — c\'est ce qui la distingue de Gram-Schmidt', () => {
    const { transformation: T } = lowdinOrthogonalise(colonnes);
    let max = 0;
    for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) max = Math.max(max, Math.abs(T[i][j] - T[j][i]));
    assert.ok(max < 1e-12, `asymétrie maximale ${max}`);
  });

  test('INVARIANCE À L\'ORDRE des colonnes', () => {
    // La raison d'être du choix de Löwdin. Gram-Schmidt garde le premier
    // signal intact et transforme les suivants en résidus : l'ordre de
    // traitement décide alors qui garde sa substance. Rien ne justifierait
    // que le modèle passe avant le momentum, ou l'inverse.
    const { colonnes: Z } = lowdinOrthogonalise(colonnes);
    const perm = [3, 0, 4, 1, 2];
    const { colonnes: Zp } = lowdinOrthogonalise(perm.map((i) => colonnes[i]));
    let max = 0;
    for (let i = 0; i < k; i += 1) {
      for (let t = 0; t < n; t += 1) {
        const a = Z[perm[i]][t]; const b = Zp[i][t];
        if (Number.isFinite(a) && Number.isFinite(b)) max = Math.max(max, Math.abs(a - b));
      }
    }
    // ── La tolérance, et pourquoi elle vaut 1e-8 ─────────────────────────
    // C'est ce test qui a révélé que le critère d'arrêt de Jacobi portait sur
    // une SOMME DE CARRÉS : à 1e-12, chaque terme hors diagonale pouvait
    // encore valoir 1e-6, et l'écart après permutation atteignait 1e-7 sur
    // certains jeux de données. Le seuil est passé à 1e-18.
    //
    // L'invariance n'est pas exacte pour autant, et ne peut pas l'être : le
    // calcul de S^(-1/2) enchaîne des produits matriciels dont chaque
    // arrondi se propage. Mesuré sur 40 tirages après correction, le pire
    // écart vaut 7,8e-10 — contre 1e-7 avant, soit cent fois mieux.
    //
    // On borne donc à 1e-8 : au-dessus du pire cas observé, et assez serré
    // pour que la régression du seuil de Jacobi refasse échouer cette ligne.
    assert.ok(max < 1e-8, `écart maximal après permutation ${max}`);
  });

  test('la colinéarité parfaite est détectée sans produire d\'infini', () => {
    const r = lowdinOrthogonalise([colonnes[0], colonnes[0], colonnes[1]]);
    assert.equal(r.degenere, true, 'deux colonnes identiques doivent être signalées');
    assert.ok(r.colonnes.every((c) => c.every((v) => v === null || Number.isFinite(v))),
      'la racine inverse d\'une valeur propre nulle ne doit pas exploser');
  });
});

describe('entropie de diversité', () => {
  test('vaut 1 quand les directions se valent', () => {
    assert.ok(Math.abs(entropieDiversite([1, 1, 1, 1]) - 1) < 1e-9);
  });

  test('s\'effondre quand une direction domine', () => {
    assert.ok(entropieDiversite([100, 1e-6, 1e-6, 1e-6]) < 0.05);
  });

  test('reste bornée et invariante par changement d\'échelle', () => {
    const h = entropieDiversite([4, 2, 1, 1]);
    assert.ok(h > 0 && h < 1, `${h}`);
    assert.ok(Math.abs(entropieDiversite([2, 4, 6]) - entropieDiversite([20, 40, 60])) < 1e-12);
  });
});

describe('combinaison pondérée', () => {
  const noms = ['a', 'b', 'c'];
  const signaux = new Map();
  for (let i = 0; i < 60; i += 1) signaux.set(`S${i}`, { a: normal(), b: normal(), c: normal() });

  test('les poids publiés somment à 1 et respectent le poids de base', () => {
    const r = combinerSignaux(signaux, { noms, poidsBase: { a: 6 } });
    const somme = Object.values(r.poids).reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(somme - 1) < 5e-4, `Σ = ${somme}`);
    // 6 / (6 + 1 + 1) = 0,75
    assert.ok(Math.abs(r.poids.a - 0.75) < 5e-4, `a = ${r.poids.a}`);
  });

  test('un poids quasi nul ne RETIRE PAS le facteur', () => {
    // Propriété de Löwdin, contre-intuitive et documentée : la matrice
    // S^(-1/2) est pleine, donc chaque colonne de sortie mélange toutes les
    // entrées. Pour écarter un signal il faut l'ôter de `noms`.
    const cle = [...signaux.keys()];
    const poidsMinuscule = combinerSignaux(signaux, { noms, poidsBase: { c: 1e-9 } });
    const colonneRetiree = combinerSignaux(signaux, { noms: ['a', 'b'] });
    const ecart = Math.max(...cle.map((s) => Math.abs(poidsMinuscule.scores.get(s) - colonneRetiree.scores.get(s))));
    assert.ok(ecart > 1e-3, `les deux devraient différer, écart ${ecart}`);
  });

  test('le régime produit un stress borné et monotone', () => {
    const s = [0, 0.02, 0.04, 0.06, 0.2].map((d) => poidsSelonRegime(d).stress);
    assert.ok(s.every((x) => x >= 0 && x <= 1), s.join(', '));
    assert.ok(s.every((x, i) => i === 0 || x >= s[i - 1]), 'la sigmoïde doit être croissante');
    assert.equal(poidsSelonRegime(Number.NaN).stress, 0.5, 'dispersion inconnue → neutre');
  });
});

describe('Plackett-Luce', () => {
  const N = 12;
  const vrai = Array.from({ length: N }, (_, i) => (N - i) / 4);
  const tirer = () => {
    const restants = vrai.map((l, i) => ({ i, w: Math.exp(l) }));
    const ordre = [];
    while (restants.length) {
      const tot = restants.reduce((a, x) => a + x.w, 0);
      let u = alea() * tot; let k = 0;
      while (k < restants.length - 1 && u > restants[k].w) { u -= restants[k].w; k += 1; }
      ordre.push(`S${restants[k].i}`); restants.splice(k, 1);
    }
    return { order: ordre };
  };
  const classements = Array.from({ length: 300 }, tirer);
  const fit = ajusterPlackettLuce(classements);

  test('l\'ajustement converge sur un graphe connexe', () => {
    assert.equal(fit.converge, true);
    assert.equal(fit.connexe, true);
  });

  test('les forces estimées retrouvent la vérité terrain', () => {
    // Le test décisif : on ENGENDRE les classements depuis des forces connues,
    // et l'ajustement doit les reconstituer. Une erreur de signe ou d'indice
    // dans l'itération montée-minoration casserait cette corrélation.
    const est = Array.from({ length: N }, (_, i) => fit.lambda.get(`S${i}`));
    assert.ok(est.every(Number.isFinite));
    const mv = vrai.reduce((a, b) => a + b, 0) / N;
    const me = est.reduce((a, b) => a + b, 0) / N;
    let num = 0; let dv = 0; let de = 0;
    for (let i = 0; i < N; i += 1) {
      num += (vrai[i] - mv) * (est[i] - me); dv += (vrai[i] - mv) ** 2; de += (est[i] - me) ** 2;
    }
    const rho = num / Math.sqrt(dv * de);
    assert.ok(rho > 0.95, `corrélation ${rho.toFixed(4)}`);
  });

  test('la log-vraisemblance ajustée dépasse celle de la nulle', () => {
    assert.ok(fit.logLik > fit.logLikNul, `${fit.logLik} vs ${fit.logLikNul}`);
  });

  test('les erreurs types sont finies et positives', () => {
    const ses = Array.from({ length: N }, (_, i) => fit.se.get(`S${i}`));
    assert.ok(ses.every((s) => Number.isFinite(s) && s > 0));
  });

  test('la statistique de Wald est symétrique, et non définie contre soi-même', () => {
    const obj = (s) => ({ symbol: s, lambda: fit.lambda.get(s), se: fit.se.get(s) });
    const w = statistiqueWald(obj('S0'), obj('S3'), fit.covariance);
    const inv = statistiqueWald(obj('S3'), obj('S0'), fit.covariance);
    assert.ok(Math.abs(Math.abs(w.z) - Math.abs(inv.z)) < 1e-9);

    // Écart nul ET variance nulle : le rapport 0/0 n'est pas défini. NaN est
    // le retour SÛR — un zéro se lirait « différence mesurée, non
    // significative », ce qui est une affirmation et non une abstention.
    const soi = statistiqueWald(obj('S0'), obj('S0'), fit.covariance);
    assert.ok(Math.abs(soi.ecart) < 1e-12);
    assert.ok(Number.isNaN(soi.z));
  });
});

describe('bande de non-négociation', () => {
  test('la largeur suit la RACINE CUBIQUE du coût', () => {
    // Janecek & Shreve 2004 : sous coûts proportionnels, la largeur optimale
    // croît en c^(1/3). Multiplier le coût par 8 doit donc doubler la bande,
    // pas la multiplier par 8. Un raisonnement linéaire donnerait une bande
    // cent trente-sept fois trop étroite.
    const l1 = exitRank({ universe: 150, maxSelected: 10, cost: 0.000625, kappa: 1 }) - 10;
    const l8 = exitRank({ universe: 150, maxSelected: 10, cost: 0.005, kappa: 1 }) - 10;
    assert.ok(Math.abs(l8 / l1 - 2) < 0.05, `${l1} → ${l8}, rapport ${(l8 / l1).toFixed(3)}`);
  });

  test('le rang de sortie dépasse toujours le nombre de retenus', () => {
    // Sinon une position serait vendue le jour même de son achat.
    assert.ok(exitRank({ universe: 20, maxSelected: 10, cost: 1e-12 }) > 10);
    assert.ok(exitRank({ universe: 300, maxSelected: 10 }) > exitRank({ universe: 150, maxSelected: 10 }));
  });

  test('l\'âge en séances est croissant et jamais négatif', () => {
    const t0 = new Date('2026-01-01T12:00:00Z');
    const ages = [0, 7, 14, 28].map((d) => ageEnSeances(t0.toISOString(), new Date(t0.getTime() + d * 86400000)));
    assert.deepEqual(ages, [0, 5, 10, 20], 'sept jours calendaires valent cinq séances');
  });
});

describe('corrélation de rang', () => {
  test('vaut ±1 sur des relations parfaites', () => {
    // rankIC dégroupe par jour : il faut plusieurs jours de plusieurs actifs.
    const construire = (signe) => {
      const out = [];
      for (let j = 0; j < 8; j += 1) {
        for (let i = 0; i < 12; i += 1) {
          out.push({ day: `2026-01-0${j + 1}`, predicted: i / 11, realized: (signe * i) / 11 });
        }
      }
      return out;
    };
    assert.ok(Math.abs(rankIC(construire(1), { horizon: 1 }).icMoyen - 1) < 1e-6);
    assert.ok(Math.abs(rankIC(construire(-1), { horizon: 1 }).icMoyen + 1) < 1e-6);
  });
});

describe('dimensionnement et protections', () => {
  const limits = {
    maxPositions: 10, maxPositionPct: 0.10, minOrderValue: 5, minConfidence: 0.35,
    stopAtrMultiple: 0, stopMinPct: 0.35, stopMaxPct: 0.35, takeProfitPct: 0.14,
  };
  const risk = new RiskManager(limits);

  test('le budget ne dépasse jamais le cash ni l\'enveloppe', () => {
    for (const [equity, cash] of [[100, 100], [100, 3], [250, 40], [80, 80]]) {
      const b = risk.computeBudget({
        account: { equity, cash, currency: 'USD', positionsCount: 0 },
        position: null, price: 50, fxRate: 1, circuitBreaker: { tripped: false },
      });
      const plafond = Math.min(cash, equity * limits.maxPositionPct);
      assert.ok(b.maxNotionalBase <= plafond + 1e-9,
        `équity ${equity}, cash ${cash} : ${b.maxNotionalBase} > ${plafond}`);
    }
  });

  test('l\'exposition totale vaut exactement 100 %, sans levier', () => {
    assert.equal(limits.maxPositions * limits.maxPositionPct, 1);
  });

  test('les niveaux de protection encadrent le prix d\'entrée', () => {
    const p = risk.protectionLevels(100, 2.5);
    assert.equal(p.stopPrice, 65);
    assert.equal(p.takeProfitPrice, 114);
    assert.ok(p.stopPrice < 100 && p.takeProfitPrice > 100);
  });

  test('les trois régimes de sortie sont bien séparés', () => {
    const p = { quantity: 1, avgPrice: 100, ...risk.protectionLevels(100, 2.5) };
    assert.equal(risk.checkExits(p, 60)?.triggered, 'STOP_LOSS');
    assert.equal(risk.checkExits(p, 120)?.triggered, 'TAKE_PROFIT');
    assert.equal(risk.checkExits(p, 105), null, 'entre les deux, on garde');
  });
});
