# Debian, а не alpine: официальные Linux-сборки Stockfish собраны под glibc.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7777 \
    NOSTROMO_HOME=/home/node/.nostromo \
    ENGINE_WORKERS=1

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Движок ставится до копирования остального кода: 80 МБ архива не перекачиваются
# при каждой правке в src/. Скрипту нужен только модуль путей.
COPY --chown=node:node src/shared/paths.mjs ./src/shared/paths.mjs
COPY --chown=node:node scripts/install-engine-docker.mjs ./scripts/install-engine-docker.mjs
RUN node scripts/install-engine-docker.mjs

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7777)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/main.mjs"]
