/**
 * Adaptation d'un résultat de scan en fiche affichable, puis en entrée
 * d'inventaire.
 *
 * Pourquoi ce module existe. `App.jsx` construisait lui-même l'objet carte
 * destiné à la collection : quinze lignes de valeurs par défaut, deux URL
 * d'images écrites à la main, et le même travail répété pour l'affichage. Un
 * composant racine n'a pas à connaître la forme d'une entrée d'inventaire ni
 * l'adresse des visuels d'un tiers ; son rôle est d'aiguiller.
 *
 * Les deux fonctions ci-dessous forment la frontière entre le domaine et la
 * présentation. En amont : ce que rend la résolution (`scanApi`) et la fiche
 * détaillée (YGOPRODeck, en français). En aval : des champs prêts à poser dans
 * une mise en page, et un couple carte/tirage prêt pour `collection.track`.
 *
 * Elles sont pures et testées : aucun React, aucun DOM.
 */

import { imageComplete, imagePetite, imagesDe } from './images.js';

/**
 * Champs d'une carte identifiée, prêts pour l'affichage.
 *
 * La fiche détaillée arrive après coup — la carte s'affiche sans l'attendre.
 * Chaque champ retombe donc sur ce que le scan connaît déjà, et vaut `null`
 * quand personne ne le sait : c'est à la mise en page de décider comment
 * montrer une absence, pas à ce module d'inventer une valeur.
 *
 * @param {object|null} scan résultat de `scanCode`
 * @param {object|null} detail fiche YGOPRODeck traduite, ou `null`
 */
export function ficheDepuisScan(scan, detail = null) {
  if (!scan?.card) return null;

  const carte = scan.card;
  const approchee = scan.method === 'fuzzy';

  return {
    identifiant: carte.id,

    /* --- identité --------------------------------------------------- */
    // Le code tel qu'il est imprimé sur l'exemplaire en main, et non la forme
    // anglaise publiée : l'utilisateur doit reconnaître sa carte.
    code: scan.matchedCode ?? null,
    codePublie: scan.sourceCode ?? null,
    regionale: Boolean(scan.regional),
    nom: detail?.name ?? carte.name ?? null,
    sousTitre: detail?.subtitle ?? null,

    /* --- fiabilité de la lecture ------------------------------------ */
    // Une correspondance approchée a corrigé la lecture : c'est le visuel qui
    // confirme, pas le code. L'interface doit le dire au lieu d'afficher la
    // même assurance qu'une lecture exacte.
    approchee,
    lectureBrute: approchee ? (scan.read ?? null) : null,
    confiance: typeof scan.confidence === 'number' ? scan.confidence : null,
    methode: scan.method ?? null,
    // Identifiée par son illustration : le visuel est la preuve, et le code
    // d'extension n'a pas été lu — c'est le tirage qui reste à désigner.
    parIllustration: scan.method === 'art',
    saisieManuelle: typeof scan.source === 'string' && scan.source.endsWith(':manual'),

    /* --- caractéristiques -------------------------------------------- */
    texte: detail?.desc ?? null,
    type: detail?.type ?? null,
    categorie: detail?.race ?? null,
    attribut: detail?.attribute ?? null,
    atk: detail?.atk ?? null,
    def: detail?.def ?? null,
    niveau: detail?.level ?? null,
    lien: detail?.linkval ?? null,

    /* --- visuels ------------------------------------------------------ */
    image: detail?.image ?? imageComplete(carte.id),
    imagePetite: detail?.image_small ?? imagePetite(carte.id),

    /* --- tirages ------------------------------------------------------ */
    raretes: scan.rarities ?? [],
    choixRequis: scan.status === 'needs_user_selection',
  };
}

/**
 * Cote à afficher avant l'enregistrement, et d'où elle vient.
 *
 * Deux sources, qui n'ont pas la même valeur probante, et l'interface doit le
 * dire : le tirage retenu porte parfois un prix relevé pour CETTE rareté (le
 * backend le fournit) ; sinon on ne dispose que de la moyenne YGOPRODeck,
 * toutes raretés confondues, qui ne vaut que comme ordre de grandeur. Un
 * chiffre sans provenance n'est pas une donnée.
 *
 * La cote définitive, filtrée par état, est relevée à l'enregistrement par
 * `useCollection` : c'est elle qui fait foi dans l'inventaire.
 *
 * @returns {{montant: number|null, source: string, indicative: boolean}}
 */
export function coteAffichable(fiche, rarete, detail) {
  if (typeof rarete?.priceEur === 'number') {
    return {
      montant: rarete.priceEur,
      source: `Cardmarket · ${rarete.rarity}`,
      indicative: false,
    };
  }

  const moyenne = detail?.prices?.cardmarket_eur ?? null;
  if (typeof moyenne === 'number') {
    return {
      montant: moyenne,
      source: 'Moyenne YGOPRODeck, toutes raretés',
      indicative: true,
    };
  }

  return {
    montant: null,
    source: fiche?.choixRequis
      ? 'Choisissez la rareté pour situer la cote'
      : 'Relevée à l’enregistrement',
    indicative: true,
  };
}

/**
 * Couple carte/tirage attendu par `collection.track`.
 *
 * Le tirage retenu vient du choix de l'utilisateur quand plusieurs raretés
 * partagent le code : la caméra ne voit pas l'holographie, et c'est la rareté
 * qui décide du prix. Sans rareté retenue, on ne enregistre rien — enregistrer
 * une carte sans savoir laquelle des sept versions on tient fausserait
 * l'inventaire dès la première ligne.
 *
 * @returns {{carte: object, tirage: object}|null}
 */
export function entreeDepuisScan(scan, detail, rarete) {
  const fiche = ficheDepuisScan(scan, detail);
  if (!fiche || !rarete) return null;

  return {
    carte: {
      id: fiche.identifiant,
      name: fiche.nom,
      image: fiche.image,
      images: [imagesDe(fiche.identifiant)],
      type: fiche.type ?? '',
      race: fiche.categorie ?? '',
      attribute: fiche.attribut ?? '',
      atk: fiche.atk,
      def: fiche.def,
      level: fiche.niveau,
    },
    tirage: {
      // Le code lu s'il y en a un ; sinon celui du tirage choisi (identification
      // par l'illustration, où le code n'est pas lu).
      setCode: fiche.code ?? rarete.setCode ?? null,
      setName: rarete.setName,
      rarity: rarete.rarity,
      rarityCode: rarete.rarityCode,
    },
  };
}

/**
 * Caractéristiques à présenter en lignes « intitulé / valeur ».
 *
 * L'ordre est celui qu'on lit sur la carte physique, de haut en bas. Les champs
 * absents sont écartés ici plutôt que dans la mise en page : une fiche de
 * catalogue ne montre pas de lignes vides.
 */
export function caracteristiques(fiche) {
  if (!fiche) return [];

  const lignes = [
    ['Type', fiche.type],
    ['Catégorie', fiche.categorie],
    ['Attribut', fiche.attribut],
    ['Niveau', fiche.niveau],
    ['Liens', fiche.lien],
    ['ATK', fiche.atk],
    ['DEF', fiche.def],
  ];

  return lignes
    .filter(([, valeur]) => valeur !== null && valeur !== undefined && valeur !== '')
    .map(([intitule, valeur]) => ({ intitule, valeur: String(valeur) }));
}
