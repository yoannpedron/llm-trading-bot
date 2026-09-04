/**
 * Les fichiers du moteur de lecture, et leur mise en cache.
 *
 * PP-OCRv6 « small » : un détecteur (où est le texte) et un reconnaisseur
 * (ce qu'il dit), plus le dictionnaire des caractères que ce dernier sait
 * produire. Trente et un mégaoctets, servis depuis `public/modeles/` — jamais
 * depuis un CDN tiers : l'application doit lire sans dépendre d'un domaine
 * qu'on ne contrôle pas.
 *
 * Pourquoi « small » et pas « tiny » (6 Mo) : mesuré sur les trois recadrages
 * réels, six images bruitées chacun, image brute sans prétraitement :
 *
 *     modèle        poids   cartes lues   images bonnes   fausses   par passe
 *     v6 tiny        6 Mo       2/3           10/18          0        190 ms
 *     v5 en mobile  13 Mo       2/3           12/18          0        320 ms
 *     v6 small      31 Mo       3/3           16/18          0        360 ms
 *
 * Le petit modèle ne lit jamais MAMA-FR113 (floue) ; le moyen la lit du
 * premier coup, et lit STOR-FR040 — que Tesseract refusait depuis le début —
 * six fois sur six. Trente et un mégaoctets, une fois, contre une carte sur
 * trois qui ne se lit pas : le choix est fait.
 *
 * Le téléchargement passe par le Cache API quand il existe : la deuxième
 * visite ne télécharge rien, même si le serveur ne dit rien de la durée de
 * vie de ses fichiers (GitHub Pages : dix minutes).
 */

/** Nom du cache. À incrémenter si les fichiers changent sous le même nom. */
export const CACHE = 'ygo-moteur-v1';

/** Les trois fichiers, et leur taille en octets — pour la barre de progression. */
export const FICHIERS = {
  detection: { nom: 'PP-OCRv6_small_det.ort', octets: 9_982_352 },
  recognition: { nom: 'PP-OCRv6_small_rec.ort', octets: 21_290_816 },
  charactersDictionary: { nom: 'ppocrv6_dict.txt', octets: 74_948 },
};

export const TOTAL_OCTETS = Object.values(FICHIERS).reduce((somme, f) => somme + f.octets, 0);

/**
 * Le cache, s'il est disponible.
 *
 * Absent hors contexte sécurisé (http:// autre que localhost) et dans
 * certains navigateurs en navigation privée : dans ce cas on télécharge à
 * chaque chargement, sans en faire une erreur.
 */
async function ouvrirCache() {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(CACHE);
  } catch {
    return null;
  }
}

/**
 * Lit une réponse en suivant l'avancement.
 *
 * `response.arrayBuffer()` ne dit rien tant qu'il n'a pas tout. On lit le
 * corps par morceaux pour pouvoir remonter les octets reçus — c'est la seule
 * chose qui rend supportable une attente de trente mégaoctets.
 */
async function lireAvecProgression(response, attendu, onOctets) {
  const taille = Number(response.headers.get('content-length')) || attendu;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onOctets(buffer.byteLength);
    return buffer;
  }

  const reader = response.body.getReader();
  const morceaux = [];
  let recu = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    morceaux.push(value);
    recu += value.byteLength;
    onOctets(Math.min(recu, taille));
  }

  const sortie = new Uint8Array(recu);
  let position = 0;
  for (const morceau of morceaux) {
    sortie.set(morceau, position);
    position += morceau.byteLength;
  }
  return sortie.buffer;
}

/**
 * Télécharge un fichier, ou le reprend du cache.
 *
 * Une réponse partielle ou en erreur n'est jamais mise en cache : un fichier
 * tronqué rendrait le moteur muet à chaque visite suivante, sans message.
 *
 * @param {string} url
 * @param {number} attendu taille en octets, pour la progression
 * @param {(octets: number) => void} onOctets octets reçus jusqu'ici
 * @returns {Promise<ArrayBuffer>}
 */
export async function chargerFichier(url, attendu, onOctets) {
  const cache = await ouvrirCache();

  const enCache = await cache?.match(url).catch(() => null);
  if (enCache) {
    const buffer = await enCache.arrayBuffer();
    // Un cache abîmé (coupure pendant `put`) se remarque à la taille.
    if (buffer.byteLength === attendu || attendu === 0) {
      onOctets(buffer.byteLength);
      return buffer;
    }
    await cache.delete(url).catch(() => {});
  }

  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Moteur de lecture introuvable (${response.status}) : ${url}`);

  const buffer = await lireAvecProgression(response, attendu, onOctets);
  if (attendu && buffer.byteLength !== attendu) {
    throw new Error(`Fichier du moteur incomplet : ${url} (${buffer.byteLength} octets sur ${attendu})`);
  }

  // Le cache reçoit une copie : le buffer part ensuite au moteur, qui le
  // consomme.
  await cache
    ?.put(url, new Response(buffer.slice(0), { headers: { 'content-type': 'application/octet-stream' } }))
    .catch(() => {});

  return buffer;
}

/**
 * Charge les trois fichiers du moteur.
 *
 * @param {string} base URL du dossier `modeles/`, terminée par `/`
 * @param {(fraction: number) => void} onProgress avancement global dans [0, 1]
 * @returns {Promise<{detection: ArrayBuffer, recognition: ArrayBuffer, charactersDictionary: ArrayBuffer}>}
 */
export async function chargerModeles(base, onProgress = () => {}) {
  const recu = {};
  const signaler = () => {
    const somme = Object.values(recu).reduce((total, octets) => total + octets, 0);
    onProgress(Math.min(1, somme / TOTAL_OCTETS));
  };

  const entrees = await Promise.all(
    Object.entries(FICHIERS).map(async ([cle, { nom, octets }]) => {
      const buffer = await chargerFichier(`${base}${nom}`, octets, (n) => {
        recu[cle] = n;
        signaler();
      });
      return [cle, buffer];
    }),
  );

  onProgress(1);
  return Object.fromEntries(entrees);
}
