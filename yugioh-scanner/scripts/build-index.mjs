/**
 * Génère l'index de cartes embarqué avec l'application.
 *
 * La base YGOPRODeck complète pèse 21 Mo : impensable à télécharger dans le
 * navigateur. Mais l'appariement n'a besoin que de trois choses — le passcode,
 * le nom, et la liste des tirages (code d'extension, série, rareté). Réduit à
 * cela, et avec un dictionnaire pour les noms de série et de rareté qui se
 * répètent des milliers de fois, l'index tient dans quelques centaines de Ko
 * une fois gzippé. Toute l'identification devient alors locale et instantanée.
 *
 *   node scripts/build-index.mjs [chemin de sortie]
 *
 * Sans réseau, le script sort en code 0 si un index existe déjà : une coupure
 * chez YGOPRODeck ne doit pas casser un déploiement.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SOURCE = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const OUTPUT = resolve(process.argv[2] ?? 'public/card-index.json');

/** Dictionnaire : renvoie l'indice d'une valeur, en l'ajoutant si besoin. */
function interner() {
  const seen = new Map();
  const values = [];
  return {
    values,
    index(value) {
      const key = value ?? '';
      if (!seen.has(key)) {
        seen.set(key, values.length);
        values.push(key);
      }
      return seen.get(key);
    },
  };
}

async function build() {
  const response = await fetch(SOURCE, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`YGOPRODeck a répondu ${response.status}`);

  const { data } = await response.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('réponse vide');

  const sets = interner();
  const rarities = interner();

  const cards = data.map((card) => [
    card.id,
    card.name,
    (card.card_sets ?? []).map((printing) => [
      sets.index(printing.set_name),
      printing.set_code ?? '',
      rarities.index(printing.set_rarity),
    ]),
  ]);

  const index = {
    version: new Date().toISOString().slice(0, 10),
    sets: sets.values,
    rarities: rarities.values,
    cards,
  };

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(index));

  const { size } = await stat(OUTPUT);
  const printings = cards.reduce((total, card) => total + card[2].length, 0);
  console.log(
    `index écrit : ${cards.length} cartes, ${printings} tirages, ` +
      `${sets.values.length} séries — ${(size / 1048576).toFixed(2)} Mo`,
  );
}

try {
  await build();
} catch (error) {
  // Un index déjà présent vaut mieux qu'un déploiement avorté.
  const existing = await stat(OUTPUT).catch(() => null);
  if (existing) {
    console.warn(`index non régénéré (${error.message}) — celui en place est conservé`);
  } else {
    console.warn(
      `index non généré (${error.message}) — l'application retombera sur l'API YGOPRODeck`,
    );
  }
}
