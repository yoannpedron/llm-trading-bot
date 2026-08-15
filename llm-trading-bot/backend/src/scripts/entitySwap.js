/**
 * Test contrefactuel par échange d'entité.
 *
 * ── La question ───────────────────────────────────────────────────────────
 * Quand le modèle annonce « 70 % de chances de surperformance », réagit-il aux
 * FAITS qu'on lui a donnés, ou au NOM de l'entreprise ?
 *
 * C'est une question sur laquelle aucune quantité de données de production ne
 * peut trancher, parce qu'en production les faits et le nom varient ensemble.
 * Il faut une expérience : tenir tout constant sauf le nom.
 *
 * ── Le protocole ──────────────────────────────────────────────────────────
 * On construit un contexte NUMÉRIQUEMENT IDENTIQUE — même prix, même RSI, même
 * ATR, mêmes dix bougies, mêmes titres d'actualité mot pour mot — et on ne fait
 * varier qu'une chose : l'entreprise à laquelle ces faits sont attribués.
 *
 * Quatre bras, choisis pour leurs a priori opposés dans le corpus
 * d'entraînement :
 *
 *   • NVIDIA  — le nom le plus associé à la hausse sur la période récente ;
 *   • Intel   — le nom le plus associé au déclin sur la même période ;
 *   • Tesla   — polarisant, à forte variance d'opinion ;
 *   • témoin  — [ENTREPRISE_A], ce que la production envoie réellement.
 *
 * Chaque bras est répété k fois, ce qui permet de séparer deux sources de
 * variation qu'une exécution unique confondrait :
 *
 *   • INTRA-BRAS  — la stochasticité du modèle à contexte identique ;
 *   • INTER-BRAS  — l'effet du nom.
 *
 * Le rapport des deux est un F. S'il est proche de 1, le nom n'apporte rien et
 * le modèle raisonne sur les faits. S'il est grand, le modèle récite sa mémoire
 * et le bot mesurerait la réputation des entreprises plutôt que l'information
 * du jour.
 *
 * ── Ce que le résultat décide ─────────────────────────────────────────────
 * L'anonymisation est déjà active en production. Ce test dit si elle est
 * NÉCESSAIRE (bras nommés divergents) et si elle est SUFFISANTE (le témoin doit
 * se comporter comme un bras dont on aurait retiré l'information de nom, pas
 * comme un régime à part). Un témoin qui s'effondre sur des valeurs rondes —
 * le « jeton refuge » observé en production — signalerait que retirer le nom
 * retire aussi la capacité de juger, ce qui est un coût, pas un gain.
 *
 * ── Coût ──────────────────────────────────────────────────────────────────
 * 4 bras × k appels. À k = 5, vingt appels — un tiers du quota quotidien d'une
 * clé Gemini gratuite. Le script refuse de démarrer s'il n'y a pas de quoi
 * finir, pour ne pas laisser une expérience à moitié faite.
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { keyPool } from '../llm/keyPool.js';
import { geminiProvider } from '../llm/providers/gemini.js';
import { normalizeDecision, extractJson } from '../llm/agent.js';

const log = createLogger('entity-swap');

/**
 * Contexte factuel commun à tous les bras.
 *
 * Volontairement AMBIGU : RSI à 52, tendance plate, ATR moyen, actualités
 * mitigées. Sur un cas tranché — RSI à 18 après un effondrement — tous les bras
 * répondraient la même chose et le test ne mesurerait rien. C'est dans la zone
 * d'incertitude que l'a priori sur le nom a la place de s'exprimer.
 */
const FAITS = {
  price: 100.0,
  rsi14: 52.3,
  ema20: 99.4,
  ema50: 99.1,
  atrPct: 2.4,
  trend: 'plate',
  candles: [
    '2026-07-31 | O 98.20 | H 99.80 | L 97.90 | C 99.10',
    '2026-08-03 | O 99.15 | H 100.40 | L 98.75 | C 100.05',
    '2026-08-04 | O 100.10 | H 101.20 | L 99.30 | C 99.60',
    '2026-08-05 | O 99.55 | H 100.90 | L 99.10 | C 100.70',
    '2026-08-06 | O 100.75 | H 101.60 | L 99.95 | C 100.20',
    '2026-08-07 | O 100.25 | H 100.85 | L 98.60 | C 98.90',
    '2026-08-10 | O 98.95 | H 100.30 | L 98.40 | C 100.10',
    '2026-08-11 | O 100.05 | H 101.40 | L 99.70 | C 101.05',
    '2026-08-12 | O 101.00 | H 101.70 | L 99.20 | C 99.85',
    '2026-08-13 | O 99.90 | H 100.60 | L 99.05 | C 100.00',
  ],
  news: [
    '{E} publie un chiffre d\'affaires trimestriel en hausse de 4 % sur un an, légèrement au-dessus du consensus.',
    'Un analyste de Morgan Stanley relève son objectif de cours sur {E} tout en maintenant une recommandation neutre.',
    '{E} annonce le report de trois mois d\'un produit attendu, invoquant des contraintes d\'approvisionnement.',
    'Le régulateur européen ouvre une consultation sur les pratiques commerciales du secteur où opère {E}.',
  ],
};

/** Les bras. `label` sert à l'affichage, `entity` remplace {E}. */
const BRAS = [
  { label: 'NVIDIA', entity: 'NVIDIA' },
  { label: 'Intel', entity: 'Intel' },
  { label: 'Tesla', entity: 'Tesla' },
  { label: 'témoin anonymisé', entity: '[ENTREPRISE_A]', control: true },
];

function promptPour(entity) {
  const news = FAITS.news.map((n, i) => `[${i + 1}] ${n.replaceAll('{E}', entity)}`).join('\n');
  return `## ACTIF ANALYSÉ : ${entity}
Prix courant : ${FAITS.price} USD
Unité de temps : bougies journalières | Horizon de détention visé : 1 à 7 séances

## TROIS INDICATEURS (momentum / tendance / volatilité)
Momentum   — RSI(14) : ${FAITS.rsi14} | seuils conventionnels : 30 survente, 70 surachat
Tendance   — ${FAITS.trend} | EMA20 ${FAITS.ema20} vs EMA50 ${FAITS.ema50}
Volatilité — ATR(14) : ${FAITS.atrPct} % du prix

## 10 DERNIÈRES SÉANCES
${FAITS.candles.join('\n')}

## ACTUALITÉS (fenêtre 24 h)
${news}

## PORTEFEUILLE
Équity 100.00 USD | Liquidités 100.00 USD | Positions 0/3

## CONTRAINTES NON NÉGOCIABLES
Budget maximal mobilisable : 35.00 USD
Achat autorisé.
Vente impossible : aucune position (découvert interdit).
Stop qui sera posé : 9.6 % sous le prix d'entrée.

## CE QUE TU DOIS PRÉVOIR
L'indice de référence est un panier large du marché actions américain. Ta prévision porte sur
l'écart entre cet actif et cet indice, sur les 3 prochaines séances — pas sur la hausse ou la
baisse du marché lui-même. Un actif qui perd 2 % quand l'indice perd 4 % SURPERFORME.

## TA TÂCHE
Remplis le schéma JSON dans l'ordre : evidence, checks, pre_mortem, forecast, risk_math, action.
Les trois nombres de "forecast" doivent totaliser exactement 100.`;
}

async function main() {
  const k = Number(process.env.REPS ?? 5);
  const besoin = BRAS.length * k;

  const capacite = await keyPool.capacity();
  const restant = capacite.totalPerDay - capacite.used;
  if (restant < besoin) {
    log.error(
      `Il faut ${besoin} appels (${BRAS.length} bras × ${k} répétitions) et il en reste ${restant}. `
      + 'Une expérience interrompue à mi-parcours ne se compare pas : baisse REPS ou attends le reset.',
    );
    process.exit(1);
  }

  log.info(`Test contrefactuel : ${BRAS.length} bras × ${k} répétitions = ${besoin} appels.`);

  const resultats = [];

  for (const bras of BRAS) {
    const prompt = promptPour(bras.entity);
    const obs = [];

    for (let i = 0; i < k; i += 1) {
      const cle = await keyPool.acquire();
      if (!cle) {
        log.error('Quota épuisé en cours d\'expérience — résultats partiels, non comparables.');
        process.exit(1);
      }
      try {
        const rep = await geminiProvider.decide(prompt);
        const d = normalizeDecision(extractJson(rep.raw), null, { degraded: false });
        if (d.forecast) {
          obs.push({ pUp: d.forecast.pUp, edge: d.forecast.edge, action: d.action });
          log.info(`${bras.label} #${i + 1} : pUp ${(d.forecast.pUp * 100).toFixed(0)} — écart ${(d.forecast.edge * 100).toFixed(0)} pts — ${d.action}`);
        } else {
          log.warn(`${bras.label} #${i + 1} : pas de prévision exploitable.`);
        }
      } catch (err) {
        log.error(`${bras.label} #${i + 1} en échec : ${err.message}`);
      }

      // Le palier gratuit plafonne à 15 requêtes/minute. Vingt appels d'affilée
      // les déclencheraient, et un 429 ici ne coûterait pas qu'un appel : il
      // laisserait un bras avec moins d'observations que les autres, ce qui
      // fausse la comparaison des variances que tout le protocole vise.
      if (config.llm.cooldownMs > 0) {
        await new Promise((r) => { setTimeout(r, config.llm.cooldownMs); });
      }
    }

    resultats.push({ ...bras, obs });
  }

  rapport(resultats, k);
}

/**
 * Décomposition de la variance : intra-bras contre inter-bras.
 *
 * C'est une analyse de variance à un facteur. Le facteur est le nom de
 * l'entreprise, la réponse est la probabilité de surperformance annoncée.
 */
function rapport(resultats, k) {
  const utiles = resultats.filter((r) => r.obs.length >= 2);
  if (utiles.length < 2) {
    log.error('Moins de deux bras exploitables — rien à comparer.');
    return;
  }

  const lignes = utiles.map((r) => {
    const ps = r.obs.map((o) => o.pUp);
    const m = moyenne(ps);
    return { label: r.label, control: r.control, n: ps.length, moyenne: m, ecartType: ecartType(ps, m) };
  });

  console.log('\n── Probabilité de surperformance annoncée, par bras ──────────────');
  for (const l of lignes) {
    console.log(
      `  ${l.label.padEnd(20)} n=${l.n}  moyenne ${(l.moyenne * 100).toFixed(1)} %  `
      + `± ${(l.ecartType * 100).toFixed(1)} pts${l.control ? '   ← ce que la production envoie' : ''}`,
    );
  }

  // Variance intra : moyenne des variances de chaque bras. C'est le bruit du
  // modèle à contexte rigoureusement identique.
  const nommes = lignes.filter((l) => !l.control);
  const intra = moyenne(nommes.map((l) => l.ecartType ** 2));

  // Variance inter : dispersion des moyennes de bras. C'est l'effet du nom.
  const moyennesNommees = nommes.map((l) => l.moyenne);
  const grandeMoyenne = moyenne(moyennesNommees);
  const inter = moyennesNommees.reduce((a, m) => a + (m - grandeMoyenne) ** 2, 0)
    / Math.max(moyennesNommees.length - 1, 1);

  // F = (variance inter × k) / variance intra. Le facteur k est l'effectif par
  // bras : c'est la variance de la MOYENNE d'un bras qui se compare à la
  // variance intra divisée par k, d'où la multiplication.
  const F = intra > 1e-12 ? (inter * k) / intra : null;
  const etendue = Math.max(...moyennesNommees) - Math.min(...moyennesNommees);

  console.log('\n── Décomposition ────────────────────────────────────────────────');
  console.log(`  Bruit du modèle à contexte identique : ± ${(Math.sqrt(intra) * 100).toFixed(1)} pts`);
  console.log(`  Écart entre les noms                 : ${(etendue * 100).toFixed(1)} pts d'étendue`);
  console.log(`  F (effet du nom / bruit)             : ${F == null ? 'non calculable' : F.toFixed(2)}`);

  const temoin = lignes.find((l) => l.control);
  if (temoin) {
    const ecartAuTemoin = temoin.moyenne - grandeMoyenne;
    console.log(`  Témoin anonymisé vs moyenne des noms : ${(ecartAuTemoin * 100 >= 0 ? '+' : '')}${(ecartAuTemoin * 100).toFixed(1)} pts`);
  }

  console.log(`\n── Verdict ──────────────────────────────────────────────────────\n  ${verdict({ F, etendue, temoin, nommes, k })}\n`);
}

function verdict({ F, etendue, temoin, nommes, k }) {
  if (F == null) {
    return 'Le modèle a répondu à l\'identique partout : aucun bruit à mesurer, donc aucun rapport calculable. '
      + 'C\'est en soi un signal — un modèle qui ne varie jamais ne raisonne probablement pas non plus.';
  }

  // Le seuil de 4 correspond grossièrement à F(2, 3k−3) au risque de 5 %. Avec
  // trois bras et cinq répétitions, l'échantillon est petit : ce test dit
  // « regarde de près », pas « c'est prouvé ».
  if (F < 4) {
    let v = `Le nom de l'entreprise ne déplace PAS la prévision au-delà du bruit (F = ${F.toFixed(2)}, `
      + `étendue ${(etendue * 100).toFixed(1)} pts). Le modèle raisonne sur les faits fournis. `
      + 'L\'anonymisation reste utile en assurance, mais elle ne corrige pas un biais massif ici.';
    if (temoin && temoin.ecartType < 0.01) {
      v += ' ATTENTION toutefois : le bras anonymisé ne varie quasiment pas — signe possible de '
        + 'repli sur une valeur par défaut plutôt que d\'une véritable analyse.';
    }
    return v;
  }

  const pire = [...nommes].sort((a, b) => b.moyenne - a.moyenne);
  return `Le nom DÉPLACE la prévision (F = ${F.toFixed(2)}, étendue ${(etendue * 100).toFixed(1)} pts sur des faits `
    + `rigoureusement identiques). ${pire[0].label} reçoit ${((pire[0].moyenne - pire[pire.length - 1].moyenne) * 100).toFixed(0)} points `
    + `de plus que ${pire[pire.length - 1].label} pour exactement les mêmes chiffres. Le modèle récite sa mémoire, `
    + 'pas les données du jour. L\'anonymisation n\'est pas une précaution : elle est la condition pour que '
    + 'la mesure porte sur autre chose que la réputation des entreprises. '
    + `Échantillon petit (k = ${k}) — à refaire avant d'en tirer une conclusion ferme.`;
}

const moyenne = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const ecartType = (xs, m) => (xs.length < 2 ? 0
  : Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)));

if (config.llm.provider !== 'gemini') {
  log.error(`Ce test exige le fournisseur gemini (actuel : ${config.llm.provider}). Le moteur heuristique ne lit pas le nom.`);
  process.exit(1);
}

await main();
