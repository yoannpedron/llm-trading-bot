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
  ['Gold Secret Rare', 'goldsecret'],
  ['10000 Secret Rare', 'secret'],
  ['Ghost Rare', 'ghost'],
  ['Ghost/Gold Rare', 'ghost'],
  ['Platinum Secret Rare', 'platinum'],
  ['PLatinum Secret Rare', 'platinum'],
  ['Platinum Rare', 'platinum'],
  ['Quarter Century Secret Rare', 'premium'],
  ['Starlight Rare', 'premium'],
  ["Collector's Rare", 'collector'],
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

test('chaque palier décrit des zones et des finitions connues', () => {
  const zones = new Set(['name', 'art', 'stars', 'border', 'full', 'fullNoText']);
  const finishes = new Set(['silver', 'gold', 'rainbow', 'pattern', 'relief', 'platinum', 'ghost']);
  for (const tier of RARITY_TIERS) {
    for (const [zone, finish] of Object.entries(tier.zones)) {
      assert.ok(zones.has(zone), `${tier.key} : zone ${zone}`);
      assert.ok(finishes.has(finish), `${tier.key} : finition ${finish}`);
    }
    assert.ok([null, 'diagonals', 'sparkle'].includes(tier.texture));
    assert.ok(tier.foil >= 0 && tier.foil <= 1);
    assert.ok(tier.glare >= 0 && tier.glare <= 1);
    assert.match(tier.glow, /^#[0-9a-f]{6}$/i);
    assert.match(tier.accent, /^#[0-9a-f]{6}$/i);
  }
});

test('les zones suivent la carte physique', () => {
  const zones = (label) => rarityProfile(label).zones;
  // Une Commune n'a rien ; une Rare n'a que le nom, en argent.
  assert.deepEqual(zones('Common'), {});
  assert.deepEqual(zones('Rare'), { name: 'silver' });
  // Super : illustration et étoiles, nom non foilé. Ultra : idem + nom doré.
  assert.equal(zones('Super Rare').name, undefined);
  assert.equal(zones('Ultra Rare').name, 'gold');
  assert.equal(zones('Ultra Rare').art, 'rainbow');
  // Gold et Platinum foilent les bordures ; Secret et Ultra non.
  assert.equal(zones('Gold Rare').border, 'gold');
  assert.equal(zones('Platinum Secret Rare').border, 'platinum');
  assert.equal(zones('Secret Rare').border, undefined);
  // Ultimate : relief partout sauf le nom, qui est doré.
  assert.equal(zones('Ultimate Rare').art, 'relief');
  assert.equal(zones('Ultimate Rare').name, 'gold');
  // Seuls les Parallel couvrent toute la carte, boîte de texte comprise.
  assert.deepEqual(zones('Starfoil Rare'), { full: 'pattern' });
  assert.deepEqual(zones('Starlight Rare'), { fullNoText: 'rainbow' });
  assert.deepEqual(zones('Quarter Century Secret Rare'), { fullNoText: 'rainbow' });
  assert.equal(zones("Collector's Rare").full, undefined);
  // La texture Secret est là où on l'attend.
  assert.equal(rarityProfile('Secret Rare').texture, 'diagonals');
  assert.equal(rarityProfile('Gold Secret Rare').texture, 'diagonals');
  assert.equal(rarityProfile('Gold Secret Rare').zones.border, 'gold');
  assert.equal(rarityProfile('Ultra Rare').texture, null);
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
