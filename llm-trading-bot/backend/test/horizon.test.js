import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = process.env.DATA_DIR || `${process.cwd()}/data`;
process.env.GEMINI_API_KEY = '';

const { rankAndSelect, ageEnSeances, exitRank, actionEffective } = await import('../src/core/ranking.js');
const { fenetreResultats, SEANCES_AVANT, SEANCES_APRES, _resetCache } = await import('../src/data/earnings.js');
const { momentumCourtTerme, reversalCourtTerme, FACTEURS } = await import('../src/core/baselines.js');
const { RiskManager } = await import('../src/core/riskManager.js');

/** Évaluations synthétiques : `edge` décroissant, donc rang = position. */
function evaluations(symbols) {
  return symbols.map((symbol, i) => ({
    symbol,
    evaluated: true,
    decision: { forecast: { edge: 1 - i * 0.05 } },
  }));
}

const ilYA = (jours) => new Date(Date.now() - jours * 86_400_000).toISOString();

describe('durée minimale de détention', () => {
  // 30 actifs, seuil de sortie autour du rang 13 : les derniers décrochent
  // franchement, ce qui isole l'effet de l'âge de celui du rang.
  const univers = Array.from({ length: 30 }, (_, i) => `S${i}`);

  test('une position trop jeune n\'est pas vendue malgré un rang décroché', () => {
    const held = new Set(['S29']);
    const positions = [{ symbol: 'S29', openedAt: ilYA(3) }];   // ~2 séances

    const sansAge = rankAndSelect(evaluations(univers), { maxSelected: 10, held });
    const avecAge = rankAndSelect(evaluations(univers), {
      maxSelected: 10, held, ageMinimum: 21, positions,
    });

    assert.ok(sansAge.sorties.has('S29'), 'sans durée minimale, le rang décroché doit sortir');
    assert.equal(avecAge.sorties.has('S29'), false, 'la durée minimale doit primer sur le rang');
  });

  test('une position mûre sort normalement', () => {
    const held = new Set(['S29']);
    const positions = [{ symbol: 'S29', openedAt: ilYA(40) }];   // ~28 séances

    const r = rankAndSelect(evaluations(univers), {
      maxSelected: 10, held, ageMinimum: 21, positions,
    });
    assert.ok(r.sorties.has('S29'), 'passé la durée minimale, le rang reprend la main');
  });

  test('une position bien classée n\'est jamais vendue, quel que soit son âge', () => {
    const held = new Set(['S0']);
    for (const jours of [1, 40]) {
      const r = rankAndSelect(evaluations(univers), {
        maxSelected: 10, held, ageMinimum: 21, positions: [{ symbol: 'S0', openedAt: ilYA(jours) }],
      });
      assert.equal(r.sorties.has('S0'), false, `S0 est premier, il ne doit jamais sortir (${jours} j)`);
    }
  });

  test('une position sans date d\'ouverture reste régie par le rang', () => {
    // Position ouverte hors du bot, ou état perdu : on ne doit pas la geler
    // indéfiniment sous prétexte qu'on ignore son âge.
    const r = rankAndSelect(evaluations(univers), {
      maxSelected: 10,
      held: new Set(['S29']),
      ageMinimum: 21,
      positions: [{ symbol: 'S29', openedAt: null }],
    });
    assert.ok(r.sorties.has('S29'));
  });

  test('l\'âge se compte en séances et non en jours calendaires', () => {
    assert.equal(ageEnSeances(ilYA(7)), 5, 'une semaine = 5 séances');
    assert.equal(ageEnSeances(ilYA(28)), 20, 'quatre semaines = 20 séances');
    assert.equal(ageEnSeances(null), null);
    assert.equal(ageEnSeances('pas une date'), null);
  });

  test('la rotation annuelle chute bien d\'un facteur 7', () => {
    // C'est le calcul qui justifie tout le changement : 84 rotations à 3
    // séances contre 12 à 21 séances, soit 5,25 % de frais annuels contre
    // 0,75 % au coût mesuré de 6,25 bps.
    const cout = 0.000625;
    const fraisAnnuels = (seances) => (252 / seances) * cout;

    assert.ok(Math.abs(fraisAnnuels(3) - 0.0525) < 1e-4);
    assert.ok(Math.abs(fraisAnnuels(21) - 0.0075) < 1e-4);
    assert.ok(fraisAnnuels(3) - fraisAnnuels(21) > 0.04, 'le gain doit dépasser 4 points par an');
  });
});

describe('fenêtre de publication de résultats', () => {
  const dansNJours = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const calendrier = (dates) => ({ ok: true, dates: new Map(Object.entries(dates)) });

  test('exclut les séances précédant l\'annonce', () => {
    const cal = calendrier({ NVDA: [dansNJours(3)] });
    assert.equal(fenetreResultats('NVDA', cal).exclu, true);
  });

  test('exclut le lendemain de l\'annonce', () => {
    const cal = calendrier({ NVDA: [dansNJours(-1)] });
    assert.equal(fenetreResultats('NVDA', cal).exclu, true);
  });

  test('laisse passer une annonce lointaine', () => {
    const cal = calendrier({ NVDA: [dansNJours(30)] });
    assert.equal(fenetreResultats('NVDA', cal).exclu, false);
  });

  test('laisse passer une annonce déjà digérée', () => {
    const cal = calendrier({ NVDA: [dansNJours(-10)] });
    assert.equal(fenetreResultats('NVDA', cal).exclu, false);
  });

  test('la fenêtre est bien asymétrique', () => {
    assert.ok(SEANCES_AVANT > SEANCES_APRES, 'plus large avant qu\'après');
    assert.equal(SEANCES_AVANT, 5);
    assert.equal(SEANCES_APRES, 1);
  });

  test('un actif sans annonce connue reste éligible', () => {
    assert.equal(fenetreResultats('AAPL', calendrier({ NVDA: [dansNJours(1)] })).exclu, false);
  });

  test('calendrier indisponible => on EXCLUT, jamais on n\'autorise', () => {
    // Le choix est délibéré : bloquer coûte une journée d'abstention, autoriser
    // coûte une position ouverte la veille d'un saut de 2,5 %.
    _resetCache();
    const r = fenetreResultats('NVDA', { ok: false, dates: new Map(), raison: 'clé absente' });
    assert.equal(r.exclu, true);
    assert.match(r.raison, /indisponible/);
  });

  test('plusieurs annonces : la plus proche décide', () => {
    const cal = calendrier({ NVDA: [dansNJours(60), dansNJours(2), dansNJours(90)] });
    assert.equal(fenetreResultats('NVDA', cal).exclu, true);
  });
});

describe('sens du signal court terme', () => {
  const bougies = (closes) => closes.map((c) => ({ close: c, high: c, low: c, open: c }));

  test('momentum et retour à la moyenne sont exactement opposés', () => {
    const c = bougies([100, 101, 102, 103, 104, 110]);
    assert.ok(Math.abs(momentumCourtTerme(c) + reversalCourtTerme(c)) < 1e-12);
  });

  test('le momentum court terme récompense la hausse récente', () => {
    const monte = bougies([100, 100, 100, 100, 100, 110]);
    const baisse = bougies([100, 100, 100, 100, 100, 90]);
    assert.ok(momentumCourtTerme(monte) > 0);
    assert.ok(momentumCourtTerme(baisse) < 0);
    assert.ok(momentumCourtTerme(monte) > momentumCourtTerme(baisse));
  });

  test('le momentum 5 j est déclaré adapté à l\'horizon, le reversal ne l\'est plus', () => {
    // Sur un univers de grandes capitalisations très liquides, le retour à la
    // moyenne s'inverse en momentum. Le facteur reste mesuré, mais comme
    // témoin négatif.
    assert.equal(FACTEURS.momentumCourt.horizonAdapte, true);
    assert.equal(FACTEURS.reversal.horizonAdapte, false);
  });

  test('les deux facteurs restent mesurés côte à côte', () => {
    // Retirer le perdant supposé serait la meilleure façon de ne jamais savoir
    // qu'on s'est trompé de sens.
    assert.ok(FACTEURS.momentumCourt && FACTEURS.reversal);
  });

  test('données insuffisantes => null, jamais zéro', () => {
    assert.equal(momentumCourtTerme(bougies([100, 101])), null);
    assert.equal(momentumCourtTerme(null), null);
  });
});

describe('le stop devient un coupe-circuit de catastrophe', () => {
  const limites = (over = {}) => ({
    baseCurrency: 'USD', initialCapital: 100, maxPositions: 10, maxPositionPct: 0.35,
    minOrderValue: 5, stopAtrMultiple: 0, stopMinPct: 0.25, stopMaxPct: 0.35,
    takeProfitPct: null, maxMonthlyLossPct: 0.15, minConfidence: 0.35,
    minEdge: 0.2, minUpProbability: 0.4, minEdgeDegraded: 0.35, minHoldingDays: 21, ...over,
  });

  test('l\'ATR ne pilote plus le stop', () => {
    const rm = new RiskManager(limites());
    // Deux volatilités radicalement différentes doivent donner le même stop :
    // le niveau ne dépend plus du bruit du titre.
    const calme = rm.protectionLevels(100, 0.5);
    const agite = rm.protectionLevels(100, 8);
    assert.equal(calme.stopPct, agite.stopPct);
    assert.equal(calme.stopPct, 0.25);
  });

  test('le stop est assez loin pour ne jamais trancher sur du bruit', () => {
    const rm = new RiskManager(limites());
    const { stopPct } = rm.protectionLevels(100, 2);
    // ATR 2 % => 25 % vaut 12,5 ATR, soit 2,7 σ cumulés sur 21 séances :
    // probabilité de toucher 0,4 à 0,6 %. L'ancien réglage à 4 ATR aurait valu
    // 0,87 σ sur ce même horizon, donc 32 à 38 % de déclenchements sur du
    // bruit — il était calibré pour une détention de trois jours.
    assert.ok(stopPct / 0.02 > 10, 'le coupe-circuit doit être hors de portée du bruit ordinaire');
  });

  test('aucun objectif de gain n\'est posé', () => {
    const rm = new RiskManager(limites());
    assert.equal(rm.protectionLevels(100, 2).takeProfitPrice, null);
  });
});

describe('cohérence de la bande de non-transaction', () => {
  test('le seuil de sortie s\'élargit avec l\'univers', () => {
    assert.ok(exitRank({ universe: 150, maxSelected: 10 }) > exitRank({ universe: 30, maxSelected: 10 }));
  });

  test('le seuil laisse toujours de la place au-delà des retenus', () => {
    for (const u of [10, 50, 150]) {
      assert.ok(exitRank({ universe: u, maxSelected: 10 }) > 10);
    }
  });
});

describe('la sélection déclenche-t-elle vraiment un achat ?', () => {
  // Ces tests n'existaient pas, et c'est exactement pour ça que le moteur a
  // pu passer une journée entière incapable d'acheter : la décision
  // synthétisée valait toujours HOLD, et l'exécution ne savait que
  // rétrograder BUY en HOLD.
  const decisionRang = { action: 'HOLD', sizePct: 1, confidence: 0.98 };

  test('un actif retenu produit un ACHAT', () => {
    const r = actionEffective({
      decision: decisionRang, symbol: 'NVDA',
      selected: new Set(['NVDA']), sorties: new Set(), position: null,
    });
    assert.equal(r.action, 'BUY');
    assert.ok(r.sizePct > 0, 'un achat de taille nulle n\'est pas un achat');
  });

  test('un actif NON retenu ne produit aucun achat', () => {
    const r = actionEffective({
      decision: { ...decisionRang, action: 'BUY' }, symbol: 'AAPL',
      selected: new Set(['NVDA']), sorties: new Set(), position: null,
    });
    assert.equal(r.action, 'HOLD');
    assert.equal(r.sizePct, 0);
  });

  test('une position en sortie produit une VENTE totale', () => {
    const r = actionEffective({
      decision: decisionRang, symbol: 'NVDA',
      selected: new Set(), sorties: new Set(['NVDA']), position: { quantity: 3 },
    });
    assert.equal(r.action, 'SELL');
    assert.equal(r.sizePct, 1);
  });

  test('la sortie prime sur la sélection en cas de contradiction', () => {
    // Un actif à la fois retenu et marqué en sortie est une incohérence du
    // classement. Vendre à tort coûte un aller-retour ; acheter à tort engage
    // du capital sur un signal qu'on vient de juger caduc.
    const r = actionEffective({
      decision: decisionRang, symbol: 'NVDA',
      selected: new Set(['NVDA']), sorties: new Set(['NVDA']), position: { quantity: 3 },
    });
    assert.equal(r.action, 'SELL');
  });

  test('une sortie sans position ne vend rien', () => {
    const r = actionEffective({
      decision: decisionRang, symbol: 'NVDA',
      selected: new Set(), sorties: new Set(['NVDA']), position: { quantity: 0 },
    });
    assert.notEqual(r.action, 'SELL');
  });

  test('le poids ne dépend jamais du rang', () => {
    const premier = actionEffective({
      decision: { ...decisionRang, confidence: 1 }, symbol: 'A',
      selected: new Set(['A']), sorties: new Set(), position: null,
    });
    const dixieme = actionEffective({
      decision: { ...decisionRang, confidence: 0.94 }, symbol: 'B',
      selected: new Set(['B']), sorties: new Set(), position: null,
    });
    assert.equal(premier.sizePct, dixieme.sizePct);
  });

  test('bout en bout : classement -> sélection -> achat', () => {
    // Le chemin complet, celui qui était rompu.
    const univers = Array.from({ length: 30 }, (_, i) => `S${i}`);
    const evals = univers.map((symbol, i) => ({
      symbol, evaluated: true,
      decision: { ...decisionRang, forecast: { edge: 3 - i * 0.1 } },
    }));

    const sel = rankAndSelect(evals, { maxSelected: 10 });
    assert.ok(sel.selected.size > 0, 'le classement doit retenir des actifs');

    const achats = univers
      .map((symbol) => actionEffective({
        decision: evals.find((e) => e.symbol === symbol).decision,
        symbol, selected: sel.selected, sorties: sel.sorties, position: null,
      }))
      .filter((r) => r.action === 'BUY');

    assert.equal(achats.length, sel.selected.size, 'chaque actif retenu doit devenir un achat');
  });
});
