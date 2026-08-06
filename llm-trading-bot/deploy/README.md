# Mise en ligne du bot

## Pourquoi Oracle Cloud et pas Render

Le bot a deux contraintes que la plupart des paliers gratuits ne satisfont pas :

**Il lui faut un disque qui persiste.** Tout l'état — carnet fantôme, positions,
clés, spreads mesurés — vit dans des fichiers JSON sous `data/`. Le SPRT a besoin
d'environ 50 observations, soit une semaine de bourse. Un système de fichiers
remis à zéro à chaque redéploiement fait repartir la mesure de zéro **sans que
rien ne le signale** : le dashboard afficherait simplement « 0 en attente ».

**Il doit rester allumé.** Les décisions sont prises par un cron interne à 16:30,
19:30 et 21:30 heure de Paris. Un service qui s'endort après quinze minutes
d'inactivité ne se réveille pas tout seul pour honorer un cron — les cycles sont
purement et simplement sautés.

Vérifié en août 2026 :

| | Disque persistant | Reste allumé | Verdict |
|---|---|---|---|
| Render gratuit | non — réservé aux offres payantes | non — dort après 15 min | éliminé |
| Fly.io | plus de palier gratuit pour les nouveaux comptes | — | éliminé |
| **Oracle Always Free** | **oui, 200 Go** | **oui** | **retenu** |

Oracle demande une carte bancaire à l'inscription pour vérifier l'identité, mais
les ressources « Always Free » ne sont jamais débitées : elles sont refusées
plutôt que facturées si tu dépasses.

## Ce qu'il te faut créer chez Oracle

1. Compte sur <https://www.oracle.com/cloud/free/> — choisis une **région proche
   de toi** et retiens-la, on ne peut plus la changer ensuite.
2. **Compute → Instances → Create instance**
   - Image : **Ubuntu 24.04**
   - Forme : **VM.Standard.A1.Flex**, 1 OCPU / 6 Go (ARM, dans l'enveloppe
     gratuite). Si Oracle répond « Out of capacity », prends
     **VM.Standard.E2.1.Micro** (AMD, 1 Go) — largement suffisant ici, le bot
     consomme quelques dizaines de Mo.
   - Réseau : coche **Assign a public IPv4 address**
   - Clé SSH : **génère et télécharge la clé privée**, tu ne pourras plus l'avoir après
3. Note l'**adresse IP publique** affichée après création.
4. **Networking → Virtual Cloud Networks → ton VCN → Security Lists → Default**
   → *Add Ingress Rules* : source `0.0.0.0/0`, TCP, ports **80** et **443**.
   Oracle bloque tout par défaut, y compris ce que `ufw` autorise côté machine —
   les deux niveaux doivent être ouverts.

## Installation

Connecte-toi (depuis PowerShell, la clé téléchargée à l'étape 2) :

```bash
ssh -i ~/Downloads/ssh-key.key ubuntu@<TON-IP>
```

Puis :

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <ton-dépôt> /tmp/bot && sudo bash /tmp/bot/llm-trading-bot/deploy/install.sh
```

Le script installe Node 22, crée un utilisateur de service sans shell, prépare
`/opt/llm-trading-bot/backend/data`, enregistre le service systemd et configure
le pare-feu. Il affiche ensuite les trois étapes restantes.

## Les trois étapes que le script ne peut pas faire pour toi

### 1. Le code

```bash
sudo -u botuser git clone <ton-dépôt> /opt/llm-trading-bot/src
sudo -u botuser npm --prefix /opt/llm-trading-bot/src/llm-trading-bot/backend ci --omit=dev
```

### 2. Les secrets

`.env` est dans `.gitignore` : il n'arrivera jamais par le dépôt, et c'est voulu.

```bash
cd /opt/llm-trading-bot/src/llm-trading-bot/backend
sudo -u botuser cp .env.example .env
sudo -u botuser nano .env
```

À renseigner : `GEMINI_API_KEYS`, `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`,
`ADMIN_TOKEN`, et **impérativement** :

```
CORS_ORIGINS=https://llm-trading-bot-dashboard.netlify.app
```

Sans cette ligne, le navigateur bloquera le dashboard même si le back-end
fonctionne parfaitement.

### 3. Tes données existantes

**C'est l'étape qu'on oublie, et elle coûte une semaine.** Le dossier `data/` est
gitignoré : il ne suivra pas ton push. Sans lui, tes décisions déjà enregistrées
disparaissent et le compteur du SPRT repart de zéro.

Depuis Windows, dans le dossier `backend` :

```bash
scp -i ~/Downloads/ssh-key.key -r data/* ubuntu@<TON-IP>:/tmp/data/
```

Puis sur le serveur :

```bash
sudo mkdir -p /opt/llm-trading-bot/backend/data
sudo cp /tmp/data/* /opt/llm-trading-bot/backend/data/
sudo chown -R botuser:botuser /opt/llm-trading-bot/backend/data
```

## Démarrage

```bash
sudo systemctl start llm-trading-bot
sudo journalctl -u llm-trading-bot -f
```

Tu dois voir `API en écoute sur le port 8099`, le nombre de clés Gemini, et
`Planificateur actif`.

## HTTPS

Le dashboard est servi en HTTPS par Netlify ; un navigateur refuse qu'une page
HTTPS appelle une API en HTTP. Il faut donc un certificat, et Let's Encrypt ne
signe pas les adresses IP — il faut un nom.

1. <https://www.duckdns.org> → connexion, crée un sous-domaine, renseigne l'IP
   publique de ta VM.
2. Sur le serveur :

```bash
sudo bash /opt/llm-trading-bot/src/llm-trading-bot/deploy/setup-https.sh mon-bot.duckdns.org
```

Le script vérifie d'abord que le DNS pointe bien vers cette machine — autant
échouer avec un message clair que de laisser Caddy boucler sur un certificat
impossible à obtenir.

Ensuite, dans le dashboard → **Réglages** → URL du back-end :
`https://mon-bot.duckdns.org`

À partir de là le dashboard fonctionne depuis n'importe où, y compris ton
téléphone, sans rien lancer sur ton PC.

## Mises à jour

```bash
sudo bash /opt/llm-trading-bot/src/llm-trading-bot/deploy/update.sh
```

Le script sauvegarde `data/` avant toute chose, récupère le code, **fait tourner
les tests**, et ne redémarre le bot que s'ils passent. En cas d'échec il revient
au commit précédent sans toucher au service : un bot qui passe des ordres ne
redémarre pas sur du code cassé.

## Deux pièges à connaître

**Ne fais jamais tourner deux instances sur le même dossier `data/`.** Le
stockage JSON est en « dernier écrivain gagne », sans verrou. Deux processus qui
se chevauchent, et l'un écrase l'état de l'autre. C'est exactement comme ça
qu'une clé Gemini ajoutée depuis le dashboard a disparu pendant le développement.
Donc : arrête le bot local avant de démarrer celui du serveur.

**Le stop-loss n'existe pas chez Alpaca.** Il est vérifié par le code à chaque
cycle, soit trois fois par jour. Entre 16:30 et 19:30, une chute de 20 % passe
inaperçue jusqu'au cycle suivant. Acceptable sur un compte de démonstration à
100 $ ; à revoir avant tout passage en réel.

## Vérifier que tout va bien

```bash
systemctl status llm-trading-bot        # le service tourne
journalctl -u llm-trading-bot --since '1 hour ago' | grep -E '→|Cycle'
curl -s localhost:8099/api/diagnostic   # rapport complet en texte
```

Ce dernier est le même rapport que le bouton **Diagnostic** du dashboard : à
copier-coller tel quel si quelque chose te paraît anormal.
