import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, SCHEMA, SENSITIVITY, mergeSettings, sensitivityOf } from '../src/lib/settings.js';

test('chaque réglage du schéma a une valeur par défaut', () => {
  for (const group of SCHEMA) {
    for (const item of group.items) {
      assert.notEqual(DEFAULTS[item.key], undefined, item.key);
    }
  }
});

test('aucune clé de réglage n’est déclarée deux fois', () => {
  const keys = SCHEMA.flatMap((group) => group.items.map((item) => item.key));
  assert.equal(new Set(keys).size, keys.length);
});

test('un choix par défaut fait toujours partie des options', () => {
  for (const group of SCHEMA) {
    for (const item of group.items.filter((entry) => entry.type === 'choice')) {
      assert.ok(
        item.options.some((option) => option.value === item.default),
        item.key,
      );
    }
  }
});

test('les réglages stockés complètent les valeurs par défaut', () => {
  const merged = mergeSettings({ animations: false });
  assert.equal(merged.animations, false);
  assert.equal(merged.holo, DEFAULTS.holo);
});

test('une valeur d’un mauvais type est ignorée', () => {
  assert.equal(mergeSettings({ animations: 'non' }).animations, DEFAULTS.animations);
  assert.equal(mergeSettings({ sensitivity: 'turbo' }).sensitivity, DEFAULTS.sensitivity);
  assert.equal(mergeSettings({ defaultCondition: 'ZZ' }).defaultCondition, DEFAULTS.defaultCondition);
});

test('une clé inconnue n’entre pas dans les réglages', () => {
  assert.equal('inconnue' in mergeSettings({ inconnue: true }), false);
});

test('un stockage vide ou corrompu redonne les valeurs par défaut', () => {
  assert.deepEqual(mergeSettings(null), DEFAULTS);
  assert.deepEqual(mergeSettings('cassé'), DEFAULTS);
});

test('la sensibilité se traduit en seuils exploitables', () => {
  assert.equal(sensitivityOf({ sensitivity: 'rapide' }), SENSITIVITY.rapide);
  assert.equal(sensitivityOf({ sensitivity: 'inexistante' }), SENSITIVITY.normale);
  // Plus c'est rapide, moins on exige d'immobilité.
  assert.ok(SENSITIVITY.rapide.stableMs < SENSITIVITY.normale.stableMs);
  assert.ok(SENSITIVITY.normale.stableMs < SENSITIVITY.patient.stableMs);
});
