import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITE,
  ajouter,
  bilan,
  charger,
  entreeIdentifiee,
  entreeRefusee,
  marquerEnregistree,
} from '../src/lib/journal.js';

const fiche = {
  identifiant: 89631139,
  code: 'LOB-FR001',
  nom: 'Dragon Blanc aux Yeux Bleus',
  methode: 'region',
  lectureBrute: null,
  saisieManuelle: false,
};

test('une identification garde ce qui permet de la retrouver', () => {
  const entree = entreeIdentifiee(fiche, { at: 1000 });
  assert.equal(entree.statut, 'identifiee');
  assert.equal(entree.cardId, 89631139);
  assert.equal(entree.code, 'LOB-FR001');
  assert.equal(entree.methode, 'region');
  assert.equal(entree.at, 1000);
  // Rien n'est enregistré tant que l'utilisateur n'a pas validé.
  assert.equal(entree.enregistree, false);
});

test('un refus conserve ce qui a été tapé — la seule trace exploitable', () => {
  const introuvable = entreeRefusee('ZZZZ-FR999', 'no_match', { at: 2000 });
  assert.equal(introuvable.statut, 'introuvable');
  assert.equal(introuvable.lecture, 'ZZZZ-FR999');
  assert.equal(introuvable.manuelle, true);

  const illisible = entreeRefusee('bonjour', 'no_code', { at: 2001 });
  assert.equal(illisible.statut, 'illisible');
});

test('le journal est borné : il ne peut pas saturer le stockage', () => {
  let entrees = [];
  for (let n = 0; n < LIMITE + 50; n += 1) {
    entrees = ajouter(entrees, entreeIdentifiee(fiche, { at: n }));
  }
  assert.equal(entrees.length, LIMITE);
  // La plus récente est en tête, les plus anciennes sont tombées.
  assert.equal(entrees[0].at, LIMITE + 49);
  assert.equal(entrees[LIMITE - 1].at, 50);
});

test('valider ne marque QUE la dernière rencontre de cette carte', () => {
  let entrees = [];
  entrees = ajouter(entrees, entreeIdentifiee(fiche, { at: 1 }));
  entrees = ajouter(entrees, entreeIdentifiee({ ...fiche, identifiant: 111 }, { at: 2 }));
  entrees = ajouter(entrees, entreeIdentifiee(fiche, { at: 3 }));

  const apres = marquerEnregistree(entrees, 89631139);
  // La plus récente des deux rencontres de cette carte, et elle seule.
  assert.equal(apres[0].enregistree, true);
  assert.equal(apres[2].enregistree, false);
  // L'autre carte n'est pas touchée.
  assert.equal(apres[1].enregistree, false);

  // Une seconde validation marque la rencontre suivante, pas deux fois la même.
  const encore = marquerEnregistree(apres, 89631139);
  assert.equal(encore[2].enregistree, true);
});

test('le bilan compte ce que l’écran affiche', () => {
  let entrees = [];
  entrees = ajouter(entrees, entreeIdentifiee(fiche, { at: 1 }));
  entrees = ajouter(entrees, entreeRefusee('XXXX', 'no_match', { at: 2 }));
  entrees = ajouter(entrees, entreeIdentifiee(fiche, { at: 3 }));
  entrees = marquerEnregistree(entrees, 89631139);

  assert.deepEqual(bilan(entrees), {
    total: 3,
    identifiees: 2,
    refusees: 1,
    enregistrees: 1,
  });
});

test('une donnée corrompue n’emporte pas l’écran', () => {
  globalThis.localStorage = {
    getItem: () =>
      JSON.stringify([null, 'texte', {}, { at: 'hier', statut: 'identifiee' }, { at: 5, statut: 'identifiee' }]),
    setItem: () => {},
  };
  const lues = charger();
  assert.equal(lues.length, 1);
  assert.equal(lues[0].at, 5);

  globalThis.localStorage = { getItem: () => 'pas du JSON', setItem: () => {} };
  assert.deepEqual(charger(), []);

  delete globalThis.localStorage;
});
