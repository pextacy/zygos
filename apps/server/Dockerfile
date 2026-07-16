# Zygos server (DOCS.md §10): Fly.io single machine, SQLite on a volume.
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
ENV DATABASE_URL=/data/zygos.db
EXPOSE 8080
WORKDIR /app/apps/server
CMD ["pnpm", "start"]
