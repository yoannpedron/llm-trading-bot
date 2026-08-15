/**
 * Élicitation par CLASSEMENT plutôt que par notation.
 *
 * ── Le défaut qu'on élimine ───────────────────────────────────────────────
 * L'ancien protocole demandait au modèle de noter chaque actif ISOLÉMENT, sur
 * 100, puis triait les notes côté code. Deux défauts irréductibles :
 *
 *   • le modèle ne comparait jamais rien. Il devait produire un nombre absolu
 *     sur une échelle qu'il ne voyait jamais s'appliquer ailleurs ;
 *   • ce nombre s'agglutinait sur des valeurs rondes — trois valeurs distinctes
 *     mesurées sur vingt réponses. Le tri qui suivait départageait du bruit.
 *
 * Demander un ORDRE supprime les deux d'un coup. Le modèle voit dix actifs
 * ensemble et les compare, ce qui est la tâche pour laquelle un mécanisme
 * d'attention est fait. Et il ne produit aucun nombre : il n'y a plus rien à
 * arrondir. La granularité ne dépend plus de sa capacité à écrire « 37 » plutôt
 * que « 35 ».
 *
 * ── L'ordre des champs, encore ────────────────────────────────────────────
 * Le champ d'analyse libre vient AVANT le classement, et ce n'est pas
 * cosmétique. Contraindre un modèle à produire directement une structure
 * rigide lui fait payer ce que la littérature appelle la taxe de projection :
 * le décodeur écarte les jetons qui violeraient le schéma et amplifie des
 * trajectoires que le modèle n'aurait pas choisies. Lui laisser d'abord un
 * espace de texte libre ancre le contexte dans la bonne région avant que la
 * contrainte ne s'applique — la structure est alors celle qu'il aurait produite
 * spontanément.
 *
 * ── Ce qui est délibérément ABSENT ────────────────────────────────────────
 * Aucune probabilité, aucune note, aucune confiance chiffrée. La magnitude est
 * reconstruite en aval par l'ajustement de Plackett-Luce, qui infère une force
 * latente continue à partir des ordres observés. Redemander un nombre au modèle
 * réintroduirait exactement le défaut qu'on vient de supprimer.
 */

import { config } from '../config.js';

/**
 * Schéma de sortie.
 *
 * `classement` est contraint par énumération aux étiquettes réellement
 * présentes dans le lot : le modèle ne peut pas inventer un nom, et une réponse
 * incomplète est détectable sans ambiguïté.
 */
export function buildListwiseSchema(etiquettes) {
  return {
    type: 'object',
    properties: {
      analyse: {
        type: 'string',
        description:
          'Avant de classer : en trois à cinq phrases, quels éléments séparent réellement '
          + 'ces actifs les uns des autres ? Cite les entreprises par leur nom. Si rien ne '
          + 'les distingue nettement, dis-le.',
      },
      classement: {
        type: 'array',
        items: { type: 'string', enum: etiquettes },
        description:
          'Les entreprises, de celle qui a le plus de chances de battre l\'indice à celle qui '
          + 'en a le moins. Chacune apparaît une fois et une seule.',
      },
      separation: {
        type: 'string',
        enum: ['NETTE', 'PARTIELLE', 'AUCUNE'],
        description:
          'NETTE si l\'ordre repose sur des différences franches ; PARTIELLE si seuls les '
          + 'extrêmes se détachent ; AUCUNE si tu as dû trancher arbitrairement.',
      },
    },
    required: ['analyse', 'classement', 'separation'],
  };
}

export const LISTWISE_SYSTEM_PROMPT = `Tu es un moteur de comparaison transversale d'actifs.

TA TÂCHE EST DE CLASSER, PAS DE NOTER.
On te présente un groupe d'entreprises. Tu dois les ordonner de la plus susceptible de
SURPERFORMER un indice large du marché actions américain sur les 3 prochaines séances, à la
moins susceptible. Tu ne produis aucune note, aucun pourcentage, aucune probabilité.

CE QUI COMPTE EST L'ÉCART ENTRE ELLES, PAS LEUR NIVEAU ABSOLU.
La question n'est jamais « cette entreprise va-t-elle monter ? » mais « laquelle de ces deux
fera mieux que l'autre par rapport à l'indice ? ». Une entreprise qui perd 2 % quand l'indice
perd 4 % a SURPERFORMÉ.

LES ENTREPRISES TE SONT INCONNUES, C'EST VOULU.
Les noms qui te sont donnés sont réels pour cet exercice mais tu n'en as aucun souvenir : ne
cherche pas à les rapprocher de sociétés que tu croirais reconnaître. Le secteur et la taille
te sont fournis explicitement — ce sont les seuls éléments de contexte dont tu disposes, et ils
suffisent à interpréter correctement un événement.

MÉTHODE IMPOSÉE :
1. Écris d'abord ton analyse : qu'est-ce qui sépare réellement ces entreprises ?
2. Produis ensuite l'ordre complet.
3. Déclare enfin si la séparation était nette, partielle, ou inexistante.

SUR TROIS SÉANCES, L'ESSENTIEL EST DU BRUIT.
La plupart de ces entreprises suivront l'indice de près. Il t'est demandé un ordre complet, tu
dois donc trancher même quand c'est serré — mais dis-le dans "separation". Déclarer AUCUNE
quand rien ne distingue les actifs est une réponse juste et utile, pas un échec.

N'ESSAIE NI D'ÊTRE PRUDENT NI D'ÊTRE AUDACIEUX.
Aucun ordre n'est passé à partir de ta réponse seule. Ton classement est recoupé avec d'autres
et confronté aux rendements réellement observés. La seule chose qui compte est d'avoir raison
sur l'ordre.`;

const fmt = (v, suffixe = '', decimales = 1) =>
  (v == null || Number.isNaN(v) ? 'n/d' : `${Number(v).toFixed(decimales)}${suffixe}`);

/**
 * Bloc descriptif d'un actif.
 *
 * Volontairement compact : dix actifs par appel, et une fenêtre d'attention
 * saturée dégrade le milieu de liste. On garde les trois indicateurs
 * orthogonaux — momentum, tendance, volatilité — plus le niveau dans la
 * fourchette et le rendement récent, chacun accompagné de son point de
 * comparaison et jamais de son interprétation.
 */
function blocActif({ etiquette, secteur, taille, indicateurs, contexte, rendement5j, actualites }) {
  const lignes = [
    `── ${etiquette} ──`,
    `Secteur : ${secteur || 'non renseigné'} | Taille : ${taille || 'non renseignée'}`,
    `Momentum : RSI(14) ${fmt(indicateurs.rsi14)} (seuils conventionnels 30 / 70)`
      + (rendement5j != null ? ` | 5 dernières séances : ${rendement5j >= 0 ? '+' : ''}${(rendement5j * 100).toFixed(2)} %` : ''),
    `Tendance : ${indicateurs.trend || 'n/d'}${contexte?.trend ? ` (${contexte.trend})` : ''}`,
    `Volatilité : ATR ${fmt(indicateurs.atrPct, ' %')} du prix${contexte?.atr ? ` — ${contexte.atr}` : ''}`,
  ];

  if (contexte?.range) lignes.push(`Niveau : ${contexte.range}`);

  if (actualites?.length) {
    lignes.push('Actualités récentes :');
    for (const a of actualites.slice(0, 2)) {
      const quand = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : 'date inconnue';
      lignes.push(`  · [${quand}] ${a.title}`);
    }
  } else {
    lignes.push('Actualités récentes : aucune disponible.');
  }

  return lignes.join('\n');
}

/**
 * Construit le prompt d'un lot.
 *
 * @param {Array} actifs  déjà pseudonymisés et dans l'ordre de présentation voulu
 */
export function buildListwisePrompt(actifs, { horizonSeances = 3 } = {}) {
  const etiquettes = actifs.map((a) => a.etiquette);

  return `## GROUPE À CLASSER — ${actifs.length} entreprises

${actifs.map(blocActif).join('\n\n')}

## CE QUE TU DOIS PRODUIRE
Ordonne ces ${actifs.length} entreprises de la plus susceptible de battre l'indice large sur les
${horizonSeances} prochaines séances à la moins susceptible.

L'indice de référence est un panier large du marché actions américain. Tu ne prévois pas la
hausse ou la baisse du marché : uniquement l'ÉCART de chaque entreprise avec cet indice.

Les ${actifs.length} noms doivent apparaître dans ton classement, chacun exactement une fois :
${etiquettes.join(', ')}.

Actualités issues d'une fenêtre de ${config.news.lookbackHours} h.`;
}

/**
 * Valide la réponse et la ramène à un ordre exploitable.
 *
 * ── Pourquoi valider aussi durement ───────────────────────────────────────
 * Un classement amputé ou comportant un doublon n'est pas « un peu faux » : il
 * fausse la vraisemblance de Plackett-Luce, qui suppose une permutation. Un
 * actif dupliqué serait compté deux fois comme choisi, un actif absent
 * disparaîtrait des dénominateurs. Mieux vaut rejeter le lot que corriger en
 * douce une réponse qu'on n'a pas comprise.
 *
 * Le seul rattrapage admis est la TRONCATURE : si le modèle a classé les huit
 * premiers sur dix et s'est arrêté, les huit sont exploitables — un classement
 * partiel est précisément ce que Plackett-Luce sait ingérer. On ne complète
 * jamais par nous-mêmes.
 */
export function validerClassement(reponse, etiquettesAttendues) {
  const attendues = new Set(etiquettesAttendues);
  const ordre = Array.isArray(reponse?.classement) ? reponse.classement : null;

  if (!ordre?.length) {
    return { ok: false, raison: 'aucun classement dans la réponse', ordre: [] };
  }

  const vus = new Set();
  const propre = [];
  const inconnues = [];

  for (const nom of ordre) {
    if (!attendues.has(nom)) { inconnues.push(nom); continue; }
    if (vus.has(nom)) continue;   // doublon : on garde la première position
    vus.add(nom);
    propre.push(nom);
  }

  if (propre.length < 2) {
    return { ok: false, raison: `classement inexploitable (${propre.length} entrée valide)`, ordre: propre };
  }

  const manquantes = etiquettesAttendues.filter((e) => !vus.has(e));

  return {
    ok: true,
    ordre: propre,
    partiel: manquantes.length > 0,
    manquantes,
    inconnues,
    doublons: ordre.length - new Set(ordre).size,
    separation: reponse?.separation ?? null,
    analyse: reponse?.analyse ?? null,
  };
}
