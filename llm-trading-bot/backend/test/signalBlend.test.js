import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = process.env.DATA_DIR || `${process.cwd()}/data`;
process.env.GEMINI_API_KEY = '';

const {
  zscoreWinsorise, jacobiEigen, lowdinOrthogonalise,
  combinerSignaux, poidsSelonRegime, entropieDiversite,
} = await import('../src/core/signalBlend.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function correlation(a, b) {
  const paires = a.map((x, i) => [x, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = paires.length;
  const ma = paires.reduce((s, p) => s + p[0], 0) / n;
  const mb = paires.reduce((s, p) => s + p[1], 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (const [x, y] of paires) { num += (x - ma) * (y - mb); da += (x - ma) ** 2; db += (y - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

/** Deux signaux partageant une composante commune de corrélation `rho`. */
function signauxCorreles(n, rho, graine) {
  const r = mulberry32(graine);
  const g = () => { const u = r(); const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const commun = Array.from({ length: n }, g);
  const k = Math.sqrt(1 - rho * rho);
  return {
    a: commun.map((x) => rho * x + k * g()),
    b: commun.map((x) => rho * x + k * g()),
    independant: Array.from({ length: n }, g),
  };
}

describe('normalisation transversale', () => {
  test('écrête les valeurs aberrantes avant de standardiser', () => {
    // Sans écrêtage, un seul actif à +200 comprime tous les autres à ~0 et le
    // classement qui en sort ne distingue plus rien.
    const avecOutlier = [...Array.from({ length: 100 }, (_, i) => i / 100), 200];
    const z = zscoreWinsorise(avecOutlier);
    const sansOutlier = z.slice(0, 100).filter(Number.isFinite);
    const etendue = Math.max(...sansOutlier) - Math.min(...sansOutlier);
    assert.ok(etendue > 1, `les valeurs normales doivent rester étalées (étendue ${etendue.toFixed(2)})`);
  });

  test('produit une moyenne nulle et un écart-type unitaire', () => {
    const r = mulberry32(3);
    const v = Array.from({ length: 200 }, () => r() * 10 + 5);
    const z = zscoreWinsorise(v).filter(Number.isFinite);
    const m = z.reduce((a, b) => a + b, 0) / z.length;
    const sd = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / (z.length - 1));
    assert.ok(Math.abs(m) < 1e-9);
    assert.ok(Math.abs(sd - 1) < 0.05);
  });

  test('un signal constant devient zéro, jamais NaN', () => {
    const z = zscoreWinsorise([5, 5, 5, 5, 5]);
    assert.ok(z.every((v) => v === 0), 'aucune division par un écart-type nul');
  });

  test('les valeurs manquantes restent manquantes', () => {
    const z = zscoreWinsorise([1, 2, null, 4, Number.NaN, 6]);
    assert.equal(z[2], null);
    assert.equal(z[4], null);
    assert.ok(Number.isFinite(z[0]));
  });
});

describe('décomposition propre (Jacobi)', () => {
  test('conserve la trace', () => {
    const A = [[4, 1, 0], [1, 3, 1], [0, 1, 2]];
    const { valeurs } = jacobiEigen(A);
    assert.ok(Math.abs(valeurs.reduce((a, b) => a + b, 0) - 9) < 1e-9);
  });

  test('satisfait A·v = λ·v', () => {
    const A = [[4, 1, 0], [1, 3, 1], [0, 1, 2]];
    const { valeurs, vecteurs } = jacobiEigen(A);
    let maxErr = 0;
    for (let m = 0; m < 3; m += 1) {
      for (let i = 0; i < 3; i += 1) {
        let s = 0;
        for (let j = 0; j < 3; j += 1) s += A[i][j] * vecteurs[j][m];
        maxErr = Math.max(maxErr, Math.abs(s - valeurs[m] * vecteurs[i][m]));
      }
    }
    assert.ok(maxErr < 1e-9, `erreur ${maxErr}`);
  });
});

describe('orthogonalisation de Löwdin', () => {
  test('rend les signaux réellement orthogonaux', () => {
    const { a, b, independant } = signauxCorreles(300, 0.89, 7);
    assert.ok(Math.abs(correlation(a, b)) > 0.6, 'les entrées doivent bien être corrélées');

    const o = lowdinOrthogonalise([a, b, independant].map((c) => zscoreWinsorise(c)));
    const [x, y, z] = o.colonnes;
    assert.ok(Math.abs(correlation(x, y)) < 0.02, `corr résiduelle ${correlation(x, y)}`);
    assert.ok(Math.abs(correlation(x, z)) < 0.02);
    assert.ok(Math.abs(correlation(y, z)) < 0.02);
  });

  test('la matrice de transformation est SYMÉTRIQUE — la garantie d\'invariance', () => {
    // C'est la propriété qui distingue Löwdin de Gram-Schmidt : la symétrie de
    // S^(-1/2) rend le résultat indépendant de l'ordre des signaux. Gram-Schmidt
    // garderait le premier intact et réduirait les suivants à des résidus, ce
    // qui ferait dépendre le résultat d'un choix arbitraire.
    const { a, b, independant } = signauxCorreles(200, 0.85, 11);
    const { transformation } = lowdinOrthogonalise([a, b, independant].map(zscoreWinsorise));
    let asym = 0;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) asym = Math.max(asym, Math.abs(transformation[i][j] - transformation[j][i]));
    }
    assert.ok(asym < 1e-12, `asymétrie ${asym}`);
  });

  test('déforme les deux signaux corrélés de façon ÉQUITABLE', () => {
    // Gram-Schmidt donnerait ~1,00 au premier et ~0,45 au second. Löwdin
    // répartit la charge : chacun garde la même part de sa structure.
    const { a, b } = signauxCorreles(300, 0.89, 5);
    const o = lowdinOrthogonalise([a, b].map(zscoreWinsorise));
    const f1 = Math.abs(correlation(a, o.colonnes[0]));
    const f2 = Math.abs(correlation(b, o.colonnes[1]));
    assert.ok(Math.abs(f1 - f2) < 0.05, `fidélités déséquilibrées : ${f1.toFixed(3)} vs ${f2.toFixed(3)}`);
    assert.ok(f1 > 0.5, 'chaque signal doit rester reconnaissable');
  });

  test('l\'ordre des signaux ne change pas le résultat', () => {
    const { a, b, independant } = signauxCorreles(200, 0.9, 13);
    const cols = [a, b, independant].map(zscoreWinsorise);
    const direct = lowdinOrthogonalise([cols[0], cols[1], cols[2]]);
    const inverse = lowdinOrthogonalise([cols[2], cols[1], cols[0]]);
    // Le signal du milieu occupe la même position dans les deux appels.
    const ecart = Math.max(...direct.colonnes[1].map((v, i) => Math.abs(v - inverse.colonnes[1][i])));
    // Tolérance à la précision de convergence de Jacobi, pas à zéro machine.
    assert.ok(ecart < 1e-5, `écart ${ecart.toExponential(2)}`);
  });

  test('signale les signaux parfaitement colinéaires au lieu de diverger', () => {
    const r = mulberry32(2);
    const x = Array.from({ length: 100 }, () => r());
    const copie = [...x];
    const o = lowdinOrthogonalise([x, copie].map(zscoreWinsorise));
    assert.equal(o.degenere, true, 'une direction sans information propre doit être signalée');
    assert.ok(o.colonnes.every((c) => c.every((v) => Number.isFinite(v))), 'aucune valeur infinie');
  });
});

describe('entropie de diversité', () => {
  test('vaut 1 quand les signaux sont parfaitement complémentaires', () => {
    assert.equal(entropieDiversite([1, 1, 1]), 1);
  });

  test('s\'effondre quand une seule direction domine', () => {
    assert.ok(entropieDiversite([2.9, 0.05, 0.05]) < 0.3);
  });

  test('détecte la saturation : ajouter un doublon n\'augmente pas la diversité', () => {
    const troisIndependants = entropieDiversite([1, 1, 1]);
    const deuxPlusUnDoublon = entropieDiversite([2, 1, 0.0001]);
    assert.ok(deuxPlusUnDoublon < troisIndependants);
  });
});

describe('régime de marché', () => {
  test('la bascule est continue, jamais binaire', () => {
    // Un basculement brutal ferait tourner tout le portefeuille le jour où le
    // seuil est franchi, pour un coût certain.
    const valeurs = [0.01, 0.025, 0.03, 0.04, 0.05, 0.07].map((d) => poidsSelonRegime(d).stress);
    for (let i = 1; i < valeurs.length; i += 1) {
      assert.ok(valeurs[i] >= valeurs[i - 1], 'le stress doit croître avec la dispersion');
    }
    assert.ok(valeurs.some((v) => v > 0 && v < 1), 'il doit exister des états intermédiaires');
  });

  test('reste borné dans [0, 1]', () => {
    for (const d of [-1, 0, 0.5, 100]) {
      const s = poidsSelonRegime(d).stress;
      assert.ok(s >= 0 && s <= 1);
    }
  });

  test('une dispersion inconnue donne un état neutre, pas un extrême', () => {
    assert.equal(poidsSelonRegime(null).stress, 0.5);
    assert.equal(poidsSelonRegime(Number.NaN).regime, 'inconnu');
  });
});

describe('combinaison complète', () => {
  /** 150 actifs, une vérité cachée, six signaux bruités dont deux opposés. */
  function universSynthetique(n = 150, graine = 21) {
    const r = mulberry32(graine);
    const g = () => { const u = r(); const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const m = new Map(); const vrai = [];
    for (let i = 0; i < n; i += 1) {
      const v = g(); vrai.push(v);
      m.set(`S${i}`, {
        llm: v + 0.5 * g(),
        momentum: v + 0.5 * g(),
        reversal: -(v + 0.5 * g()),
        vol: g(),
        rsi: g(),
      });
    }
    return { signaux: m, vrai };
  }

  const noms = ['llm', 'momentum', 'reversal', 'vol', 'rsi'];
  const orientations = { reversal: -1 };

  test('bat tout signal isolé QUAND tous les signaux portent de l\'information', () => {
    const { signaux, vrai } = universSynthetique();
    const informatifs = ['llm', 'momentum', 'reversal'];
    const combine = combinerSignaux(signaux, { noms: informatifs, orientations, stress: 0 });

    const rhoCombine = Math.abs(correlation([...combine.scores.values()], vrai));
    const rhoSeul = Math.abs(correlation([...signaux.values()].map((s) => s.llm), vrai));
    assert.ok(rhoCombine > rhoSeul, `combiné ${rhoCombine.toFixed(3)} doit battre le seul LLM ${rhoSeul.toFixed(3)}`);
  });

  test('mais DILUE dès qu\'un signal est du bruit — la limite à connaître', () => {
    // Le résultat le plus important de ce fichier, et il va contre l'intuition
    // « plus de signaux vaut mieux ». Mesuré sur 40 tirages :
    //
    //     3 informatifs, 0 bruit : 0,959  contre 0,891 pour le LLM seul
    //            + 1 signal vide : 0,824
    //            + 2 signaux vides: 0,740
    //
    // Le poids égal ne protège de l'erreur d'estimation que si les signaux
    // sont comparables en qualité. Trois informatifs et deux vides, c'est
    // 40 % du poids donné au néant.
    //
    // Conséquence directe sur l'architecture : on ne peut PAS basculer la
    // décision sur la combinaison sans avoir mesuré lesquels des six signaux
    // prédisent réellement. C'est le rôle du carnet fantôme.
    const { signaux, vrai } = universSynthetique();
    const avecBruit = combinerSignaux(signaux, { noms, orientations, stress: 0 });
    const sansBruit = combinerSignaux(signaux, { noms: ['llm', 'momentum', 'reversal'], orientations, stress: 0 });

    const rhoAvec = Math.abs(correlation([...avecBruit.scores.values()], vrai));
    const rhoSans = Math.abs(correlation([...sansBruit.scores.values()], vrai));
    assert.ok(rhoSans > rhoAvec, 'inclure du bruit doit dégrader, et le test doit le prouver');
  });

  test('ne produit AUCUN ex æquo', () => {
    const { signaux } = universSynthetique();
    const scores = [...combinerSignaux(signaux, { noms, orientations }).scores.values()];
    assert.equal(new Set(scores.map((v) => v.toFixed(9))).size, scores.length);
  });

  test('momentum et retour à la moyenne ne s\'annulent plus', () => {
    // Sans réorientation, additionner deux signaux opposés donne du bruit.
    const { signaux, vrai } = universSynthetique();
    const sansOrientation = combinerSignaux(signaux, { noms: ['momentum', 'reversal'] });
    const avecOrientation = combinerSignaux(signaux, { noms: ['momentum', 'reversal'], orientations });

    const rhoSans = Math.abs(correlation([...sansOrientation.scores.values()], vrai));
    const rhoAvec = Math.abs(correlation([...avecOrientation.scores.values()], vrai));
    assert.ok(rhoAvec > rhoSans + 0.1, `${rhoAvec.toFixed(3)} doit nettement dépasser ${rhoSans.toFixed(3)}`);
  });

  test('le régime module les poids sans jamais toucher à l\'exposition', () => {
    // La recherche invalide la modulation d'exposition. Ce qu'on module ici,
    // c'est QUEL signal départage les actifs — jamais combien on investit.
    const { signaux } = universSynthetique();
    const calme = combinerSignaux(signaux, { noms, orientations, stress: 0, sensibiliteRegime: { reversal: -1 } });
    const stress = combinerSignaux(signaux, { noms, orientations, stress: 1, sensibiliteRegime: { reversal: -1 } });

    assert.notDeepEqual(calme.poids, stress.poids, 'les poids doivent changer avec le régime');
    assert.equal(calme.scores.size, stress.scores.size, 'le nombre d\'actifs classés ne change jamais');
  });

  test('un actif aux signaux partiellement manquants reste classé', () => {
    const { signaux } = universSynthetique(50);
    signaux.get('S0').vol = null;
    signaux.get('S0').rsi = Number.NaN;
    const r = combinerSignaux(signaux, { noms, orientations });
    assert.ok(Number.isFinite(r.scores.get('S0')), 'ne pas pénaliser une donnée manquante');
  });

  test('refuse de combiner sur un univers trop étroit', () => {
    const petit = new Map([['A', { llm: 1 }], ['B', { llm: 2 }]]);
    assert.equal(combinerSignaux(petit, { noms: ['llm'] }).scores.size, 0);
  });

  test('publie l\'entropie de diversité pour détecter la saturation', () => {
    const { signaux } = universSynthetique();
    const r = combinerSignaux(signaux, { noms, orientations });
    assert.ok(r.entropieDiversite > 0 && r.entropieDiversite <= 1);
  });
});
