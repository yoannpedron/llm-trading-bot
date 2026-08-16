import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// entities.js ne dépend que de node: — pas de cycle d'import avec config.
import { entityCoverage } from './llm/entities.js';
import { UNIVERSE_150 } from './data/universe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const str = (key, fallback = '') => (process.env[key] ?? fallback).toString().trim();
const num = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key, fallback) => {
  const raw = str(key, String(fallback)).toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
};
const list = (key, fallback = []) => {
  const raw = str(key);
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

/**
 * Budget de raisonnement interne par famille de modèle.
 *
 * Gemini 2.x accepte `thinkingBudget: 0` pour désactiver complètement la
 * réflexion. Gemini 3.x le REFUSE avec un HTTP 400 : il faut lui donner un
 * budget strictement positif. Un budget de 128 suffit — vérifié en pratique,
 * le modèle n'en consomme alors aucun et répond directement.
 */
function defaultThinkingBudget(model) {
  return /^gemini-[3-9]/.test(model) ? 128 : 0;
}

const model = str('GEMINI_MODEL', 'gemini-3.5-flash-lite');

export const config = {
  server: {
    port: num('PORT', 8080),
    corsOrigins: list('CORS_ORIGINS', ['*']),
    adminToken: str('ADMIN_TOKEN'),
  },

  llm: {
    provider: str('LLM_PROVIDER', 'gemini'),
    // Plusieurs comptes gratuits = plusieurs quotas cumulés.
    apiKeys: [...new Set([...list('GEMINI_API_KEYS'), ...(str('GEMINI_API_KEY') ? [str('GEMINI_API_KEY')] : [])])],
    model,
    // Température NULLE. Ce n'est pas un réglage de style, c'est une condition
    // de la mesure : le SPRT teste UNE stratégie, pas un nuage de stratégies.
    // À température 0,2 le même contexte peut produire des décisions
    // différentes, ce qui injecte de la variance qui n'est due qu'à
    // l'échantillonnage du décodeur. Cette variance gonfle σ, écrase le Sharpe
    // observé, et rallonge le test sans rien apprendre. On la supprime.
    temperature: num('LLM_TEMPERATURE', 0),
    maxOutputTokens: num('LLM_MAX_OUTPUT_TOKENS', 4096),
    thinkingBudget: num('LLM_THINKING_BUDGET', defaultThinkingBudget(model)),
    timeoutMs: num('LLM_TIMEOUT_MS', 60000),
    // 15 requêtes/minute sur le palier gratuit → 5 s d'écart garantit la marge.
    cooldownMs: num('LLM_COOLDOWN_MS', 5000),
    // Plafond journalier PAR CLÉ. Recalibré automatiquement si un 429 révèle
    // une valeur différente (voir keyPool.calibrateFrom429).
    callsPerKeyPerDay: num('LLM_CALLS_PER_KEY_PER_DAY', 500),
  },

  universe: {
    // Univers analysé à chaque cycle. Ce n'est PAS le nombre de positions :
    // le gestionnaire de risque en retient 10 au maximum.
    //
    // ── Pourquoi le défaut est l'univers complet ───────────────────────────
    // Il valait ici une liste de DIX valeurs codée en dur, pendant que
    // `.env.example` annonçait « vide = univers de 150 valeurs par défaut ».
    // La documentation décrivait une intention, le code faisait autre chose,
    // et rien ne signalait l'écart.
    //
    // La conséquence n'est pas cosmétique. Toute la stratégie est un
    // CLASSEMENT TRANSVERSAL : on retient les dix meilleurs d'un univers
    // large. Avec dix candidats pour dix places, il n'y a plus de sélection —
    // le bot achète tout ce qu'il regarde, et le classement, la bande de
    // non-négociation et le plafond sectoriel deviennent tous inertes.
    //
    // Le serveur tournait exactement dans cet état. Renseigner les 150
    // symboles à la main dans chaque `.env` reconduirait le piège au premier
    // oubli : le défaut doit être l'univers complet.
    symbols: list('SYMBOLS', UNIVERSE_150),
    // Bougies journalières : l'horizon de détention visé est de 1 à 7 jours.
    // L'intraday est écarté — le coût de rotation le rend non rentable ici.
    interval: str('CANDLE_INTERVAL', '1d'),
    range: str('CANDLE_RANGE', '1y'),
    // Flux de données Alpaca : `iex` (gratuit) ou `sip` (abonnement payant).
    feed: str('ALPACA_DATA_FEED', 'iex'),
  },

  /**
   * ── Un seul cycle par jour, et dans la bonne fenêtre ──────────────────
   * Il y en avait trois : 16h30, 19h30 et 21h30 heure de Paris. Converties à
   * New York, cela donne 10h30, 13h30 et 15h30 — or la fenêtre d'exécution
   * ne s'ouvre qu'entre 11h et 14h. Deux cycles sur trois calculaient donc un
   * classement qu'ils n'avaient pas le droit d'utiliser.
   *
   * Et ils calculaient le MÊME. Les bougies sont journalières : entre 10h30 et
   * 15h30, le RSI, l'ATR, la tendance et le rendement 5 séances sont
   * rigoureusement identiques. Seules les actualités bougent. Les trois cycles
   * refaisaient le même travail sur les mêmes chiffres, pour 180 appels par
   * jour au lieu de 60.
   *
   * ── ET LE FUSEAU EST CELUI DE NEW YORK, PAS DE PARIS ──────────────────
   * Le cron était réglé en heure de Paris alors que la contrainte — la fenêtre
   * 11h-14h où le spread est au plus bas — est new-yorkaise. Les deux
   * continents ne changent pas d'heure le même jour : les États-Unis passent à
   * l'heure d'été le deuxième dimanche de mars, l'Europe le dernier.
   *
   * Pendant ces trois semaines, Paris est en UTC+1 quand New York est déjà en
   * UTC−4 : 19h30 Paris tombe à 14h30 à New York, hors fenêtre. Même décalage
   * inversé fin octobre.
   *
   * Vérifié sur les 261 jours ouvrés de 2026 : 20 cycles ne pouvaient PAS
   * acheter — quinze jours d'affilée en mars, cinq fin octobre. Trois semaines
   * de blocage complet, sans erreur ni message, sur un bot destiné à tourner
   * plusieurs mois sans surveillance.
   *
   * Exprimer l'horaire dans le fuseau de la contrainte supprime le problème à
   * la racine : 13h30 à New York reste 13h30 à New York toute l'année.
   *
   * Le risque assumé est qu'une panne ce jour-là fasse sauter le cycle. À 21
   * séances de détention, un jour manqué ne coûte presque rien — le classement
   * du lendemain sera quasi identique.
   */
  schedule: {
    cron: str('CRON_SCHEDULE', '30 13 * * 1-5'),
    timezone: str('CRON_TIMEZONE', 'America/New_York'),
    runOnStart: bool('RUN_ON_START', true),
    onlyMarketHours: bool('ONLY_MARKET_HOURS', true),
  },

  risk: {
    // Le compte Alpaca est libellé en dollars : aucune conversion de devise.
    baseCurrency: str('BASE_CURRENCY', 'USD'),
    initialCapital: num('INITIAL_CAPITAL', 100),

    /**
     * ── Pourquoi 10 positions et non 3 ────────────────────────────────────
     * Deux résultats s'opposent frontalement et il a fallu trancher.
     *
     * La loi fondamentale de la gestion active dit que concentrer maximise
     * l'exposition au meilleur signal : à corrélation transversale élevée,
     * diversifier n'abaisse presque plus la variance (elle bute sur
     * l'asymptote de covariance) tout en diluant l'alpha vers des titres de
     * rang inférieur. Ce raisonnement défend 3.
     *
     * L'analyse du risque idiosyncratique dit l'inverse : à 3 lignes, le
     * terme σ²/M reste énorme et les mouvements du portefeuille sont dictés
     * par les aléas propres de trois entreprises — un procès, un dirigeant
     * qui part — et non par le signal qui les a désignées. Espérer capturer
     * la tendance d'une population en n'interrogeant que trois de ses membres
     * n'est pas de la gestion factorielle, c'est un pari directionnel.
     *
     * 10 est le compromis assumé : assez pour que la loi des grands nombres
     * commence à jouer, pas assez pour diluer le signal dans le rang 25. À
     * 100 $ cela fait des lignes de 10 $, très au-dessus du plancher
     * technique — l'argument des commissions fixes qui condamnerait la
     * fragmentation ne s'applique pas chez un courtier sans commission.
     */
    maxPositions: num('MAX_POSITIONS', 10),

    /**
     * ── Durée minimale de détention ───────────────────────────────────────
     * C'est le paramètre le plus rentable de tout le fichier, et il n'existait
     * pas.
     *
     * La rotation n'était bornée par rien : les positions sortaient dès que
     * leur rang décrochait, à trois cycles par jour. Sur un horizon visé de
     * 3 séances, cela fait 84 rotations complètes par an :
     *
     *     84 × 6,25 bps = 5,25 % du capital, brûlés chaque année, garantis,
     *     avant même de savoir si le signal vaut quelque chose.
     *
     * Deux résultats imposent d'allonger. D'abord la durée de vie du signal :
     * sur les grandes capitalisations très liquides, le momentum court terme
     * se dissipe en 2 à 6 SEMAINES. Vendre au troisième jour coupait le signal
     * au moment précis où il commençait à produire — on payait le plein tarif
     * pour un dixième du mouvement. Ensuite l'horizon optimal sous frictions :
     * il s'allonge toujours AU-DELÀ de la demi-vie du signal, le temps que
     * l'espérance accumulée amortisse le coût d'entrée.
     *
     * À 21 séances : 12 rotations par an, soit 0,75 % de frais. Quatre points
     * et demi de rendement annuel récupérés sans avoir rien à prédire.
     *
     * La contrepartie est réelle et assumée : moins de transactions, donc une
     * validation statistique encore plus lente. Le but est le rendement, pas
     * la mesure — l'arbitrage se tranche donc de ce côté.
     */
    minHoldingDays: num('MIN_HOLDING_DAYS', 21),

    /**
     * ── Plafond par secteur ───────────────────────────────────────────────
     * Prendre les dix meilleurs sans contrainte paraît neutre et ne l'est pas.
     * Quand un secteur entier surperforme, il occupe tout le haut du
     * classement et le portefeuille devient un pari sur ce secteur — un
     * risque macroéconomique qu'aucune prime ne rémunère, déguisé en
     * sélection de titres.
     *
     * L'élan non contraint est d'ailleurs presque entièrement absorbé par sa
     * composante sectorielle : la part qui porte réellement de l'information
     * est la comparaison entre pairs d'une même industrie.
     *
     * ── Pourquoi 3 et non 2 ───────────────────────────────────────────────
     * Le plafond valait 2, chiffre choisi par raisonnement et jamais mesuré.
     * Rejoué avec le VRAI code sur deux périodes indépendantes, écart annuel
     * contre l'inaction du même univers :
     *
     *     plafond   2017-2023   2023-2026
     *        2       −1,8 pt     +11,7 pt     ← le seul à perdre quelque part
     *        3       +4,4 pt     +12,6 pt
     *        4       +1,4 pt     +18,0 pt
     *      aucun     +1,4 pt     +14,9 pt
     *
     * À 2, le bot perdait 13,9 points en 2017 et 16,3 points en 2019 — deux
     * années de forte hausse portées par une poignée de valeurs
     * technologiques. Le mécanisme est direct : la règle qui protège d'un pari
     * sectoriel empêchait aussi de suivre le secteur qui MÈNE le marché, et
     * les journaux montrent qu'elle écartait massivement de la technologie ces
     * années-là.
     *
     * Trois valeurs battent l'ancienne sur les DEUX périodes, ce qui écarte la
     * coïncidence. On retient la plus petite : elle est la meilleure sur la
     * période la plus longue et la plus dure, c'est le changement minimal, et
     * elle n'est le maximum d'aucune des deux — donc pas un sommet ajusté.
     *
     * 3 sur 9 secteurs, soit 30 % du portefeuille au plus pour un secteur :
     * de quoi suivre celui qui mène, pas de quoi lui abandonner le compte.
     *
     * Cela reste un a priori mieux étayé, pas une démonstration : sept
     * observations annuelles ne suffisent pas à conclure.
     */
    maxPerSector: num('MAX_PER_SECTOR', 3),

    /**
     * ── Fenêtre d'exécution, en heure de New York ─────────────────────────
     * Le spread suit une courbe en U sur la séance. À l'ouverture, les teneurs
     * de marché élargissent leurs fourchettes pour se protéger de l'asymétrie
     * d'information accumulée pendant la nuit : le coût y est deux à quatre
     * fois celui du milieu de séance. En clôture, les enchères ramènent du
     * volume mais aussi de la volatilité directionnelle.
     *
     * Entre 11 h et 14 h, l'absence de flux nouveau et la concurrence des
     * algorithmes compriment le spread à son minimum. L'économie mesurée est
     * de 1 à 3 points de base par transaction — sur un budget de 6,25, c'est
     * 15 à 45 % du coût, pour la seule peine d'attendre.
     *
     * ── Et pourquoi ça ne s'applique qu'aux ACHATS ────────────────────────
     * Une entrée est patiente : on détient 21 séances, rien n'oblige à ouvrir
     * ce matin plutôt que cet après-midi. Une sortie ne l'est pas : elle peut
     * répondre à un coupe-circuit, et faire attendre un ordre de protection
     * pour économiser deux points de base serait une inversion des priorités.
     */
    executionStartHourET: num('EXECUTION_START_HOUR_ET', 11),
    executionEndHourET: num('EXECUTION_END_HOUR_ET', 14),

    /**
     * ── Plafond de spread, en points de base ──────────────────────────────
     * L'homogénéité du spread à l'intérieur des grandes capitalisations est
     * une illusion. La moyenne tourne autour de 6 bps, mais la dispersion est
     * large : certains titres importants en affichent le double, et en période
     * de tension l'ensemble peut tripler.
     *
     * Un titre à 12 bps coûte 24 bps l'aller-retour — quatre fois notre coût
     * mesuré. Aucun signal de cette force ne justifie de le payer alors que
     * 149 autres candidats attendent. Le filtre sacrifie ponctuellement des
     * signaux valides ; c'est le prix d'une friction qu'on maîtrise.
     */
    maxSpreadBps: num('MAX_SPREAD_BPS', 7),

    /**
     * ── Veto de risque ────────────────────────────────────────────────────
     * Le modèle relit les actualités des seuls finalistes et peut refuser un
     * achat. C'est le seul emploi du LLM dont la valeur économique soit
     * chiffrée : le taux de réussite bouge à peine (51 % → 54 %), mais
     * l'amplitude moyenne des pertes baisse d'environ 36 %. Le gain vient de
     * la queue gauche.
     *
     * Et il est asymétrique par construction : un veto ne peut que refuser. Il
     * ne peut ni désigner un actif, ni inverser le classement, ni pousser à
     * l'action. Au pire il fait manquer une occasion — il ne peut pas
     * fabriquer une perte.
     *
     * Coût : une dizaine d'appels par cycle, sur les seuls candidats retenus.
     */
    vetoActif: bool('VETO_ACTIF', true),
    /**
     * ── Enveloppe par position ────────────────────────────────────────────
     * Doit rester cohérente avec `maxPositions`, et ça ne va pas de soi : les
     * deux réglages sont indépendants alors qu'ils décrivent le même partage.
     *
     * Le défaut était à 0,35 quand le bot visait 3 positions. En passant à 10
     * sans y toucher, la cible devenait 350 % de l'équity : le cash s'épuisait
     * après la troisième ligne et les sept autres étaient refusées faute de
     * fonds. Le passage à 10 positions était donc purement décoratif, et rien
     * ne le signalait — le bot se comportait exactement comme avant.
     *
     * À 0,10, dix lignes de 10 $ sur 100 $ d'équity : le poids égal redevient
     * réellement égal. Un contrôle de cohérence au démarrage refuse désormais
     * les combinaisons impossibles.
     */
    maxPositionPct: num('MAX_POSITION_PCT', 0.10),
    // Plancher d'ordre volontairement bas.
    //
    // Les rapports de recherche justifiaient un plancher élevé (50 € et plus)
    // par la dilution des COMMISSIONS FIXES : chez IBKR ou Trade Republic, un
    // ordre à 0,35-1 € rend toute position inférieure à ~50 € non rentable.
    // Cet argument ne s'applique PAS ici : Alpaca ne prend aucune commission,
    // et les frais réglementaires (~0,03 bps) sont proportionnels. Le coût
    // dominant est le spread, lui aussi proportionnel — donc un ordre de 5 $
    // coûte exactement le même POURCENTAGE qu'un ordre de 50 $.
    //
    // On garde 5 $ comme marge au-dessus du plancher technique d'Alpaca (1 $).
    minOrderValue: num('MIN_ORDER_VALUE', 5),

    /**
     * ── Le stop, recalculé plutôt que recopié ─────────────────────────────
     * J'avais repris d'un rapport le chiffre « 4 × ATR ≈ 5 σ, probabilité de
     * déclenchement 0,20 % sur 3 séances ». Les deux valeurs sont fausses et
     * je n'ai pas su reproduire leur dérivation.
     *
     * Le calcul juste : sur h séances la volatilité cumulée croît en √h, donc
     * 4 × ATR vaut 4/√3 ≈ 2,3 σ cumulés sur trois séances, pas 5. Et la
     * probabilité de TOUCHER la barrière — le minimum du chemin, pas la
     * clôture — s'obtient par la formule de réflexion 2·Φ(−a/σ√T) :
     *
     *     4 × ATR sur  3 séances : 1,1 % (clôtures) à 2,1 % (continu)
     *     4 × ATR sur 21 séances :  32 %           à  38 %
     *
     * Le premier chiffre justifiait déjà de retirer le stop : à 1 ou 2 %, il ne
     * protégeait de rien. Le second est bien plus décisif, et je ne l'avais pas
     * vu. En allongeant la détention à 21 séances SANS toucher au stop, on
     * aurait liquidé un tiers des positions sur du bruit de marché pur, en
     * payant l'aller-retour à chaque fois. La distance était calibrée pour un
     * horizon de trois jours ; l'horizon a été multiplié par sept.
     *
     * Pire, quand il se déclenche, c'est sur le seul événement contre lequel
     * il est inopérant. La totalité du rendement des actions américaines se
     * construit HORS séance : une position détenue trois semaines traverse une
     * vingtaine d'ouvertures, et c'est là qu'est le risque. Or un stop ne
     * s'exécute pas dans un trou de cotation. Une action qui clôture à 100 $
     * et ouvre à 85 $ ne traverse jamais le seuil de 98 $ : l'ordre devient un
     * ordre au marché exécuté à 85 $. Le stop n'a pas borné la perte, il a
     * forcé la vente au pire prix de la journée.
     *
     * Les travaux sur l'efficacité des stops en système court terme sont
     * convergents : hors d'un régime de tendance baissière persistante, un
     * stop ne fait que retirer le portefeuille d'un actif à espérance
     * positive. Sur trois semaines, la sortie par le TEMPS et par le rang est
     * le mécanisme pertinent ; le risque de saut se gère à l'entrée, par la
     * taille de position et par l'exclusion des événements programmés.
     *
     * Ce qui reste ici n'est donc plus un stop de gestion mais un
     * coupe-circuit de catastrophe : fraude, radiation, effondrement. Il est
     * placé assez loin pour ne jamais intervenir sur du bruit, et existe
     * uniquement pour qu'une ligne ne puisse pas aller à zéro sans réaction.
     *
     * ── Il n'était PAS placé assez loin ───────────────────────────────────
     * Mesuré sur 18 629 périodes de 21 séances, tous titres de l'univers,
     * 2016-2026 — la baisse la plus profonde traversée pendant une détention :
     *
     *     centile   0,5 %   -33,9 %
     *     centile     1 %   -28,5 %
     *     centile     2 %   -22,8 %
     *     centile    50 %    -4,0 %
     *
     * -25 % tombe donc au centile 1,5. Ce n'est pas un seuil de catastrophe,
     * c'est le bord de la distribution ordinaire : 268 déclenchements, et
     * 270 sur 272 des positions concernées terminent AU-DESSUS de -25 %. Le
     * coupe-circuit vendait au plus bas, presque à chaque fois.
     *
     * Effet mesuré, médiane de l'excédent sur ~430 fenêtres d'un an :
     *
     *     seuil    -25 %   -30 %   -35 %   -40 %   -50 %   aucun
     *     médiane  +0,5    +5,3    +2,3    +3,7    +2,7    +2,7
     *     bat      54 %    69 %    62 %    65 %    65 %    65 %
     *
     * Une valeur isolément mauvaise, puis un plateau. C'est la structure qui
     * distingue un effet réel d'un pic de hasard — et c'est celle qu'aucun
     * autre paramètre testé cette semaine n'a produite.
     *
     * ── Pourquoi 35 % et pas la suppression, que les chiffres réclament ───
     * Parce que ces données ne peuvent PAS voir à quoi sert un coupe-circuit.
     * L'univers est la composition du S&P 500 d'aujourd'hui : toute entreprise
     * qui s'est effondrée en a été retirée avant le téléchargement. Les cas où
     * le stop sauve la mise sont absents par construction, et la récupération
     * mesurée à 90 % au-delà de -40 % en est le symptôme direct.
     *
     * Le backtest sait donc dire que -25 % est trop serré. Il ne sait pas dire
     * qu'aucun seuil n'est nécessaire, et on ne lui fait pas dire.
     *
     * 35 % est la plus petite valeur du plateau que la configuration
     * contemplait déjà — c'est `stopMaxPct`. Plancher et plafond coïncident
     * désormais : le coupe-circuit est un seuil fixe, franc, hors du bruit.
     */
    stopAtrMultiple: num('STOP_ATR_MULTIPLE', 0),
    stopMinPct: num('STOP_MIN_PCT', 0.35),
    stopMaxPct: num('STOP_MAX_PCT', 0.35),
    // Pas de take-profit fixe : il tronque la queue droite de la distribution
    // et détruit l'espérance des stratégies de suivi de tendance. La sortie
    // se fait sur signal du LLM ou sur stop.
    takeProfitPct: num('TAKE_PROFIT_PCT', 0) || null,

    // Coupe-circuit MENSUEL et non journalier : 10 % de 100 $ = 10 $, très
    // en dessous du bruit stochastique normal du portefeuille.
    maxMonthlyLossPct: num('MAX_MONTHLY_LOSS_PCT', 0.15),
    // Confiance minimale du LLM pour autoriser une ouverture.
    minConfidence: num('MIN_CONFIDENCE', 0.35),

    // ── Seuils appliqués à la PRÉVISION du modèle ─────────────────────────
    // Le modèle ne choisit plus l'action : il annonce une répartition d'issues
    // sur 100 scénarios, et c'est ici qu'on décide quoi en faire. Ce
    // déplacement est délibéré. Un LLM entraîné par RLHF privilégie la réponse
    // prudente quand on lui demande d'agir — le biais penche vers HOLD, pour
    // des raisons de politesse apprise et non d'analyse. En lui demandant
    // seulement de prévoir, puis en fixant NOUS-MÊMES le seuil de passage à
    // l'acte, on récupère la prévision sans hériter du biais, et le seuil
    // devient un paramètre visible et mesurable au lieu d'un réflexe caché.
    //
    // 0,20 d'écart : il faut 60/40 au minimum, pas 51/49. En dessous, l'écart
    // est indiscernable du bruit d'estimation du modèle lui-même.
    minEdge: num('MIN_EDGE', 0.2),
    // Et une probabilité haussière absolue suffisante. L'écart seul ne suffit
    // pas : un 20/0/80 affiche 20 points d'écart alors que le modèle annonce
    // 80 % de chances qu'il ne se passe rien. Ce seuil écarte ces cas où le
    // pari porte sur un scénario minoritaire.
    //
    // Il est atteint de justesse par un 40/20/40, qui passe donc — et c'est
    // volontaire : à 40 contre 20, la hausse reste deux fois plus probable que
    // la baisse, l'espérance est positive, et la bande d'indécision ne coûte
    // presque rien. Ce n'est pas le cas que ce garde-fou vise.
    minUpProbability: num('MIN_UP_PROBABILITY', 0.4),

    // ── Seuil relevé quand les actualités manquent ────────────────────────
    // Mesuré, pas supposé. En rejouant une séance sans actualités
    // reconstituables, le modèle a penché à la baisse dans 9 cas sur 10 — alors
    // que la consigne du prompt lui demande explicitement de RESSERRER vers
    // l'équilibre quand une des deux sources manque. Il lit l'absence
    // d'information comme une mauvaise nouvelle.
    //
    // On ne corrige pas sa prévision : elle doit rester telle qu'annoncée, sans
    // quoi la mesure de calibration mesurerait nos retouches. On exige
    // simplement DAVANTAGE d'écart avant d'agir — moins d'information, plus de
    // preuves. Le seuil s'applique dans les deux sens : une sortie déclenchée
    // par une panne de flux RSS coûte le tail droit d'une position saine.
    //
    // 0,35 est provisoire. Dès que le carnet fantôme comptera assez de
    // décisions en mode dégradé, le décalage réel sera mesurable et remplacera
    // ce chiffre.
    minEdgeDegraded: num('MIN_EDGE_DEGRADED', 0.35),
  },

  /**
   * ── Classement transversal ────────────────────────────────────────────
   * Le modèle ordonne des lots au lieu de noter des actifs isolés. Mesuré sur
   * l'API réelle : 10 rangs distincts sur 10, contre 3 valeurs distinctes sur
   * 20 réponses en notation.
   */
  ranking: {
    /**
     * Taille des lots.
     *
     * Dix est le compromis documenté : au-delà, la fenêtre d'attention se
     * dégrade au milieu de la liste ; en deçà, on multiplie les appels sans
     * gagner en information puisqu'un lot de m actifs porte m−1 comparaisons.
     */
    tailleLot: num('RANKING_TAILLE_LOT', 10),

    /**
     * Nombre de tours de re-partitionnement.
     *
     * Mesuré par simulation à 150 actifs, pour un signal d'écart-type 0,3 :
     *
     *     2 tours (30 appels) → puissance 19 %
     *     3 tours (45 appels) → puissance 31 %
     *     4 tours (60 appels) → puissance 51 %
     *     6 tours (90 appels) → puissance 68 %
     *
     * Quatre tours placent le bot au-dessus d'une chance sur deux de détecter
     * un signal réel, pour 60 appels — moins que les 150 de la notation
     * individuelle. C'est là que la courbe commence à s'aplatir.
     */
    tours: num('RANKING_TOURS', 4),

    /**
     * Tirages de la calibration bootstrap.
     *
     * Sert à établir la distribution du rapport de vraisemblance sous
     * l'hypothèse « le modèle ne différencie rien ». Ne consomme aucun appel
     * d'API, uniquement du calcul : environ 2,5 s pour 200 tirages à 150
     * actifs, une fois par cycle.
     */
    tiragesBootstrap: num('RANKING_TIRAGES_BOOTSTRAP', 200),

    /**
     * Exiger que le test global soit significatif pour autoriser un achat.
     *
     * C'est le remplaçant de la garde de dispersion, qui surveillait la
     * largeur de la distribution des notes et laissait donc passer cinquante
     * ex æquo au sommet sans broncher.
     */
    exigerSignificativite: bool('RANKING_EXIGER_SIGNIFICATIVITE', true),
  },

  broker: {
    // `alpaca` = compte paper réel chez Alpaca (recommandé).
    // `paper`  = simulateur interne, conservé pour les tests hors ligne.
    kind: str('BROKER', 'alpaca'),
    feePct: num('FEE_PCT', 0),
    slippagePct: num('SLIPPAGE_PCT', 0),
    alpaca: {
      keyId: str('ALPACA_KEY_ID'),
      secretKey: str('ALPACA_SECRET_KEY'),
      baseUrl: str('ALPACA_BASE_URL', 'https://paper-api.alpaca.markets'),
      dataUrl: str('ALPACA_DATA_URL', 'https://data.alpaca.markets'),
    },
  },

  news: {
    providers: list('NEWS_PROVIDERS', ['finnhub', 'newsapi', 'rss']),
    lookbackHours: num('NEWS_LOOKBACK_HOURS', 48),
    maxArticles: num('NEWS_MAX_ARTICLES', 6),
    finnhubKey: str('FINNHUB_API_KEY'),
    newsapiKey: str('NEWSAPI_KEY'),
    // Remplace les noms d'entreprise par des jetons génériques avant l'appel
    // LLM. Contre-intuitif mais démontré (Glasserman & Lin 2023) : supprime
    // « l'effet de distraction » et améliore la performance hors échantillon.
    anonymize: bool('NEWS_ANONYMIZE', true),
  },

  storage: {
    dir: path.isAbsolute(str('DATA_DIR', './data'))
      ? str('DATA_DIR', './data')
      : path.resolve(ROOT, str('DATA_DIR', './data')),
  },
};

/**
 * Vérifie la cohérence de la configuration au démarrage.
 * Retourne la liste des avertissements (non bloquants) ; lève sur erreur fatale.
 */
export function validateConfig() {
  const warnings = [];

  if (config.llm.provider === 'gemini' && !config.llm.apiKeys.length) {
    warnings.push('Aucune clé dans GEMINI_API_KEYS/GEMINI_API_KEY — ajoute-en via `npm run keys:add`.');
  }
  if (!config.server.adminToken) {
    warnings.push('ADMIN_TOKEN absent → les routes d\'écriture sont désactivées.');
  }
  if (config.broker.kind === 'alpaca') {
    if (!config.broker.alpaca.keyId || !config.broker.alpaca.secretKey) {
      throw new Error('BROKER=alpaca exige ALPACA_KEY_ID et ALPACA_SECRET_KEY.');
    }
    if (!config.broker.alpaca.baseUrl.includes('paper-api')) {
      warnings.push('⚠️  ALPACA_BASE_URL ne pointe PAS vers paper-api : ordres sur compte RÉEL.');
    }
  }
  if (!config.universe.symbols.length) {
    throw new Error('SYMBOLS est vide : aucun actif à analyser.');
  }
  if (config.risk.maxPositionPct <= 0 || config.risk.maxPositionPct > 1) {
    throw new Error('MAX_POSITION_PCT doit être compris entre 0 et 1.');
  }
  if (config.risk.initialCapital <= 0) {
    throw new Error('INITIAL_CAPITAL doit être strictement positif.');
  }

  // Le quota LLM doit couvrir l'univers : sinon les derniers actifs de chaque
  // cycle basculeront systématiquement sur le moteur heuristique.
  const callsPerCycle = config.universe.symbols.length;
  if (config.llm.callsPerKeyPerDay > 0 && callsPerCycle > config.llm.callsPerKeyPerDay) {
    warnings.push(
      `${callsPerCycle} actifs pour ${config.llm.callsPerKeyPerDay} appels/jour/clé : un seul cycle épuise le quota.`,
    );
  }

  // ── Couverture de l'anonymisation ───────────────────────────────────────
  // Un symbole sans dictionnaire d'entités part avec ses dirigeants et ses
  // produits en clair. Le modèle identifie alors l'entreprise et répond depuis
  // sa mémoire plutôt que depuis les faits du jour — ce que le carnet fantôme
  // enregistrera comme une prévision, sans moyen de le distinguer.
  //
  // L'avertissement est ici, et pas seulement dans un script à lancer à la
  // main, parce que c'est au démarrage qu'il faut le voir : une fois le bot
  // parti, les décisions contaminées s'accumulent en silence.
  if (config.news.anonymize) {
    const c = entityCoverage(config.universe.symbols);
    const manquants = c.partiels.length + c.absents.length;
    if (manquants > 0) {
      warnings.push(
        `Anonymisation incomplète : ${c.couverts}/${c.total} symboles couverts. `
        + `${manquants} partiront avec dirigeants et produits en clair — leurs décisions sont `
        + 'contaminées par la mémoire du modèle. Corriger avec `npm run entities:build`, '
        + 'détail avec `npm run entities`.',
      );
    }
  }

  // ── Cohérence entre le nombre de positions et leur taille ────────────────
  // Ces deux réglages sont indépendants alors qu'ils décrivent le même
  // partage du capital. Une incohérence ne provoque aucune erreur : le bot
  // ouvre simplement moins de positions que demandé, faute de cash, et se
  // comporte comme si le plafond n'avait jamais changé.
  //
  // C'est exactement ce qui s'est produit en passant de 3 à 10 positions sans
  // toucher à l'enveloppe : la cible atteignait 350 % de l'équity et sept
  // lignes sur dix étaient refusées, sans le moindre message.
  const exposition = config.risk.maxPositions * config.risk.maxPositionPct;
  if (exposition > 1.05) {
    const possible = Math.floor(1 / config.risk.maxPositionPct);
    warnings.push(
      `Dimensionnement incohérent : ${config.risk.maxPositions} positions × `
      + `${(config.risk.maxPositionPct * 100).toFixed(0)} % = ${(exposition * 100).toFixed(0)} % de l'équity. `
      + `Le cash s'épuisera après ~${possible} ligne(s) et les suivantes seront refusées sans erreur. `
      + `Fixer MAX_POSITION_PCT à ${(1 / config.risk.maxPositions).toFixed(2)} pour un poids réellement égal.`,
    );
  } else if (exposition < 0.5) {
    warnings.push(
      `Capital sous-employé : ${config.risk.maxPositions} × `
      + `${(config.risk.maxPositionPct * 100).toFixed(0)} % = ${(exposition * 100).toFixed(0)} % de l'équity investie au maximum.`,
    );
  }

  // Une ligne trop petite pour le plancher d'ordre ne sera jamais exécutée.
  const ligneTypique = config.risk.initialCapital * config.risk.maxPositionPct;
  if (ligneTypique < config.risk.minOrderValue) {
    warnings.push(
      `Lignes trop petites : ${ligneTypique.toFixed(2)} par position, sous le plancher `
      + `de ${config.risk.minOrderValue}. Aucun ordre ne passera. Réduire MAX_POSITIONS ou MIN_ORDER_VALUE.`,
    );
  }

  return warnings;
}
