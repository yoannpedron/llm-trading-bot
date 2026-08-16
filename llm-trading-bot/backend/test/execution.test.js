import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATA_DIR = process.env.DATA_DIR || `${process.cwd()}/data`;
process.env.GEMINI_API_KEY = '';

const { rankAndSelect } = await import('../src/core/ranking.js');
const { fenetreExecution, spreadAcceptable, filtrerParSpread, heureNewYork } =
  await import('../src/core/execution.js');
const { normaliserVerdict, filtrerParVeto, buildVetoPrompt, MOTIFS, VETO_SCHEMA } =
  await import('../src/llm/veto.js');

const limites = { executionStartHourET: 11, executionEndHourET: 14, maxSpreadBps: 7 };

describe('neutralité sectorielle', () => {
  // Cinq actifs d'un même secteur en tête, puis d'autres secteurs. Sans
  // plafond, le portefeuille est un pari sur un seul secteur.
  const secteurs = {
    T1: 'Technologie', T2: 'Technologie', T3: 'Technologie', T4: 'Technologie', T5: 'Technologie',
    F1: 'Finance', F2: 'Finance', S1: 'Santé', E1: 'Énergie', I1: 'Industrie',
    X1: 'Services publics', X2: 'Immobilier', X3: 'Matériaux', X4: 'Communication',
  };
  const ordre = ['T1', 'T2', 'T3', 'T4', 'T5', 'F1', 'F2', 'S1', 'E1', 'I1', 'X1', 'X2', 'X3', 'X4'];
  const evals = ordre.map((symbol, i) => ({
    symbol, evaluated: true, decision: { forecast: { edge: 1 - i * 0.05 } },
  }));
  const secteurDe = (s) => secteurs[s];

  test('sans plafond, un seul secteur rafle le portefeuille', () => {
    const r = rankAndSelect(evals, { maxSelected: 5, secteurDe, maxParSecteur: 0 });
    const pris = [...r.selected];
    assert.equal(pris.filter((s) => secteurs[s] === 'Technologie').length, 5, 'les 5 places partent à la tech');
  });

  test('avec plafond, la concentration sectorielle est bornée', () => {
    const r = rankAndSelect(evals, { maxSelected: 5, secteurDe, maxParSecteur: 2 });
    const pris = [...r.selected];
    const parSecteur = {};
    for (const s of pris) parSecteur[secteurs[s]] = (parSecteur[secteurs[s]] ?? 0) + 1;
    assert.ok(Math.max(...Object.values(parSecteur)) <= 2, `concentration : ${JSON.stringify(parSecteur)}`);
  });

  test('le plafond ne réordonne rien : le meilleur reste pris en premier', () => {
    const r = rankAndSelect(evals, { maxSelected: 5, secteurDe, maxParSecteur: 2 });
    assert.ok(r.selected.has('T1'), 'le premier du classement doit toujours être retenu');
    assert.ok(r.selected.has('T2'), 'le deuxième de son secteur passe encore');
    assert.equal(r.selected.has('T3'), false, 'le troisième du même secteur est écarté');
  });

  test('le plafond ne réduit pas le nombre de positions sur un univers réaliste', () => {
    // Sur 14 actifs, ce n'est pas le plafond sectoriel qui limite mais le
    // filtre de médiane déjà en place — seuls les actifs au-dessus de la
    // médiane sont achetables, soit 7 candidats. À 150 actifs la médiane tombe
    // au rang 75 et ne contraint plus rien : c'est le cas réel qu'il faut
    // tester.
    const grands = Array.from({ length: 150 }, (_, i) => ({
      symbol: `A${i}`, evaluated: true, decision: { forecast: { edge: 1 - i * 0.005 } },
    }));
    // Neuf secteurs distribués en tourniquet : chacun a largement de quoi
    // fournir deux candidats bien classés.
    const neufSecteurs = ['Tech', 'Finance', 'Santé', 'Énergie', 'Industrie', 'Conso', 'Utilities', 'Immo', 'Télécom'];
    const secteurLarge = (s) => neufSecteurs[Number(s.slice(1)) % 9];

    const r = rankAndSelect(grands, { maxSelected: 10, secteurDe: secteurLarge, maxParSecteur: 2 });
    assert.equal(r.selected.size, 10, 'les places libérées doivent être reprises ailleurs');

    const parSecteur = {};
    for (const s of r.selected) parSecteur[secteurLarge(s)] = (parSecteur[secteurLarge(s)] ?? 0) + 1;
    assert.ok(Math.max(...Object.values(parSecteur)) <= 2);
  });

  test('le filtre de médiane borne le nombre d\'ouvertures sur un petit univers', () => {
    // Comportement préexistant, rendu explicite : on n'achète jamais un actif
    // sous la médiane transversale, quel que soit le nombre de places libres.
    // Sur un univers étroit, c'est lui qui limite, pas le plafond sectoriel.
    const r = rankAndSelect(evals, { maxSelected: 12, secteurDe, maxParSecteur: 0 });
    assert.ok(r.selected.size <= Math.ceil(evals.length / 2));
  });
});

describe('fenêtre d\'exécution', () => {
  // 2026-08-17 est un lundi. Les heures sont exprimées en UTC ; l'heure d'été
  // de New York place ET à UTC−4 en août.
  const lundi = (heureUTC) => new Date(Date.UTC(2026, 7, 17, heureUTC, 30));

  test('l\'ouverture est écartée', () => {
    const r = fenetreExecution(lundi(13), limites);   // 9 h 30 ET
    assert.equal(r.ouverte, false);
    assert.match(r.raison, /ouverture trop récente/);
  });

  test('le milieu de séance est retenu', () => {
    assert.equal(fenetreExecution(lundi(16), limites).ouverte, true);   // 12 h 30 ET
  });

  test('la clôture est écartée', () => {
    const r = fenetreExecution(lundi(19), limites);   // 15 h 30 ET
    assert.equal(r.ouverte, false);
    assert.match(r.raison, /clôture/);
  });

  test('le week-end est écarté', () => {
    const samedi = new Date(Date.UTC(2026, 7, 15, 16, 30));
    assert.equal(fenetreExecution(samedi, limites).ouverte, false);
  });

  test('l\'heure de New York suit bien le fuseau, pas une soustraction fixe', () => {
    // Août : heure d'été, UTC−4. Janvier : heure d'hiver, UTC−5. Un décalage
    // codé en dur se tromperait d'une heure la moitié de l'année.
    assert.equal(heureNewYork(new Date(Date.UTC(2026, 7, 17, 16, 0))).heure, 12);
    assert.equal(heureNewYork(new Date(Date.UTC(2026, 0, 19, 16, 0))).heure, 11);
  });
});

describe('filtre de spread', () => {
  test('accepte sous le plafond, refuse au-dessus', () => {
    assert.equal(spreadAcceptable(4, limites).acceptable, true);
    assert.equal(spreadAcceptable(12, limites).acceptable, false);
  });

  test('le spread n\'est compté QU\'UNE FOIS sur l\'aller-retour', () => {
    // On achète à l'ask et on revend au bid : l'écart total parcouru vaut un
    // spread plein, pas deux. Je l'avais doublé, en contradiction avec
    // `roundTripCost` qui documente explicitement la convention — le seuil de
    // décision restait juste, le chiffre affiché était deux fois trop grand.
    assert.equal(spreadAcceptable(12, limites).coutAllerRetourBps, 12);
  });

  test('une mesure aberrante n\'écarte PAS l\'actif', () => {
    // Le flux gratuit IEX donne META à 118 bps, AVGO à 88, TSLA à 63 — pour
    // des mégacapitalisations dont l'écart réel tient dans 1 à 5 bps. Un tel
    // relevé dit que la cotation est défaillante, pas que l'actif coûte cher.
    // Les traiter pareil retirerait les plus grosses valeurs de l'univers pour
    // une raison fausse.
    const r = spreadAcceptable(118, limites);
    assert.equal(r.acceptable, true);
    assert.equal(r.mesureDouteuse, true);
    assert.match(r.raison, /défaillant/);
  });

  test('un spread élevé mais plausible reste écarté', () => {
    const r = spreadAcceptable(25, limites);
    assert.equal(r.acceptable, false);
    assert.notEqual(r.mesureDouteuse, true);
  });

  test('un spread négatif est une cotation cassée, pas une aubaine', () => {
    // Relevé en séance sur IEX le 16 août 2026 : META, AAPL et NVDA à
    // −20 000 bps, c'est-à-dire une offre à zéro. La demande sous l'offre est
    // impossible sur un marché ordinaire.
    //
    // Avant correction, le filtre répondait « sous le plafond de 7 » : il
    // annonçait un spread excellent là où il n'avait aucune cotation, sur
    // trois des plus grosses valeurs de l'univers.
    for (const casse of [-20000, -1, 0]) {
      const r = spreadAcceptable(casse, limites);
      assert.equal(r.acceptable, true, `${casse} : ne pas exclure sur une mesure inexploitable`);
      assert.equal(r.mesureDouteuse, true, `${casse} : doit être signalé comme douteux`);
      assert.doesNotMatch(
        r.raison,
        /sous le plafond/,
        `${casse} : ne doit pas prétendre avoir mesuré un bon spread`,
      );
    }
  });

  test('un spread inconnu ne fait pas écarter l\'actif', () => {
    // Une donnée manquante n'est pas une information sur le coût.
    assert.equal(spreadAcceptable(null, limites).acceptable, true);
    assert.equal(spreadAcceptable(undefined, limites).acceptable, true);
    assert.equal(spreadAcceptable(Number.NaN, limites).acceptable, true);
  });

  test('filtre un lot de candidats', () => {
    // 'E' à 200 bps : mesure aberrante, donc laissée passer.
    const spreads = new Map([['A', 3], ['B', 15], ['C', 6.9], ['D', 7.1], ['E', 200]]);
    const { retenus, ecartes } = filtrerParSpread(['A', 'B', 'C', 'D', 'E'], spreads, limites);
    assert.deepEqual([...retenus].sort(), ['A', 'C', 'E']);
    assert.deepEqual([...ecartes.keys()].sort(), ['B', 'D']);
  });
});

describe('veto de risque', () => {
  const provider = (reponse) => ({
    decide: async () => ({ raw: JSON.stringify(reponse) }),
  });

  test('un blocage motivé et grave passe', async () => {
    const { autorises, refuses } = await filtrerParVeto(['NVDA'], {
      provider: provider({ constat: 'Enquête ouverte par le régulateur.', verdict: 'BLOQUER', motif: 'ENQUETE_REGLEMENTAIRE', gravite: 'SERIEUSE' }),
      newsPour: async () => ({ articles: [] }),
    });
    assert.equal(autorises.size, 0);
    assert.equal(refuses.get('NVDA').motif, 'ENQUETE_REGLEMENTAIRE');
  });

  test('un blocage SANS motif est ramené à PASSER', () => {
    // Un refus qu'on ne peut pas expliquer est un refus qu'on ne peut pas
    // évaluer. On ne l'accepte pas en silence.
    const r = normaliserVerdict({ verdict: 'BLOQUER', motif: 'AUCUN', gravite: 'SERIEUSE' });
    assert.equal(r.bloque, false);
    assert.equal(r.incoherent, true);
  });

  test('un blocage de gravité nulle ne bloque pas', () => {
    const r = normaliserVerdict({ verdict: 'BLOQUER', motif: 'LITIGE', gravite: 'NULLE' });
    assert.equal(r.bloque, false);
    assert.equal(r.ignore, 'gravité nulle');
  });

  test('une réponse inconnue est traitée comme PASSER', () => {
    // Le veto est un droit de refus, pas un droit de blocage par défaut.
    assert.equal(normaliserVerdict({}).bloque, false);
    assert.equal(normaliserVerdict({ verdict: 'PEUT-ÊTRE' }).bloque, false);
    assert.equal(normaliserVerdict(null).bloque, false);
  });

  test('un motif inventé est ramené à AUCUN', () => {
    const r = normaliserVerdict({ verdict: 'BLOQUER', motif: 'MAUVAISES_VIBES', gravite: 'SERIEUSE' });
    assert.equal(r.motif, 'AUCUN');
    assert.equal(r.bloque, false, 'donc incohérent, donc non bloquant');
  });

  test('une panne du modèle SUSPEND l\'achat', async () => {
    // Ne pas avoir pu vérifier n'est pas la même chose qu'avoir vérifié sans
    // rien trouver. À 21 séances de détention, reporter coûte presque rien.
    const { autorises, refuses } = await filtrerParVeto(['NVDA'], {
      provider: { decide: async () => { throw new Error('429 quota'); } },
      newsPour: async () => ({ articles: [] }),
    });
    assert.equal(autorises.size, 0);
    assert.match(refuses.get('NVDA').constat, /contrôle impossible/);
  });

  test('un candidat propre est autorisé', async () => {
    const { autorises } = await filtrerParVeto(['AAPL'], {
      provider: provider({ constat: 'Rien de notable.', verdict: 'PASSER', motif: 'AUCUN', gravite: 'NULLE' }),
      newsPour: async () => ({ articles: [] }),
    });
    assert.ok(autorises.has('AAPL'));
  });

  test('l\'absence d\'actualité est présentée comme un cas de PASSER', () => {
    const p = buildVetoPrompt({ etiquette: 'Norvane', secteur: 'Finance', articles: [], fenetreHeures: 24 });
    assert.match(p, /AUCUNE actualité/);
    assert.match(p, /n'est pas\s+une mauvaise nouvelle|pas une mauvaise nouvelle/);
  });

  test('le schéma impose le constat AVANT le verdict', () => {
    // Laisser le modèle formuler avant de trancher évite la taxe de projection
    // du décodage contraint.
    assert.deepEqual(Object.keys(VETO_SCHEMA.properties), ['constat', 'verdict', 'motif', 'gravite']);
    assert.ok(MOTIFS.includes('AUCUN'));
  });

  test('le prompt ne laisse jamais fuir le vrai nom de la société', () => {
    const p = buildVetoPrompt({ etiquette: 'Norvane Group', secteur: 'Technologie', articles: [], fenetreHeures: 24 });
    assert.equal(p.includes('NVDA'), false);
    assert.equal(p.includes('Nvidia'), false);
  });
});
