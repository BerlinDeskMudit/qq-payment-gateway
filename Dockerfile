# syntax=docker/dockerfile:1

# Multi-stage so the runtime image carries no TypeScript, no dev dependency, and
# no source. Everything in the final stage is something the running service
# needs.

# --- deps --------------------------------------------------------------------
# Build tools are not needed to install these, and leaving them out keeps the
# layer cache warm across source-only changes.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# --- build -------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the
# graceful shutdown in server.ts actually runs on `docker stop`.
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/db/migrations ./dist/db/migrations

# PGlite writes its database here when DATABASE_URL is unset. Named volume so
# local data survives an image rebuild.
VOLUME ["/data"]
ENV PGLITE_DATA_DIR=/data/qqpg

# Never run as root: a container escape should not start as uid 0.
USER node

EXPOSE 8080

# The health route needs no auth and no database, so an unhealthy container is
# one that cannot serve at all.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]