import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = process.env.DATA_DIR || `${process.cwd()}/data`;
process.env.GEMINI_API_KEY = '';

const { ajusterPlackettLuce, testGlobal, calibrerNulle, statistiqueWald, chi2SurvieSuperieure, classementDepuisAjustement } =
  await import('../src/core/plackettLuce.js');
const { construireLots, positionsMoyennes, biaisDePosition } = await import('../src/core/batching.js');
const { pseudonymePour, trancheTaille, substitutsPour } = await import('../src/llm/pseudonyms.js');
const { validerClassement, buildListwiseSchema } = await import('../src/llm/listwisePrompt.js');

/** Générateur reproductible — un LCG naïf produirait des tirages corrélés. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tirage EXACT du modèle de Plackett-Luce, par la représentation de Gumbel. */
function tirerClassement(lot, lambda, rnd) {
  return lot
    .map((s) => ({ s, u: lambda[s] - Math.log(-Math.log(rnd())) }))
    .sort((a, b) => b.u - a.u)
    .map((x) => x.s);
}

function spearman(a, b) {
  const n = a.length;
  const rang = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    idx.forEach(([, i], k) => { r[i] = k; });
    return r;
  };
  const ra = rang(a); const rb = rang(b); const m = (n - 1) / 2;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) { num += (ra[i] - m) * (rb[i] - m); da += (ra[i] - m) ** 2; db += (rb[i] - m) ** 2; }
  return num / Math.sqrt(da * db);
}

describe('Plackett-Luce', () => {
  test('retrouve un vecteur de forces connu à partir de classements partiels', () => {
    const rnd = mulberry32(42);
    const symboles = Array.from({ length: 60 }, (_, i) => `S${i}`);
    const vrai = {};
    symboles.forEach((s) => {
      const u = rnd(); const v = rnd();
      vrai[s] = 0.8 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    });

    const { lots } = construireLots(symboles, { taille: 10, tours: 6, graine: 7 });
    const classements = lots.map((l) => ({ order: tirerClassement(l.membres, vrai, rnd) }));

    const fit = ajusterPlackettLuce(classements);
    assert.ok(fit.converge, 'l\'ajustement doit converger');
    assert.ok(fit.connexe, 'le graphe doit être connexe après 6 tours');

    const rho = spearman(symboles.map((s) => vrai[s]), symboles.map((s) => fit.lambda.get(s)));
    assert.ok(rho > 0.8, `corrélation avec les forces vraies trop faible : ${rho.toFixed(3)}`);
  });

  test('la vraisemblance croît à chaque itération (propriété MM)', () => {
    const rnd = mulberry32(7);
    const symboles = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const vrai = Object.fromEntries(symboles.map((s, i) => [s, i / 10 - 1]));
    const { lots } = construireLots(symboles, { taille: 5, tours: 6, graine: 3 });
    const classements = lots.map((l) => ({ order: tirerClassement(l.membres, vrai, rnd) }));

    let precedent = -Infinity;
    for (let it = 1; it <= 25; it += 1) {
      const f = ajusterPlackettLuce(classements, { maxIterations: it, tolerance: 0 });
      assert.ok(f.logLik >= precedent - 1e-9, `rupture de monotonie à l'itération ${it}`);
      precedent = f.logLik;
    }
  });

  test('l\'écart-type de la DIFFÉRENCE décroît en 1/√n', () => {
    // λ seul n'est identifié que relativement au fantôme : sa variance a un
    // plancher. C'est l'écart λi − λj qui est utilisé partout, et lui doit
    // bien se resserrer avec les données.
    const symboles = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const vrai = Object.fromEntries(symboles.map((s) => [s, 0]));

    const seEcart = (tours) => {
      const rnd = mulberry32(99);
      const { lots } = construireLots(symboles, { taille: 10, tours, graine: 11 });
      const fit = ajusterPlackettLuce(lots.map((l) => ({ order: tirerClassement(l.membres, vrai, rnd) })));
      const w = statistiqueWald(
        { symbol: 'S0', lambda: fit.lambda.get('S0'), se: fit.se.get('S0') },
        { symbol: 'S1', lambda: fit.lambda.get('S1'), se: fit.se.get('S1') },
        fit.covariance,
      );
      return Math.sqrt(w.variance);
    };

    const a = seEcart(4);
    const b = seEcart(64);
    const attendu = a * Math.sqrt(4 / 64);
    assert.ok(b < a, 'plus de données doit resserrer l\'écart-type');
    assert.ok(b / attendu > 0.7 && b / attendu < 1.4, `décroissance non conforme à 1/√n : ratio ${(b / attendu).toFixed(2)}`);
  });

  test('un actif peu comparé garde un écart-type plus large', () => {
    const rnd = mulberry32(5);
    const symboles = Array.from({ length: 20 }, (_, i) => `S${i}`);
    const vrai = Object.fromEntries(symboles.map((s) => [s, 0]));
    const { lots } = construireLots(symboles, { taille: 10, tours: 10, graine: 2 });
    const classements = lots.map((l) => ({ order: tirerClassement(l.membres, vrai, rnd) }));

    // On RETIRE S0 des classements plutôt que d'en supprimer : écarter un
    // classement entier priverait aussi les neuf autres actifs qui s'y
    // trouvaient, et le test ne mesurerait plus ce qu'il prétend.
    let vus = 0;
    const restreints = classements.map((c) => {
      if (!c.order.includes('S0')) return c;
      vus += 1;
      return vus <= 2 ? c : { order: c.order.filter((s) => s !== 'S0') };
    });

    const fit = ajusterPlackettLuce(restreints);
    const autres = symboles.filter((s) => s !== 'S0').map((s) => fit.se.get(s));
    assert.ok(fit.se.get('S0') > Math.max(...autres), 'l\'actif sous-échantillonné doit avoir le plus grand écart-type');
  });

  test('détecte deux groupes jamais confrontés', () => {
    const a = ['A1', 'A2', 'A3'];
    const b = ['B1', 'B2', 'B3'];
    const separe = ajusterPlackettLuce([{ order: a }, { order: [...a].reverse() }, { order: b }, { order: [...b].reverse() }]);
    const relie = ajusterPlackettLuce([{ order: a }, { order: b }, { order: ['A1', 'B1'] }, { order: ['A3', 'B3'] }]);

    assert.equal(separe.connexe, false, 'des lots disjoints ne forment pas un classement');
    assert.equal(relie.connexe, true, 'un recouvrement suffit à relier les groupes');
  });

  test('la loi du χ² est exacte aux valeurs de référence', () => {
    for (const [x, k, attendu] of [[3.841, 1, 0.05], [11.070, 5, 0.05], [124.342, 100, 0.05], [6.635, 1, 0.01]]) {
      assert.ok(Math.abs(chi2SurvieSuperieure(x, k) - attendu) < 0.0015, `P(χ²_${k} > ${x})`);
    }
  });
});

describe('test global de différenciation', () => {
  // Le χ² asymptotique rejette 23 % du temps sous H0 à 150 actifs — 150
  // paramètres pour 540 observations, l'approximation ne tient pas. La
  // calibration par bootstrap est la parade, et elle doit être vérifiée.
  test('la calibration par bootstrap tient le taux nominal sous H0', () => {
    const symboles = Array.from({ length: 40 }, (_, i) => `S${i}`);
    const { lots } = construireLots(symboles, { taille: 10, tours: 4, graine: 1 });
    const compositions = lots.map((l) => l.membres);
    const nulle = calibrerNulle(compositions, { tirages: 120 });

    let rejets = 0;
    const REPS = 120;
    for (let rep = 0; rep < REPS; rep += 1) {
      const rnd = mulberry32(9000 + rep * 17);
      const classements = compositions.map((lot) => {
        const m = [...lot];
        for (let i = m.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [m[i], m[j]] = [m[j], m[i]]; }
        return { order: m };
      });
      if (testGlobal(ajusterPlackettLuce(classements), { referenceNulle: nulle }).significatif) rejets += 1;
    }

    const taux = rejets / REPS;
    assert.ok(taux <= 0.15, `trop de faux positifs : ${(taux * 100).toFixed(1)} %`);
  });

  test('détecte un modèle parfaitement cohérent', () => {
    const symboles = Array.from({ length: 40 }, (_, i) => `S${i}`);
    const vrai = Object.fromEntries(symboles.map((s, i) => [s, -i]));
    const { lots } = construireLots(symboles, { taille: 10, tours: 4, graine: 5 });
    const compositions = lots.map((l) => l.membres);
    const classements = compositions.map((lot) => ({ order: [...lot].sort((a, b) => vrai[b] - vrai[a]) }));

    const t = testGlobal(ajusterPlackettLuce(classements), { referenceNulle: calibrerNulle(compositions, { tirages: 100 }) });
    assert.ok(t.significatif, `un ordre strictement reproductible doit être détecté (p = ${t.p})`);
  });

  test('ne déclare rien de significatif sur des classements tirés au hasard', () => {
    const symboles = Array.from({ length: 40 }, (_, i) => `S${i}`);
    const { lots } = construireLots(symboles, { taille: 10, tours: 4, graine: 8 });
    const compositions = lots.map((l) => l.membres);
    const nulle = calibrerNulle(compositions, { tirages: 100 });

    const rnd = mulberry32(1234);
    const classements = compositions.map((lot) => {
      const m = [...lot];
      for (let i = m.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [m[i], m[j]] = [m[j], m[i]]; }
      return { order: m };
    });
    assert.equal(testGlobal(ajusterPlackettLuce(classements), { referenceNulle: nulle }).significatif, false);
  });
});

describe('découpage en lots', () => {
  test('chaque actif est vu exactement une fois par tour', () => {
    const symboles = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const { lots } = construireLots(symboles, { taille: 10, tours: 4, graine: 1 });

    for (let tour = 1; tour <= 4; tour += 1) {
      const membres = lots.filter((l) => l.tour === tour).flatMap((l) => l.membres);
      assert.equal(membres.length, 150, `tour ${tour}`);
      assert.equal(new Set(membres).size, 150, `doublon au tour ${tour}`);
    }
  });

  test('le coût est bien 4 tours × 15 lots et non 150 appels', () => {
    const { lots } = construireLots(Array.from({ length: 150 }, (_, i) => `S${i}`), { taille: 10, tours: 4 });
    assert.equal(lots.length, 60);
  });

  test('un reliquat isolé est rattaché au lot précédent, jamais perdu', () => {
    const symboles = Array.from({ length: 21 }, (_, i) => `S${i}`);
    const { lots } = construireLots(symboles, { taille: 10, tours: 1, graine: 4 });
    const membres = lots.flatMap((l) => l.membres);
    assert.equal(new Set(membres).size, 21, 'aucun actif ne doit disparaître');
    assert.ok(lots.every((l) => l.membres.length >= 2), 'aucun lot d\'un seul actif');
  });

  test('la position de présentation est mélangée entre les tours', () => {
    const symboles = Array.from({ length: 150 }, (_, i) => `S${i}`);
    const { lots } = construireLots(symboles, { taille: 10, tours: 4, graine: 12 });
    const positions = positionsMoyennes(lots);

    // Sur 4 tirages, la position moyenne d'un actif doit se rapprocher de 0,5
    // sans y être collée. On vérifie surtout qu'aucun actif n'est
    // systématiquement premier ou dernier.
    const valeurs = [...positions.values()];
    assert.ok(Math.min(...valeurs) > 0, 'aucun actif ne doit être toujours en tête');
    assert.ok(Math.max(...valeurs) < 1, 'aucun actif ne doit être toujours en queue');
  });

  test('le biais de position se mesure et vaut zéro sur un classement indépendant', () => {
    const symboles = Array.from({ length: 60 }, (_, i) => `S${i}`);
    const { lots } = construireLots(symboles, { taille: 10, tours: 4, graine: 6 });
    const positions = positionsMoyennes(lots);
    const ranks = new Map(symboles.map((s, i) => [s, { rank: i + 1 }]));

    const b = biaisDePosition(ranks, positions);
    assert.equal(b.n, 60);
    assert.ok(Math.abs(b.correlation) < 0.4, `corrélation inattendue : ${b.correlation}`);
  });
});

describe('pseudonymes', () => {
  test('sont stables pour un symbole donné', () => {
    assert.equal(pseudonymePour('NVDA'), pseudonymePour('NVDA'));
    assert.notEqual(pseudonymePour('NVDA'), pseudonymePour('NVDA', 'sel-2'));
  });

  test('ne contiennent aucune trace du symbole réel', () => {
    for (const s of ['NVDA', 'AAPL', 'TSLA', 'JPM', 'XOM']) {
      const p = pseudonymePour(s).toUpperCase();
      assert.ok(!p.includes(s), `${p} laisse fuir ${s}`);
    }
  });

  test('les substituts d\'un actif sont cohérents entre eux', () => {
    const a = substitutsPour('NVDA', { executives: ['Jensen Huang'], products: ['Blackwell'] });
    const b = substitutsPour('NVDA', { executives: ['Jensen Huang'], products: ['Blackwell'] });
    assert.deepEqual(a.dirigeants, b.dirigeants);
    assert.deepEqual(a.produits, b.produits);
    assert.equal(a.dirigeants.length, 1);
  });

  test('la tranche de taille est descriptive et non identifiante', () => {
    assert.match(trancheTaille(3.2e12), /méga/);
    assert.match(trancheTaille(4e11), /très grande/);
    assert.equal(trancheTaille(null), 'non renseignée');
  });
});

describe('validation des classements du modèle', () => {
  const attendues = ['Alpha', 'Beta', 'Gamma', 'Delta'];

  test('accepte une permutation complète', () => {
    const r = validerClassement({ classement: ['Gamma', 'Alpha', 'Delta', 'Beta'] }, attendues);
    assert.ok(r.ok);
    assert.equal(r.partiel, false);
    assert.deepEqual(r.ordre, ['Gamma', 'Alpha', 'Delta', 'Beta']);
  });

  test('accepte un classement tronqué sans jamais le compléter', () => {
    const r = validerClassement({ classement: ['Gamma', 'Alpha'] }, attendues);
    assert.ok(r.ok);
    assert.equal(r.partiel, true);
    assert.deepEqual(r.manquantes.sort(), ['Beta', 'Delta']);
    assert.equal(r.ordre.length, 2, 'aucun actif ne doit être ajouté d\'office');
  });

  test('écarte les étiquettes inventées et les doublons', () => {
    const r = validerClassement({ classement: ['Alpha', 'Zeta', 'Alpha', 'Beta'] }, attendues);
    assert.ok(r.ok);
    assert.deepEqual(r.ordre, ['Alpha', 'Beta']);
    assert.deepEqual(r.inconnues, ['Zeta']);
    assert.equal(r.doublons, 1);
  });

  test('rejette une réponse inexploitable', () => {
    assert.equal(validerClassement({ classement: [] }, attendues).ok, false);
    assert.equal(validerClassement({}, attendues).ok, false);
    assert.equal(validerClassement({ classement: ['Zeta'] }, attendues).ok, false);
  });

  test('le schéma contraint la sortie aux étiquettes du lot', () => {
    const s = buildListwiseSchema(attendues);
    assert.deepEqual(s.properties.classement.items.enum, attendues);
    // Le champ d'analyse libre doit précéder le classement : c'est ce qui évite
    // au modèle de payer la taxe de projection du décodage contraint.
    assert.deepEqual(Object.keys(s.properties), ['analyse', 'classement', 'separation']);
  });
});

describe('classement issu de l\'ajustement', () => {
  test('produit des rangs sans ex æquo et une frontière testable', () => {
    const rnd = mulberry32(21);
    const symboles = Array.from({ length: 30 }, (_, i) => `S${i}`);
    const vrai = Object.fromEntries(symboles.map((s, i) => [s, -i / 5]));
    const { lots } = construireLots(symboles, { taille: 10, tours: 5, graine: 9 });
    const fit = ajusterPlackettLuce(lots.map((l) => ({ order: tirerClassement(l.membres, vrai, rnd) })));

    const cl = classementDepuisAjustement(fit, { maxSelected: 3 });
    assert.equal(cl.lignes.length, 30);
    assert.equal(new Set(cl.lignes.map((l) => l.lambda)).size, 30, 'aucun ex æquo : c\'est tout l\'intérêt');
    assert.equal(cl.ranks.get(cl.lignes[0].symbol).rank, 1);
    assert.ok(cl.wald && Number.isFinite(cl.wald.z), 'la frontière de sélection doit être testable');
  });
});
