import test from 'node:test';
import assert from 'node:assert/strict';

import { RARITY_TIERS, rarityProfile, rarityTier, sortRarities } from '../src/lib/rarity.js';

/** Libellés réels de l'index YGOPRODeck (recensés le 4 septembre 2026), avec
 *  le palier attendu. Coquilles comprises : elles sont dans la donnée. */
const CASES = [
  ['Common', 'common'],
  ['Short Print', 'common'],
  ['Super Short Print', 'common'],
  ['Rare', 'rare'],
  ['Grand Master Rare', 'rare'],
  ['Super Rare', 'super'],
  ['Ultra Rare', 'ultra'],
  ["Ultra Rare (Pharaoh's Rare)", 'gold'],
  ['Gold Rare', 'gold'],
  ['Premium Gold Rare', 'gold'],
  ['Ultimate Rare', 'ultimate'],
  ['Secret Rare', 'secret'],
  ['Prismatic Secret Rare', 'secret'],
  ['Extra Secret Rare', 'secret'],
  ['Gold Secret Rare', 'secret'],
  ['10000 Secret Rare', 'secret'],
  ['Ghost Rare', 'ghost'],
  ['Ghost/Gold Rare', 'ghost'],
  ['Platinum Secret Rare', 'platinum'],
  ['PLatinum Secret Rare', 'platinum'],
  ['Platinum Rare', 'platinum'],
  ['Quarter Century Secret Rare', 'premium'],
  ['Starlight Rare', 'premium'],
  ["Collector's Rare", 'premium'],
  ['Duel Terminal Normal Parallel Rare', 'parallel'],
  ['Duel Terminal Ultra Parallel Rare', 'parallel'],
  ['Ultra Parallel Rare', 'parallel'],
  ['Starfoil Rare', 'parallel'],
  ['Starfoil', 'parallel'],
  ['Shatterfoil Rare', 'parallel'],
  ['Mosaic Rare', 'parallel'],
  ['New', 'common'],
  ['2', 'common'],
  ['Cr', 'common'],
  ['', 'common'],
  [undefined, 'common'],
];

test('chaque libellé réel tombe dans le palier attendu', () => {
  for (const [label, tier] of CASES) {
    assert.equal(rarityTier(label), tier, `${label} devrait être ${tier}`);
  }
});

test('le palier et le profil disent la même chose', () => {
  for (const [label] of CASES) {
    assert.equal(rarityProfile(label).key, rarityTier(label));
  }
});

test('chaque palier décrit une couverture et une finition connues', () => {
  const coverages = new Set(['none', 'name', 'art', 'artname', 'full']);
  const finishes = new Set(['silver', 'gold', 'rainbow', 'pattern', 'relief', 'platinum', 'ghost']);
  for (const tier of RARITY_TIERS) {
    assert.ok(coverages.has(tier.coverage), `${tier.key} : couverture ${tier.coverage}`);
    assert.ok(finishes.has(tier.finish), `${tier.key} : finition ${tier.finish}`);
    assert.ok(tier.foil >= 0 && tier.foil <= 1);
    assert.ok(tier.glare >= 0 && tier.glare <= 1);
    assert.match(tier.glow, /^#[0-9a-f]{6}$/i);
    assert.match(tier.accent, /^#[0-9a-f]{6}$/i);
  }
  // Une Commune n'a pas de foil ; un foil intégral en a le plus.
  assert.equal(rarityProfile('Common').foil, 0);
  assert.equal(rarityProfile('Common').coverage, 'none');
  assert.ok(rarityProfile('Starlight Rare').foil > rarityProfile('Super Rare').foil);
});

test('le tri va du plus commun au plus rare, et se renverse à la demande', () => {
  const printings = [
    { rarity: 'Secret Rare' },
    { rarity: 'Common' },
    { rarity: 'Ultra Rare' },
    { rarity: 'Rare' },
  ];
  assert.deepEqual(
    sortRarities(printings).map((p) => p.rarity),
    ['Common', 'Rare', 'Ultra Rare', 'Secret Rare'],
  );
  assert.deepEqual(
    sortRarities(printings, { rarestFirst: true }).map((p) => p.rarity),
    ['Secret Rare', 'Ultra Rare', 'Rare', 'Common'],
  );
});
