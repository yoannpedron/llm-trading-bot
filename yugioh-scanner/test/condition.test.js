import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONDITIONS,
  DEFAULT_CONDITION,
  adjustForCondition,
  cardmarketLink,
  conditionId,
  conditionPrice,
} from '../src/lib/condition.js';

test('l’échelle suit celle de Cardmarket, du meilleur au pire', () => {
  assert.deepEqual(
    CONDITIONS.map((entry) => entry.code),
    ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'],
  );
  // Les identifiants alimentent le filtre minCondition : ils doivent être
  // croissants et sans trou.
  assert.deepEqual(CONDITIONS.map((entry) => entry.id), [1, 2, 3, 4, 5, 6, 7]);
  // Le coefficient décroît strictement avec l'usure.
  const factors = CONDITIONS.map((entry) => entry.factor);
  assert.deepEqual(factors, [...factors].sort((a, b) => b - a));
});

test('Near Mint est la référence', () => {
  assert.equal(DEFAULT_CONDITION, 'NM');
  assert.equal(adjustForCondition(10, 'NM'), 10);
});

test('le coefficient s’applique et s’arrête à deux décimales', () => {
  assert.equal(adjustForCondition(10, 'LP'), 5.5);
  assert.equal(adjustForCondition(3.33, 'EX'), 2.83);
  assert.equal(adjustForCondition(null, 'EX'), null);
  assert.equal(adjustForCondition(Number.NaN, 'EX'), null);
});

test('un état inconnu laisse la cote intacte', () => {
  assert.equal(adjustForCondition(10, 'XX'), 10);
});

test('un « à partir de » déjà filtré par Cardmarket n’est pas réestimé', () => {
  const price = { conditionApplied: true, prices: { from: 4.2, trend: 9 } };
  assert.deepEqual(conditionPrice(price, 'LP'), {
    value: 4.2,
    estimated: false,
    basis: 'from',
  });
});

test('sans filtre appliqué, l’état donne une estimation signalée', () => {
  const price = { prices: { trend: 10 } };
  const result = conditionPrice(price, 'GD');
  assert.equal(result.value, 7);
  assert.equal(result.estimated, true);
});

test('en Near Mint, rien n’est estimé', () => {
  const result = conditionPrice({ prices: { trend: 10 } }, 'NM');
  assert.equal(result.value, 10);
  assert.equal(result.estimated, false);
});

test('sans cote, il n’y a rien à afficher', () => {
  assert.deepEqual(conditionPrice(null, 'NM'), { value: null, estimated: false, basis: null });
  assert.deepEqual(conditionPrice({ prices: {} }, 'NM'), {
    value: null,
    estimated: false,
    basis: null,
  });
});

test('le lien Cardmarket porte le filtre d’état', () => {
  assert.equal(conditionId('EX'), 3);
  assert.equal(
    cardmarketLink({ productUrl: 'https://cm.test/p' }, 'EX'),
    'https://cm.test/p?minCondition=3',
  );
  // Une URL de recherche porte déjà une requête : on enchaîne avec « & ».
  assert.equal(
    cardmarketLink({ searchUrl: 'https://cm.test/s?searchString=x' }, 'GD'),
    'https://cm.test/s?searchString=x&minCondition=4',
  );
  assert.equal(cardmarketLink(null, 'GD'), null);
});
