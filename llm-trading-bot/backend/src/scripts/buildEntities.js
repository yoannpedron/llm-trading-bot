/**
 * Construit le dictionnaire d'anonymisation pour l'univers élargi.
 *
 * ── Le problème que ce script résout ──────────────────────────────────────
 * L'anonymisation n'est pas graduelle. Masquer « AMD » en laissant « Lisa Su »
 * dans le texte ne réduit pas le risque de réidentification de moitié : il ne
 * le réduit pas du tout, parce qu'un seul nom de dirigeant suffit à désigner
 * l'entreprise sans ambiguïté. Une couverture partielle est donc pire que rien,
 * puisqu'elle donne l'illusion d'une mesure propre.
 *
 * Le dictionnaire écrit à la main couvre 10 valeurs. L'univers en vise 150.
 * Les 140 restantes seraient traitées avec le seul ticker et la raison sociale
 * — c'est-à-dire pas anonymisées.
 *
 * ── Pourquoi passer par le modèle ─────────────────────────────────────────
 * Les dirigeants et les produits emblématiques d'une grande capitalisation
 * américaine sont exactement le genre de fait qu'un modèle de langage connaît
 * de manière fiable. C'est même le contraire du problème habituel : ici, la
 * mémorisation du corpus d'entraînement est l'outil, pas le biais.
 *
 * La distinction qui rend cet usage légitime : ce script tourne UNE FOIS, hors
 * de la boucle de mesure, et son résultat est un dictionnaire de censure — pas
 * une prévision. Rien de ce qu'il produit n'entre dans le score du bot.
 *
 * ── Reprise ───────────────────────────────────────────────────────────────
 * L'écriture est incrémentale après chaque symbole. Une interruption — quota,
 * réseau, Ctrl-C — ne perd que le symbole en cours, et relancer reprend là où
 * ça s'était arrêté.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { postJson, HttpError } from '../utils/http.js';
import { keyPool } from '../llm/keyPool.js';
import { UNIVERSE_ENTITIES, entityCoverage } from '../llm/entities.js';
import { UNIVERSE_150 } from '../data/universe.js';

const log = createLogger('entities:build');
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'llm', 'entities.generated.json');

/**
 * Schéma imposé à la réponse.
 *
 * On force des tableaux de chaînes : sans schéma, le modèle produit volontiers
 * de la prose (« Les principaux dirigeants sont… ») qu'il faudrait ensuite
 * découper à la main, avec le taux d'erreur que ça suppose.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    names: { type: 'array', items: { type: 'string' } },
    executives: { type: 'array', items: { type: 'string' } },
    products: { type: 'array', items: { type: 'string' } },
    subsidiaries: { type: 'array', items: { type: 'string' } },
  },
  required: ['names', 'executives', 'products', 'subsidiaries'],
};

const INSTRUCTION = `Tu construis un dictionnaire de CENSURE, pas une fiche d'investissement.

Pour le ticker donné, liste les termes qu'un lecteur pourrait utiliser pour identifier
l'entreprise dans un article de presse financière :

- names        : raison sociale et variantes usuelles dans la presse (3 à 5 entrées).
- executives   : dirigeants actuels ou très récents — PDG, directeur financier — sous la
                 forme complète ET sous la forme du seul nom de famille quand il est
                 distinctif (4 à 8 entrées).
- products     : produits, marques et gammes emblématiques que la presse cite en associant
                 implicitement l'entreprise (5 à 12 entrées).
- subsidiaries : filiales, marques rachetées, usines nommées (0 à 6 entrées).

Règles strictes :
- N'inclus AUCUN terme générique ("smartphone", "cloud", "puce", "IA", "logiciel") : il
  serait censuré partout et rendrait les textes illisibles.
- N'inclus aucun nom de famille trop courant pour être distinctif (Smith, Lee, Martin).
- Si tu n'es pas sûr d'un dirigeant, omets-le plutôt que d'inventer : un faux terme ne
  censure rien, il ne coûte donc rien, mais un dirigeant OUBLIÉ laisse fuiter l'identité.
- Écris les termes tels qu'ils apparaissent en anglais dans la presse.`;

/** Termes trop génériques pour être censurés — filet de sécurité côté code. */
const TROP_GENERIQUE = new Set([
  'inc', 'corp', 'corporation', 'company', 'group', 'holdings', 'the', 'and',
  'cloud', 'ai', 'chip', 'chips', 'software', 'hardware', 'phone', 'smartphone',
  'bank', 'energy', 'oil', 'gas', 'health', 'care', 'motors', 'systems', 'technologies',
]);

function nettoie(liste) {
  if (!Array.isArray(liste)) return [];
  return [...new Set(
    liste
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !TROP_GENERIQUE.has(t.toLowerCase())),
  )];
}

async function interroge(symbol) {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: `${INSTRUCTION}\n\nTicker : ${symbol} (bourse américaine).` }] }],
    generationConfig: {
      // Température nulle : on veut un fait, pas une variante créative.
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      thinkingConfig: { thinkingBudget: config.llm.thinkingBudget },
    },
    safetySettings: [],
  };

  const maxAttempts = Math.max(1, (await keyPool.capacity()).keys);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const entry = await keyPool.acquire();
    if (!entry) throw new Error('Toutes les clés sont épuisées.');

    try {
      const data = await postJson(
        `${API_ROOT}/models/${config.llm.model}:generateContent?key=${encodeURIComponent(entry.key)}`,
        payload,
        { timeoutMs: config.llm.timeoutMs, retries: 1, retryOnRateLimit: false },
      );
      await keyPool.recordUse(entry.id);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('réponse vide');
      return JSON.parse(text);
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        await keyPool.markExhausted(entry.id, 'quota atteint pendant la construction du dictionnaire');
        continue;
      }
      throw err;
    }
  }
  throw new Error('Aucune clé disponible après rotation.');
}

async function main() {
  if (config.llm.provider !== 'gemini') {
    log.error(`Fournisseur ${config.llm.provider} : ce script exige gemini.`);
    process.exit(1);
  }

  const cible = process.env.UNIVERSE_FILE
    ? JSON.parse(fs.readFileSync(process.env.UNIVERSE_FILE, 'utf8'))
    : UNIVERSE_150;

  const genere = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

  // Le dictionnaire manuel fait autorité : on ne le réinterroge pas et on ne
  // l'écrase jamais.
  const aFaire = cible.filter((s) => !UNIVERSE_ENTITIES[s] && !genere[s]);

  const avant = entityCoverage(cible);
  log.info(`Couverture actuelle : ${avant.couverts}/${avant.total} (${(avant.part * 100).toFixed(1)} %).`);

  if (!aFaire.length) {
    log.info('Rien à faire — tous les symboles sont déjà couverts.');
    return;
  }

  const capacite = await keyPool.capacity();
  const restant = capacite.totalPerDay - capacite.used;
  log.info(`${aFaire.length} symbole(s) à interroger, ${restant} appel(s) disponibles aujourd'hui.`);
  if (restant < aFaire.length) {
    log.warn(
      `Le quota ne suffit pas pour tout faire aujourd'hui. Le script ira aussi loin qu'il peut et `
      + 'écrira au fur et à mesure : relance-le demain pour terminer.',
    );
  }

  let ok = 0;
  let rates = 0;

  for (const [i, symbol] of aFaire.entries()) {
    try {
      const brut = await interroge(symbol);
      const entree = {
        names: nettoie(brut.names),
        executives: nettoie(brut.executives),
        products: nettoie(brut.products),
        subsidiaries: nettoie(brut.subsidiaries),
      };

      // Un symbole sans dirigeant ni produit ne serait pas anonymisé. Mieux
      // vaut l'absence déclarée qu'une entrée creuse qui ferait passer la
      // couverture pour bonne.
      if (!entree.names.length || (!entree.executives.length && !entree.products.length)) {
        log.warn(`${symbol} : réponse trop pauvre (${entree.names.length} noms, ${entree.executives.length} dirigeants) — non enregistré.`);
        rates += 1;
        continue;
      }

      genere[symbol] = entree;
      fs.writeFileSync(OUT, `${JSON.stringify(genere, null, 2)}\n`);
      ok += 1;
      log.info(
        `[${i + 1}/${aFaire.length}] ${symbol} : ${entree.names.length} noms, `
        + `${entree.executives.length} dirigeants, ${entree.products.length} produits, `
        + `${entree.subsidiaries.length} filiales`,
      );
    } catch (err) {
      rates += 1;
      log.error(`${symbol} : ${err.message}`);
      if (/épuisée|epuisee/i.test(err.message)) {
        log.warn('Quota atteint — arrêt propre. Les symboles déjà traités sont enregistrés.');
        break;
      }
    }

    if (config.llm.cooldownMs > 0) {
      await new Promise((r) => { setTimeout(r, config.llm.cooldownMs); });
    }
  }

  console.log(`\n  ${ok} symbole(s) ajouté(s), ${rates} en échec.`);
  console.log(`  Dictionnaire : ${OUT}`);
  console.log('\n  Relance le processus pour recharger le fichier, puis vérifie avec `npm run entities`.\n');
}

await main();
