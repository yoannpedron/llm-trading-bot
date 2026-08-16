#!/usr/bin/env bash
#
# Installation du bot sur une VM Ubuntu fraîche (Oracle Cloud Always Free).
#
# À lancer UNE FOIS sur le serveur, depuis un dépôt déjà cloné :
#   git clone <dépôt> /tmp/bot
#   sudo bash /tmp/bot/llm-trading-bot/deploy/install.sh
#
# Pas de `curl | bash` : le script installe le fichier `llm-trading-bot.service`
# situé à côté de lui, il a donc besoin du dépôt sur le disque.
#
# Idempotent : relançable sans casser une installation existante.
set -euo pipefail

APP_USER="botuser"
APP_DIR="/opt/llm-trading-bot"
NODE_MAJOR="22"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!! \033[0m%s\n' "$1"; }

[[ $EUID -eq 0 ]] || { echo "Ce script doit tourner en root (sudo bash deploy/install.sh)."; exit 1; }

log "Paquets de base"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git rsync ufw

log "Fichier d'échange"
# La forme Always Free E2.1.Micro n'a qu'1 Go de RAM et aucun swap par défaut.
# Le bot lui-même tient dans quelques dizaines de Mo, mais `npm ci` et la suite
# de tests peuvent dépasser le gigaoctet et se faire tuer par l'OOM killer — un
# échec déroutant, qui ressemble à un plantage de npm sans l'être.
# 2 Go d'échange coûtent 2 Go sur les 200 Go gratuits.
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Sur une machine à 1 Go, on préfère échanger tôt plutôt que d'être tué.
  sysctl -q vm.swappiness=30
  grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=30' >> /etc/sysctl.conf
fi
free -h | head -3

log "Node.js ${NODE_MAJOR}"
# Le dépôt NodeSource évite la version trop ancienne d'Ubuntu : le projet exige
# Node >= 20 (modules ES).
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node --version

log "Utilisateur de service : ${APP_USER}"
# Compte sans shell ni mot de passe : le bot n'a aucune raison de pouvoir se
# connecter, et une clé d'API volée ne doit pas donner un accès interactif.
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

log "Arborescence ${APP_DIR}"
mkdir -p "$APP_DIR"
# Le dossier de données est le SEUL état qui compte : le carnet fantôme, les
# positions, les clés. Il survit aux redéploiements et ne doit jamais être
# écrasé par un `git pull`.
mkdir -p "$APP_DIR/backend/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Service systemd"
install -m 644 "$(dirname "$0")/llm-trading-bot.service" /etc/systemd/system/llm-trading-bot.service
systemctl daemon-reload
systemctl enable llm-trading-bot >/dev/null

log "Pare-feu"
# Seuls SSH et HTTPS sont exposés. Le bot écoute sur 8099 en local uniquement,
# derrière le reverse proxy : le port n'est jamais joignable de l'extérieur.
ufw allow OpenSSH >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 80/tcp >/dev/null  # nécessaire au renouvellement Let's Encrypt
ufw --force enable >/dev/null
ufw status | head -8

# ── Le REJECT que les images Oracle placent AVANT ufw ─────────────────────
# Leurs images Ubuntu arrivent avec une chaîne INPUT déjà peuplée :
#
#     4  ACCEPT  tcp dpt:22
#     5  REJECT  all  reject-with icmp-host-prohibited   <-- ici
#     6  ufw-before-input ...
#
# Tout ce qu'autorise ufw se trouve derrière ce REJECT et n'est donc jamais
# évalué. `ufw status` affiche « 443/tcp ALLOW Anywhere », Caddy écoute bien
# sur le port, et pourtant rien n'entre.
#
# Constaté sur cette installation : Caddy a échoué 62 fois en dix jours à
# obtenir son certificat, avec pour seul symptôme « Error getting validation
# data ». Le bot tournait parfaitement, injoignable, sans qu'aucun des trois
# niveaux — ufw, Caddy, service — ne signale quoi que ce soit d'anormal.
#
# On insère donc les autorisations AVANT ce REJECT, en cherchant sa position
# plutôt qu'en la codant en dur.
if iptables -C INPUT -j REJECT --reject-with icmp-host-prohibited 2>/dev/null; then
  POS_REJECT="$(iptables -L INPUT --line-numbers -n \
    | awk '$2 == "REJECT" { print $1; exit }')"
  if [ -n "$POS_REJECT" ]; then
    for PORT in 443 80; do
      iptables -C INPUT -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT 2>/dev/null \
        || iptables -I INPUT "$POS_REJECT" -p tcp -m state --state NEW --dport "$PORT" -j ACCEPT
    done
    echo "   REJECT Oracle détecté en position $POS_REJECT — 80 et 443 insérés avant"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
    netfilter-persistent save >/dev/null 2>&1 \
      || iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
  fi
fi

cat <<'FIN'

────────────────────────────────────────────────────────────────
Installation terminée. Il reste TROIS choses, dans cet ordre :

1. Le code
     sudo -u botuser git clone <ton-dépôt> /opt/llm-trading-bot/src
     cd /opt/llm-trading-bot/src/llm-trading-bot/backend
     sudo -u botuser npm ci --omit=dev

2. Les secrets — le fichier .env n'est PAS dans le dépôt
     sudo -u botuser cp .env.example .env
     sudo -u botuser nano .env
   À renseigner : GEMINI_API_KEYS, ALPACA_KEY_ID, ALPACA_SECRET_KEY,
   ADMIN_TOKEN, et surtout :
     CORS_ORIGINS=https://llm-trading-bot-dashboard.netlify.app

3. Tes données existantes — sinon le compteur repart de zéro
   Depuis ta machine Windows :
     scp -r backend/data/* ubuntu@<IP>:/tmp/data/
   Puis sur le serveur :
     sudo cp /tmp/data/* /opt/llm-trading-bot/backend/data/
     sudo chown -R botuser:botuser /opt/llm-trading-bot/backend/data

Puis :  sudo systemctl start llm-trading-bot
        sudo journalctl -u llm-trading-bot -f
────────────────────────────────────────────────────────────────
FIN
