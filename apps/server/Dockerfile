# Zygos server (DOCS.md §10): Fly.io single machine; DB is Neon Postgres
# (set DATABASE_URL=postgres://… as a Fly secret). Without it the server
# falls back to embedded PGlite at /data/pglite (attach a volume to persist).
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
COPY packages/venue-adapters/package.json packages/venue-adapters/
RUN pnpm install --frozen-lockfile --filter @zygos/server...

COPY packages ./packages
COPY apps/server ./apps/server

ENV NODE_ENV=production
ENV DATABASE_URL=/data/pglite
EXPOSE 8080
WORKDIR /app/apps/server
CMD ["pnpm", "start"]
