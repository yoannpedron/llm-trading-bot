#!/usr/bin/env bash
#
# HTTPS pour le back-end, via Caddy et un certificat Let's Encrypt automatique.
#
#   sudo bash deploy/setup-https.sh mon-bot.duckdns.org
#
# ── Pourquoi c'est obligatoire, pas optionnel ────────────────────────────────
# Le dashboard est servi en HTTPS par Netlify. Un navigateur refuse qu'une page
# HTTPS appelle une API en HTTP : c'est la regle du « contenu mixte », et elle
# n'est pas contournable cote client. Sans certificat, le dashboard affichera
# « Hors ligne » quoi qu'on fasse.
#
# ── Comment obtenir un nom de domaine gratuit ────────────────────────────────
# Caddy a besoin d'un NOM, pas d'une adresse IP : Let's Encrypt ne signe pas les
# adresses IP. Le plus simple et gratuit :
#   1. https://www.duckdns.org  (connexion via GitHub/Google)
#   2. cree un sous-domaine, par exemple « mon-bot »
#   3. renseigne l'IP publique de ta VM Oracle dans le champ « current ip »
#   4. relance ce script avec mon-bot.duckdns.org
set -euo pipefail

HOSTNAME_ARG="${1:-}"
BACKEND_PORT="${2:-8099}"

[[ $EUID -eq 0 ]] || { echo "À lancer en root : sudo bash deploy/setup-https.sh <hote>"; exit 1; }
[[ -n "$HOSTNAME_ARG" ]] || {
  echo "Usage : sudo bash deploy/setup-https.sh mon-bot.duckdns.org [port]"
  exit 1
}

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }

log "Vérification DNS de ${HOSTNAME_ARG}"
# Autant echouer ici avec un message clair que de laisser Caddy tourner en
# boucle sur un challenge Let's Encrypt qui ne peut pas aboutir.
RESOLVED="$(getent hosts "$HOSTNAME_ARG" | awk '{print $1}' | head -1 || true)"
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || echo '')"
if [[ -z "$RESOLVED" ]]; then
  echo "!! ${HOSTNAME_ARG} ne résout vers aucune adresse. Configure d'abord le DNS."
  exit 1
fi
echo "   ${HOSTNAME_ARG} → ${RESOLVED}"
[[ -n "$PUBLIC_IP" ]] && echo "   IP publique de cette VM → ${PUBLIC_IP}"
if [[ -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
  echo "!! Le DNS ne pointe pas vers cette machine. Let's Encrypt échouera."
  echo "   Corrige l'IP sur DuckDNS, attends une minute, puis relance."
  exit 1
fi

log "Installation de Caddy"
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

log "Configuration du reverse proxy"
cat > /etc/caddy/Caddyfile <<CADDY
# Certificat Let's Encrypt obtenu et renouvelé automatiquement par Caddy.
${HOSTNAME_ARG} {
	# Le bot n'écoute que sur la boucle locale : il n'est joignable que par ce
	# proxy, jamais directement depuis Internet.
	reverse_proxy 127.0.0.1:${BACKEND_PORT}

	# Le dashboard est en lecture seule et n'a besoin que de GET. Les routes
	# d'écriture restent protégées par ADMIN_TOKEN côté application ; ceci
	# ajoute simplement une barrière avant que la requête n'atteigne le bot.
	@ecriture method POST PUT PATCH DELETE
	handle @ecriture {
		reverse_proxy 127.0.0.1:${BACKEND_PORT}
	}

	header {
		# En-têtes de sécurité usuels. Le dashboard vit sur un autre domaine,
		# donc pas de CSP restrictive ici : l'API ne sert pas de HTML.
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		-Server
	}

	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 3
		}
	}
}
CADDY

mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

log "Redémarrage"
systemctl reload-or-restart caddy
sleep 3
systemctl is-active --quiet caddy && echo "   Caddy actif" || { journalctl -u caddy -n 20 --no-pager; exit 1; }

log "Test"
if curl -fsS --max-time 20 "https://${HOSTNAME_ARG}/api/health"; then
  cat <<FIN


────────────────────────────────────────────────────────────────
HTTPS opérationnel.

Dans le dashboard → Réglages → URL du back-end :
    https://${HOSTNAME_ARG}

Et vérifie que le .env du serveur contient bien :
    CORS_ORIGINS=https://llm-trading-bot-dashboard.netlify.app
────────────────────────────────────────────────────────────────
FIN
else
  echo
  echo "!! Le certificat est peut-être encore en cours d'émission (30 à 60 s)."
  echo "   Réessaie :  curl https://${HOSTNAME_ARG}/api/health"
  echo "   Sinon :     sudo journalctl -u caddy -n 40 --no-pager"
fi
