/**
 * Pseudonymes plausibles, en remplacement des jetons vides.
 *
 * ── Ce que le masquage par jeton coûtait ──────────────────────────────────
 * Le protocole précédent remplaçait chaque entité par « [ENTREPRISE_A] ». La
 * protection contre la contamination mémorielle était bonne, mais le prix en
 * capacité de discrimination est documenté et lourd : privé de tout ancrage, le
 * modèle cesse d'analyser et se replie sur une réponse par défaut. C'est le
 * même mécanisme que l'effondrement observé en production — trois valeurs
 * distinctes sur vingt réponses.
 *
 * Une dépêche réduite à « [ENTREPRISE_A] et [AUTRE_SOCIETE] discutent d'un
 * accord que [DIRIGEANT_A] juge décisif » n'est plus une phrase : c'est un
 * gabarit. Le modèle n'a plus de sujet auquel rattacher les actions successives
 * et son mécanisme d'attention n'a plus rien à lier.
 *
 * ── Ce qu'on fait à la place ──────────────────────────────────────────────
 * On substitue des entités FICTIVES mais linguistiquement naturelles. La même
 * dépêche devient « Norvane et Calderis discutent d'un accord que M. Aldrich
 * juge décisif ». La phrase se lit normalement, les chaînes de coréférence sont
 * intactes, et le modèle n'a strictement aucun souvenir de Norvane — donc aucun
 * a priori de réputation à projeter dessus.
 *
 * L'anonymat est au moins aussi fort : un jeton « [ENTREPRISE_A] » signale au
 * modèle qu'on lui cache quelque chose et l'invite à deviner ; un nom plausible
 * ne déclenche même pas la question.
 *
 * ── Les noms sont volontairement NEUTRES SECTORIELLEMENT ──────────────────
 * « AeroGlobal » suggérerait l'aéronautique et injecterait une information
 * fausse. Les noms ci-dessous sont des inventions sans racine sémantique
 * exploitable. Le secteur réel est fourni séparément, en clair, comme une
 * donnée de contexte assumée : il ne permet pas d'identifier l'entreprise parmi
 * les vingt de son secteur, et il conditionne correctement l'analyse.
 */

/**
 * Racines inventées, vérifiées sans collision avec une société cotée connue.
 * Assez nombreuses pour qu'un lot de dix n'épuise jamais le stock, et assez
 * distinctes les unes des autres pour qu'aucune confusion ne soit possible à
 * l'intérieur d'un même lot.
 */
const RACINES = [
  'Norvane', 'Calderis', 'Vextra', 'Kelmore', 'Suvanto', 'Draymer', 'Ondelis',
  'Trevanne', 'Marnoch', 'Belvara', 'Cortis', 'Halvorn', 'Quenza', 'Ferrane',
  'Aldemir', 'Norwick', 'Sablon', 'Ternova', 'Ilvarine', 'Corbeau',
  'Melvara', 'Rhodane', 'Vantris', 'Escaly', 'Purbeck', 'Oranthe', 'Kestrane',
  'Livonde', 'Tarquin', 'Wessline', 'Amberlo', 'Nordisk', 'Cavelle', 'Brimont',
  'Sorrelen', 'Thalvic', 'Ravenne', 'Ostrande', 'Verlaine', 'Cindral',
];

/** Suffixes de forme sociale : rendent le nom crédible sans rien connoter. */
const SUFFIXES = ['', ' Group', ' Industries', ' Holdings', ' Partners', ' Systems'];

/** Patronymes pour les dirigeants — mêmes contraintes. */
const PATRONYMES = [
  'Aldrich', 'Béranger', 'Costner', 'Delmare', 'Ekvall', 'Fontaine', 'Grimald',
  'Harkness', 'Ivarsen', 'Jourdain', 'Kellerman', 'Lindqvist', 'Marchetti',
  'Norrington', 'Ostrowski', 'Pellerin', 'Quintaine', 'Rasmussen', 'Sandoval',
  'Thibault', 'Ullmann', 'Vasquez', 'Wexford', 'Yarrow', 'Zimmerli',
];

/** Noms de produits génériques et manifestement inventés. */
const PRODUITS = [
  'Axion', 'Belrose', 'Cobalt Line', 'Delta Series', 'Everest One', 'Fairmont',
  'Granite', 'Helix', 'Ionis', 'Juniper', 'Kestrel', 'Lumen', 'Meridian',
  'Nimbus', 'Orion', 'Pallas', 'Quartz', 'Rivet', 'Solstice', 'Tessera',
];

/**
 * Hachage stable d'une chaîne (FNV-1a 32 bits).
 *
 * Il faut que le pseudonyme d'un symbole soit REPRODUCTIBLE : deux cycles
 * consécutifs doivent donner le même nom au même actif, sinon la comparaison de
 * deux réponses du modèle mélange l'effet du nom et l'effet des données. Un
 * hachage rend cette stabilité gratuite, sans rien stocker.
 */
function hacher(texte) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i += 1) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Attribue un pseudonyme stable à un symbole.
 *
 * `sel` permet de faire tourner les noms d'une campagne à l'autre. Le laisser
 * fixe est le comportement voulu en production ; le changer sert au test
 * d'échange d'entités, qui vérifie justement que le nom n'influence rien.
 */
export function pseudonymePour(symbol, sel = '') {
  const h = hacher(`${symbol}|${sel}`);
  const racine = RACINES[h % RACINES.length];
  const suffixe = SUFFIXES[(h >>> 8) % SUFFIXES.length];
  return `${racine}${suffixe}`;
}

/**
 * Attribue des pseudonymes GARANTIS distincts à un groupe d'actifs.
 *
 * ── Pourquoi le hachage seul ne suffit pas ────────────────────────────────
 * `pseudonymePour` tire indépendamment dans 40 racines × 6 suffixes. Sur 150
 * symboles, mesuré : 46 collisions — trois actifs se retrouvaient nommés
 * « Escaly Group ».
 *
 * Anodin tant que chaque actif était interrogé seul. Fatal dès qu'on en
 * présente dix ensemble et qu'on demande un classement : le modèle renvoie
 * « Escaly Group », et rien ne dit lequel des trois il désigne. Le classement
 * devient inexploitable au moment précis où il compte.
 *
 * On sonde donc les combinaisons à partir de la position dictée par le
 * hachage, jusqu'à en trouver une libre. Le résultat reste déterministe pour
 * un groupe donné — rejouer le même lot redonne les mêmes noms.
 *
 * ── Et le fait que les noms changent d'un lot à l'autre est un avantage ───
 * Un actif apparaît dans plusieurs lots au cours d'un cycle, souvent sous des
 * noms différents. Loin d'être un défaut, c'est exactement le protocole
 * d'échange d'entités : si le nom influençait le jugement, l'effet se
 * disperserait sur quatre tirages au lieu de s'accumuler.
 */
export function pseudonymesUniques(symbols, sel = '') {
  const pris = new Set();
  const out = new Map();

  // Ordre de traitement déterministe : sans tri, l'ordre d'arrivée déciderait
  // qui garde son nom de prédilection et le résultat varierait d'un appel à
  // l'autre pour un même ensemble.
  for (const symbol of [...symbols].sort()) {
    const h = hacher(`${symbol}|${sel}`);
    let nom = null;

    for (let essai = 0; essai < RACINES.length * SUFFIXES.length; essai += 1) {
      const racine = RACINES[(h + essai) % RACINES.length];
      const suffixe = SUFFIXES[((h >>> 8) + Math.floor((h + essai) / RACINES.length)) % SUFFIXES.length];
      const candidat = `${racine}${suffixe}`;
      if (!pris.has(candidat)) { nom = candidat; break; }
    }

    // Réserve épuisée : ne peut arriver qu'au-delà de 240 actifs simultanés.
    // On suffixe plutôt que de rendre un doublon silencieux.
    if (!nom) nom = `${RACINES[h % RACINES.length]} ${pris.size}`;

    pris.add(nom);
    out.set(symbol, nom);
  }

  return out;
}

/**
 * Jeu complet de substituts pour un actif : société, dirigeants, produits.
 *
 * Les dirigeants et produits sont dérivés du MÊME hachage que la société, donc
 * cohérents entre eux et stables dans le temps, sans table à maintenir.
 */
export function substitutsPour(symbol, { executives = [], products = [], subsidiaries = [] } = {}, sel = '') {
  const h = hacher(`${symbol}|${sel}`);
  const societe = pseudonymePour(symbol, sel);

  const prendre = (liste, decalage) => liste[(h >>> decalage) % liste.length];

  return {
    societe,
    // Un dirigeant par nom réel connu, tous distincts entre eux.
    dirigeants: executives.map((_, i) => `M. ${PATRONYMES[(h + i * 7) % PATRONYMES.length]}`),
    produits: products.map((_, i) => PRODUITS[(h + i * 11) % PRODUITS.length]),
    filiales: subsidiaries.map((_, i) => `${RACINES[(h + i * 13) % RACINES.length]} ${['Labs', 'Services', 'Digital', 'Capital'][i % 4]}`),
    // Pour les entreprises tierces citées dans une dépêche : un nom neutre
    // différent de celui de la cible, tiré de la même réserve.
    tiers: (n) => Array.from({ length: n }, (_, i) => `${RACINES[(h + 17 + i * 3) % RACINES.length]}${SUFFIXES[(h + i) % SUFFIXES.length]}`),
    _racine: prendre(RACINES, 4),
  };
}

/**
 * Tranche de capitalisation, en clair.
 *
 * Non identifiante — une centaine de sociétés partagent chaque tranche — et
 * pourtant décisive pour interpréter un événement : une acquisition à
 * 50 M$ ne signifie pas la même chose pour une méga-capitalisation que pour une
 * société dix fois plus petite. C'est exactement le type de contexte que le
 * masquage détruisait sans nécessité.
 */
export function trancheTaille(capitalisation) {
  if (capitalisation == null || !Number.isFinite(capitalisation)) return 'non renseignée';
  const md = capitalisation / 1e9;
  if (md >= 1000) return 'méga-capitalisation (> 1 000 Md$)';
  if (md >= 200) return 'très grande capitalisation (200 à 1 000 Md$)';
  if (md >= 50) return 'grande capitalisation (50 à 200 Md$)';
  if (md >= 10) return 'capitalisation moyenne (10 à 50 Md$)';
  return 'petite capitalisation (< 10 Md$)';
}

export { RACINES, PATRONYMES, PRODUITS };
