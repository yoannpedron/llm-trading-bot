/**
 * Réglages de l'application.
 *
 * Le schéma ci-dessous est la seule source : il décrit les champs, alimente les
 * valeurs par défaut et sert directement à dessiner le panneau. Ajouter une
 * option se fait ici, en un endroit, et elle apparaît à l'écran.
 */

import { CONDITIONS, DEFAULT_CONDITION } from './condition.js';

export const STORAGE_KEY = 'ygo-scanner:settings:v1';

/**
 * Sensibilité de la détection : elle décide de la patience exigée avant qu'un
 * scan parte. « Rapide » réagit au quart de tour mais tente aussi sur des
 * images encore un peu floues ; « patient » attend une image franchement nette.
 */
export const SENSITIVITY = {
  patient: { label: 'Patiente', motionThreshold: 0.04, stableMs: 340, sameCardThreshold: 0.03 },
  normale: { label: 'Normale', motionThreshold: 0.055, stableMs: 220, sameCardThreshold: 0.035 },
  rapide: { label: 'Rapide', motionThreshold: 0.08, stableMs: 120, sameCardThreshold: 0.045 },
};

export const SCHEMA = [
  {
    section: 'Scan',
    items: [
      {
        key: 'autoScan',
        type: 'toggle',
        label: 'Scan continu',
        hint: 'Lit dès qu’une carte se stabilise, sans bouton. Désactivé, un bouton déclenche la lecture.',
        default: true,
      },
      {
        key: 'sensitivity',
        type: 'choice',
        label: 'Sensibilité',
        hint: 'Durée d’immobilité exigée avant de lancer une lecture.',
        options: Object.entries(SENSITIVITY).map(([value, preset]) => ({
          value,
          label: preset.label,
        })),
        default: 'normale',
      },
      {
        key: 'diagnostics',
        type: 'toggle',
        label: 'Afficher la lecture OCR',
        hint: 'Le texte brut reconnu et l’image binarisée envoyée au moteur.',
        default: true,
      },
    ],
  },
  {
    section: 'Cartes',
    items: [
      {
        key: 'askCondition',
        type: 'toggle',
        label: 'Demander l’état à chaque carte',
        hint: 'Aucune API ne donne de prix par état : la cote est filtrée sur Cardmarket quand c’est possible, estimée sinon.',
        default: true,
      },
      {
        key: 'defaultCondition',
        type: 'choice',
        label: 'État par défaut',
        hint: 'Appliqué automatiquement quand la question est désactivée.',
        options: CONDITIONS.map((entry) => ({
          value: entry.code,
          label: `${entry.code} — ${entry.label}`,
        })),
        default: DEFAULT_CONDITION,
      },
    ],
  },
  {
    section: 'Apparence',
    items: [
      {
        key: 'animations',
        type: 'toggle',
        label: 'Animations',
        hint: 'Révélation 3D, balayages, étincelles. À couper sur un appareil qui peine.',
        default: true,
      },
      {
        key: 'holo',
        type: 'toggle',
        label: 'Voile holographique',
        hint: 'Reflet arc-en-ciel dont l’intensité suit la rareté.',
        default: true,
      },
      {
        key: 'aurora',
        type: 'toggle',
        label: 'Fond animé',
        hint: 'Les nappes de couleur derrière l’interface.',
        default: true,
      },
    ],
  },
  {
    section: 'Retour',
    items: [
      {
        key: 'sound',
        type: 'toggle',
        label: 'Bip à l’identification',
        hint: 'Un son court quand une carte est reconnue.',
        default: false,
      },
      {
        key: 'haptics',
        type: 'toggle',
        label: 'Vibration',
        hint: 'Sur les appareils qui la prennent en charge.',
        default: true,
      },
    ],
  },
  {
    section: 'Données',
    items: [
      {
        key: 'keepHistory',
        type: 'toggle',
        label: 'Conserver l’historique',
        hint: 'Les cartes scannées restent dans ce navigateur. Rien n’est envoyé ailleurs.',
        default: true,
      },
      {
        key: 'refreshOnLoad',
        type: 'toggle',
        label: 'Actualiser les cotes à l’ouverture',
        hint: 'Relève à nouveau toutes les cotes de l’historique au chargement du site.',
        default: true,
      },
    ],
  },
];

/** Valeurs par défaut, dérivées du schéma pour ne pas les écrire deux fois. */
export const DEFAULTS = Object.fromEntries(
  SCHEMA.flatMap((group) => group.items.map((item) => [item.key, item.default])),
);

/**
 * Fusionne des réglages stockés avec les valeurs par défaut.
 *
 * Une version antérieure a pu enregistrer des clés disparues, ou en manquer de
 * nouvelles : on ne garde que ce que le schéma connaît, et on refuse une valeur
 * qui ne fait pas partie des choix proposés.
 */
export function mergeSettings(stored) {
  const result = { ...DEFAULTS };
  if (!stored || typeof stored !== 'object') return result;

  for (const group of SCHEMA) {
    for (const item of group.items) {
      const value = stored[item.key];
      if (value === undefined) continue;

      if (item.type === 'toggle' && typeof value === 'boolean') result[item.key] = value;
      if (item.type === 'choice' && item.options.some((option) => option.value === value)) {
        result[item.key] = value;
      }
    }
  }

  return result;
}

export function loadSettings() {
  try {
    return mergeSettings(JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** Préréglage de sensibilité correspondant aux réglages courants. */
export const sensitivityOf = (settings) =>
  SENSITIVITY[settings.sensitivity] ?? SENSITIVITY.normale;
