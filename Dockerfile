# syntax=docker/dockerfile:1

# ---------- build: compila a interface (Vite) e o servidor (TypeScript)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---------- runtime
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=America/Sao_Paulo \
    APP_TIMEZONE=America/Sao_Paulo
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
