# Front-end — dashboard

Page statique, **sans build ni dépendance** : trois fichiers (`index.html`, `assets/app.js`,
`assets/styles.css`). Rien à installer, rien à compiler.

En lecture seule par construction : l'interface n'appelle que `GET /api/dashboard`. Impossible de
passer un ordre depuis le navigateur, même en modifiant le code côté client — les routes d'écriture
du back-end exigent `ADMIN_TOKEN`, qui n'est jamais envoyé au front.

## Contenu

- **4 indicateurs clés** — capital total, liquidités, P&L réalisé, positions ouvertes
- **Courbe d'équity** en SVG pur (aucune librairie de graphiques), avec la ligne du capital initial
- **Positions ouvertes** — quantité, PRU, cours, valeur, P&L latent, stop et objectif
- **État du moteur** — statut, dernier cycle, modèle IA, univers, fréquence, coupe-circuit
- **Journal de l'IA** — pour chaque décision : action, confiance, justification, lecture technique,
  lecture des actualités, risques identifiés, titres de presse sources, indicateurs du moment
- **Historique des ordres** — avec frais et P&L réalisé

Thème clair/sombre automatique selon les préférences du système, responsive jusqu'au mobile.

## Déploiement Netlify

### Par l'interface (le plus simple)

1. [app.netlify.com](https://app.netlify.com) → **Add new site** → **Deploy manually**
2. Glisse-dépose le dossier `frontend/`
3. Le site est en ligne. `netlify.toml` applique automatiquement les en-têtes de sécurité.

### Par dépôt Git (déploiement continu)

**Add new site** → **Import an existing project** → sélectionne le dépôt front-end.

- Build command : *(vide)*
- Publish directory : `.` (ou `frontend` si les deux dossiers sont dans le même dépôt)

Chaque `git push` redéploie automatiquement.

### Par CLI

```bash
npx netlify-cli deploy --dir=frontend --prod
```

## Configuration

Au premier chargement, clique sur **Réglages** et saisis l'URL de ton back-end
(ex. `https://mon-bot.onrender.com`). Elle est stockée dans le `localStorage` du navigateur : pas de
rebuild nécessaire pour la changer, et l'adresse n'est pas écrite en dur dans le code publié.

Le champ **Jeton administrateur** est optionnel. Renseigne-y l'`ADMIN_TOKEN` de ton back-end pour
débloquer la gestion des clés API depuis l'interface. Il reste lui aussi dans le `localStorage` de
ton navigateur : il n'est jamais publié avec le site, et un visiteur qui ouvre l'URL ne voit qu'un
dashboard en lecture seule.

## Gérer les clés Gemini depuis l'interface

Avec le jeton admin renseigné, la carte **Clés API Gemini** devient interactive :

- **Jauge de capacité** — appels consommés sur le total du jour, nombre de cycles que cela permet,
  et le `CRON_SCHEDULE` correspondant. Quand le quota est dépassé, elle l'annonce explicitement et
  rappelle que le bot bascule sur son moteur heuristique.
- **Tableau des clés** — nom, clé masquée, origine (`.env` ou ajoutée), consommation, jauge de quota
  individuelle et état. Une clé venant du `.env` ne peut être retirée que du `.env`.
- **Ajouter une clé** — la clé est **testée auprès de Google avant d'être enregistrée**. Trois cas
  distingués : clé valide, clé valide mais quota déjà atteint (ajoutée et marquée pour demain), clé
  invalide ou révoquée (refusée). La nouvelle capacité s'affiche immédiatement.
- **Tester les clés** — re-teste tout le pool sans consommer de quota de génération. Utile pour
  savoir laquelle est à sec, ou pour lever un marquage devenu obsolète après le reset.

La clé transite en clair dans le corps de la requête POST : ton back-end doit être en **HTTPS** dès
qu'il n'est plus sur `localhost`.

Pour figer l'URL par défaut, ajoute avant le `<script src="assets/app.js">` dans `index.html` :

```html
<script>window.__API_URL__ = 'https://mon-bot.onrender.com';</script>
```

## Deux pièges classiques

**Contenu mixte et réseau local.** Une page servie en HTTPS par Netlify ne peut pas appeler une API
en `http://` sur un domaine public : le navigateur bloque et le dashboard reste vide. Ton back-end
doit être en HTTPS — Render et Fly.io le font d'office ; sur un VPS, mets Caddy ou Nginx devant.

Cas particulier de `http://localhost` : Chrome l'autorise, mais applique le contrôle *Private
Network Access* — une page publique qui contacte le réseau local doit recevoir l'en-tête
`Access-Control-Allow-Private-Network: true`. Le back-end le renvoie, donc pointer le dashboard
Netlify vers `http://localhost:8099` fonctionne. Si ton navigateur refuse malgré tout, sers
simplement le dashboard en local :

```bash
npx serve frontend -l 5174
```

**CORS.** Le back-end doit autoriser le domaine du dashboard. En production, remplace
`CORS_ORIGINS=*` par l'URL exacte de ton site Netlify.

## Confidentialité

Le dashboard est public : toute personne connaissant l'URL voit le portefeuille et le journal de
l'IA (aucune clé n'est exposée, mais les montants et décisions le sont). Pour le restreindre, active
la protection par mot de passe de Netlify (plan payant) ou Netlify Identity.
