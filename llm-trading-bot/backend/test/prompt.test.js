import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = path.join(os.tmpdir(), `bot-prompt-${Date.now()}`);
process.env.DATA_DIR = TMP_DIR;
process.env.GEMINI_API_KEY = '';

const { buildRedactionTerms, redact, anonymizeNews, redactAll, requiresExactCase } = await import('../src/llm/anonymize.js');
const { entitiesFor, competitorEntities, TERMES_ECARTES } = await import('../src/llm/entities.js');
const { verifyEvidence, normalizeDecision } = await import('../src/llm/agent.js');

after(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

describe('anonymisation des entités', () => {
  test('extrait le ticker et les mots significatifs du nom', () => {
    const terms = buildRedactionTerms('NVDA', 'NVIDIA Corporation');
    assert.ok(terms.includes('NVDA'));
    assert.ok(terms.includes('NVIDIA'));
    assert.ok(terms.includes('NVIDIA Corporation'));
    assert.ok(!terms.includes('Corporation'), 'les suffixes juridiques sont écartés');
  });

  test('masque les termes les plus longs en premier', () => {
    const terms = buildRedactionTerms('TSLA', 'Tesla, Inc.');
    // Sans cet ordre, masquer « Tesla » laisserait un « , Inc. » orphelin.
    assert.equal(terms[0], 'Tesla, Inc.');
  });

  test('remplace toutes les occurrences, insensible à la casse', () => {
    const terms = buildRedactionTerms('NVDA', 'NVIDIA Corporation');
    const { text, redactions } = redact('nvidia beats estimates, NVDA up 5%', terms);
    assert.equal(redactions, 2);
    assert.ok(!/nvidia|nvda/i.test(text));
  });

  test('ne mutile pas un mot plus long contenant le terme', () => {
    const terms = buildRedactionTerms('CAT', 'Caterpillar Inc.');
    const { text } = redact('The category of construction equipment', terms);
    assert.match(text, /category/, '« category » ne doit pas être amputé');
  });

  test('n\'altère rien si aucun terme ne correspond', () => {
    const terms = buildRedactionTerms('NVDA', 'NVIDIA Corporation');
    const { text, redactions } = redact('Alphabet posts strong earnings', terms);
    assert.equal(redactions, 0);
    assert.equal(text, 'Alphabet posts strong earnings');
  });

  test('anonymise un paquet d\'actualités en conservant la source', () => {
    const news = {
      companyName: 'Tesla, Inc.',
      articles: [
        { title: 'Tesla deliveries beat estimates', summary: 'TSLA rose 4%', source: 'Reuters' },
        { title: 'Analyst raises Tesla target', summary: '', source: 'CNBC' },
      ],
    };
    const out = anonymizeNews(news, 'TSLA');
    assert.ok(out.redactions >= 3);
    assert.ok(!/tesla|tsla/i.test(JSON.stringify(out.articles.map((a) => [a.title, a.summary]))));
    assert.equal(out.articles[0].source, 'Reuters', 'la source informe sur la fiabilité, elle est conservée');
  });
});

describe('anonymisation stricte — protocole Glasserman & Lin', () => {
  test('masque les dirigeants de l\'entreprise cible', () => {
    const news = {
      companyName: 'Tesla, Inc.',
      articles: [{ title: 'Elon Musk announces new factory', summary: '', source: 'Reuters' }],
    };
    const out = anonymizeNews(news, 'TSLA');
    assert.match(out.articles[0].title, /\[DIRIGEANT_A\]/);
    assert.ok(!/musk/i.test(out.articles[0].title), 'un dirigeant identifie son entreprise aussi sûrement que son nom');
  });

  test('masque les produits emblématiques', () => {
    const news = {
      companyName: 'Apple Inc.',
      articles: [{ title: 'iPhone sales disappoint in China', summary: '', source: 'CNBC' }],
    };
    const out = anonymizeNews(news, 'AAPL');
    assert.match(out.articles[0].title, /\[PRODUIT_A\]/);
  });

  test('masque les filiales', () => {
    const news = {
      companyName: 'Microsoft Corporation',
      articles: [{ title: 'GitHub reports record usage', summary: '', source: 'The Verge' }],
    };
    const out = anonymizeNews(news, 'MSFT');
    assert.match(out.articles[0].title, /\[FILIALE_A\]/);
  });

  test('bloque la triangulation en masquant les sociétés tierces', () => {
    // Sans cette couche, « [ENTREPRISE_A] Lifts Dow, But Google, SpaceX Skid »
    // livre le contexte complet et l'anonymat n'est qu'une illusion.
    const news = {
      companyName: 'NVIDIA Corporation',
      articles: [{ title: 'Nvidia Lifts Dow, But Google, SpaceX Skid', summary: '', source: 'IBD' }],
    };
    const out = anonymizeNews(news, 'NVDA');
    assert.ok(!/google|spacex/i.test(out.articles[0].title));
    assert.match(out.articles[0].title, /\[AUTRE_SOCIETE\]/);
  });

  test('distingue les dirigeants tiers des sociétés tierces', () => {
    // « [AUTRE_SOCIETE] CEO [AUTRE_SOCIETE] » serait incompréhensible.
    const news = {
      companyName: 'NVIDIA Corporation',
      articles: [{ title: 'Alphabet CEO Sundar Pichai made a move', summary: '', source: 'Yahoo' }],
    };
    const out = anonymizeNews(news, 'NVDA');
    assert.match(out.articles[0].title, /\[AUTRE_SOCIETE\] CEO \[AUTRE_DIRIGEANT\]/);
  });

  test('traite les produits avant la raison sociale', () => {
    // Masquer « Apple » avant « Apple Watch » produirait « [ENTREPRISE_A] Watch »,
    // qui reste parfaitement identifiable.
    const known = entitiesFor('AAPL');
    const out = redactAll('Apple Watch sales up', {
      target: buildRedactionTerms('AAPL', 'Apple Inc.'),
      products: known.products,
      executives: known.executives,
      subsidiaries: known.subsidiaries,
    });
    assert.ok(!/\[ENTREPRISE_A\] Watch/.test(out.text));
    assert.match(out.text, /\[PRODUIT_A\]/);
  });

  test('la cible n\'est jamais listée dans ses propres concurrents', () => {
    const others = competitorEntities('TSLA');
    assert.ok(!others.companies.includes('Tesla'));
    assert.ok(!others.people.includes('Elon Musk'));
    assert.ok(others.companies.some((c) => /Rivian|Lucid/.test(c)));
  });
});

describe('ancrage des preuves (VERDI)', () => {
  const expected = { cited_price: 220.15, cited_rsi: 31.4, cited_atr_pct: 2.8, cited_budget: 35 };

  test('accepte une recopie exacte', () => {
    const v = verifyEvidence({ ...expected }, expected);
    assert.equal(v.grounded, true);
    assert.equal(v.severity, 'aucune');
  });

  test('tolère un arrondi raisonnable', () => {
    const v = verifyEvidence({ ...expected, cited_price: 220.2 }, expected);
    assert.equal(v.grounded, true);
  });

  test('détecte un prix inventé', () => {
    const v = verifyEvidence({ ...expected, cited_price: 195 }, expected);
    assert.equal(v.grounded, false);
    assert.equal(v.severity, 'mineure');
  });

  test('qualifie de grave deux divergences ou plus', () => {
    const v = verifyEvidence({ ...expected, cited_price: 195, cited_rsi: 70 }, expected);
    assert.equal(v.severity, 'grave');
    assert.equal(v.mismatches.length, 2);
  });

  test('signale un champ absent', () => {
    const v = verifyEvidence({ cited_price: 220.15 }, expected);
    assert.equal(v.grounded, false);
    assert.ok(v.mismatches.some((m) => /cited_rsi/.test(m)));
  });

  test('ignore les indicateurs non calculables', () => {
    const v = verifyEvidence({ cited_price: 220.15 }, { cited_price: 220.15, cited_rsi: null });
    assert.equal(v.grounded, true);
  });
});

describe('normalisation avec grille et preuves', () => {
  const expected = { cited_price: 220, cited_rsi: 31, cited_atr_pct: 2.8, cited_budget: 35 };
  const allTrue = {
    momentum_favorable: true, trend_favorable: true,
    news_confirms: true, volatility_acceptable: true,
  };
  const base = {
    evidence: { cited_price: 220, cited_rsi: 31, cited_atr_pct: 2.8, cited_budget: 35 },
    checks: allTrue,
    forecast: { sur_100_surperforme: 68, sur_100_sousperforme: 17, sur_100_indistinct: 15 },
    action: 'BUY',
    news_sentiment: 'POSITIF',
    justification: 'Achat : RSI bas ET actualités positives.',
  };

  test('une décision bien ancrée et unanime passe intacte', () => {
    const d = normalizeDecision(base, expected);
    assert.equal(d.action, 'BUY');
    assert.equal(d.confidence, 0.68, 'la probabilité annoncée sert de confiance');
    assert.equal(d.checksPassed, 4);
    assert.deepEqual(d.warnings, []);
  });

  test('un ancrage gravement défaillant annule l\'exécution', () => {
    const d = normalizeDecision(
      { ...base, evidence: { cited_price: 999, cited_rsi: 99, cited_atr_pct: 50, cited_budget: 1 } },
      expected,
    );
    assert.equal(d.action, 'HOLD');
    assert.equal(d.sizePct, 0);
    assert.equal(d.voided, true);
  });

  test('la probabilité annoncée n\'est JAMAIS retouchée par les garde-fous', () => {
    // Point crucial : cette probabilité est l'objet même de la mesure de
    // calibration. La raboter quand un contrôle échoue reviendrait à mesurer
    // nos corrections au lieu du modèle — et fabriquerait une calibration
    // artificiellement bonne, puisqu'on écraserait précisément les valeurs
    // suspectes.
    const grave = normalizeDecision(
      { ...base, evidence: { cited_price: 999, cited_rsi: 99, cited_atr_pct: 50, cited_budget: 1 } },
      expected,
    );
    assert.equal(grave.forecast.pUp, 0.68, 'prévision préservée malgré l\'annulation');
    assert.equal(grave.confidence, 0.68);

    const mineure = normalizeDecision({ ...base, evidence: { ...base.evidence, cited_price: 150 } }, expected);
    assert.equal(mineure.confidence, 0.68, 'un écart mineur ne modifie pas la probabilité');
    assert.ok(mineure.warnings.some((w) => /ancrage défaillant \(mineure\)/.test(w)));
  });

  test('un achat sans majorité de critères devient HOLD', () => {
    const d = normalizeDecision(
      { ...base, checks: { ...allTrue, trend_favorable: false, news_confirms: false } },
      expected,
    );
    assert.equal(d.action, 'HOLD');
    assert.ok(d.warnings.some((w) => /critères validés/.test(w)));
  });

  test('3 critères sur 4 suffisent pour un achat', () => {
    const d = normalizeDecision(
      { ...base, checks: { ...allTrue, news_confirms: false } },
      expected,
    );
    assert.equal(d.action, 'BUY');
  });

  test('le stop n\'est plus une sortie du modèle', () => {
    const d = normalizeDecision(base, expected);
    assert.equal(d.stopLossPct, undefined);
    assert.equal(d.takeProfitPct, undefined);
  });

  test('accepte les booléens renvoyés sous forme de chaînes', () => {
    // Gemini renvoie régulièrement "true"/"false" en chaînes malgré un
    // responseSchema déclarant BOOLEAN. Une comparaison stricte comptait alors
    // 0/4 critères et transformait chaque achat en HOLD.
    const d = normalizeDecision(
      {
        ...base,
        checks: {
          momentum_favorable: 'true', trend_favorable: 'true',
          news_confirms: 'true', volatility_acceptable: 'true',
        },
      },
      expected,
    );
    assert.equal(d.checksPassed, 4);
    assert.equal(d.action, 'BUY', 'un achat unanime ne doit pas être écrasé par un problème de type');
    assert.deepEqual(d.warnings, []);
  });

  test('interprète correctement les chaînes « false »', () => {
    const d = normalizeDecision(
      {
        ...base,
        checks: {
          momentum_favorable: 'false', trend_favorable: 'false',
          news_confirms: 'false', volatility_acceptable: 'true',
        },
      },
      expected,
    );
    assert.equal(d.checksPassed, 1);
    assert.equal(d.action, 'HOLD');
  });
});

describe('tickers ambigus — la censure ne doit pas manger la langue', () => {
  // Défaut réel, invisible sur l'univers de dix valeurs parce qu'aucun de leurs
  // tickers n'est un mot anglais. À 150 valeurs il devient massif : SO
  // (Southern), MO (Altria), PM (Philip Morris), NOW (ServiceNow), CAT
  // (Caterpillar), DE (Deere), ALL (Allstate) sont tous des mots courants.
  //
  // La conséquence n'était pas cosmétique : le modèle recevait des phrases dont
  // les mots de liaison avaient disparu, et c'est sa lecture entière qui était
  // dégradée — en croyant améliorer la mesure, on la corrompait.
  const censure = (ticker, texte) => redact(texte, buildRedactionTerms(ticker, null)).text;

  test('un ticker en minuscules dans une phrase n\'est pas censuré', () => {
    assert.equal(
      censure('NOW', 'The company said it will now expand'),
      'The company said it will now expand',
    );
    assert.equal(
      censure('SO', 'Analysts see upside, so the stock rose'),
      'Analysts see upside, so the stock rose',
    );
  });

  test('mais le ticker réellement cité l\'est toujours', () => {
    assert.match(censure('NOW', 'NOW shares jumped'), /\[ENTREPRISE_A\] shares jumped/);
    assert.match(censure('SO', 'SO raised its dividend'), /\[ENTREPRISE_A\] raised/);
  });

  test('les deux usages coexistent dans la même phrase', () => {
    assert.equal(
      censure('SO', 'Analysts see upside, so SO raised its dividend.'),
      'Analysts see upside, so [ENTREPRISE_A] raised its dividend.',
    );
  });

  test('une heure n\'est pas confondue avec Philip Morris', () => {
    // « PM » l'heure et « PM » le ticker s'écrivent identiquement, majuscules
    // comprises : la règle de casse ne peut pas les départager, seul le
    // contexte le peut. Un chiffre devant, c'est une heure.
    const r = censure('PM', 'Shares rose 3% at 4 PM ET, and PM lagged after 9:30 AM.');
    assert.match(r, /at 4 PM ET/, 'l\'heure est préservée');
    assert.match(r, /9:30 AM/, 'l\'autre heure aussi');
    assert.match(r, /and \[ENTREPRISE_A\] lagged/, 'le ticker cité est bien censuré');
  });

  test('les noms longs restent insensibles à la casse', () => {
    // La règle ne doit pas affaiblir le cas normal : « nvidia » en minuscules
    // dans une dépêche mal formatée doit rester censuré.
    const terms = buildRedactionTerms('NVDA', 'NVIDIA Corporation');
    const { text } = redact('nvidia and NVIDIA and Nvidia', terms);
    assert.equal(text, '[ENTREPRISE_A] and [ENTREPRISE_A] and [ENTREPRISE_A]');
  });

  test('la règle elle-même est explicite, pas seulement ses effets', () => {
    assert.equal(requiresExactCase('SO'), true, 'trop court');
    assert.equal(requiresExactCase('NOW'), true, 'trop court ET mot courant');
    assert.equal(requiresExactCase('Target'), true, 'long mais mot courant');
    assert.equal(requiresExactCase('Blackwell'), false, 'long et distinctif');
    assert.equal(requiresExactCase('NVIDIA'), false);
  });
});

describe('termes interdits de censure — vocabulaire de la presse financière', () => {
  // Trouvés par `npm run entities:audit` sur le dictionnaire des 150 valeurs.
  // Ce sont des patronymes de dirigeants et des noms de produits qui sont AUSSI
  // du vocabulaire courant. La règle de casse ne les attrape pas : ils sont
  // naturellement capitalisés dans ces phrases.
  const tousLesTermes = (symbol) => {
    const e = entitiesFor(symbol);
    return [...e.names, ...e.executives, ...e.products, ...e.subsidiaries];
  };

  test('« Wall Street » survit — c\'est le cas décisif', () => {
    // « Wall » vient du patronyme d'un dirigeant de Cadence. L'expression
    // « Wall Street » figure dans une dépêche financière sur trois : la
    // censurer dégraderait la lecture de tout le corpus, pour masquer un mot
    // qui ne désigne personne à lui seul.
    const phrase = 'Wall Street analysts raised their targets after the print.';
    assert.equal(redact(phrase, tousLesTermes('CDNS')).text, phrase);
  });

  test('« Core inflation » n\'est pas un produit Intel', () => {
    const phrase = 'Core inflation cooled in July, supporting a rate cut.';
    assert.equal(redact(phrase, tousLesTermes('INTC')).text, phrase);
  });

  test('« Capitol Hill » n\'est pas un dirigeant d\'Applied Materials', () => {
    const phrase = 'Capitol Hill lawmakers debated the chips subsidy.';
    assert.equal(redact(phrase, tousLesTermes('AMAT')).text, phrase);
  });

  test('les homographes techniques et d\'actualité sont épargnés', () => {
    const spyware = 'Pegasus spyware allegations weighed on the sector.';
    assert.equal(redact(spyware, tousLesTermes('NKE')).text, spyware);
    const crypto = 'LTC and other tokens rallied overnight.';
    assert.equal(redact(crypto, tousLesTermes('ADI')).text, crypto);
  });

  test('retirer le fragment ne désarme PAS la censure du nom complet', () => {
    // C'est ce qui rend l'arbitrage acceptable : on perd « Hill », on garde
    // « Elliott Hill ». L'identité reste masquée, la langue reste lisible.
    const { text } = redact('Elliott Hill leads the group.', tousLesTermes('NKE'));
    assert.match(text, /\[ENTREPRISE_A\] leads/);
    assert.doesNotMatch(text, /Elliott/);
  });

  test('les termes écartés sont déclarés, pas supprimés en douce', () => {
    // Une censure qui disparaît sans trace serait indétectable à la relecture.
    assert.ok(TERMES_ECARTES.length > 0);
    assert.ok(
      TERMES_ECARTES.some((t) => t.terme === 'Core' && t.symbol === 'INTC'),
      'le retrait de « Core » chez INTC doit être traçable',
    );
  });
});
