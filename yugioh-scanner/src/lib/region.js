/**
 * La région : la langue des cartes que l'utilisateur tient en main.
 *
 * L'index embarqué (`public/card-index.json`, YGOPRODeck) ne porte que les
 * codes d'extension ANGLAIS. Mesuré sur les 44 499 tirages : 41 482 têtes
 * « EN » (« JUSH-EN040 », « LEHD-ENA26 »), 456 « PT », 732 codes anciens à
 * une lettre (« PSV-E088 »), 1 808 sans région du tout (« AST-070 »). Aucun
 * code français, allemand, italien… Or l'utilisateur doit reconnaître le
 * code inscrit sur SA carte : « LOB-FR005 », pas « LOB-EN005 ».
 *
 * Ce module fait trois choses, toutes pures :
 *  - la liste des régions qui existent, avec un libellé français ;
 *  - la préférence courante, lue et écrite dans `localStorage` ;
 *  - la dérivation d'un code anglais vers la région choisie, et le tri d'une
 *    liste de tirages qui met en tête ceux qui existent dans cette région.
 *
 * Il n'existe pas de cartes Yu-Gi-Oh! en danois, néerlandais ou suédois : ces
 * pays reçoivent les éditions anglaises. C'est dit dans le libellé de « EN »,
 * parce qu'un utilisateur de Copenhague chercherait sinon « DK » en vain.
 */

/** Clé de la préférence dans `localStorage`. */
export const CLE_STOCKAGE = 'ygo.region';

/** Région par défaut : l'application est en français, ses cartes aussi. */
export const REGION_DEFAUT = 'FR';

/**
 * Les régions qui existent, dans l'ordre où on les propose.
 *
 * `lettre` est la forme à une lettre des premières extensions (2002-2004) :
 * « LOB-E003 » (Europe, anglais), « LOB-F003 » (français), « LOB-G003 »
 * (allemand)… Les régions sans `lettre` n'ont pas existé à cette époque sous
 * cette forme.
 *
 * Les cinq dernières (JP, KR, AE, TC, SC) sont celles de l'OCG, dont les
 * extensions ne suivent pas la numérotation du TCG : un code dérivé pour ces
 * régions n'est qu'indicatif, et le libellé le dit.
 */
export const REGIONS = [
  { code: 'FR', libelle: 'Français', detail: 'France, Belgique, Suisse, Québec', lettre: 'F' },
  { code: 'EN', libelle: 'Anglais', detail: 'aussi Danemark, Pays-Bas, Scandinavie', lettre: 'E' },
  { code: 'DE', libelle: 'Allemand', detail: 'Allemagne, Autriche, Suisse', lettre: 'G' },
  { code: 'IT', libelle: 'Italien', detail: '', lettre: 'I' },
  { code: 'SP', libelle: 'Espagnol', detail: '', lettre: 'S' },
  { code: 'PT', libelle: 'Portugais', detail: 'Portugal, Brésil', lettre: 'P' },
  { code: 'JP', libelle: 'Japonais', detail: 'OCG, codes indicatifs', lettre: '' },
  { code: 'KR', libelle: 'Coréen', detail: 'codes indicatifs', lettre: '' },
  { code: 'AE', libelle: 'Anglais d’Asie', detail: 'OCG, codes indicatifs', lettre: '' },
  { code: 'TC', libelle: 'Chinois traditionnel', detail: 'OCG, codes indicatifs', lettre: '' },
  { code: 'SC', libelle: 'Chinois simplifié', detail: 'OCG, codes indicatifs', lettre: '' },
];

const PAR_CODE = new Map(REGIONS.map((region) => [region.code, region]));

/** Une région connue, sous sa forme canonique, ou `null`. */
export function regionConnue(code) {
  const propre = String(code ?? '').trim().toUpperCase();
  return PAR_CODE.has(propre) ? propre : null;
}

/**
 * Libellé complet d'une région : « Anglais (EN) — aussi Danemark, Pays-Bas,
 * Scandinavie ». Une région inconnue rend son code tel quel.
 */
export function libelleRegion(code) {
  const region = PAR_CODE.get(regionConnue(code));
  if (!region) return String(code ?? '');
  return `${region.libelle} (${region.code})${region.detail ? ` — ${region.detail}` : ''}`;
}

/* ------------------------------------------------------------------ */
/* Préférence                                                           */
/* ------------------------------------------------------------------ */

/**
 * La région préférée, lue dans `localStorage`.
 *
 * Sans `localStorage` (test, navigation privée qui lève, rendu hors
 * navigateur) ou avec une valeur inconnue, on rend le défaut : la préférence
 * est un confort, jamais une condition.
 */
export function lireRegion(stockage = globalThis.localStorage) {
  try {
    return regionConnue(stockage?.getItem(CLE_STOCKAGE)) ?? REGION_DEFAUT;
  } catch {
    return REGION_DEFAUT;
  }
}

/**
 * Enregistre la préférence et rend ce qui a été retenu.
 *
 * Une valeur inconnue n'est pas enregistrée : on rend la région courante,
 * pour que l'appelant affiche toujours ce qui est vraiment en vigueur.
 */
export function ecrireRegion(code, stockage = globalThis.localStorage) {
  const region = regionConnue(code);
  if (!region) return lireRegion(stockage);
  try {
    stockage?.setItem(CLE_STOCKAGE, region);
  } catch {
    // Stockage plein ou interdit : la préférence vaut pour la session.
  }
  return region;
}

/* ------------------------------------------------------------------ */
/* Codes                                                                */
/* ------------------------------------------------------------------ */

/**
 * Un code d'extension, découpé : préfixe, tête de région, reste.
 *
 * Trois formes, relevées dans l'index :
 *  - « LOB-EN005 », « LEHD-ENA26 », « SOI-ENSE1 » : région à deux lettres,
 *    suivie d'une lettre de série éventuelle et du numéro ;
 *  - « PSV-E088 » : région à une lettre, les premières extensions ;
 *  - « AST-070 », « DB49 » : rien à substituer.
 *
 * La tête n'est reconnue que si c'est une région connue : « SE1 » dans
 * « XXX-SE1 » n'en est pas une, et reste intacte.
 */
function decouper(setCode) {
  const code = String(setCode ?? '').toUpperCase();
  const deux = /^([A-Z0-9]{2,6})-([A-Z]{2})([A-Z]{0,2}\d+)$/.exec(code);
  if (deux && PAR_CODE.has(deux[2])) return { prefixe: deux[1], region: deux[2], reste: deux[3], forme: 'deux' };

  const une = /^([A-Z0-9]{2,6})-([A-Z])(\d+)$/.exec(code);
  if (une && REGIONS.some((r) => r.lettre === une[2])) return { prefixe: une[1], region: une[2], reste: une[3], forme: 'une' };

  return null;
}

/**
 * Région d'un code, sous sa forme à deux lettres : « LDK2-FR001 » → « FR »,
 * « PSV-E088 » → « EN », « AST-070 » → chaîne vide.
 */
export function regionDuCode(setCode) {
  const parts = decouper(setCode);
  if (!parts) return '';
  if (parts.forme === 'deux') return parts.region;
  return REGIONS.find((r) => r.lettre === parts.region)?.code ?? '';
}

/**
 * Le code tel qu'il est imprimé dans la région choisie.
 *
 *   « LOB-EN005 »  → « LOB-FR005 »
 *   « LEHD-ENA26 » → « LEHD-FRA26 »   (lettre de série conservée)
 *   « PSV-E088 »   → « PSV-F088 »     (forme ancienne à une lettre)
 *   « AST-070 »    → « AST-070 »      (inchangé, voir ci-dessous)
 *
 * CE QUI N'EST PAS CONVERTI, ET POURQUOI
 *
 * Un code sans région est une édition nord-américaine des premières années,
 * dont la numérotation diffère de l'édition européenne : dans l'index, le
 * Magicien Sombre est « LOB-005 » en Amérique et « LOB-E003 » en Europe.
 * Fabriquer « LOB-F005 » désignerait une AUTRE carte française. Le code est
 * donc laissé tel quel ; c'est la forme européenne, quand elle existe, qui
 * donne le code français.
 *
 * Une région à une lettre ne se convertit que vers une région qui a existé
 * sous cette forme (E, F, G, I, S, P) : « PSV-E088 » reste « PSV-E088 » si la
 * région choisie est JP.
 *
 * Une région inconnue rend le code tel quel.
 */
export function codePourRegion(setCode, region) {
  const cible = PAR_CODE.get(regionConnue(region));
  const parts = decouper(setCode);
  if (!cible || !parts) return setCode;

  if (parts.forme === 'deux') return `${parts.prefixe}-${cible.code}${parts.reste}`;
  if (cible.lettre) return `${parts.prefixe}-${cible.lettre}${parts.reste}`;
  return setCode;
}

/* ------------------------------------------------------------------ */
/* Tirages                                                              */
/* ------------------------------------------------------------------ */

/**
 * Tri stable : les tirages dont le code est dans la région choisie d'abord,
 * puis les autres, chacun dans l'ordre reçu.
 *
 * Une carte reconnue par son illustration peut avoir soixante tirages. Ceux
 * que l'utilisateur tient en main sont dans sa langue : ils passent en tête,
 * le reste suit, rien n'est caché.
 */
export function trierParRegion(tirages, region) {
  const cible = regionConnue(region);
  const rang = (tirage) => (cible && regionDuCode(tirage.setCode) === cible ? 0 : 1);
  return (tirages ?? [])
    .map((tirage, position) => [tirage, position])
    .sort((a, b) => rang(a[0]) - rang(b[0]) || a[1] - b[1])
    .map(([tirage]) => tirage);
}

/**
 * Les tirages d'une carte, tels qu'on les montre et les enregistre dans la
 * région choisie : codes convertis, doublons écartés, région en tête.
 *
 * Chaque tirage garde son code publié dans `setCodePublie` : c'est la clé
 * stable pour retrouver le tirage quand la région change après le choix.
 *
 * Les doublons se jugent APRÈS conversion : l'index porte 331 tirages à la
 * fois en « EN » et en « PT » (même carte, même numéro), qui ne font qu'un
 * tirage dans toute autre langue.
 */
export function tiragesPourRegion(printings, region) {
  const vus = new Set();
  const sortie = [];
  for (const tirage of printings ?? []) {
    const setCodePublie = tirage.setCodePublie ?? tirage.setCode;
    const setCode = codePourRegion(setCodePublie, region);
    const cle = `${setCode}|${tirage.rarity}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    sortie.push({ ...tirage, setCode, setCodePublie });
  }
  return trierParRegion(sortie, region);
}
