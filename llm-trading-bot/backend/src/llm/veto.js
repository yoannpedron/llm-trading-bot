/**
 * Veto de risque : le seul emploi du modèle de langage dont la valeur
 * économique soit chiffrée.
 *
 * ── Pourquoi ce poste et pas un autre ────────────────────────────────────
 * Demander à un LLM de prévoir des rendements ne rapporte rien : il reproduit
 * l'extrapolation des derniers jours, qu'une ligne de code calcule
 * gratuitement. Mesuré sur notre propre univers, son classement corrèle à
 * +0,89 avec le rendement 5 séances brut.
 *
 * En revanche, lire un texte et y repérer un problème est précisément ce
 * qu'aucune formule ne sait faire. Les mesures publiées sur ce cas d'usage
 * portent moins sur le taux de réussite — qui ne bouge presque pas, 51 % à
 * 54 % — que sur l'AMPLEUR des pertes : environ 36 % de moins en moyenne, et
 * 39 % à un horizon de trois jours. Le gain vient de la queue gauche, pas du
 * centre de la distribution.
 *
 * ── La propriété qui rend ce poste sûr ───────────────────────────────────
 * Un veto est ASYMÉTRIQUE par construction. Il ne peut que refuser un achat.
 * Il ne peut pas inverser le signal, ni désigner un actif, ni pousser à
 * l'action. Au pire il fait manquer une occasion ; il ne peut pas fabriquer
 * une perte que le classement n'avait pas déjà engagée.
 *
 * C'est la différence décisive avec le poste précédent : quand le modèle
 * classait, une erreur de sa part devenait une position. Ici, une erreur de sa
 * part devient une abstention.
 *
 * ── Le coût ──────────────────────────────────────────────────────────────
 * Seuls les finalistes sont soumis — une dizaine par cycle, pas cent
 * cinquante. Le budget d'appels cesse d'être une contrainte.
 */

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { anonymizeNews } from './anonymize.js';
import { pseudonymePour } from './pseudonyms.js';
import { sectorOf } from '../data/universe.js';

const log = createLogger('veto');

/**
 * Catégories de risque.
 *
 * Fermées, et pas par confort d'implémentation : un motif en texte libre
 * serait impossible à agréger, donc impossible à évaluer. Avec une
 * énumération, on pourra mesurer dans six mois quels motifs ont effectivement
 * évité des pertes et lesquels ne faisaient que coûter des occasions — et
 * retirer ceux qui ne servent à rien.
 *
 * Les catégories retenues sont celles dont la littérature documente une
 * asymétrie de rendement négative : rumeur et spéculation, tensions
 * géopolitiques, litiges. On y ajoute les événements dont le mécanisme est
 * évident même sans mesure : enquête réglementaire, fraude, avertissement sur
 * résultats, départ soudain d'un dirigeant.
 */
export const MOTIFS = [
  'AUCUN',
  'LITIGE',
  'ENQUETE_REGLEMENTAIRE',
  'FRAUDE_COMPTABLE',
  'AVERTISSEMENT_RESULTATS',
  'DEPART_DIRIGEANT',
  'RUMEUR_SPECULATION',
  'CHOC_SECTORIEL',
];

export const VETO_SCHEMA = {
  type: 'object',
  properties: {
    // Champ libre EN PREMIER : laisser le modèle formuler avant de trancher
    // évite qu'il paie la taxe de projection du décodage contraint, et rend sa
    // décision lisible quand elle sera relue.
    constat: {
      type: 'string',
      description:
        'Ce que disent réellement ces actualités, en deux phrases. Si elles sont banales, dis-le.',
    },
    verdict: {
      type: 'string',
      enum: ['PASSER', 'BLOQUER'],
      description:
        'BLOQUER uniquement si un risque CONCRET et DATÉ apparaît dans le texte. '
        + 'Une actualité neutre, ancienne ou purement descriptive donne PASSER.',
    },
    motif: { type: 'string', enum: MOTIFS },
    gravite: {
      type: 'string',
      enum: ['NULLE', 'FAIBLE', 'SERIEUSE'],
      description: 'SERIEUSE seulement si le risque peut faire chuter le titre de plus de 5 %.',
    },
  },
  required: ['constat', 'verdict', 'motif', 'gravite'],
};

export const VETO_SYSTEM_PROMPT = `Tu es un contrôleur des risques. Tu ne choisis aucune action.

Une décision d'achat a DÉJÀ été prise par un modèle quantitatif. Ton unique rôle est de dire
s'il existe, dans les actualités fournies, une raison concrète de ne PAS exécuter cet achat
aujourd'hui.

CE QUI JUSTIFIE UN BLOCAGE :
- litige, plainte, action collective en cours
- enquête d'un régulateur ou d'une autorité de marché
- soupçon de fraude ou d'irrégularité comptable
- avertissement sur les résultats, révision à la baisse annoncée
- départ soudain ou non planifié d'un dirigeant
- rumeur ou spéculation non confirmée servant de moteur au cours
- choc frappant tout le secteur et non cette seule entreprise

CE QUI NE JUSTIFIE PAS UN BLOCAGE :
- une actualité simplement négative en ton, sans fait précis
- une baisse de cours déjà passée : le modèle quantitatif l'a déjà vue
- une opinion d'analyste, une note abaissée, un objectif de cours modifié
- l'absence d'actualité : ne rien savoir n'est pas une mauvaise nouvelle
- une information ancienne, déjà largement diffusée

TU ES BIAISÉ VERS PASSER, ET C'EST VOULU.
Bloquer à tort coûte une occasion manquée. Bloquer trop souvent rend le contrôle inutile et
te fait remplacer par rien du tout. N'utilise BLOQUER que si tu peux citer le fait précis qui
le motive. Dans le doute, tu passes.

L'entreprise t'est présentée sous un nom qui ne te dira rien : c'est délibéré, pour que tu
juges l'événement rapporté et non la réputation de la société.`;

/**
 * Construit le prompt d'un candidat.
 */
export function buildVetoPrompt({ etiquette, secteur, articles, fenetreHeures }) {
  if (!articles?.length) {
    return `## CANDIDAT : ${etiquette}\nSecteur : ${secteur || 'non renseigné'}\n\n`
      + `## ACTUALITÉS (fenêtre ${fenetreHeures} h)\nAUCUNE actualité disponible.\n\n`
      + `## TA DÉCISION\nAucune information n'est un cas de PASSER : l'absence de nouvelle n'est pas `
      + `une mauvaise nouvelle, et le modèle quantitatif a ses propres raisons d'avoir retenu cet actif.`;
  }

  const lignes = articles.slice(0, 8).map((a, i) => {
    const quand = a.publishedAt
      ? new Date(a.publishedAt).toISOString().slice(0, 16).replace('T', ' ')
      : 'date inconnue';
    const resume = a.summary ? ` — ${a.summary.slice(0, 300)}` : '';
    return `${i + 1}. [${quand}] (${a.source}) ${a.title}${resume}`;
  });

  return `## CANDIDAT : ${etiquette}
Secteur : ${secteur || 'non renseigné'}

## ACTUALITÉS (fenêtre ${fenetreHeures} h, entités remplacées)
${lignes.join('\n')}

## TA DÉCISION
Existe-t-il là-dedans un fait concret et daté qui rende cet achat imprudent aujourd'hui ?
Si oui : BLOQUER, en nommant le motif. Sinon : PASSER.`;
}

/**
 * Interroge le modèle sur un candidat.
 *
 * @param {object} deps  { provider } — injecté pour que le test n'appelle pas le réseau
 */
export async function verifierCandidat(symbol, news, { provider, sel = '' } = {}) {
  const etiquette = pseudonymePour(symbol, sel);
  const secteur = sectorOf(symbol);

  const anonymise = config.news.anonymize
    ? anonymizeNews(news, symbol)
    : { articles: news?.articles ?? [] };

  const prompt = buildVetoPrompt({
    etiquette,
    secteur,
    articles: anonymise.articles,
    fenetreHeures: config.news.lookbackHours,
  });

  const brut = await provider.decide(prompt, {
    schema: VETO_SCHEMA,
    systemPrompt: VETO_SYSTEM_PROMPT,
  });

  const parsed = typeof brut.raw === 'string' ? JSON.parse(brut.raw) : brut.raw;
  return normaliserVerdict(parsed, symbol);
}

/**
 * Normalise et valide la réponse.
 *
 * Une réponse incohérente — « BLOQUER » avec le motif « AUCUN » — n'est pas
 * corrigée en silence. On la ramène à PASSER et on la signale : un veto qu'on
 * ne comprend pas est un veto qu'on ne peut pas évaluer, et le laisser bloquer
 * reviendrait à accepter des refus sans motif.
 */
export function normaliserVerdict(reponse, symbol = null) {
  const verdict = reponse?.verdict === 'BLOQUER' ? 'BLOQUER' : 'PASSER';
  const motif = MOTIFS.includes(reponse?.motif) ? reponse.motif : 'AUCUN';
  const gravite = ['NULLE', 'FAIBLE', 'SERIEUSE'].includes(reponse?.gravite) ? reponse.gravite : 'NULLE';

  if (verdict === 'BLOQUER' && motif === 'AUCUN') {
    log.warn(`${symbol ?? 'candidat'} : blocage sans motif — ramené à PASSER.`);
    return { bloque: false, verdict: 'PASSER', motif: 'AUCUN', gravite, constat: reponse?.constat ?? null, incoherent: true };
  }

  // Un risque jugé de gravité nulle ne justifie pas de renoncer à une position
  // que le classement a désignée. Le modèle a la main pour bloquer, pas pour
  // bloquer sur un détail qu'il qualifie lui-même d'anodin.
  if (verdict === 'BLOQUER' && gravite === 'NULLE') {
    return { bloque: false, verdict: 'PASSER', motif, gravite, constat: reponse?.constat ?? null, ignore: 'gravité nulle' };
  }

  return {
    bloque: verdict === 'BLOQUER',
    verdict,
    motif,
    gravite,
    constat: reponse?.constat ?? null,
  };
}

/**
 * Passe les finalistes au contrôle.
 *
 * ── En cas de panne : on BLOQUE ──────────────────────────────────────────
 * Ne pas avoir pu vérifier n'est pas la même chose qu'avoir vérifié sans rien
 * trouver. Avec une détention de 21 séances, renoncer à une entrée pour un
 * cycle ne coûte presque rien — le classement de demain sera quasi identique.
 * Acheter sans contrôle coûte, rarement, beaucoup.
 *
 * @returns {{autorises: Set<string>, refuses: Map<string, object>}}
 */
export async function filtrerParVeto(candidats, { provider, newsPour, sel = '' } = {}) {
  const autorises = new Set();
  const refuses = new Map();

  for (const symbol of candidats) {
    try {
      const news = await newsPour(symbol);
      const r = await verifierCandidat(symbol, news, { provider, sel });
      if (r.bloque) {
        refuses.set(symbol, r);
        log.warn(`VETO ${symbol} : ${r.motif} (${r.gravite}) — ${(r.constat ?? '').slice(0, 140)}`);
      } else {
        autorises.add(symbol);
      }
    } catch (err) {
      refuses.set(symbol, {
        bloque: true,
        verdict: 'BLOQUER',
        motif: 'AUCUN',
        gravite: 'NULLE',
        erreur: err.message,
        constat: `contrôle impossible : ${err.message}`,
      });
      log.error(`Contrôle impossible sur ${symbol} (${err.message}) — achat suspendu par précaution.`);
    }
  }

  if (refuses.size) {
    log.info(`Veto : ${autorises.size} autorisé(s), ${refuses.size} refusé(s) sur ${candidats.length} candidat(s).`);
  }

  return { autorises, refuses };
}
