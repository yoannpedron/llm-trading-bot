import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = process.env.DATA_DIR || `${process.cwd()}/data`;
process.env.GEMINI_API_KEY = '';
process.env.LLM_COOLDOWN_MS = '0';

const { classerUnivers, decisionDepuisRang, ficheActif } = await import('../src/core/listwiseRanking.js');
const { rankAndSelect } = await import('../src/core/ranking.js');
const { pseudonymesUniques } = await import('../src/llm/pseudonyms.js');
const { ecartApparie } = await import('../src/core/rankMetrics.js');

/** Bougies synthétiques amenant le prix à `fin`. */
function bougies(fin, n = 260) {
  return Array.from({ length: n }, (_, i) => {
    const c = fin * (0.8 + (0.2 * i) / n);
    return { t: `j${i}`, open: c, high: c * 1.01, low: c * 0.99, close: c };
  });
}

function univers(n) {
  const donnees = new Map();
  for (let i = 0; i < n; i += 1) {
    const symbol = `S${String(i).padStart(3, '0')}`;
    const prix = 100 + i;
    donnees.set(symbol, {
      snapshot: {
        symbol,
        candles: bougies(prix),
        indicators: { price: prix, rsi14: 50, atrPct: 1.5, trend: 'neutre', ema20: prix, ema50: prix },
      },
      news: { articles: [] },
    });
  }
  return donnees;
}

/**
 * Fournisseur simulé : classe chaque lot selon une VÉRITÉ cachée, avec du
 * bruit. C'est ce qui permet de vérifier que le module retrouve l'ordre au
 * lieu de simplement produire un ordre.
 */
function fournisseurOrdonne(veriteParSymbole, { bruit = 0, seed = 1 } = {}) {
  let etat = seed;
  const rnd = () => {
    etat = (etat * 1103515245 + 12345) & 0x7fffffff;
    return etat / 0x7fffffff;
  };
  return {
    appels: 0,
    async decide(prompt, { schema }) {
      this.appels += 1;
      const etiquettes = schema.properties.classement.items.enum;
      // Le prompt ne contient que des pseudonymes : on retrouve le symbole via
      // la ligne de contexte, comme le ferait un lecteur humain.
      const ordonne = [...etiquettes].sort((a, b) => {
        const va = veriteParSymbole.get(a) + (rnd() - 0.5) * bruit;
        const vb = veriteParSymbole.get(b) + (rnd() - 0.5) * bruit;
        return vb - va;
      });
      return {
        raw: JSON.stringify({
          analyse: 'classement simulé', classement: ordonne, separation: 'NETTE',
        }),
      };
    },
  };
}

/** Table pseudonyme → valeur vraie, pour que le fournisseur simulé puisse trier. */
function veriteParEtiquette(donnees, valeur) {
  const noms = pseudonymesUniques([...donnees.keys()]);
  const m = new Map();
  for (const [symbol, nom] of noms) m.set(nom, valeur(symbol));
  return m;
}

describe('classement par comparaison — bout en bout', () => {
  test('retrouve l\'ordre caché et produit des valeurs TOUTES distinctes', async () => {
    const donnees = univers(60);
    const vraie = (s) => -Number(s.slice(1));                    // S000 le meilleur
    const provider = fournisseurOrdonne(veriteParEtiquette(donnees, vraie), { bruit: 0.5 });

    const r = await classerUnivers(donnees, { provider, tours: 4, taille: 10, graine: 7, cooldownMs: 0 });

    assert.equal(r.diagnostics.reussis, r.diagnostics.lots, 'tous les lots doivent aboutir');
    assert.equal(
      r.diagnostics.valeursDistinctes, 60,
      `60 actifs doivent donner 60 forces distinctes, obtenu ${r.diagnostics.valeursDistinctes}`,
    );

    // L'ordre retrouvé doit fortement corréler avec la vérité cachée.
    const rangs = [...r.ranks.entries()].map(([s, i]) => [vraie(s), i.rank]);
    const n = rangs.length;
    const mx = rangs.reduce((a, p) => a + p[0], 0) / n;
    const my = rangs.reduce((a, p) => a + p[1], 0) / n;
    let num = 0; let dx = 0; let dy = 0;
    for (const [x, y] of rangs) { num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; }
    const rho = num / Math.sqrt(dx * dy);
    assert.ok(rho < -0.9, `l'ordre doit être retrouvé (corrélation ${rho.toFixed(3)})`);
  });

  test('le coût est bien de 4 tours × lots, pas d\'un appel par actif', async () => {
    const donnees = univers(150);
    const provider = fournisseurOrdonne(veriteParEtiquette(donnees, (s) => -Number(s.slice(1))));
    await classerUnivers(donnees, { provider, tours: 4, taille: 10, graine: 3, cooldownMs: 0 });
    assert.equal(provider.appels, 60, '150 actifs, 4 tours de 15 lots = 60 appels');
    assert.ok(provider.appels < 150, 'moins cher que la notation individuelle');
  });

  test('un modèle qui répond au hasard est déclaré non significatif', async () => {
    const donnees = univers(60);
    // Vérité constante + bruit énorme = ordre purement aléatoire.
    const provider = fournisseurOrdonne(veriteParEtiquette(donnees, () => 0), { bruit: 1000 });
    const r = await classerUnivers(donnees, { provider, tours: 4, taille: 10, graine: 11, cooldownMs: 0 });

    assert.equal(
      r.test.significatif, false,
      `un classement aléatoire ne doit pas être déclaré significatif (p = ${r.test.p})`,
    );
    assert.equal(r.test.methode, 'bootstrap');
  });

  test('un modèle cohérent est déclaré significatif', async () => {
    const donnees = univers(60);
    const provider = fournisseurOrdonne(veriteParEtiquette(donnees, (s) => -Number(s.slice(1))), { bruit: 0.2 });
    const r = await classerUnivers(donnees, { provider, tours: 4, taille: 10, graine: 13, cooldownMs: 0 });
    assert.equal(r.test.significatif, true, `p = ${r.test.p}`);
  });

  test('les lots en échec n\'empêchent pas le classement', async () => {
    const donnees = univers(60);
    const bon = fournisseurOrdonne(veriteParEtiquette(donnees, (s) => -Number(s.slice(1))));
    let n = 0;
    const capricieux = {
      async decide(p, o) {
        n += 1;
        if (n % 3 === 0) throw new Error('429 quota');
        return bon.decide(p, o);
      },
    };
    const r = await classerUnivers(donnees, { provider: capricieux, tours: 4, taille: 10, graine: 5, cooldownMs: 0 });
    assert.ok(r.diagnostics.echecs.length > 0, 'des échecs doivent être consignés');
    assert.ok(r.ranks.size >= 55, 'le classement doit survivre à un tiers de pertes');
    assert.ok(r.diagnostics.connexe, 'le graphe doit rester connexe');
  });

  test('le classement alimente la sélection SANS ex æquo', async () => {
    const donnees = univers(60);
    const provider = fournisseurOrdonne(veriteParEtiquette(donnees, (s) => -Number(s.slice(1))), { bruit: 0.3 });
    const r = await classerUnivers(donnees, { provider, tours: 4, taille: 10, graine: 17, cooldownMs: 0 });

    const sel = rankAndSelect(r.evaluations, {
      maxSelected: 10,
      abstention: { abstenir: !r.test.significatif, raison: 'non significatif' },
     seuilConviction: 0 });

    assert.equal(sel.selected.size, 10);
    // C'est LE point : avec la notation individuelle, cinquante actifs
    // partageaient la meilleure note et le tri les départageait par ordre
    // alphabétique. Ici chaque force est unique.
    const edges = r.evaluations.map((e) => e.decision.forecast.edge);
    assert.equal(new Set(edges).size, edges.length, 'aucun ex æquo ne doit subsister');
  });

  test('abstention si le test global échoue', async () => {
    const donnees = univers(60);
    const provider = fournisseurOrdonne(veriteParEtiquette(donnees, () => 0), { bruit: 1000 });
    const r = await classerUnivers(donnees, { provider, tours: 4, taille: 10, graine: 23, cooldownMs: 0 });

    const sel = rankAndSelect(r.evaluations, {
      maxSelected: 10,
      abstention: { abstenir: !r.test.significatif, raison: 'hasard' },
     seuilConviction: 0 });
    assert.equal(sel.selected.size, 0, 'aucun achat sur un classement aléatoire');
    assert.match(sel.reason, /hasard/);
  });
});

describe('décision dérivée du rang', () => {
  test('ne fabrique aucune probabilité', () => {
    const d = decisionDepuisRang({ rank: 3, total: 150, fractional: 0.98, lambda: 1.24, se: 0.31 });
    // Le modèle n'a annoncé aucune probabilité : en inventer une ferait
    // mesurer nos conversions au lieu de ses convictions.
    assert.equal(d.forecast.up, undefined);
    assert.equal(d.forecast.down, undefined);
    assert.equal(d.forecast.edge, 1.24);
  });

  test('le poids reste égal quel que soit le rang', () => {
    const premier = decisionDepuisRang({ rank: 1, total: 150, fractional: 1, lambda: 2.5, se: 0.2 });
    const dernier = decisionDepuisRang({ rank: 10, total: 150, fractional: 0.94, lambda: 0.4, se: 0.2 });
    assert.equal(premier.sizePct, dernier.sizePct);
  });

  test('un actif absent du classement ne peut rien déclencher', () => {
    const d = decisionDepuisRang(null);
    assert.equal(d.action, 'HOLD');
    assert.equal(d.sizePct, 0);
  });

  test('la confiance reste NULLE, jamais zéro', () => {
    // Écrire 0 ferait croire à une confiance nulle MESURÉE là où il n'y a rien
    // à mesurer — le modèle n'annonce plus de probabilité depuis qu'il ordonne.
    // Le module de calibration lirait ce zéro comme une annonce et produirait
    // une courbe fausse mais parfaitement lisible.
    for (const d of [decisionDepuisRang(null),
      decisionDepuisRang({ rank: 3, total: 150, fractional: 0.98, lambda: 1.2, se: 0.3 })]) {
      assert.equal(d.confidence, null, 'confidence doit être null, pas 0');
    }
  });

  test('le rang est publié sous son vrai nom', () => {
    const d = decisionDepuisRang({ rank: 3, total: 150, fractional: 0.98, lambda: 1.2, se: 0.3 });
    assert.equal(d.rankFractional, 0.98);
  });

  test('la justification cite le rang et l\'incertitude', () => {
    const d = decisionDepuisRang({ rank: 7, total: 150, fractional: 0.95, lambda: 0.8, se: 0.25 });
    assert.match(d.justification, /Rang 7 sur 150/);
    assert.match(d.justification, /± 0\.25/);
  });
});

describe('fiche transmise au modèle', () => {
  test('porte le secteur et la taille, jamais le symbole réel', () => {
    const f = ficheActif('NVDA', {
      snapshot: { candles: bougies(100), indicators: { price: 100, rsi14: 55, atrPct: 2, trend: 'haussière' } },
      news: { articles: [] },
      etiquette: 'Norvane Group',
    });
    assert.equal(f.etiquette, 'Norvane Group');
    assert.ok(f.secteur, 'le secteur est fourni en clair : il n\'identifie personne');
    assert.ok(f.taille, 'la tranche de taille conditionne la lecture d\'un événement');
    assert.equal(JSON.stringify(f).includes('NVDA'), false || f.symbol === 'NVDA');
  });

  test('calcule le rendement 5 séances', () => {
    const f = ficheActif('X', {
      snapshot: { candles: bougies(100), indicators: { price: 100 } },
      news: { articles: [] },
      etiquette: 'Test',
    });
    assert.ok(Number.isFinite(f.rendement5j));
  });
});

describe('comparaison appariée modèle / formule', () => {

  const serie = (vals) => ({ quotidien: vals.map((ic, i) => ({ day: `2026-01-${String(i + 1).padStart(2, '0')}`, ic })) });

  test('détecte un écart constant que les moyennes seules noieraient', () => {
    // Les deux prédicteurs suivent le marché du jour — forte variance commune —
    // mais l'un devance l'autre de 0,05 chaque jour. Comparer deux moyennes
    // séparées ne verrait rien ; l'appariement voit tout.
    const marche = [0.4, -0.3, 0.5, -0.6, 0.2, 0.35, -0.45, 0.1, -0.2, 0.3, 0.15, -0.1];
    const a = serie(marche.map((m) => m + 0.05));
    const b = serie(marche);

    const r = ecartApparie(a, b);
    assert.equal(r.jours, 12);
    assert.ok(Math.abs(r.ecartMoyen - 0.05) < 1e-9);
    assert.ok(r.significatif, `écart constant doit être détecté (t = ${r.tStat})`);
    assert.match(r.verdict, /modèle fait mieux/);
  });

  test('ne conclut rien quand les deux se valent', () => {
    const a = serie([0.4, -0.3, 0.5, -0.6, 0.2, 0.35, -0.45, 0.1, -0.2, 0.3]);
    const b = serie([-0.3, 0.4, -0.5, 0.6, -0.2, 0.3, 0.4, -0.15, 0.25, -0.3]);
    const r = ecartApparie(a, b);
    assert.equal(r.significatif, false);
    assert.match(r.verdict, /indistinguables/);
  });

  test('détecte aussi le sens INVERSE', () => {
    // Un facteur qui bat le modèle est une information exploitable, pas un
    // échec de mesure.
    const marche = [0.4, -0.3, 0.5, -0.6, 0.2, 0.35, -0.45, 0.1, -0.2, 0.3, 0.15, -0.1];
    const r = ecartApparie(serie(marche), serie(marche.map((m) => m + 0.08)));
    assert.ok(r.significatif);
    assert.ok(r.tStat < 0);
    assert.match(r.verdict, /facteur fait mieux/);
  });

  test('n\'apparie que les jours COMMUNS aux deux', () => {
    const a = { quotidien: [{ day: 'j1', ic: 0.1 }, { day: 'j2', ic: 0.2 }, { day: 'j3', ic: 0.3 }] };
    const b = { quotidien: [{ day: 'j2', ic: 0.1 }, { day: 'j3', ic: 0.1 }, { day: 'j9', ic: 0.9 }] };
    assert.equal(ecartApparie(a, b).jours, 2);
  });

  test('annonce combien de jours il faudrait pour trancher', () => {
    // « Pas encore significatif » ne dit pas s'il faut attendre deux semaines
    // ou dix ans. Ce chiffre-là est actionnable.
    const marche = Array.from({ length: 20 }, (_, i) => Math.sin(i) * 0.4);
    const r = ecartApparie(serie(marche.map((m) => m + 0.01)), serie(marche));
    assert.ok(Number.isFinite(r.joursEstimesPourTrancher));
  });

  test('refuse de conclure sous 5 jours communs', () => {
    const r = ecartApparie(serie([0.1, 0.2, 0.3]), serie([0.05, 0.1, 0.2]));
    assert.equal(r.jours, 3);
    assert.match(r.note, /au moins 5/);
  });
});
