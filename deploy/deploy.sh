#!/usr/bin/env bash
#
# Deploy script — runs ON the VM, from the repo checkout (e.g. /opt/erria), invoked over SSH by
# .github/workflows/deploy.yml. Implements issue #58's ordered sequence:
#
#   1. pull
#   2. migrate (abort here on failure — the previous containers are untouched and keep serving)
#   3. up -d
#   4. health check the public URL
#
# Also the local rehearsal script: deploy/README.md's manual runbook and this file run the same
# commands, so testing this locally (docs/adr/0008 and the PR for #58 record such a run) exercises
# the exact sequence CI runs on the VM.
#
# Requires DEPLOY_IMAGE_TAG (the commit SHA to deploy) and DEPLOY_DOMAIN (the host to health-check)
# already exported, and every other compose.deploy.yaml variable (POSTGRES_PASSWORD, etc.) already
# sourced from .env — this script reads no file itself, so it behaves identically whether a human
# or deploy.yml invokes it.

set -euo pipefail

: "${DEPLOY_IMAGE_TAG:?set DEPLOY_IMAGE_TAG to the commit SHA to deploy}"
: "${DEPLOY_DOMAIN:?set DEPLOY_DOMAIN to the public hostname to health-check}"

COMPOSE=(docker compose -f compose.yaml -f compose.deploy.yaml)

echo "==> Pulling images for $DEPLOY_IMAGE_TAG"
"${COMPOSE[@]}" pull

echo "==> Bringing up postgres (must be reachable before a migration can run against it)"
"${COMPOSE[@]}" up -d --wait postgres

echo "==> Building the migrate stage for $DEPLOY_IMAGE_TAG"
# The published console-api image deliberately excludes the Prisma CLI (see that Dockerfile's
# prod-deps stage comment: "none of that CLI tooling is needed here") — `docker compose run --rm
# console-api npx prisma migrate deploy` has no CLI to invoke inside that image. The Dockerfile's
# `migrate` stage exists for exactly this reason, is deliberately never published to GHCR, and is
# already how deploy/README.md's manual runbook runs a migration — this script automates that same
# recipe rather than the issue's literal `npx prisma migrate deploy` one-liner.
docker build -f apps/console-api/Dockerfile --target migrate -t erria-migrate:"$DEPLOY_IMAGE_TAG" .

echo "==> Running prisma migrate deploy"
# Not hardcoded to "erria_default": compose.yaml pins the project name to "erria" via its own
# top-level `name:` field, so that's the real network name whenever COMPOSE_PROJECT_NAME is
# unset (true on the VM) — but deriving it the same way `docker compose` itself would, rather
# than hardcoding the result, is what makes this script honest under a different project name
# too (verified locally against an isolated `COMPOSE_PROJECT_NAME=demo58` run for this ticket).
if ! docker run --rm --network "${COMPOSE_PROJECT_NAME:-erria}_default" \
  --env DATABASE_URL="postgresql://${POSTGRES_USER:-erria}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-erria}" \
  erria-migrate:"$DEPLOY_IMAGE_TAG"
then
  echo "!! Migration failed. Aborting before 'up -d' — the previous containers are untouched and keep serving." >&2
  exit 1
fi

echo "==> Migration succeeded. Starting the new containers."
"${COMPOSE[@]}" up -d --wait

echo "==> Health-checking https://$DEPLOY_DOMAIN/health"
for attempt in $(seq 1 10); do
  if curl -fsS "https://$DEPLOY_DOMAIN/health" > /dev/null; then
    echo "Health check passed."
    exit 0
  fi
  echo "Health check attempt $attempt/10 failed; retrying in 5s..."
  sleep 5
done

echo "!! Health check never passed after the new containers started." >&2
exit 1
