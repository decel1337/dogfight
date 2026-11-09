# syntax=docker/dockerfile:1
#
# Три стадії. Фінальний образ має лише те, що потрібно для ЗАПУСКУ:
# production-залежності, TS-вихідники сервера й спільного коду, зібраний клієнт.
# Node 22 виконує .ts напряму (strip-types), тож окремого кроку компіляції сервера немає.

# ---- 1. build: повні залежності + vite build клієнта ----
FROM node:22-alpine AS build
WORKDIR /app
# Спершу лише маніфести: шар npm ci кешується, доки залежності не змінились.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY client client
RUN npm run build -w client

# ---- 2. deps: лише production-залежності сервера ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server --workspace=shared \
 && npm cache clean --force

# ---- 3. runtime ----
# Беремо з образу node ЛИШЕ бінарник: npm, yarn, corepack і заголовки лишаються
# в його шарах і в наш образ не потрапляють (видалення в пізнішому шарі
# розмір не зменшує, тому rm -rf тут не допоможе).
FROM node:22-alpine AS nodebin

FROM alpine:3.24 AS runtime
RUN apk add --no-cache libstdc++ \
 && addgroup -g 1000 node \
 && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=nodebin /usr/local/bin/node /usr/local/bin/node
WORKDIR /app

ARG GIT_SHA=dev
ARG APP_VERSION=0.0.0
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_DIR=/data/logs \
    STATIC_DIR=/app/client/dist \
    GIT_SHA=$GIT_SHA \
    APP_VERSION=$APP_VERSION

COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY shared shared
COPY server/package.json server/package.json
COPY server/src server/src
COPY --from=build /app/client/dist client/dist

RUN mkdir -p /data/logs && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

# Docker/compose перезапускають або позначають unhealthy за /ready.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# SIGTERM -> graceful shutdown (exit 0 менш ніж за 10 с).
STOPSIGNAL SIGTERM
# Exec-форма: node — PID 1 і сам отримує сигнали (shell-форма `sh -c` їх би «з'їла»).
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
