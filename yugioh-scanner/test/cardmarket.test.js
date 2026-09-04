import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProductUrls,
  hasUsablePrices,
  parseEuroAmount,
  parsePriceTable,
  slugify,
} from '../netlify/functions/_lib/cardmarket.js';

test('lit les montants au format européen', () => {
  assert.equal(parseEuroAmount('0,10 €'), 0.1);
  assert.equal(parseEuroAmount('1.234,56 €'), 1234.56);
  assert.equal(parseEuroAmount('12 €'), 12);
  assert.equal(parseEuroAmount('sans montant'), null);
  assert.equal(parseEuroAmount(null), null);
});

test('extrait le tableau de prix de la fiche produit', () => {
  const html = `
    <dl class="labeled">
      <dt>Available items</dt><dd>1.234</dd>
      <dt>From</dt><dd><span>0,10 €</span></dd>
      <dt>Price Trend</dt><dd><span class="value">0,25 €</span></dd>
      <dt>30-days average price</dt><dd>0,24 €</dd>
      <dt>7-days average price</dt><dd>0,22 €</dd>
      <dt>1-day average price</dt><dd>0,20 €</dd>
      <dt>Rarity</dt><dd><span>Ultra Rare</span></dd>
    </dl>`;

  assert.deepEqual(parsePriceTable(html), {
    available: 1234,
    from: 0.1,
    trend: 0.25,
    avg30: 0.24,
    avg7: 0.22,
    avg1: 0.2,
  });
});

test('ne renvoie rien quand la page ne contient pas de prix', () => {
  assert.deepEqual(parsePriceTable('<html><body>404</body></html>'), {});
  assert.equal(hasUsablePrices({}), false);
  assert.equal(hasUsablePrices({ available: 3 }), false);
  assert.equal(hasUsablePrices({ trend: 0.25 }), true);
});

test('construit des slugs conformes à Cardmarket', () => {
  assert.equal(slugify('Blue-Eyes White Dragon'), 'Blue-Eyes-White-Dragon');
  assert.equal(slugify("Harpie's Feather Duster"), 'Harpies-Feather-Duster');
  assert.equal(slugify('Number 39: Utopia'), 'Number-39-Utopia');
  assert.equal(slugify('Légendaire'), 'Legendaire');
});

test('essaie la variante avec rareté avant la variante nue', () => {
  const urls = buildProductUrls({
    name: 'Beast Fangs',
    setName: 'Legend of Blue Eyes White Dragon',
    rarity: 'Short Print',
  });

  assert.equal(urls.length, 2);
  assert.match(urls[0], /Legend-of-Blue-Eyes-White-Dragon\/Beast-Fangs-Short-Print$/);
  assert.match(urls[1], /Legend-of-Blue-Eyes-White-Dragon\/Beast-Fangs$/);
});

test('n’invente pas d’URL sans nom ni série', () => {
  assert.deepEqual(buildProductUrls({ name: '', setName: 'X' }), []);
  assert.deepEqual(buildProductUrls({ name: 'X', setName: '' }), []);
});
