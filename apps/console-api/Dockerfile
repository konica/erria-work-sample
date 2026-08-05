# syntax=docker/dockerfile:1
#
# Multi-stage build for apps/console-api over the pnpm workspace (ticket #55, ADR-0007).
# Build context is the repo root: docker build -f apps/console-api/Dockerfile .
#
# @erria/db and @erria/domain are built before console-api, matching the ordering
# .github/workflows/ci.yml already documents (each app resolves the other's types through
# dist/index.d.ts). console-web's Vite bundle is built too and copied into the runtime
# image's static directory, so one container serves the SPA and the API on one port
# (Application architecture §6 / ADR-0007).

ARG NODE_IMAGE=node:24-slim@sha256:cd84903a12dbd26b46f1f3b8144a2568c41c5d37ddd0c7a80a34c7a19786b35f

FROM ${NODE_IMAGE} AS base
WORKDIR /app
# packageManager in package.json pins pnpm@10.0.0; corepack reads that field itself, so no
# version is repeated here.
RUN corepack enable

# ---- deps: every workspace package.json, full (dev + prod) install for building ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console-api/package.json apps/console-api/package.json
COPY apps/console-web/package.json apps/console-web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
# @erria/db's postinstall runs `prisma generate`, which needs the schema (not just the
# package.json copied above) to be present at `pnpm install` time.
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/prisma.config.ts
RUN pnpm install --frozen-lockfile

# ---- build: compile @erria/db, @erria/domain, console-api, and the console-web SPA ----
FROM deps AS build
COPY . .
RUN pnpm --filter @erria/db run build
RUN pnpm --filter @erria/domain run build
RUN pnpm --filter console-api run build
RUN pnpm --filter console-web run build

# ---- prod-deps: production-only deps for console-api and its workspace dependencies ----
# --no-optional matters as much as --prod here: @prisma/client declares `prisma` and
# `typescript` as *optional* peers, and pnpm resolves those regardless of --prod since
# they're peer-satisfying, not devDependencies — pulling the full Prisma CLI, Prisma
# Studio, and their dependency trees (effect, @electric-sql/pglite, elkjs, ~180MB) into
# what should be a lean runtime install. The schema was already generated at build time
# above, so none of that CLI tooling is needed here.

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console-api/package.json apps/console-api/package.json
COPY apps/console-web/package.json apps/console-web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --no-optional --filter "console-api..."

# ---- runtime: no toolchain, no dev dependencies, non-root ----
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 10001 erria \
 && useradd --system --uid 10001 --gid erria --no-create-home --shell /usr/sbin/nologin erria

# pnpm gives every workspace member its own node_modules of symlinks into the central
# .pnpm store under the root node_modules copied first — both are required, not just the
# root one, or each package's direct (non-workspace) dependencies fail to resolve.
COPY --from=prod-deps --chown=erria:erria /app/node_modules ./node_modules
COPY --from=prod-deps --chown=erria:erria /app/package.json ./package.json
COPY --from=prod-deps --chown=erria:erria /app/packages/db/package.json ./packages/db/package.json
COPY --from=prod-deps --chown=erria:erria /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps --chown=erria:erria /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=prod-deps --chown=erria:erria /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=prod-deps --chown=erria:erria /app/apps/console-api/package.json ./apps/console-api/package.json
COPY --from=prod-deps --chown=erria:erria /app/apps/console-api/node_modules ./apps/console-api/node_modules

COPY --from=build --chown=erria:erria /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=erria:erria /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=erria:erria /app/apps/console-api/dist ./apps/console-api/dist
# Served by useStaticAssets() in main.ts — one origin for the SPA and the API.
COPY --from=build --chown=erria:erria /app/apps/console-web/dist ./apps/console-api/dist/public

USER erria:erria
EXPOSE 3000
CMD ["node", "apps/console-api/dist/main.js"]
