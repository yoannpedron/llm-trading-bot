# Prompts Deep Research — améliorer la rentabilité du bot

Prompts prêts à coller dans **Gemini Deep Research** (ou Perplexity Deep Research / ChatGPT Deep
Research). Chacun est calibré pour produire un rapport documenté et *actionnable* sur ce bot précis,
pas une dissertation générique.

## Comment s'en servir

1. Colle le prompt tel quel — ils sont autoportants (contexte du bot inclus).
2. Exige toujours les sources : les prompts le demandent explicitement.
3. **Rien n'est appliqué sans backtest.** Un résultat de recherche est une hypothèse, pas un signal.
   Le prompt n°6 sert précisément à ne pas se faire piéger par un résultat trop beau.
4. Ordre recommandé : **6 → 1 → 4 → 2 → 3 → 5 → 7 → 8**. Commencer par la méthodologie de
   validation évite de construire sur du sable.

> ⚠️ Ces prompts cherchent des **inefficiences de marché documentées publiquement** — c'est le
> travail normal d'un quant. Ils ne couvrent pas, et ne doivent pas couvrir, la manipulation de
> cours, l'information privilégiée ou l'exploitation technique d'un courtier : c'est illégal, et
> aucun de ces angles n'est nécessaire pour construire un edge réel.

---

## 1. Anomalies de marché exploitables à petit capital

```
Tu es un chercheur quantitatif senior. Produis un rapport documenté sur les anomalies de marché
(market anomalies) encore statistiquement significatives sur les actions américaines liquides
depuis 2015, exploitables par un trader particulier disposant de 100 € de capital, en swing
trading sur des bougies horaires ou journalières.

Pour CHAQUE anomalie identifiée, fournis obligatoirement :
1. Le nom académique et la référence originale (auteur, année, revue, DOI si disponible)
2. La règle d'entrée et de sortie, formulée assez précisément pour être codée sans ambiguïté
3. Le rendement excédentaire annualisé rapporté, ET le Sharpe ratio, ET le drawdown maximum
4. La période de test et surtout : la performance APRÈS publication de l'article
   (décroissance de l'alpha — cite McLean & Pontiff 2016 et les travaux plus récents)
5. Le coût de transaction au-delà duquel l'anomalie n'est plus rentable, en points de base
6. Les contraintes de capacité : l'anomalie survit-elle à 100 € ? à 100 000 € ?
7. Une réplication indépendante existe-t-elle ? Si non, signale-le explicitement

Couvre au minimum : momentum court terme et long terme, réversion à la moyenne intraday,
post-earnings announcement drift, effets calendaires (turn-of-the-month, jour de la semaine),
anomalies overnight vs intraday, effet de dérive post-gap.

Classe les résultats dans un tableau final par ratio (robustesse × simplicité d'implémentation),
et signale explicitement celles qui ont été invalidées ou dont l'alpha a disparu après 2015.
Distingue clairement ce qui est démontré de ce qui relève du folklore de forums de trading.
```

## 2. Le LLM comme moteur de décision de trading — état de l'art

```
Fais une revue de littérature approfondie et critique sur l'utilisation des grands modèles de
langage (LLM) pour la prise de décision d'investissement, entre 2023 et aujourd'hui.

Structure attendue :
1. Les papiers de référence (FinGPT, FinMem, TradingGPT, Alpha-GPT, StockAgent, les travaux de
   Lopez-Lira & Tang sur ChatGPT et les rendements boursiers) : méthodologie, données, résultats
   chiffrés, et surtout les LIMITES reconnues par les auteurs eux-mêmes
2. Le problème du look-ahead bias : les LLM ont mémorisé l'historique des cours pendant leur
   entraînement. Quelles méthodes existent pour détecter et neutraliser cette contamination dans
   un backtest ? Cite les protocoles concrets.
3. Les techniques de prompting qui améliorent MESURABLEMENT la qualité des décisions financières :
   chain-of-thought, self-consistency, réflexion multi-agents, injection de mémoire des trades
   passés. Quel gain chiffré pour quel surcoût en tokens ?
4. La calibration de la confiance : les LLM sont-ils sur-confiants sur les prédictions
   financières ? Comment recalibrer un score de confiance auto-déclaré ?
5. Les résultats NÉGATIFS et les échecs de réplication — je veux savoir où ça ne marche pas.

Pour chaque technique, indique si elle est applicable à un budget de 20 à 200 appels LLM par jour.
Termine par les 5 recommandations les plus rentables en rapport gain/effort, et les 3 pièges
méthodologiques qui invalident le plus souvent ce type de travaux.
```

## 3. Sentiment d'actualités — ce qui marche vraiment

```
Rapport de recherche : quelle est la valeur prédictive réelle du sentiment extrait des actualités
financières sur les rendements d'actions à horizon 1 heure, 1 jour et 1 semaine ?

Traite obligatoirement :
1. Les études quantifiant l'alpha du sentiment de presse (Tetlock 2007, Heston & Sinha,
   Ke/Kelly/Xiu "Predicting Returns with Text Data", et les travaux post-2020)
2. La vitesse d'incorporation de l'information : combien de temps une nouvelle publique met-elle
   à être intégrée dans le prix ? Un bot qui lit un flux RSS gratuit avec 15 à 60 minutes de
   latence a-t-il encore un edge exploitable, ou arrive-t-il structurellement trop tard ?
3. Quels TYPES d'actualités déplacent réellement les cours, classés par ampleur d'effet mesurée :
   résultats trimestriels, guidance, changements de notation analyste, procédures réglementaires,
   départs de dirigeants, rappels produit, contrats majeurs
4. Le biais de sur-réaction : quelles catégories de nouvelles provoquent une réversion à 3-5 jours
   plutôt qu'une continuation ? C'est là que se trouve le contre-pied rentable.
5. La différence mesurée entre sentiment par lexique, par modèle spécialisé (FinBERT) et par LLM
   généraliste

Conclus par : quel est le seuil de latence au-delà duquel le sentiment de presse cesse d'être
rentable, et quelles sources gratuites ou peu coûteuses restent sous ce seuil ? Cite des chiffres.
```

## 4. Position sizing et gestion du risque — le vrai levier

```
Rapport technique approfondi sur le dimensionnement de position et la gestion du risque pour un
portefeuille de très petite taille (100 à 1000 €) tradant 3 à 10 actions américaines.

Couvre :
1. Critère de Kelly et Kelly fractionnaire : formulation exacte, pourquoi le Kelly plein est
   dangereux en pratique, quelle fraction retiennent les praticiens et pourquoi. Comment estimer
   l'espérance et la variance quand on n'a que 30 à 100 trades d'historique — et à partir de
   combien de trades l'estimation devient-elle fiable ?
2. Volatility targeting et position sizing basé sur l'ATR : formules, choix des paramètres,
   preuves empiriques d'amélioration du Sharpe. Compare à une taille fixe.
3. Stops : littérature comparant stop fixe en %, stop ATR, stop suiveur (trailing) et absence de
   stop. Sur quels régimes de marché chaque approche domine-t-elle ? Le stop détruit-il l'alpha
   sur les stratégies de momentum ?
4. Le coût réel des frottements à petite taille : spread bid-ask, commissions, slippage sur
   fractions d'actions. À partir de quelle taille de position ces frottements mangent-ils
   l'espérance de gain ? Donne un seuil chiffré en euros.
5. Coupe-circuits et limites de perte journalière : est-ce statistiquement bénéfique ou est-ce
   simplement du confort psychologique qui coupe les stratégies gagnantes ?

Termine par un tableau de paramètres recommandés pour un capital de 100 €, avec la justification
empirique de chaque valeur. Sois honnête si la conclusion est qu'un capital de 100 € rend certains
mécanismes inapplicables.
```

## 5. Choix de l'univers d'actifs

```
Recherche : sur quels instruments un bot de swing trading algorithmique piloté par IA, disposant
de 100 € et prenant 5 à 30 décisions par jour, a-t-il la meilleure espérance de gain nette de
frais ?

Compare rigoureusement, chiffres à l'appui :
1. Actions US très liquides (méga-capitalisations) — spread typique, volatilité réalisée,
   disponibilité des fractions d'actions chez les courtiers accessibles depuis la France
2. Actions US de moyenne capitalisation et actions à forte volatilité — plus d'amplitude mais
   quel coût en spread et en risque de gap ?
3. ETF indiciels et ETF sectoriels — moins de risque idiosyncratique, mais reste-t-il assez
   d'amplitude pour couvrir les frais ?
4. Crypto majeures (BTC, ETH) — marché 24/7, donc plus d'opportunités de cycles, mais quelle
   est la rentabilité nette après frais chez les plateformes accessibles ?
5. Forex majeurs — spreads très serrés mais amplitude faible sans levier

Pour chaque classe : spread moyen en points de base, volatilité horaire et journalière moyenne,
frais typiques chez les courtiers accessibles depuis la France, montant minimum d'ordre, et
surtout le RATIO amplitude moyenne / coût total aller-retour. C'est ce ratio qui détermine si une
stratégie peut être rentable, indique-le explicitement pour chaque classe.

Conclus par le classement des 5 meilleurs tickers ou paires pour ce profil précis, avec la
justification chiffrée. Précise les contraintes réglementaires françaises et européennes
pertinentes (PRIIPs pour les ETF US, disponibilité des fractions d'actions, fiscalité).
```

## 6. Ne pas se mentir — méthodologie de validation

```
Guide méthodologique exhaustif : comment backtester honnêtement une stratégie de trading
algorithmique et éviter d'obtenir un résultat qui ne se reproduira jamais en réel ?

Détaille chaque biais avec un exemple concret de code ou de procédure qui l'introduit, et la
parade correspondante :
1. Look-ahead bias et survivorship bias
2. Data snooping et p-hacking : combien de stratégies peut-on tester avant que le meilleur
   résultat ne soit du pur bruit ? Explique et illustre le Deflated Sharpe Ratio de Bailey et
   López de Prado, et la correction du multiple testing
3. Overfitting sur les hyperparamètres : purged k-fold cross-validation avec embargo,
   combinatorial purged CV — explique le principe et quand chacune s'impose
4. Modélisation réaliste des coûts : spread, slippage dépendant du volume, impact de marché,
   ordres non exécutés, gaps d'ouverture
5. Régimes de marché : une stratégie validée sur 2015-2020 survit-elle à 2022 ? Comment tester
   la robustesse par régime plutôt que sur une moyenne qui masque tout ?

Puis : quel est le nombre MINIMUM de trades nécessaire pour affirmer avec une confiance
statistique raisonnable qu'une stratégie a une espérance positive, en fonction de son Sharpe
supposé ? Donne la formule et un tableau de valeurs.

Termine par une checklist de validation en 10 points à passer avant d'engager du capital réel, et
par la liste des signaux d'alerte qui doivent faire rejeter un backtest immédiatement.
```

## 7. Détection de régime de marché

```
Rapport sur la détection de régime de marché appliquée au trading algorithmique.

1. Quelles méthodes permettent de classifier en temps réel le régime courant (tendance haussière,
   tendance baissière, range, forte volatilité) à partir de données de prix uniquement ? Couvre
   les modèles de Markov à chaînes cachées, les indicateurs de volatilité réalisée, la
   classification par ADX/efficiency ratio, et les approches par clustering.
2. Quelles familles de stratégies fonctionnent dans quel régime ? Le momentum échoue-t-il
   systématiquement en range, et la réversion à la moyenne en tendance ? Quantifie l'écart de
   performance avec des sources.
3. Quel est le délai de détection typique d'un changement de régime, et ce délai annule-t-il le
   bénéfice de l'adaptation ? C'est la question centrale, traite-la sérieusement.
4. Comment un LLM peut-il être utilisé pour la classification de régime, et est-ce plus fiable
   qu'un modèle statistique classique ? Cite les comparaisons existantes.
5. Quels indicateurs macro accessibles gratuitement (VIX, courbe des taux, indices de largeur de
   marché, put/call ratio) améliorent la détection ?

Conclus par une méthode de détection concrètement implémentable avec des données gratuites, et par
la règle d'allocation associée. Indique honnêtement si la littérature soutient que le jeu en vaut
la chandelle pour un petit portefeuille.
```

## 8. Ingénierie de prompt pour la décision financière

```
Recherche appliquée : comment structurer un prompt pour qu'un LLM produise les meilleures
décisions de trading possibles, avec un budget limité à un seul appel par actif et par cycle ?

1. Quelle est la meilleure façon de présenter des séries temporelles de prix à un LLM ? Compare
   les formats étudiés : tableau brut de bougies, indicateurs pré-calculés, description en
   langage naturel, représentation textuelle compressée. Existe-t-il des benchmarks comparant
   ces formats sur des tâches de prédiction financière ?
2. Combien de bougies historiques faut-il fournir avant que la performance ne plafonne ou ne se
   dégrade ? Cite les travaux sur la dégradation de l'attention en contexte long ("lost in the
   middle") et leurs implications ici.
3. Le fait de demander au modèle un raisonnement explicite avant sa décision améliore-t-il la
   qualité mesurée, ou produit-il surtout une rationalisation a posteriori ? Que dit la
   littérature sur la fidélité du chain-of-thought ?
4. Comment formuler les contraintes de risque pour qu'un LLM les respecte réellement ? Quelles
   techniques réduisent le taux de violation des contraintes dans une sortie structurée ?
5. Comment obtenir un score de confiance calibré plutôt qu'un nombre auto-déclaré sans valeur ?
   Couvre le sampling multiple avec vote, la log-probabilité des tokens, la vérification croisée.
6. Le modèle doit-il connaître ses positions ouvertes et son historique de décisions ? Quel est
   l'effet mesuré de cette mémoire sur la cohérence et sur le biais de disposition (garder les
   perdants, vendre les gagnants) ?

Pour chaque point, donne une recommandation concrète et le gain attendu. Termine par un modèle de
prompt système optimisé pour la décision de trading, et par les 3 erreurs de prompting qui
dégradent le plus les performances.
```

---

## Après la recherche : le protocole

Un rapport de recherche ne rapporte rien tant qu'il n'est pas validé sur tes propres données.

1. **Extraire** de chaque rapport les hypothèses testables (« le RSI < 30 sur bougie horaire
   produit un rendement positif à 5 bougies sur les méga-caps »).
2. **Backtester** chaque hypothèse isolément, avec les coûts réels du bot (`FEE_PCT`,
   `SLIPPAGE_PCT`), sur une période *non utilisée* pour la découvrir.
3. **Appliquer la checklist** du prompt n°6 avant toute intégration.
4. **Laisser tourner en paper trading** plusieurs mois. Le bot journalise chaque décision : c'est
   exactement le matériau nécessaire pour mesurer un taux de réussite réel.
5. Ne modifier **qu'un seul paramètre à la fois**, sinon aucune conclusion n'est attribuable.

Un point de réalisme, à garder en tête en lisant les rapports : sur 100 € de capital, un aller-retour
coûte environ 0,15 % en frais et slippage avec les réglages par défaut. Une stratégie doit donc
générer plus de 0,15 % de gain moyen par trade rien que pour rentrer dans ses frais. C'est la
contrainte qui élimine la majorité des idées séduisantes — et c'est pour cela que le prompt n°4
(dimensionnement et frottements) est probablement celui qui aura le plus d'impact sur ton résultat
final, bien avant la recherche d'un signal magique.
