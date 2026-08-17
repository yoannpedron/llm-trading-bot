#!/usr/bin/env bash
#
# Mise à jour du bot depuis le dépôt, sans perdre l'état.
#
#   sudo bash /opt/llm-trading-bot/src/llm-trading-bot/deploy/update.sh
#
# ── Le point délicat ─────────────────────────────────────────────────────────
# Le dossier de données vit HORS du dépôt (/opt/llm-trading-bot/backend/data) et
# `DATA_DIR` le désigne en absolu dans le service systemd. Un `git pull`, un
# `git clean` ou un changement de branche ne peuvent donc pas l'atteindre.
#
# Cette séparation n'est pas cosmétique : le carnet fantôme est la totalité de la
# mesure. Le SPRT a besoin de ~50 observations, soit une semaine de bourse. Le
# perdre lors d'un déploiement revient à recommencer le projet, sans que rien ne
# le signale — le dashboard afficherait simplement « 0 en attente ».
set -euo pipefail

APP_USER="botuser"
REPO_DIR="/opt/llm-trading-bot/src"
BACKEND_DIR="${REPO_DIR}/llm-trading-bot/backend"
DATA_DIR="/opt/llm-trading-bot/backend/data"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }

[[ $EUID -eq 0 ]] || { echo "À lancer en root."; exit 1; }

log "Sauvegarde de l'état avant toute modification"
BACKUP="/opt/llm-trading-bot/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp -a "$DATA_DIR"/. "$BACKUP"/ 2>/dev/null || true
echo "   → ${BACKUP}"
# On ne garde que les 10 dernières : de quoi revenir en arrière sans remplir le
# disque d'une VM à 200 Go partagés.
ls -1dt /opt/llm-trading-bot/backups/*/ 2>/dev/null | tail -n +11 | xargs -r rm -rf

log "Récupération du code"
sudo -u "$APP_USER" git -C "$REPO_DIR" fetch --quiet origin
AVANT="$(sudo -u "$APP_USER" git -C "$REPO_DIR" rev-parse --short HEAD)"

# `origin/HEAD` n'est pas toujours défini selon la façon dont le dépôt a été
# cloné : on se cale sur la branche réellement suivie, avec repli sur main.
BRANCHE="$(sudo -u "$APP_USER" git -C "$REPO_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [[ -z "$BRANCHE" ]]; then
  BRANCHE="origin/$(sudo -u "$APP_USER" git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
fi
sudo -u "$APP_USER" git -C "$REPO_DIR" rev-parse --verify --quiet "$BRANCHE" >/dev/null \
  || { echo "!! Branche distante ${BRANCHE} introuvable."; exit 1; }

echo "   suit ${BRANCHE}"
sudo -u "$APP_USER" git -C "$REPO_DIR" reset --hard --quiet "$BRANCHE"
APRES="$(sudo -u "$APP_USER" git -C "$REPO_DIR" rev-parse --short HEAD)"
echo "   ${AVANT} → ${APRES}"

if [[ "$AVANT" == "$APRES" ]]; then
  log "Aucune modification, rien à faire"
  exit 0
fi

log "Dépendances"
sudo -u "$APP_USER" npm --prefix "$BACKEND_DIR" ci --omit=dev --silent

log "Tests"
# Un bot qui passe des ordres ne redémarre pas sur du code dont les tests
# échouent. Mieux vaut rester sur l'ancienne version, qui fonctionnait.
if ! sudo -u "$APP_USER" npm --prefix "$BACKEND_DIR" test >/tmp/bot-tests.log 2>&1; then
  echo "!! Les tests échouent — retour à ${AVANT}, le bot n'est pas touché."
  tail -25 /tmp/bot-tests.log
  sudo -u "$APP_USER" git -C "$REPO_DIR" reset --hard --quiet "$AVANT"
  exit 1
fi
# ── Ce grep faisait échouer le déploiement entier ────────────────────────────
# Le reporter de node:test n'écrit « ℹ tests » que sur un terminal. Redirigé
# vers un fichier il produit du TAP, où la même ligne s'écrit « # tests ».
# Le motif ne correspondait donc à rien, grep rendait 1, et `set -o pipefail`
# arrêtait le script AVANT le redémarrage. Le code était déployé, les tests
# passaient, la sortie s'arrêtait net après « Tests » — et le bot continuait de
# tourner sur l'ancienne version sans que rien ne le signale.
#
# Deux corrections : accepter les deux formats, et ne jamais faire dépendre la
# suite d'un affichage.
grep -E '^(ℹ|#) (tests|pass|fail) ' /tmp/bot-tests.log | sed 's/^/   /' || true

# Un test échoué se voit dans le code de sortie de npm, mais un reporter TAP
# peut très bien rendre 0 en signalant des échecs. On relit donc le compte.
if grep -qE '^(ℹ|#) fail [1-9]' /tmp/bot-tests.log; then
  echo "!! Des tests ont échoué — retour à ${AVANT}, le bot n'est pas touché."
  sudo -u "$APP_USER" git -C "$REPO_DIR" reset --hard --quiet "$AVANT"
  exit 1
fi

log "Redémarrage"
systemctl restart llm-trading-bot
sleep 5
if systemctl is-active --quiet llm-trading-bot; then
  echo "   Actif"
  journalctl -u llm-trading-bot -n 12 --no-pager | sed 's/^/   /'
else
  echo "!! Le service n'a pas démarré."
  journalctl -u llm-trading-bot -n 30 --no-pager
  exit 1
fi

log "Vérification de l'état"
sleep 2
curl -fsS "http://127.0.0.1:8099/api/dashboard" \
  | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);
      const sh=d.measurement?.shadow||{};
      console.log('   décisions en attente :',sh.pendingResolution??0);
      console.log('   exploitables         :',sh.rules?.usable??0);
      console.log('   équity               :',d.account?.equity,d.account?.currency);
    });" 2>/dev/null || echo "   (API pas encore prête, vérifie dans une minute)"
