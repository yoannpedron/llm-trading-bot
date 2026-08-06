FROM node:22-alpine

WORKDIR /app

# Couche de dépendances séparée : le cache Docker n'est invalidé que si
# package.json change, pas à chaque modification du code.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# Volume à monter en production (Fly/Railway/Render) pour conserver le
# portefeuille entre deux déploiements.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
