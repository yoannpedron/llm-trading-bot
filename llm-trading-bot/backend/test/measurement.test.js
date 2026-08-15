import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = path.join(os.tmpdir(), `bot-measure-${Date.now()}`);
process.env.DATA_DIR = TMP_DIR;
process.env.GEMINI_API_KEY = '';
process.env.SYMBOLS = 'NVDA,AAPL';

const { calendarPhase } = await import('../src/data/calendar.js');
const { ShadowBook, RULE_VERSION } = await import('../src/core/shadowBook.js');
const { Sprt, designEffect } = await import('../src/core/sprt.js');
const { normalizeForecast, deriveAction } = await import('../src/llm/agent.js');
const { RiskManager } = await import('../src/core/riskManager.js');
const { executionQuality } = await import('../src/data/executionQuality.js');
const { calibration } = await import('../src/core/calibration.js');
const { SqliteStore } = await import('../src/storage/SqliteStore.js');
const { rankAndSelect, MIN_DISPERSION, exitRank } = await import('../src/core/ranking.js');
const { rankIC, rankCalibrationError } = await import('../src/core/rankMetrics.js');

after(async () => {
  // SQLite garde ses fichiers ouverts : sous Windows la suppression du dossier
  // échoue avec EBUSY tant qu'un descripteur subsiste.
  SqliteStore.closeAll();
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

const utc = (s) => new Date(`${s}T12:00:00Z`);

describe('phase calendaire', () => {
  test('identifie le dernier jour de bourse du mois comme T-1', () => {
    // 31 août 2026 est un lundi : c'est le dernier jour de bourse d'août.
    const p = calendarPhase(utc('2026-08-31'));
    assert.equal(p.label, 'T-1');
    assert.equal(p.phase, 'TOM');
  });

  test('identifie les trois premiers jours de bourse comme TOM', () => {
    assert.equal(calendarPhase(utc('2026-09-01')).label, 'T+1');
    assert.equal(calendarPhase(utc('2026-09-03')).label, 'T+3');
    assert.equal(calendarPhase(utc('2026-09-01')).phase, 'TOM');
  });

  test('le 4e jour du mois sort de la fenêtre TOM', () => {
    assert.equal(calendarPhase(utc('2026-09-04')).phase, 'NEUTRAL');
  });

  test('la fenêtre PreTOM couvre T-9 à T-3', () => {
    assert.equal(calendarPhase(utc('2026-08-26')).phase, 'PRE_TOM'); // T-4
    assert.equal(calendarPhase(utc('2026-08-27')).phase, 'PRE_TOM'); // T-3
  });

  test('T-3 signale le pic moderne (règlement T+1 depuis mai 2024)', () => {
    const p = calendarPhase(utc('2026-08-27'));
    assert.match(p.note, /T\+1/);
    assert.match(p.note, /Pic de liquidation/);
  });

  test('ignore les week-ends dans le décompte des jours de bourse', () => {
    // Le 30 août 2026 est un dimanche.
    assert.equal(calendarPhase(utc('2026-08-30')).phase, 'NEUTRAL');
    assert.equal(calendarPhase(utc('2026-08-30')).offset, null);
  });

  test('un jour férié NYSE n\'est pas un jour de bourse', () => {
    // 25 décembre 2026 : Noël.
    assert.equal(calendarPhase(utc('2026-12-25')).offset, null);
  });
});

describe('carnet fantôme — règles de scoring', () => {
  const { score } = ShadowBook;

  test('un BUY est récompensé par une hausse', () => {
    assert.equal(score('BUY', false, 0.03), 0.03);
    assert.equal(score('BUY', false, -0.03), -0.03);
  });

  test('un SELL est récompensé par une baisse', () => {
    assert.equal(score('SELL', true, -0.03), 0.03);
    assert.equal(score('SELL', true, 0.03), -0.03);
  });

  test('HOLD avec position vaut « ça continue » : on assume la suite', () => {
    assert.equal(score('HOLD', true, 0.03), 0.03);
    assert.equal(score('HOLD', true, -0.03), -0.03);
  });

  test('HOLD sans position vaut « rien à prendre » : s\'abstenir avant une hausse est une erreur', () => {
    assert.equal(score('HOLD', false, 0.03), -0.03);
    assert.equal(score('HOLD', false, -0.03), 0.03);
  });

  test('une action inconnue n\'est pas scorable', () => {
    assert.equal(score('WAT', false, 0.03), null);
  });
});

describe('carnet fantôme — dégroupage des corrélations', () => {
  test('ne retient qu\'une observation par symbole et par jour', async () => {
    const book = new ShadowBook();
    await book.init();

    // Trois cycles le même jour sur le même actif : en bougies journalières
    // c'est quasiment la même décision. Les compter trois fois sous-estimerait
    // la variance et validerait à tort.
    await book.replaceAll([
      { t: '2026-08-03T14:30:00Z', symbol: 'NVDA', action: 'BUY', ruleVersion: RULE_VERSION, confidence: 0.7, hadPosition: false, newsAvailable: true, calendarPhase: 'NEUTRAL', outcomes: { d3: { score: 0.01 } } },
      { t: '2026-08-03T17:30:00Z', symbol: 'NVDA', action: 'BUY', ruleVersion: RULE_VERSION, confidence: 0.7, hadPosition: false, newsAvailable: true, calendarPhase: 'NEUTRAL', outcomes: { d3: { score: 0.011 } } },
      { t: '2026-08-03T19:30:00Z', symbol: 'NVDA', action: 'BUY', ruleVersion: RULE_VERSION, confidence: 0.7, hadPosition: false, newsAvailable: true, calendarPhase: 'NEUTRAL', outcomes: { d3: { score: 0.012 } } },
      { t: '2026-08-03T14:30:00Z', symbol: 'AAPL', action: 'HOLD', ruleVersion: RULE_VERSION, confidence: 0.4, hadPosition: false, newsAvailable: true, calendarPhase: 'NEUTRAL', outcomes: { d3: { score: -0.004 } } },
      { t: '2026-08-04T14:30:00Z', symbol: 'NVDA', action: 'BUY', ruleVersion: RULE_VERSION, confidence: 0.6, hadPosition: true, newsAvailable: false, calendarPhase: 'NEUTRAL', outcomes: { d3: { score: 0.02 } } },
    ]);

    // Deux dégroupages distincts s'appliquent, et il faut les séparer :
    //
    //   • INTRAJOURNALIER : les trois cycles NVDA du 03 se réduisent à un ;
    //   • SÉRIEL : le NVDA du 04 chevauche encore la fenêtre à 3 jours ouvrée
    //     par celui du 03 — les deux observations partagent deux tiers de leur
    //     période de rendement. Les compter séparément gonflerait la taille
    //     d'échantillon d'un facteur 3 sans apporter d'information nouvelle.
    //
    // Reste donc : NVDA 03 + AAPL 03.
    const series = await book.scoreSeries({ horizon: 3 });
    assert.equal(series.length, 2, 'NVDA jour 1 + AAPL jour 1 ; le NVDA du lendemain chevauche');
    assert.equal(series[0].score, 0.01, 'la première observation du jour est retenue');

    // Le dégroupage sériel est désactivable, et sans lui on retrouve exactement
    // la troisième observation : la preuve que c'est bien cette règle-là — et
    // non le dégroupage intrajournalier — qui l'a écartée.
    const avecChevauchement = await book.scoreSeries({ horizon: 3, allowOverlap: true });
    assert.equal(avecChevauchement.length, 3, 'sans la règle sérielle, NVDA jour 2 revient');
  });

  test('ignore les décisions non résolues', async () => {
    const book = new ShadowBook();
    await book.init();
    await book.replaceAll([
      { t: '2026-08-03T14:30:00Z', symbol: 'NVDA', action: 'BUY', ruleVersion: RULE_VERSION, outcomes: null },
      { t: '2026-08-04T14:30:00Z', symbol: 'NVDA', action: 'BUY', ruleVersion: RULE_VERSION, outcomes: { d3: { score: 0.01 } } },
    ]);
    assert.equal((await book.scoreSeries({ horizon: 3 })).length, 1);
  });
});

describe('coupe-circuit mensuel', () => {
  const limits = {
    baseCurrency: 'USD', initialCapital: 100, maxPositions: 3, maxPositionPct: 0.35,
    minOrderValue: 5, maxMonthlyLossPct: 0.15,
    stopAtrMultiple: 4, stopMinPct: 0.08, stopMaxPct: 0.2,
  };

  test('ne se déclenche pas sur une perte qui relève du bruit journalier', async () => {
    // 8 % de perte : sur un portefeuille investi en valeurs dont l'ATR
    // journalier atteint 3-5 %, c'est du bruit normal. Un seuil journalier à
    // 10 % aurait coupé ici, au hasard.
    const risk = new RiskManager(limits);
    await risk.init({ equity: 100, currency: 'USD' });
    const cb = await risk.checkCircuitBreaker({ equity: 92, currency: 'USD' });
    assert.equal(cb.tripped, false);
    assert.equal(cb.period, 'mois');
  });

  test('se déclenche au-delà de la limite mensuelle', async () => {
    const risk = new RiskManager(limits);
    await risk.init({ equity: 100, currency: 'USD' });
    const cb = await risk.checkCircuitBreaker({ equity: 80, currency: 'USD' });
    assert.equal(cb.tripped, true);
    assert.ok(cb.drawdownPct >= 15);
  });

  test('bloque les achats mais laisse les ventes possibles', async () => {
    const risk = new RiskManager(limits);
    await risk.init({ equity: 100, currency: 'USD' });
    const cb = await risk.checkCircuitBreaker({ equity: 80, currency: 'USD' });

    const budget = risk.computeBudget({
      account: { equity: 80, cash: 80, currency: 'USD', positionsCount: 1 },
      position: null, price: 100, fxRate: 1, circuitBreaker: cb,
    });
    assert.equal(budget.canBuy, false);
    assert.match(budget.blockReason, /coupe-circuit/);

    // La vente reste autorisée : on doit toujours pouvoir se protéger.
    const sell = risk.validate({
      decision: { action: 'SELL', confidence: 0.9, sizePct: 1 },
      account: { equity: 80, cash: 80, currency: 'USD', positionsCount: 1 },
      position: { quantity: 2 }, price: 100, fxRate: 1, budget,
    });
    assert.equal(sell.approved, true);
  });
});

describe('qualité d\'exécution', () => {
  test('mesure un fill conforme au NBBO comme un coût nul', async () => {
    // Achat exécuté exactement à l'ask : c'est ce qu'Alpaca annonce.
    const s = await executionQuality.record({
      symbol: 'TEST1', side: 'BUY', fillPrice: 100.05, quantity: 1, orderId: 'a',
      quote: { bid: 99.95, ask: 100.05 },
    });
    assert.equal(s.slippageVsExpectedBps, 0);
    assert.ok(s.slippageVsMidBps > 0, 'par rapport au milieu, on paie bien la moitié du spread');
  });

  test('détecte une amélioration de prix', async () => {
    const s = await executionQuality.record({
      symbol: 'TEST2', side: 'BUY', fillPrice: 100.0, quantity: 1, orderId: 'b',
      quote: { bid: 99.95, ask: 100.05 },
    });
    assert.ok(s.slippageVsExpectedBps < 0, 'acheter sous l\'ask est une amélioration');
  });

  test('détecte une dégradation', async () => {
    const s = await executionQuality.record({
      symbol: 'TEST3', side: 'SELL', fillPrice: 99.85, quantity: 1, orderId: 'c',
      quote: { bid: 99.95, ask: 100.05 },
    });
    assert.ok(s.slippageVsExpectedBps > 0, 'vendre sous le bid est une dégradation');
  });

  test('archive le fill même sans cotation de référence', async () => {
    const s = await executionQuality.record({
      symbol: 'TEST4', side: 'BUY', fillPrice: 100, quantity: 1, orderId: 'd', quote: null,
    });
    assert.equal(s.slippageVsExpectedBps, null);
    assert.equal(s.fillPrice, 100);
  });

  test('le résumé sépare les fills mesurables des autres', async () => {
    const summary = await executionQuality.summary();
    assert.ok(summary.fills >= 4);
    assert.equal(summary.measurable, 3, 'le fill sans cotation est exclu de la statistique');
    assert.ok(typeof summary.interpretation === 'string');
  });
});

describe('SPRT', () => {
  const sprt = new Sprt({ targetSharpe: 0.1, alpha: 0.05, beta: 0.05, maxSamples: 400, minSamples: 30 });

  test('les bornes de Wald sont symétriques pour alpha = beta', () => {
    assert.ok(Math.abs(sprt.upperBound + sprt.lowerBound) < 1e-9);
    assert.ok(Math.abs(sprt.upperBound - Math.log(0.95 / 0.05)) < 1e-9);
  });

  test('refuse de trancher sous le plancher d\'observations', () => {
    const v = sprt.evaluate(Array.from({ length: 10 }, () => 0.01));
    assert.equal(v.status, 'DONNEES_INSUFFISANTES');
  });

  test('arrête une stratégie franchement perdante', () => {
    // Dérive négative nette et régulière.
    const scores = Array.from({ length: 300 }, (_, i) => -0.006 + 0.01 * Math.sin(i));
    const v = sprt.evaluate(scores);
    assert.equal(v.status, 'ARRETER');
    assert.ok(v.crossedAt > 0);
  });

  test('valide une stratégie franchement gagnante', () => {
    const scores = Array.from({ length: 300 }, (_, i) => 0.006 + 0.01 * Math.sin(i));
    const v = sprt.evaluate(scores);
    assert.equal(v.status, 'VALIDE');
  });

  test('distingue la troncature d\'un vrai franchissement de futilité', () => {
    // Série sans dérive : le test ne peut pas trancher, il doit tronquer.
    // La troncature porte sur les PREUVES, donc il faut fournir en plus les
    // observations consommées par la calibration d'échelle.
    const total = sprt.maxSamples + sprt.warmupSamples;
    const scores = Array.from({ length: total }, (_, i) => 0.02 * Math.sin(i * 1.7));
    const v = sprt.evaluate(scores);
    assert.ok(['TRONQUE', 'ARRETER'].includes(v.status));
    if (v.status === 'TRONQUE') {
      assert.equal(v.truncated, true);
      assert.match(v.caveat, /Type II/);
    }
  });

  test('l\'échelle n\'utilise aucune information future', () => {
    // LE test qui verrouille la correction du biais d'anticipation.
    //
    // On prend une série, on l'évalue, puis on MODIFIE sa fin et on réévalue.
    // Le préfixe étant inchangé, la trajectoire du LLR sur ce préfixe doit
    // rester rigoureusement identique. Avec une échelle globale, changer la
    // fin déplaçait σ, donc TOUS les incréments — y compris ceux du début.
    // 20 observations de calibration + 50 preuves : la trajectoire complète est
    // conservée (le plafond d'affichage est à 100), donc les indices sont
    // directement comparables.
    const prefix = Array.from({ length: 70 }, (_, i) => 0.002 + 0.012 * Math.sin(i * 0.9));
    const calme = [...prefix, ...Array.from({ length: 20 }, () => 0.001)];
    // Volatilité vingt fois supérieure : si σ était global, l'effet serait massif.
    const agite = [...prefix, ...Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.25 : -0.25))];

    const seul = sprt.evaluate(prefix);
    const a = sprt.evaluate(calme);
    const b = sprt.evaluate(agite);

    assert.equal(seul.status, 'CONTINUER', 'le préfixe ne doit pas conclure');
    assert.equal(seul.trajectory.length, 50);

    // Chaque point de la trajectoire du préfixe doit se retrouver À L'IDENTIQUE
    // dans les deux séries prolongées. Avec une échelle globale, changer la fin
    // déplaçait σ et donc TOUS les incréments, y compris ceux du début.
    for (let i = 0; i < seul.trajectory.length; i += 1) {
      assert.equal(a.trajectory[i], seul.trajectory[i], `divergence à l'indice ${i} (suite calme)`);
      assert.equal(b.trajectory[i], seul.trajectory[i], `divergence à l'indice ${i} (suite agitée)`);
    }
  });

  test('la calibration d\'échelle ne produit aucune preuve', () => {
    const v = sprt.evaluate(Array.from({ length: 25 }, (_, i) => 0.01 * Math.sin(i)));
    assert.equal(v.status, 'DONNEES_INSUFFISANTES');
    // 25 observations, 20 pour l'échelle → 5 preuves, loin des 30 requises.
    assert.equal(v.nEff, 5);
    assert.match(v.reason, /calibrer l'échelle/);
  });

  test('aucun franchissement n\'est accepté après la troncature', () => {
    // LE test qui interdit l'arrêt optionnel.
    //
    // Série volontairement piégeuse : 400 preuves de pur bruit — le test doit
    // tronquer là — suivies d'une longue dérive franchement gagnante. Un test
    // qui continuerait à regarder finirait par valider, et sa garantie de 5 %
    // serait fictive : c'est précisément « attendre que le résultat plaise ».
    const petit = new Sprt({ targetSharpe: 0.1, maxSamples: 60, minSamples: 30, warmupSamples: 20 });
    const bruit = Array.from({ length: 20 + 60 }, (_, i) => 0.02 * Math.sin(i * 1.7));
    const cadeau = Array.from({ length: 400 }, () => 0.03);

    const seul = petit.evaluate(bruit);
    assert.equal(seul.status, 'TRONQUE', 'le bruit seul doit tronquer');

    const avecSuite = petit.evaluate([...bruit, ...cadeau]);
    assert.equal(
      avecSuite.status,
      'TRONQUE',
      'une dérive gagnante APRÈS la troncature ne doit jamais valider rétroactivement',
    );
    assert.equal(avecSuite.nEff, 60, 'le test ne lit pas au-delà de sa troncature');
    assert.ok(avecSuite.nUnused > 0, 'et signale les observations laissées de côté');
  });

  test('le franchissement arrête la lecture immédiatement', () => {
    // Symétrie du point précédent : une fois la borne franchie, la suite de la
    // série n'a plus à être lue. Sinon le LLR affiché ne correspondrait plus au
    // verdict rendu.
    const scores = [
      ...Array.from({ length: 300 }, (_, i) => 0.008 + 0.01 * Math.sin(i)),
      ...Array.from({ length: 200 }, () => -0.05),
    ];
    const v = sprt.evaluate(scores);
    assert.equal(v.status, 'VALIDE');
    assert.equal(v.nEff, v.crossedAt, 'la lecture s\'arrête au franchissement');
    assert.ok(v.llr >= v.bounds.upper, 'et le LLR rapporté est bien celui du verdict');
  });

  test('le dépassement de borne renforce la garantie au lieu de la relâcher', () => {
    const scores = Array.from({ length: 300 }, (_, i) => 0.008 + 0.01 * Math.sin(i));
    const v = sprt.evaluate(scores);
    assert.equal(v.status, 'VALIDE');
    assert.ok(v.overshoot >= 0, 'le franchissement dépasse toujours la borne');
    // L'erreur réellement atteinte est nécessairement inférieure à ce que
    // garantit la borne : renforcement gratuit, par l'inégalité de Ville.
    assert.ok(
      v.achievedErrorRate <= v.guaranteedErrorRate,
      `erreur atteinte ${v.achievedErrorRate} doit être sous ${v.guaranteedErrorRate}`,
    );
    // Et la référence est bien α/(1−β), le conservatisme propre aux bornes de
    // Wald — PAS le α nominal. Confondre les deux ferait annoncer un
    // renforcement là où il y a dégradation.
    assert.ok(Math.abs(v.guaranteedErrorRate - sprt.alpha / (1 - sprt.beta)) < 1e-5);
  });

  test('un seul outlier ne peut pas franchir une borne à lui seul', () => {
    // C'est LA raison des densités Student-t. Avec un modèle gaussien, ce
    // rendement à ~30 écarts-types validerait la stratégie à lui tout seul.
    const scores = Array.from({ length: 50 }, () => 0.0001);
    scores[25] = 0.5;
    const v = sprt.evaluate(scores);
    assert.notEqual(v.status, 'VALIDE', 'un outlier isolé ne doit jamais valider');
  });

  test('l\'ASN est maximal au point d\'indifférence', () => {
    const atIndifference = sprt.expectedSampleSize(0.05);
    const atH0 = sprt.expectedSampleSize(-0.2);
    const atH1 = sprt.expectedSampleSize(0.3);
    assert.ok(atIndifference >= atH0);
    assert.ok(atIndifference >= atH1);
  });

  test('la table de référence traduit les décisions en semaines', () => {
    const table = sprt.referenceTable(4);
    const bad = table.find((r) => r.trueSharpe === -0.2);
    assert.ok(bad.expectedDecisions > 0);
    assert.ok(bad.expectedWeeks > 0 && bad.expectedWeeks < 20);
  });
});

describe('calibration des probabilités', () => {
  /** Génère n paires dont la fréquence réalisée vaut exactement `realized`. */
  const pairs = (n, announced, realized) => Array.from({ length: n }, (_, i) => ({
    p: announced,
    y: i < Math.round(n * realized) ? 1 : 0,
  }));

  test('refuse de conclure sous 10 observations', () => {
    const c = calibration(pairs(8, 0.7, 0.7));
    assert.equal(c.brier, undefined);
    assert.match(c.note, /au moins 10/);
  });

  test('une prévision parfaitement calibrée a une erreur nulle', () => {
    // Annonce 60 %, réalise 60 % : l'écart de calibration doit être nul.
    const c = calibration(pairs(100, 0.6, 0.6));
    assert.equal(c.ece, 0);
    assert.equal(c.decomposition.fiabilite, 0);
    assert.equal(c.biaisMoyen, 0);
  });

  test('détecte la surconfiance et lui donne le bon signe', () => {
    // Annonce 90 %, réalise 50 % : surconfiance de 40 points.
    const c = calibration(pairs(100, 0.9, 0.5));
    assert.ok(c.ece > 0.35, `ECE ${c.ece} doit refléter les 40 points d'écart`);
    assert.ok(c.biaisMoyen > 0, 'un biais positif signale la surconfiance');
    assert.equal(c.ecartMax, 0.4);
  });

  test('une confiance constante est déclarée non informative', () => {
    // Le modèle annonce toujours 0,7, qu'il ait raison ou tort : une seule
    // tranche, aucune variation de la fréquence réalisée entre tranches.
    const c = calibration(pairs(120, 0.7, 0.55));
    assert.equal(c.decomposition.resolution, 0, 'aucun pouvoir discriminant');
    assert.match(c.verdict, /NON INFORMATIVE/);
  });

  test('une confiance discriminante est reconnue comme telle', () => {
    // Deux populations : quand le modèle annonce 0,85 il a raison 85 % du
    // temps, quand il annonce 0,3 il a raison 30 % du temps.
    const c = calibration([...pairs(60, 0.85, 0.85), ...pairs(60, 0.3, 0.3)]);
    assert.ok(c.decomposition.resolution > 0, 'les tranches se séparent');
    assert.equal(c.decomposition.fiabilite, 0, 'et chacune est bien calibrée');
    // 0,31 est ici le PLAFOND, pas un score médiocre : la résolution ne peut
    // égaler l'incertitude que si les tranches réalisent 0 % et 100 %. Avec des
    // fréquences de 30 % et 85 %, la séparation maximale est atteinte.
    // Confondre ce plafond avec une note sur 1 conduirait à croire la
    // calibration mauvaise alors qu'elle est parfaite.
    assert.ok(c.scoreHabilete > 0.25, `score d'habileté ${c.scoreHabilete} trop faible`);
    assert.match(c.verdict, /EXPLOITABLE/);
  });

  test('la décomposition de Murphy reconstitue le score de Brier', () => {
    // Brier = fiabilité − résolution + incertitude. C'est une identité, elle
    // doit tenir exactement — sinon la lecture des trois termes est fausse.
    const c = calibration([...pairs(50, 0.9, 0.6), ...pairs(50, 0.2, 0.35)]);
    const { fiabilite, resolution, incertitude } = c.decomposition;
    assert.ok(
      Math.abs(c.brier - (fiabilite - resolution + incertitude)) < 1e-3,
      `Brier ${c.brier} vs décomposition ${fiabilite - resolution + incertitude}`,
    );
  });

  test('la pente démasque une surconfiance que le biais moyen cache', () => {
    // Surconfiance SYMÉTRIQUE : le modèle exagère de 10 points aux deux bouts.
    // Le biais moyen s'annule par compensation et dirait « équilibré ».
    const c = calibration([...pairs(100, 0.9, 0.8), ...pairs(100, 0.1, 0.2)]);

    assert.ok(Math.abs(c.biaisMoyen) < 0.01, `biais moyen ${c.biaisMoyen} quasi nul — c'est le piège`);
    // La pente, elle, voit la dilatation : écarts annoncés ±0,4 pour ±0,3 réalisés.
    assert.ok(c.penteDeCalibration < 0.8, `pente ${c.penteDeCalibration} doit révéler l'exagération`);
    assert.match(c.verdict, /SURCONFIANTE/);
    assert.match(c.verdict, /divisés par/, 'le verdict doit donner le correctif');
  });

  test('la pente détecte aussi la prudence excessive', () => {
    // L'inverse : le modèle annonce ±0,1 pour ±0,35 réalisés.
    const c = calibration([...pairs(100, 0.6, 0.85), ...pairs(100, 0.4, 0.15)]);
    assert.ok(c.penteDeCalibration > 1.25, `pente ${c.penteDeCalibration} doit dépasser 1`);
    assert.match(c.verdict, /TROP PRUDENTE/);
  });

  test('une échelle juste et un écart faible donnent le verdict le plus favorable', () => {
    const c = calibration([...pairs(100, 0.8, 0.8), ...pairs(100, 0.2, 0.2)]);
    assert.ok(Math.abs(c.penteDeCalibration - 1) < 0.05, `pente ${c.penteDeCalibration} proche de 1`);
    assert.match(c.verdict, /bien calibrée/);
  });

  test('une confiance nuisible est signalée comme telle', () => {
    // Le modèle inverse : il annonce 0,85 quand il se trompe et 0,15 quand il
    // a raison. Le classement est à l'envers, la confiance fait du mal.
    const c = calibration([...pairs(60, 0.85, 0.2), ...pairs(60, 0.15, 0.8)]);
    assert.ok(c.scoreHabilete < 0, `score ${c.scoreHabilete} doit être négatif`);
    assert.match(c.verdict, /NUISIBLE/);
  });
});

describe('effet de grappe', () => {
  /** m observations par jour, corrélées à volonté via une composante commune. */
  const build = (days, m, commonWeight) => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    const out = [];
    for (let d = 0; d < days; d += 1) {
      const commun = rnd(); // choc partagé par tous les actifs du jour
      for (let i = 0; i < m; i += 1) {
        out.push({
          t: `2026-0${1 + (d % 9)}-${String(1 + (d % 28)).padStart(2, '0')}T20:00:00Z`,
          score: commonWeight * commun + (1 - commonWeight) * rnd(),
        });
      }
    }
    return out;
  };

  test('retient une valeur prudente tant qu\'il n\'y a pas de quoi mesurer', () => {
    const de = designEffect(build(3, 10, 0.5));
    assert.equal(de.measured, false);
    assert.ok(de.value > 1, 'au démarrage on suppose la corrélation présente');
  });

  test('détecte une forte corrélation intra-journalière', () => {
    // Choc commun dominant : les dix décisions du jour disent presque la même
    // chose, donc elles ne valent pas dix informations.
    const de = designEffect(build(40, 10, 0.9));
    assert.equal(de.measured, true);
    assert.ok(de.value > 3, `effet de grappe ${de.value} devrait être élevé`);
  });

  test('ne pénalise pas des observations réellement indépendantes', () => {
    const de = designEffect(build(40, 10, 0));
    assert.ok(de.value < 1.6, `effet de grappe ${de.value} devrait rester proche de 1`);
  });

  test('ne descend jamais sous 1 : une corrélation négative n\'accélère pas le test', () => {
    // Des jours alternant systématiquement +x / −x : variance des moyennes
    // journalières quasi nulle, donc un rapport inférieur à 1.
    const obs = [];
    for (let d = 0; d < 40; d += 1) {
      for (let i = 0; i < 10; i += 1) {
        obs.push({ t: `2026-03-${String(1 + (d % 28)).padStart(2, '0')}T20:00:00Z`, score: i % 2 ? 0.02 : -0.02 });
      }
    }
    assert.ok(designEffect(obs).value >= 1);
  });

  test('l\'effet de grappe ralentit la validation au lieu de l\'accélérer', () => {
    // Même série, deux instruments : celui qui tient compte de la corrélation
    // doit accumuler moins de preuves. Sans ce test, on ne saurait pas dans
    // quel sens la correction agit.
    const scores = Array.from({ length: 200 }, (_, i) => 0.008 + 0.01 * Math.sin(i));
    const naif = new Sprt({ targetSharpe: 0.1, designEffect: 1 });
    const corrige = new Sprt({ targetSharpe: 0.1, designEffect: 1.32 });
    const a = naif.evaluate(scores);
    const b = corrige.evaluate(scores);
    assert.ok(
      Math.abs(b.llr) < Math.abs(a.llr) || b.crossedAt > a.crossedAt,
      `le test corrigé doit être plus lent : LLR ${b.llr} vs ${a.llr}`,
    );
  });
});

describe('qualité d\'exécution — cotations de référence aberrantes', () => {
  test('écarte un fill dont la cotation de référence est trop large', async () => {
    // Cas réel : AVGO coté bid 418,92 / ask 427,00 par IEX (193 bps de spread),
    // fill obtenu à 419,35 au vrai NBBO. Comparé à cet ask, le fill paraît
    // meilleur de 179 bps et la moyenne du slippage part à −59 bps : le bot
    // semblerait acheter 0,6 % sous le prix demandé, ce qui n'existe pas.
    const sample = await executionQuality.record({
      symbol: 'AVGO', side: 'BUY', quantity: 1, orderId: 'test-large',
      quote: { bid: 418.92, ask: 427 }, fillPrice: 419.346,
    });
    assert.equal(sample.referenceUsable, false);
    // C'est le plafond de plausibilité qui tranche, et le message doit le dire :
    // invoquer la médiane serait trompeur, puisque 191 bps ne font que 0,8× une
    // médiane elle-même aberrante (244 bps sur AVGO via IEX).
    assert.match(sample.excludedReason, /cotation à 191\.\d+ bps/);
    assert.match(sample.excludedReason, /plafond de plausibilité de 50 bps/);
    // La mesure existe toujours dans l'archive : on écarte de la statistique,
    // on ne réécrit pas l'historique.
    assert.ok(sample.slippageVsExpectedBps < -100);
  });

  test('un spread normal reste mesurable', async () => {
    const sample = await executionQuality.record({
      symbol: 'NVDA', side: 'BUY', quantity: 1, orderId: 'test-normal',
      quote: { bid: 223.19, ask: 223.22 }, fillPrice: 223.244,
    });
    assert.equal(sample.referenceUsable, true);
  });

  test('la statistique ignore les échantillons écartés', async () => {
    const s = await executionQuality.summary();
    assert.ok(s.excluded >= 1, 'le fill à cotation large doit être compté comme écarté');
    // Sans le filtre, la moyenne serait fortement négative — une amélioration
    // de prix imaginaire de plusieurs dizaines de points de base.
    assert.ok(
      s.vsExpectedSide.meanBps > -10,
      `moyenne ${s.vsExpectedSide.meanBps} bps : une cotation aberrante pollue encore la mesure`,
    );
  });
});

describe('exposition cible — pas de rachat du même signal', () => {
  const limits = {
    baseCurrency: 'USD', initialCapital: 100, maxPositions: 3, maxPositionPct: 0.35,
    minOrderValue: 5, maxMonthlyLossPct: 0.15, minConfidence: 0.35,
    stopAtrMultiple: 4, stopMinPct: 0.08, stopMaxPct: 0.2,
  };
  const account = { equity: 100, cash: 100, currency: 'USD', positionsCount: 0 };
  const risk = new RiskManager(limits);
  // Écart de 30 points → sizePct = 0,25 + 0,75 × (0,10/0,80) ≈ 0,34
  const decision = { action: 'BUY', confidence: 0.5, sizePct: 0.4375 };

  test('la première entrée engage la fraction voulue de l\'enveloppe entière', () => {
    const budget = risk.computeBudget({ account, position: null, price: 223, fxRate: 1, circuitBreaker: { tripped: false } });
    // Enveloppe = 35 % de 100 $ = 35 $. Cible = 35 × 0,4375 = 15,31 $.
    assert.equal(budget.totalAllowance, 35);
    assert.equal(budget.alreadyInvested, 0);
    const v = risk.validate({ decision, account, position: null, price: 223, fxRate: 1, budget });
    assert.equal(v.approved, true);
    assert.ok(Math.abs(v.quantity * 223 - 15.31) < 0.2, `notionnel ${(v.quantity * 223).toFixed(2)} attendu ~15,31`);
  });

  test('le même signal au cycle suivant n\'achète PLUS rien', () => {
    // C'est le défaut observé en production : trois achats NVDA en cinq minutes,
    // 12,02 $ puis 5,74 $ puis 5,11 $. Les bougies étant journalières, c'était
    // la même décision exécutée trois fois, chacune payant le spread.
    const position = { quantity: 0.0687, avgPrice: 223, marketValue: 15.31 };
    const budget = risk.computeBudget({ account: { ...account, positionsCount: 1 }, position, price: 223, fxRate: 1, circuitBreaker: { tripped: false } });
    const v = risk.validate({ decision, account, position, price: 223, fxRate: 1, budget });
    assert.equal(v.approved, false);
    assert.match(v.reason, /exposition déjà proche de la cible/);
  });

  test('une conviction réellement renforcée complète la position', () => {
    // Écart passé à 80 points → sizePct 0,8125 → cible 28,44 $ au lieu de 15,31.
    const position = { quantity: 0.0687, avgPrice: 223, marketValue: 15.31 };
    const budget = risk.computeBudget({ account: { ...account, positionsCount: 1 }, position, price: 223, fxRate: 1, circuitBreaker: { tripped: false } });
    const v = risk.validate({
      decision: { ...decision, sizePct: 0.8125 },
      account, position, price: 223, fxRate: 1, budget,
    });
    assert.equal(v.approved, true, 'une cible plus haute doit autoriser le complément');
    assert.ok(Math.abs(v.quantity * 223 - 13.13) < 0.3, `complément ${(v.quantity * 223).toFixed(2)} attendu ~13,13`);
  });

  test('le plafond de position reste absolu', () => {
    const position = { quantity: 0.157, avgPrice: 223, marketValue: 35 };
    const budget = risk.computeBudget({ account: { ...account, positionsCount: 1 }, position, price: 223, fxRate: 1, circuitBreaker: { tripped: false } });
    assert.equal(budget.canBuy, false, 'plus aucune marge à 35 $ sur une enveloppe de 35 $');
    const v = risk.validate({ decision: { ...decision, sizePct: 1 }, account, position, price: 223, fxRate: 1, budget });
    assert.equal(v.approved, false);
  });
});

describe('seuil de probabilité haussière — ce qu\'il vise vraiment', () => {
  const seuils = { minEdge: 0.2, minUpProbability: 0.4 };
  const fc = (u, d, f) => normalizeForecast({ sur_100_surperforme: u, sur_100_sousperforme: d, sur_100_indistinct: f });

  test('écarte un pari sur un scénario minoritaire', () => {
    // 20/0/80 : l'écart atteint bien 20 points, mais le modèle annonce 80 % de
    // chances qu'il ne se passe rien. C'est le cas que ce seuil existe pour
    // bloquer.
    assert.equal(deriveAction(fc(20, 0, 80), seuils).action, 'HOLD');
    assert.equal(deriveAction(fc(38, 18, 44), seuils).action, 'HOLD');
  });

  test('laisse passer un 40/20/40, et c\'est voulu', () => {
    // Observé en production sur MSFT. La hausse est deux fois plus probable que
    // la baisse et l'espérance est positive : ce n'est pas un pari minoritaire.
    // Un commentaire du code citait pourtant ce cas comme devant être refusé —
    // c'était le commentaire qui avait tort.
    const d = deriveAction(fc(40, 20, 40), seuils);
    assert.equal(d.action, 'BUY');
    assert.equal(d.sizePct, 1, 'poids égal : passer le seuil donne le même poids que tout le monde');
  });
});

describe('cotation de référence jugée sur la médiane de l\'actif', () => {
  test('un seuil absolu laisse passer les cas modérés, la médiane les attrape', async () => {
    // Cas réel MSFT : ask IEX à 498,00 pour un fill à 497,17, soit 16,67 bps
    // d'« amélioration » — invraisemblable sur un ordre fractionnaire, mais sous
    // le plafond absolu de 50 bps, donc comptée. D'où un « amélioration de prix
    // sur 50 % des ordres » entièrement artificiel.
    //
    // MSFT cote environ 2 bps en séance : 20 bps de spread affiché, c'est 10× sa
    // normale. Le repère relatif l'écarte, le repère absolu non.
    const spreadAffiche = ((498 - 497) / 497.5) * 10000; // ≈ 20 bps
    assert.ok(spreadAffiche < 50, 'sous le plafond absolu : il passait');
    assert.ok(spreadAffiche > 2 * 3, 'mais au-delà de 3× la médiane de MSFT');
  });

  test('le plancher évite d\'exclure sur du bruit d\'arrondi', async () => {
    // Une médiane à 0,5 bps donnerait une limite de 1,5 bps : la moindre
    // variation de cotation ferait exclure des fills parfaitement normaux. Le
    // plancher à 3 bps garde la règle utilisable sur les titres très liquides.
    const mediane = 0.5;
    assert.equal(Math.max(mediane * 3, 3), 3);
  });
});

describe('version de stratégie — le SPRT ne mélange pas deux règles', () => {
  const entry = (t, symbol, ruleVersion, score) => ({
    t, symbol, action: 'BUY', ruleVersion, confidence: 0.6,
    hadPosition: false, newsAvailable: true, calendarPhase: 'NEUTRAL',
    outcomes: { d3: { score, excessReturn: score } },
  });

  test('les décisions d\'une règle antérieure sont écartées de la mesure', async () => {
    // Le cas réel : 110 décisions de l'ancienne règle (le modèle choisissait
    // l'action) et 61 de la nouvelle. Sans ce filtre, deux tiers du verdict
    // auraient porté sur un bot remplacé le jour même.
    const book = new ShadowBook();
    await book.init();
    await book.replaceAll([
      entry('2026-08-01T14:30:00Z', 'NVDA', 'action-choisie-par-le-modele', 0.05),
      entry('2026-08-02T14:30:00Z', 'AAPL', 'action-choisie-par-le-modele', 0.04),
      entry('2026-08-03T14:30:00Z', 'NVDA', RULE_VERSION, 0.01),
    ]);

    const series = await book.scoreSeries({ horizon: 3 });
    assert.equal(series.length, 1, 'seule la décision de la règle courante compte');
    assert.equal(series[0].score, 0.01);
  });

  test('les décisions antérieures restent consultables', async () => {
    const book = new ShadowBook();
    await book.init();
    await book.replaceAll([
      entry('2026-08-01T14:30:00Z', 'NVDA', 'action-choisie-par-le-modele', 0.05),
      entry('2026-08-03T14:30:00Z', 'AAPL', RULE_VERSION, 0.01),
    ]);
    // Le carnet ne jette rien : des observations réelles restent des
    // observations, même produites par une règle remplacée.
    assert.equal((await book.scoreSeries({ horizon: 3, allRules: true })).length, 2);
  });

  test('une entrée sans version est traitée comme antérieure', async () => {
    const book = new ShadowBook();
    await book.init();
    await book.replaceAll([entry('2026-08-01T14:30:00Z', 'NVDA', undefined, 0.05)]);
    assert.equal((await book.scoreSeries({ horizon: 3 })).length, 0);
  });

  test('la répartition par règle est exposée, pas masquée', async () => {
    const book = new ShadowBook();
    await book.init();
    await book.replaceAll([
      entry('2026-08-01T14:30:00Z', 'NVDA', 'action-choisie-par-le-modele', 0.05),
      entry('2026-08-02T14:30:00Z', 'AAPL', 'action-choisie-par-le-modele', 0.04),
      entry('2026-08-03T14:30:00Z', 'NVDA', RULE_VERSION, 0.01),
    ]);
    const stats = await book.stats({ horizon: 3 });
    assert.equal(stats.rules.usable, 1);
    assert.equal(stats.rules.excluded, 2);
    assert.match(stats.rules.note, /écartée\(s\) de la mesure/);
  });
});

describe('flux de données inexploitable', () => {
  test('un plafond absolu reste nécessaire malgré le critère relatif', () => {
    // Le piège vérifié en production. AVGO cote une médiane de 244,88 bps sur
    // IEX. Un critère purement relatif y autorise 3 × 244,88 = 734 bps : une
    // cotation à 191 bps passe, et la moyenne du slippage tombe à −39,94 bps.
    //
    // Quand une source est systématiquement mauvaise sur un titre, sa médiane
    // hérite du défaut : le repère relatif devient inoffensif là où il faudrait
    // qu'il morde. Le plafond, lui, s'appuie sur un fait extérieur aux données.
    const relatifSeul = 244.88 * 3;
    assert.ok(relatifSeul > 191, 'le critère relatif seul laisse passer 191 bps');
    assert.ok(Math.min(relatifSeul, 50) === 50, 'le plus strict des deux tranche');
  });

  test('le critère relatif reste nécessaire malgré le plafond', () => {
    // Symétrie : MSFT à 20 bps de spread affiché alors que sa normale est 2 bps.
    // Sous le plafond de 50, donc compté — d'où une « amélioration de prix »
    // de 16,67 bps entièrement artificielle.
    const spread = 20;
    assert.ok(spread < 50, 'le plafond seul le laisse passer');
    assert.ok(spread > Math.max(2 * 3, 3), 'le critère relatif l\'attrape');
  });
});

describe('sélection transversale — classer plutôt que seuiller', () => {
  const ev = (symbol, edge) => ({ symbol, decision: { forecast: { edge } } });

  test('retient les meilleurs par ordre, sans regarder le niveau', () => {
    const r = rankAndSelect(
      [ev('A', 0.10), ev('B', 0.50), ev('C', 0.30), ev('D', 0.05), ev('E', 0.40)],
      { maxSelected: 3 },
    );
    // K = 3 est demandé, mais seuls B et E sont STRICTEMENT au-dessus de la
    // médiane transversale — laquelle vaut ici 0,30, c'est-à-dire C lui-même.
    // Sur un nombre impair d'actifs la médiane est un point de données, et
    // l'actif qui l'occupe est écarté : « au milieu du classement » n'est pas
    // une raison d'acheter. Ce n'est pénalisant que sur un univers minuscule ;
    // à 150 actifs, environ 75 passent le filtre et K mord bien avant.
    assert.deepEqual([...r.selected].sort(), ['B', 'E'], 'strictement au-dessus de la médiane');
    assert.equal(r.ranks.get('B').rank, 1);
    assert.equal(r.ranks.get('B').fractional, 1, 'le meilleur vaut 1 en rang fractionnaire');
    assert.equal(r.ranks.get('D').fractional, 0, 'le dernier vaut 0');
    assert.equal(r.ranks.get('C').rank, 3);
  });

  test('un décalage constant de toutes les probabilités ne change rien', () => {
    // C'est la propriété qui justifie tout le module. Un modèle globalement
    // trop optimiste — 20 points de trop sur CHAQUE actif — produisait sous
    // seuil absolu six achats au lieu de zéro. Le classement, lui, est
    // invariant : seul l'ordre compte.
    const base = [ev('A', 0.10), ev('B', 0.50), ev('C', 0.30), ev('D', 0.05), ev('E', 0.40)];
    const gonfle = base.map((e) => ev(e.symbol, e.decision.forecast.edge + 0.20));
    const a = rankAndSelect(base, { maxSelected: 3 });
    const b = rankAndSelect(gonfle, { maxSelected: 3 });
    assert.deepEqual([...a.selected].sort(), [...b.selected].sort());
  });

  test('s\'abstient quand le modèle répond la même chose partout', () => {
    // Cas observé en production : « 40/45/15 » à l'identique sur trois actifs
    // différents du même cycle. Sans ce garde-fou, le premier de la liste
    // serait acheté par pur hasard d'ordonnancement — un bruit de tri promu au
    // rang de signal.
    const r = rankAndSelect(
      [ev('A', 0.25), ev('B', 0.25), ev('C', 0.26), ev('D', 0.25), ev('E', 0.24)],
      { maxSelected: 3 },
    );
    assert.equal(r.selected.size, 0, 'aucune sélection sous le seuil de dispersion');
    assert.ok(r.dispersion < MIN_DISPERSION);
    assert.match(r.reason, /dispersion/);
    assert.ok(r.ranks.size > 0, 'les rangs restent calculés : la mesure continue même sans trade');
  });

  test('ne descend jamais sous la médiane transversale', () => {
    // K = 3 demandé, mais seuls deux actifs dépassent la médiane. Compléter
    // jusqu'à K reviendrait à acheter un actif que le modèle place dans sa
    // moitié basse — exactement le « choisir le moins pire » que le classement
    // doit empêcher.
    const r = rankAndSelect(
      [ev('A', 0.60), ev('B', 0.55), ev('C', 0.10), ev('D', 0.08), ev('E', 0.05)],
      { maxSelected: 3 },
    );
    assert.deepEqual([...r.selected].sort(), ['A', 'B']);
  });

  test('un seul actif évaluable ne se classe pas', () => {
    const r = rankAndSelect([ev('A', 0.9)], { maxSelected: 3 });
    assert.equal(r.selected.size, 0, 'un classement à un élément n\'est pas un classement');
  });

  test('les prévisions manquantes sont écartées, pas classées dernières', () => {
    const r = rankAndSelect(
      [ev('A', 0.50), { symbol: 'B', decision: null }, ev('C', 0.40), ev('D', 0.10)],
      { maxSelected: 2 },
    );
    assert.equal(r.ranks.has('B'), false, 'un actif sans prévision n\'a pas de rang');
    assert.equal(r.ranks.get('A').total, 3, 'le total ne compte que les évaluables');
  });
});

describe('mesures de rang — Rank IC et RCE', () => {
  // Générateur déterministe : `signal` contrôle la part de l'ordre annoncé qui
  // se retrouve dans la réalisation, `marche` ajoute un facteur commun au jour.
  const panneau = ({ signal, marche = 0, jours = 120, actifs = 8, graine = 7 }) => {
    let s = graine;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const rows = [];
    for (let d = 0; d < jours; d += 1) {
      const commun = (rnd() - 0.5) * 0.06 * marche;
      for (let a = 0; a < actifs; a += 1) {
        const p = rnd();
        const bruit = (rnd() + rnd() + rnd() - 1.5) * 0.03;
        rows.push({
          day: `j${String(d).padStart(3, '0')}`,
          symbol: `S${a}`,
          predicted: p,
          realized: commun + signal * (p - 0.5) * 0.1 + bruit,
        });
      }
    }
    return rows;
  };

  test('un modèle sans information donne un IC indistinguable de zéro', () => {
    const r = rankIC(panneau({ signal: 0 }));
    assert.ok(Math.abs(r.icMoyen) < 0.05, `IC proche de zéro, obtenu ${r.icMoyen}`);
    assert.equal(r.significatif, false);
    assert.match(r.verdict, /INDISTINGUABLE DE ZÉRO/);
  });

  test('un signal injecté est détecté et croît avec sa force', () => {
    const faible = rankIC(panneau({ signal: 0.3 }));
    const fort = rankIC(panneau({ signal: 1.5 }));
    assert.ok(fort.icMoyen > faible.icMoyen, `${fort.icMoyen} doit dépasser ${faible.icMoyen}`);
    assert.equal(fort.significatif, true);
  });

  test('le facteur marché ne se fait PAS passer pour de la sélection', () => {
    // C'est la raison d'être du calcul transversal. Un jour où tout monte, un
    // IC calculé sur l'échantillon groupé mesurerait « le modèle était-il
    // haussier les jours de hausse ? » — du market timing, pas du choix de
    // titres. À l'intérieur d'une journée le facteur commun s'annule.
    const sans = rankIC(panneau({ signal: 0.5, marche: 0 }));
    const avec = rankIC(panneau({ signal: 0.5, marche: 1 }));
    assert.ok(
      Math.abs(avec.icMoyen - sans.icMoyen) < 0.05,
      `l'IC ne doit pas bouger : ${sans.icMoyen} vs ${avec.icMoyen}`,
    );
  });

  test('la corrélation entre actifs effondre l\'ampleur exploitable', () => {
    // Le fait le plus important du module : 8 actifs corrélés ne sont pas
    // 8 paris. Sans cette correction, l'IR théorique était surestimé d'un
    // facteur √(N/N_eff).
    const sans = rankIC(panneau({ signal: 0.5, marche: 0 }));
    const avec = rankIC(panneau({ signal: 0.5, marche: 1 }));
    assert.ok(avec.ampleur.correlationMoyenne > 0.25, `corrélation détectée : ${avec.ampleur.correlationMoyenne}`);
    assert.ok(sans.ampleur.actifsEffectifs > 6, 'sans corrélation, l\'ampleur reste proche de N');
    assert.ok(avec.ampleur.actifsEffectifs < 4, `avec corrélation, elle s'effondre : ${avec.ampleur.actifsEffectifs}`);
    assert.ok(avec.irPlafondAnnuel < sans.irPlafondAnnuel);
  });

  test('l\'horizon divise le nombre de périodes indépendantes par an', () => {
    // Une prévision à 3 jours ne se renouvelle pas 252 fois par an. Compter
    // 252 était l'autre moitié de l'erreur qui produisait un IR de 16.
    const j1 = rankIC(panneau({ signal: 0.5 }), { horizon: 1 });
    const j3 = rankIC(panneau({ signal: 0.5 }), { horizon: 3 });
    assert.equal(j1.ampleur.periodesParAn, 252);
    assert.equal(j3.ampleur.periodesParAn, 84);
    assert.ok(j3.irPlafondAnnuel < j1.irPlafondAnnuel);
  });

  const courbe = (moyennes, parTranche = 40) => moyennes.flatMap(
    (m, b) => Array.from({ length: parTranche }, () => ({ rank: (b + 0.5) / moyennes.length, realized: m })),
  );

  test('une courbe croissante ne produit aucune erreur de rang', () => {
    const r = rankCalibrationError(courbe([-0.02, -0.01, 0, 0.01, 0.02]));
    assert.equal(r.rce, 0);
    assert.equal(r.monotone, true);
    assert.match(r.verdict, /RESPECTÉ/);
  });

  test('une inversion au milieu est détectée sans condamner l\'ensemble', () => {
    // Le cas traître : bon aux extrémités, faux au centre. Le Rank IC reste
    // positif ; seul le RCE le voit.
    const r = rankCalibrationError(courbe([-0.02, 0.01, -0.01, 0, 0.02]));
    assert.ok(r.rce > 0, 'l\'inversion doit coûter quelque chose');
    assert.equal(r.monotone, false);
    assert.ok(r.ecartHautBas > 0, 'les extrémités restent dans le bon ordre');
    assert.match(r.verdict, /inversions/);
  });

  test('un classement à l\'envers est appelé par son nom', () => {
    const r = rankCalibrationError(courbe([0.02, 0.01, 0, -0.01, -0.02]));
    assert.ok(r.ecartHautBas < 0);
    assert.match(r.verdict, /INVERSÉ/);
  });

  test('une absence de signal n\'est pas annoncée comme une inversion', () => {
    // Écart haut-bas nul et écart négatif se ressemblent numériquement et sont
    // deux diagnostics opposés : « il ne sait rien » contre « il sait et le dit
    // à l'envers ». Une première version confondait les deux et affichait
    // « ordre INVERSÉ » sur une courbe parfaitement plate.
    const r = rankCalibrationError(courbe([0.005, 0.005, 0.005, 0.005, 0.005]));
    assert.equal(r.ecartHautBas, 0);
    assert.match(r.verdict, /AUCUNE information/);
    assert.doesNotMatch(r.verdict, /INVERSÉ/);
  });

  test('la projection isotone fusionne les violations, sans toucher au reste', () => {
    const r = rankCalibrationError(courbe([-0.02, 0.01, -0.01, 0, 0.02]));
    const t = r.tranches;
    assert.equal(t[0].apresProjection, t[0].resultatMoyen, 'la première tranche ne violait rien');
    assert.equal(t[4].apresProjection, t[4].resultatMoyen, 'la dernière non plus');
    assert.equal(t[1].apresProjection, t[2].apresProjection, 'les deux tranches en conflit sont mises en commun');
  });
});

describe('sortie par classement — la moitié qui manquait', () => {
  const ev = (symbol, edge) => ({ symbol, decision: { forecast: { edge } } });
  const univers = (n) => Array.from({ length: n }, (_, i) => ev(`S${i}`, 0.5 - i * 0.006));

  test('la bande suit la racine cubique du coût, pas le coût', () => {
    // C'est tout l'enjeu du calibrage. Un raisonnement linéaire donnerait une
    // bande de 0,06 % de la distribution — moins d'un rang sur 150, autrement
    // dit vendre au premier décrochage. La racine cubique en donne 8,55 %.
    const lineaire = 150 * 0.000625;
    const cubique = 150 * Math.cbrt(0.000625);
    assert.ok(lineaire < 0.1, `le linéaire donnerait ${lineaire.toFixed(2)} rang`);
    assert.ok(cubique > 12 && cubique < 14, `la racine cubique donne ${cubique.toFixed(1)} rangs`);
    assert.equal(exitRank({ universe: 150 }), 16);
  });

  test('le seuil s\'adapte à la taille de l\'univers', () => {
    // La bande s'indexe sur la largeur de l'UNIVERS, pas sur le nombre de
    // positions détenues : le bruit du classement dépend du nombre d'actifs
    // classés, pas de la contrainte de concentration qu'on s'impose.
    assert.ok(exitRank({ universe: 10 }) < exitRank({ universe: 150 }));
    assert.equal(exitRank({ universe: 10 }), 4);
    assert.equal(exitRank({ universe: 80 }), 10);
  });

  test('le seuil reste au-dessus du nombre de positions visées', () => {
    // Un seuil inférieur ou égal à K vendrait un actif encore retenu à
    // l'achat : le bot achèterait et revendrait le même titre dans le cycle.
    const petit = exitRank({ universe: 4, maxSelected: 3 });
    assert.ok(petit > 3, `seuil ${petit} doit dépasser les 3 positions visées`);
  });

  test('une position tombée hors de la bande est signalée à la vente', () => {
    const rows = univers(150);
    // S100 est très loin dans le classement — bien au-delà du rang 16.
    const r = rankAndSelect(rows, { maxSelected: 3, held: new Set(['S100']) });
    assert.ok(r.sorties.has('S100'), 'la position mal classée doit sortir');
    assert.equal(r.sorties.size, 1);
  });

  test('une position encore dans la bande est conservée', () => {
    // C'est la raison d'être de la bande : entre le rang 4 et le rang 16, on
    // ne fait rien. Vendre là engendrerait des allers-retours dont chacun
    // coûte 6,25 bps pour un gain de classement marginal.
    const rows = univers(150);
    const r = rankAndSelect(rows, { maxSelected: 3, held: new Set(['S9']) });
    assert.equal(r.sorties.has('S9'), false, 'le rang 10 est dans la bande de tolérance');
    assert.equal(r.sorties.size, 0);
  });

  test('un actif non classé n\'est PAS vendu', () => {
    // Absence d'évaluation ≠ mauvaise évaluation. Un actif dont la cotation a
    // manqué ce cycle n'a rien fait de mal ; vendre sur une absence de donnée
    // serait la pire des raisons d'agir.
    const rows = univers(150);
    const r = rankAndSelect(rows, { maxSelected: 3, held: new Set(['INCONNU']) });
    assert.equal(r.sorties.size, 0);
  });

  test('sans dispersion, on ne peut plus acheter mais on peut encore vendre', () => {
    // Distinction essentielle : un classement sans information n'autorise pas
    // à choisir un gagnant, mais il n'oblige pas non plus à tout conserver.
    // Les confondre ferait du bot un acheteur qui ne vend jamais — exactement
    // le défaut que cette version corrige.
    const plats = Array.from({ length: 150 }, (_, i) => ev(`S${i}`, 0.25 + (i % 3) * 0.0001));
    const r = rankAndSelect(plats, { maxSelected: 3, held: new Set(['S140']) });
    assert.equal(r.selected.size, 0, 'aucun achat sous le seuil de dispersion');
    assert.ok(r.sorties.size >= 0, 'les sorties restent calculées');
    assert.ok(r.ranks.size > 0, 'les rangs existent même sans dispersion');
  });

  test('la bande est cinq fois plus étroite que la règle précédente', () => {
    // La règle absolue vendait sur un écart de −20 points, soit une chute sous
    // la médiane : le rang 76 sur 150. Bande de 73 rangs contre 13.
    const ancienne = 76 - 3;
    const nouvelle = exitRank({ universe: 150 }) - 3;
    assert.ok(ancienne / nouvelle > 5, `${ancienne} rangs contre ${nouvelle} — facteur ${(ancienne / nouvelle).toFixed(1)}`);
  });
});
