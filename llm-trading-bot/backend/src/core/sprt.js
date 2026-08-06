import { createLogger } from '../logger.js';

const log = createLogger('sprt');

/**
 * Test séquentiel du rapport de probabilité (Wald, 1945), tronqué.
 *
 * ── Le problème qu'il résout ──────────────────────────────────────────────
 * Le MinTRL de Bailey & López de Prado dit : « attends N observations avant de
 * conclure ». Sur ce projet, N ≈ 273 et le bot exécute ~70 allers-retours par
 * an : il faudrait ~4 ans, en subissant les pertes pendant tout ce temps, sans
 * avoir le droit statistique de couper. C'est un cadre à horizon fixe, et il
 * n'offre aucune sortie anticipée.
 *
 * Le SPRT transforme la taille d'échantillon en variable aléatoire : il évalue
 * après CHAQUE observation si les preuves accumulées suffisent à trancher, tout
 * en contrôlant rigoureusement les deux erreurs. Le théorème de Wald-Wolfowitz
 * garantit qu'aucun test ne peut décider plus vite en moyenne à erreurs égales.
 *
 * ── Pourquoi Student-t et non gaussien ────────────────────────────────────
 * C'est le point critique. Avec des densités gaussiennes sur des rendements
 * leptokurtiques, un SEUL rendement extrême produit un incrément de
 * log-vraisemblance disproportionné, capable de franchir une borne à lui tout
 * seul. Le contrôle de l'erreur de Type I s'effondre — la littérature rapporte
 * qu'elle peut monter jusqu'à 100 %. Une queue épaisse (ν ≈ 4) donne à ces
 * observations le poids logarithmique qu'elles méritent, et rien de plus.
 *
 * ── Pourquoi tronqué ──────────────────────────────────────────────────────
 * Si l'edge réel se situe pile entre H0 et H1, le test dérive sans conclure
 * (~867 observations attendues). On plafonne donc : au-delà de `maxSamples`,
 * verdict de futilité forcé. Le raisonnement est économique autant que
 * statistique — un avantage trop faible pour être détecté en 400 décisions est
 * de toute façon trop faible pour rapporter quoi que ce soit sur 100 $.
 *
 * ── Pourquoi l'échelle est estimée de façon EXPANSIVE ─────────────────────
 * C'est la correction la plus importante apportée à ce fichier, et elle est
 * invisible à l'œil nu.
 *
 * La version initiale calculait l'écart-type sur la série ENTIÈRE, puis
 * parcourait les observations en s'en servant à chaque pas. L'incrément de
 * log-vraisemblance du pas i utilisait donc une échelle informée par les
 * observations i+1 … n : du futur. Le test se jugeait lui-même avec des données
 * qu'il n'avait pas encore vues.
 *
 * Ce n'est pas un détail cosmétique, c'est ce qui fait tenir tout l'édifice.
 * Les bornes de Wald ne sont valides que si exp(LLR) est une martingale sous
 * H0, ce qui exige que les paramètres du pas i soient mesurables par rapport à
 * la filtration F_{i-1} — un « processus prévisible ». Avec une échelle
 * globale, σ dépend de x_i lui-même, l'espérance conditionnelle du rapport de
 * vraisemblance n'est plus égale à 1, et le contrôle de l'erreur de Type I
 * annoncé (5 %) ne veut plus rien dire.
 *
 * La parade : à chaque pas, σ n'est estimé que sur scores[0 … i-1], par
 * l'algorithme de Welford. Conditionnellement au passé, σ_i est une constante,
 * donc ∫ f_1/f_0 · f_0 = 1 est rétabli et la martingale aussi. Le prix à payer
 * est une période de calibration initiale (`warmupSamples`) qui ne contribue
 * pas aux preuves — un coût honnête, et bien préférable à une garantie fausse.
 */

/** Degrés de liberté de la Student-t. ν = 4 est le standard pour les rendements financiers. */
const DEFAULT_DF = 4;

/**
 * Effet de grappe retenu par défaut, tant que les données du bot ne permettent
 * pas de l'estimer.
 *
 * Mesuré sur 272 séances de rendements excédentaires réels des 10 actifs suivis :
 * corrélation moyenne des paires du même jour ρ = 0,036, donc 1 + (10−1)ρ = 1,32.
 * Ce n'est pas un chiffre de littérature, c'est celui de cet univers précis.
 *
 * Le retenir par défaut plutôt que 1 est un choix conservateur : au démarrage on
 * suppose la corrélation présente, et on la remplace par l'estimation réelle dès
 * qu'il y a de quoi la calculer.
 */
const DEFAULT_DESIGN_EFFECT = 1.32;

/**
 * Effet de grappe estimé sur la série elle-même.
 *
 * ── Le problème ────────────────────────────────────────────────────────────
 * Dix décisions prises le même jour sur dix valeurs technologiques ne sont pas
 * dix informations indépendantes. Le SPRT les compte pourtant une par une, donc
 * il accumule des preuves plus vite qu'il ne le devrait et franchit la borne
 * trop tôt. Soustraire l'indice retire le facteur marché — c'est son rôle et il
 * le fait bien — mais il reste des facteurs sectoriels : NVDA et AMD bougent
 * ensemble même après neutralisation du marché.
 *
 * ── La mesure ──────────────────────────────────────────────────────────────
 * Si les observations étaient indépendantes, la variance d'une moyenne
 * journalière de m observations vaudrait σ²/m. On compare donc la variance
 * RÉELLEMENT observée des moyennes journalières à cette valeur théorique. Le
 * rapport est l'effet de grappe.
 *
 * Plancher à 1 : une corrélation négative ne doit pas servir à ACCÉLÉRER le
 * test. Le bénéfice du doute va toujours à la prudence.
 */
export function designEffect(observations, { minDays = 10 } = {}) {
  const byDay = new Map();
  for (const o of observations) {
    const day = o.t.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(o.score);
  }

  const groups = [...byDay.values()].filter((g) => g.length >= 2);
  if (groups.length < minDays) {
    return { value: DEFAULT_DESIGN_EFFECT, measured: false, days: groups.length };
  }

  const all = observations.map((o) => o.score);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const variance = all.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(all.length - 1, 1);
  if (!(variance > 0)) return { value: DEFAULT_DESIGN_EFFECT, measured: false, days: groups.length };

  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const dailyMeans = groups.map(avg);
  const mBar = avg(groups.map((g) => g.length));
  const dmMean = avg(dailyMeans);
  const dmVar = dailyMeans.reduce((a, b) => a + (b - dmMean) ** 2, 0) / Math.max(dailyMeans.length - 1, 1);

  const expectedIfIndependent = variance / mBar;
  const value = expectedIfIndependent > 0 ? dmVar / expectedIfIndependent : DEFAULT_DESIGN_EFFECT;

  return {
    value: Math.max(1, Number(value.toFixed(3))),
    measured: true,
    days: groups.length,
    obsPerDay: Number(mBar.toFixed(2)),
  };
}

/** Log-densité d'une Student-t de position `mu`, d'échelle `sigma`, à `df` degrés de liberté. */
function logStudentT(x, mu, sigma, df) {
  const z = (x - mu) / sigma;
  // Les constantes de normalisation s'annulent dans le rapport de
  // vraisemblance (même df, même sigma sous H0 et H1) : inutile de les calculer.
  return -((df + 1) / 2) * Math.log(1 + (z * z) / df);
}

export class Sprt {
  /**
   * @param {object} options
   * @param {number} options.targetSharpe  Sharpe par décision sous H1
   * @param {number} options.alpha         risque de valider une stratégie nulle
   * @param {number} options.beta          risque d'abandonner une stratégie valable
   * @param {number} options.maxSamples    troncature
   * @param {number} options.df            degrés de liberté de la Student-t
   * @param {number} options.minSamples    plancher de preuves avant tout verdict
   * @param {number} options.warmupSamples observations réservées à la calibration de σ
   */
  constructor({
    targetSharpe = 0.1,
    alpha = 0.05,
    beta = 0.05,
    maxSamples = 400,
    df = DEFAULT_DF,
    minSamples = 30,
    warmupSamples = 20,
    designEffect: de = 1,
  } = {}) {
    // Correction de Rao-Scott : sous corrélation intra-grappe, le rapport de
    // vraisemblance accumulé est divisé par l'effet de grappe. C'est le
    // correctif de premier ordre standard pour un test de rapport de
    // vraisemblance sur données groupées — il revient à dire que 10 décisions
    // corrélées du même jour ne pèsent pas 10 décisions indépendantes.
    this.designEffect = Math.max(1, de);
    this.targetSharpe = targetSharpe;
    this.alpha = alpha;
    this.beta = beta;
    this.maxSamples = maxSamples;
    this.df = df;
    this.minSamples = minSamples;
    // Assez d'observations pour que σ ne soit pas absurde : l'erreur relative
    // sur un écart-type estimé sur k points vaut ~1/√(2(k-1)), soit 16 % à
    // k = 20. Acceptable, d'autant que l'estimation se resserre ensuite et que
    // les écarts des premiers pas se compensent sur la durée du test.
    this.warmupSamples = Math.max(2, warmupSamples);

    // Bornes de Wald. A = validation (efficacité), B = arrêt (futilité).
    this.upperBound = Math.log((1 - beta) / alpha);
    this.lowerBound = Math.log(beta / (1 - alpha));
  }

  /**
   * Évalue une série de scores et rend un verdict.
   *
   * @param {number[]} scores  rendements signés, ordonnés chronologiquement
   */
  evaluate(scores) {
    const n = scores.length;

    // ── Échelle expansive, mise à jour par Welford ─────────────────────────
    // L'échelle n'est pas connue a priori : on ne dispose d'aucune volatilité
    // de référence pour un score de décision de LLM. C'est l'esprit du test-t
    // séquentiel de Hajnal, qui rend l'inférence invariante à une variance
    // inconnue — à condition de ne l'estimer que sur le passé.
    let k = 0;
    let runMean = 0;
    let runM2 = 0;
    const observe = (x) => {
      k += 1;
      const delta = x - runMean;
      runMean += delta / k;
      runM2 += delta * (x - runMean);
    };
    /** Écart-type de scores[0 … i-1]. Rigoureusement F_{i-1}-mesurable. */
    const pastSigma = () => (k > 1 ? Math.sqrt(runM2 / (k - 1)) : NaN);

    let llr = 0;
    let nEff = 0; // observations ayant réellement contribué aux preuves
    const trajectory = [];
    let crossedAt = null;
    let crossedTo = null;
    let llrAtCrossing = null;
    let sigmaAtLastStep = NaN;

    for (let i = 0; i < n; i += 1) {
      const x = scores[i];
      const sigma = pastSigma();

      // Tant que l'échelle n'est pas calibrée, l'observation sert uniquement à
      // l'estimer. Elle n'entre pas dans le rapport de vraisemblance.
      if (k >= this.warmupSamples && sigma > 0) {
        // H0 : espérance nulle. H1 : espérance = targetSharpe × σ_i.
        // L'incrément est amorti par l'effet de grappe : dix décisions
        // corrélées du même jour ne valent pas dix preuves indépendantes.
        llr += (logStudentT(x, this.targetSharpe * sigma, sigma, this.df)
              - logStudentT(x, 0, sigma, this.df)) / this.designEffect;
        nEff += 1;
        trajectory.push(Number(llr.toFixed(4)));
        sigmaAtLastStep = sigma;

        // Le verdict est celui du PREMIER franchissement, pas celui de la
        // valeur finale : un vrai test séquentiel se serait arrêté là.
        if (nEff >= this.minSamples) {
          if (llr >= this.upperBound) {
            crossedAt = nEff;
            crossedTo = 'VALIDE';
            llrAtCrossing = llr;
            break;
          }
          if (llr <= this.lowerBound) {
            crossedAt = nEff;
            crossedTo = 'ARRETER';
            llrAtCrossing = llr;
            break;
          }
        }

        // ── L'ARRÊT À LA TRONCATURE EST OBLIGATOIRE ────────────────────────
        // Sans ce `break`, le parcours continuait au-delà de maxSamples et
        // acceptait un franchissement survenu bien plus tard — observé en
        // pratique : validation annoncée à la 732ᵉ preuve pour une troncature
        // fixée à 400. C'est exactement l'arrêt optionnel que le SPRT est censé
        // interdire : regarder au-delà du point d'arrêt jusqu'à ce que le
        // résultat plaise fait exploser l'erreur de Type I, et la garantie de
        // 5 % ne veut plus rien dire.
        //
        // Le test s'arrête donc ici pour de bon. Les observations suivantes
        // n'existeraient pas dans un déroulement réel.
        if (nEff >= this.maxSamples) break;
      }

      observe(x); // APRÈS usage : x n'informe que les pas suivants
    }

    if (nEff < this.minSamples) {
      const needed = this.warmupSamples + this.minSamples;
      return this.#verdict('DONNEES_INSUFFISANTES', {
        n,
        nEff,
        llr: Number(llr.toFixed(4)),
        reason:
          `${n} observation(s) sur ${needed} requises : ${Math.min(n, this.warmupSamples)}/${this.warmupSamples} ` +
          `pour calibrer l'échelle, puis ${nEff}/${this.minSamples} de preuves accumulées.`,
        progress: Math.min(1, n / needed),
      });
    }

    const sigma = sigmaAtLastStep;
    const common = {
      n,
      nEff,
      nWarmup: Math.min(n, this.warmupSamples),
      // Le test s'étant arrêté à son point de décision, une partie des
      // observations disponibles n'a pas été lue. Le dire évite de croire à une
      // incohérence entre le nombre de décisions mesurées et la taille du test.
      nUnused: Math.max(0, n - this.warmupSamples - nEff),
      llr: Number(llr.toFixed(4)),
      observedSharpe: sigma > 0 ? Number((runMean / sigma).toFixed(4)) : null,
      meanPct: Number((runMean * 100).toFixed(4)),
      sdPct: sigma > 0 ? Number((sigma * 100).toFixed(4)) : null,
      trajectory: trajectory.slice(-100),
      crossedAt,
    };

    if (crossedTo === 'VALIDE') {
      const { overshoot, achieved, guaranteed } = this.#overshoot(llrAtCrossing, 'upper');
      return this.#verdict('VALIDE', {
        ...common,
        reason:
          `Borne supérieure franchie à la ${crossedAt}ᵉ preuve : l'hypothèse d'absence d'avantage ` +
          `est rejetée au seuil ${(this.alpha * 100).toFixed(0)} %.`,
        progress: 1,
        overshoot,
        achievedErrorRate: achieved,
        guaranteedErrorRate: guaranteed,
        achievedNote:
          `Le LLR a dépassé la borne de ${overshoot.toFixed(2)} nat. L'erreur de Type I réellement ` +
          `atteinte est donc majorée par ${(achieved * 100).toFixed(2)} %, là où la borne elle-même ` +
          `ne garantissait que ${(guaranteed * 100).toFixed(2)} %.`,
      });
    }

    if (crossedTo === 'ARRETER') {
      const { overshoot, achieved, guaranteed } = this.#overshoot(llrAtCrossing, 'lower');
      return this.#verdict('ARRETER', {
        ...common,
        reason: `Borne de futilité franchie à la ${crossedAt}ᵉ preuve : aucun avantage statistique détectable. Arrêt recommandé.`,
        progress: 1,
        overshoot,
        achievedErrorRate: achieved,
        guaranteedErrorRate: guaranteed,
        achievedNote:
          `Dépassement de ${overshoot.toFixed(2)} nat sous la borne : le risque d'abandonner à tort ` +
          `une stratégie valable est majoré par ${(achieved * 100).toFixed(2)} %, contre ` +
          `${(guaranteed * 100).toFixed(2)} % garantis par la borne.`,
      });
    }

    if (nEff >= this.maxSamples) {
      // Verdict distinct d'un vrai franchissement de la borne de futilité.
      //
      // La troncature échange délibérément de l'erreur de Type II contre du
      // temps : à Sharpe réel = targetSharpe, l'ASN théorique est d'environ
      // 530 observations, donc tronquer à 400 fait échouer la validation d'une
      // stratégie pourtant valable dans une fraction NON NÉGLIGEABLE des cas
      // (mesuré ~55 % par simulation). Le β effectif n'est donc pas celui
      // annoncé — il faut le dire plutôt que de le masquer.
      //
      // Ce compromis reste le bon ici pour une raison économique : un avantage
      // indétectable en 400 décisions correspond à une espérance trop faible
      // pour produire quoi que ce soit sur un compte de 100 $, une fois les
      // coûts de transaction déduits.
      return this.#verdict('TRONQUE', {
        ...common,
        reason:
          `Troncature à ${this.maxSamples} preuves sans franchissement de borne. ` +
          'Aucun avantage suffisamment net pour être détecté — et donc trop faible pour être exploitable à cette taille de compte.',
        progress: 1,
        truncated: true,
        caveat:
          'La troncature gonfle l\'erreur de Type II : une stratégie réellement bonne mais ' +
          'd\'avantage modeste peut être écartée ici. Ce n\'est pas une preuve d\'absence d\'edge, ' +
          'c\'est un constat d\'edge trop faible pour être exploité dans ce cadre.',
      });
    }

    // Progression vers la borne la plus proche : donne une idée du chemin restant.
    const progress = llr >= 0 ? llr / this.upperBound : llr / this.lowerBound;

    return this.#verdict('CONTINUER', {
      ...common,
      reason:
        `LLR = ${llr.toFixed(2)}, entre les bornes [${this.lowerBound.toFixed(2)} ; ${this.upperBound.toFixed(2)}]. ` +
        'Preuves insuffisantes pour trancher.',
      progress: Math.max(0, Math.min(1, progress)),
      samplesRemaining: this.maxSamples - nEff,
    });
  }

  /**
   * Dépassement de borne, et garantie qu'on en tire.
   *
   * Le LLR ne franchit jamais une borne exactement : il la dépasse. Wald traite
   * ce surplus comme une simple source de conservatisme, et Siegmund propose de
   * resserrer les bornes pour le récupérer — donc pour conclure plus vite.
   *
   * J'ai délibérément retenu l'usage INVERSE. Resserrer les bornes échange une
   * majoration rigoureuse contre une approximation asymptotique : le test dirait
   * « erreur ≈ 5 % » là où il dit aujourd'hui « erreur ≤ 5 % ». Sur un projet
   * dont l'objet est précisément de ne pas se raconter d'histoires
   * statistiques, gagner quelques semaines contre la solidité de l'unique
   * affirmation qui compte est un mauvais échange.
   *
   * Le dépassement est donc exploité dans le sens qui ne coûte rien : par
   * l'inégalité de Ville, franchir en L ≥ A majore l'erreur de Type I par
   * e^{-L}, et non seulement par e^{-A}. C'est un renforcement gratuit et
   * rigoureux de la conclusion, au lieu d'un raccourci payé en garantie.
   *
   * ── Le facteur qu'il ne faut pas oublier ──────────────────────────────────
   * La référence à laquelle comparer n'est PAS le α nominal. Avec les bornes de
   * Wald, e^{-A} = α/(1−β), soit 5,26 % et non 5 % pour α = β = 0,05. C'est le
   * conservatisme bien connu de l'approximation de Wald, et l'ignorer ferait
   * annoncer un « renforcement » à 5,02 % en le comparant à 5 % — donc une
   * dégradation présentée comme un gain. On expose les deux nombres.
   */
  #overshoot(llrAtCrossing, side) {
    const bound = side === 'upper' ? this.upperBound : this.lowerBound;
    const exponent = side === 'upper' ? -llrAtCrossing : llrAtCrossing;
    const guaranteedExponent = side === 'upper' ? -bound : bound;
    return {
      overshoot: Number(Math.abs(llrAtCrossing - bound).toFixed(4)),
      achieved: Number(Math.exp(exponent).toFixed(6)),
      guaranteed: Number(Math.exp(guaranteedExponent).toFixed(6)),
    };
  }

  #verdict(status, details) {
    return {
      status,
      ...details,
      bounds: {
        upper: Number(this.upperBound.toFixed(4)),
        lower: Number(this.lowerBound.toFixed(4)),
      },
      hypotheses: {
        h0: 'Sharpe = 0 (aucun avantage directionnel)',
        h1: `Sharpe = ${this.targetSharpe} par décision`,
        alpha: this.alpha,
        beta: this.beta,
        distribution: `Student-t (ν=${this.df})`,
        maxSamples: this.maxSamples,
        warmupSamples: this.warmupSamples,
        scaleEstimation: 'expansive (σ estimé sur le passé uniquement)',
      },
    };
  }

  /**
   * Nombre moyen de PREUVES attendu avant décision, selon le Sharpe réel.
   * Sert à annoncer un délai réaliste plutôt qu'à faire patienter à l'aveugle.
   * N'inclut pas la calibration : voir `referenceTable` pour le total.
   */
  expectedSampleSize(trueSharpe) {
    const drift = trueSharpe * this.targetSharpe - (this.targetSharpe ** 2) / 2;
    if (Math.abs(drift) < 1e-9) return Infinity; // point d'indifférence

    // Probabilité d'accepter H0, via la racine non nulle de l'équation de Wald.
    const h = (this.targetSharpe - 2 * trueSharpe) / this.targetSharpe;
    let pAcceptH0;
    if (Math.abs(h) < 1e-9) {
      pAcceptH0 = this.upperBound / (this.upperBound - this.lowerBound);
    } else {
      const eA = Math.exp(h * this.upperBound);
      const eB = Math.exp(h * this.lowerBound);
      pAcceptH0 = (eA - 1) / (eA - eB);
    }
    pAcceptH0 = Math.max(0, Math.min(1, pAcceptH0));

    const asn = (pAcceptH0 * this.lowerBound + (1 - pAcceptH0) * this.upperBound) / drift;
    return Math.min(Math.max(Math.round(asn), 1), this.maxSamples);
  }

  /**
   * Table de référence : combien de temps avant un verdict, selon l'edge réel.
   * Les délais annoncés incluent la calibration d'échelle, qui n'apporte aucune
   * preuve mais qu'il faut bien traverser.
   */
  referenceTable(decisionsPerDay = 4) {
    return [-0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2].map((sr) => {
      const asn = this.expectedSampleSize(sr);
      const total = Number.isFinite(asn) ? asn + this.warmupSamples : null;
      return {
        trueSharpe: sr,
        expectedEvidence: Number.isFinite(asn) ? asn : null,
        expectedDecisions: total,
        expectedTradingDays: total == null ? null : Math.round(total / decisionsPerDay),
        expectedWeeks: total == null ? null : Number((total / decisionsPerDay / 5).toFixed(1)),
      };
    });
  }
}

/**
 * Verdict prêt pour l'API et le dashboard, calculé sur le carnet fantôme.
 */
export async function runSprt(shadowBook, { horizon = 3, ...options } = {}) {
  const series = await shadowBook.scoreSeries({ horizon });

  // L'effet de grappe est estimé sur les décisions du bot lui-même dès qu'il y a
  // de quoi le faire, plutôt que figé sur une mesure d'historique de prix.
  const clustering = designEffect(series);
  const sprt = new Sprt({ designEffect: clustering.value, ...options });
  const verdict = sprt.evaluate(series.map((s) => s.score));

  if (verdict.status === 'ARRETER') {
    log.error(`VERDICT SPRT : ARRÊT — ${verdict.reason}`);
  } else if (verdict.status === 'TRONQUE') {
    log.warn(`VERDICT SPRT : TRONQUÉ — ${verdict.reason}`);
  } else if (verdict.status === 'VALIDE') {
    log.warn(`VERDICT SPRT : VALIDÉ — ${verdict.reason}`);
  }

  return {
    ...verdict,
    horizon,
    clustering: {
      ...clustering,
      note: clustering.measured
        ? `Estimé sur ${clustering.days} jours (${clustering.obsPerDay} décisions/jour) : les preuves sont divisées par ${clustering.value}.`
        : `Non estimable avant ${10} jours groupés — valeur prudente ${clustering.value} retenue, mesurée sur l'historique de prix de cet univers.`,
    },
    referenceTable: sprt.referenceTable(),
  };
}
