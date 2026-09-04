import test from 'node:test';
import assert from 'node:assert/strict';

import { CACHE, FICHIERS, TOTAL_OCTETS, chargerFichier, chargerModeles } from '../src/lib/modeles.js';
import { dossierModeles } from '../src/lib/ocr.js';

/** Un `fetch` qui sert des octets par morceaux, comme un vrai réseau. */
function reseau(contenus, { statut = 200, contentLength = true, morceau = 7 } = {}) {
  const appels = [];
  const fetch = async (url) => {
    appels.push(url);
    const nom = String(url).split('/').pop();
    const octets = contenus[nom];
    if (!octets || statut !== 200) return new Response(null, { status: statut || 404 });
    const flux = new ReadableStream({
      start(controller) {
        for (let i = 0; i < octets.length; i += morceau) controller.enqueue(octets.slice(i, i + morceau));
        controller.close();
      },
    });
    const headers = contentLength ? { 'content-length': String(octets.length) } : {};
    return new Response(flux, { status: 200, headers });
  };
  return { fetch, appels };
}

/** Un Cache API minimal, en mémoire. */
function cacheMemoire() {
  const entrees = new Map();
  const cache = {
    match: async (url) => entrees.get(url)?.clone() ?? undefined,
    put: async (url, response) => void entrees.set(url, response),
    delete: async (url) => entrees.delete(url),
  };
  return { caches: { open: async () => cache }, entrees };
}

const avec = async (globaux, corps) => {
  const anciens = {};
  for (const [cle, valeur] of Object.entries(globaux)) {
    anciens[cle] = globalThis[cle];
    globalThis[cle] = valeur;
  }
  try {
    return await corps();
  } finally {
    for (const [cle, valeur] of Object.entries(anciens)) {
      if (valeur === undefined) delete globalThis[cle];
      else globalThis[cle] = valeur;
    }
  }
};

test('le manifeste des modèles est complet et ses tailles sont celles des fichiers servis', () => {
  // Les trois fichiers que le moteur attend, et rien d'autre.
  assert.deepEqual(Object.keys(FICHIERS).sort(), ['charactersDictionary', 'detection', 'recognition']);
  assert.equal(TOTAL_OCTETS, Object.values(FICHIERS).reduce((s, f) => s + f.octets, 0));
  // Un chiffre faux ici fait rejeter le téléchargement comme « incomplet ».
  assert.equal(FICHIERS.detection.octets, 9_982_352);
  assert.equal(FICHIERS.recognition.octets, 21_290_816);
  assert.equal(FICHIERS.charactersDictionary.octets, 74_948);
  assert.match(CACHE, /^ygo-moteur-v\d+$/);
});

test('les modèles sont servis à côté de l’application, sous modeles/', () => {
  // Sans `location` (Node), la base est un hôte fictif : le chemin compte.
  assert.equal(dossierModeles(), 'http://localhost/modeles/');
});

test('le téléchargement suit l’avancement et vérifie la taille', async () => {
  const octets = new Uint8Array(100).map((_, i) => i);
  const { fetch } = reseau({ 'a.bin': octets });
  const progression = [];

  const buffer = await avec({ fetch, caches: undefined }, () =>
    chargerFichier('http://x/a.bin', 100, (n) => progression.push(n)),
  );

  assert.equal(buffer.byteLength, 100);
  assert.deepEqual(new Uint8Array(buffer), octets);
  // L'avancement monte par morceaux, et finit à la taille totale.
  assert.ok(progression.length > 1);
  assert.equal(progression.at(-1), 100);
  assert.ok(progression.every((n, i) => i === 0 || n >= progression[i - 1]));
});

test('un fichier tronqué est refusé plutôt que mis en cache', async () => {
  const { fetch } = reseau({ 'a.bin': new Uint8Array(40) }, { contentLength: false });
  const { caches, entrees } = cacheMemoire();

  await assert.rejects(
    avec({ fetch, caches }, () => chargerFichier('http://x/a.bin', 100, () => {})),
    /incomplet/,
  );
  assert.equal(entrees.size, 0);
});

test('une réponse en erreur est un message, pas un moteur muet', async () => {
  const { fetch } = reseau({}, { statut: 404 });
  await assert.rejects(
    avec({ fetch, caches: undefined }, () => chargerFichier('http://x/absent.bin', 10, () => {})),
    /introuvable \(404\)/,
  );
});

test('la deuxième visite ne télécharge rien', async () => {
  const octets = new Uint8Array(50).fill(7);
  const { fetch, appels } = reseau({ 'a.bin': octets });
  const { caches, entrees } = cacheMemoire();

  await avec({ fetch, caches }, () => chargerFichier('http://x/a.bin', 50, () => {}));
  assert.equal(appels.length, 1);
  assert.equal(entrees.size, 1);

  const relu = await avec({ fetch, caches }, () => chargerFichier('http://x/a.bin', 50, () => {}));
  assert.equal(appels.length, 1, 'aucun nouvel appel réseau');
  assert.deepEqual(new Uint8Array(relu), octets);
});

test('un cache abîmé est jeté et retéléchargé', async () => {
  const octets = new Uint8Array(50).fill(3);
  const { fetch, appels } = reseau({ 'a.bin': octets });
  const { caches, entrees } = cacheMemoire();
  // Une entrée de mauvaise taille : coupure pendant l'écriture, ancien fichier.
  entrees.set('http://x/a.bin', new Response(new Uint8Array(20)));

  const relu = await avec({ fetch, caches }, () => chargerFichier('http://x/a.bin', 50, () => {}));
  assert.equal(appels.length, 1);
  assert.equal(relu.byteLength, 50);
});

test('l’avancement global pondère les trois fichiers par leur taille', async () => {
  const contenus = Object.fromEntries(
    Object.values(FICHIERS).map(({ nom, octets }) => [nom, new Uint8Array(octets)]),
  );
  const { fetch } = reseau(contenus, { morceau: 4_000_000 });
  const fractions = [];

  const modeles = await avec({ fetch, caches: undefined }, () =>
    chargerModeles('http://x/modeles/', (f) => fractions.push(f)),
  );

  assert.deepEqual(Object.keys(modeles).sort(), ['charactersDictionary', 'detection', 'recognition']);
  assert.equal(modeles.recognition.byteLength, FICHIERS.recognition.octets);
  assert.equal(fractions.at(-1), 1);
  assert.ok(fractions.every((f) => f >= 0 && f <= 1));
  assert.ok(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]), 'jamais de recul');
});
