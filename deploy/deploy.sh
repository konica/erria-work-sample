#!/usr/bin/env bash
#
# Deploy script — runs ON the VM, from the repo checkout (e.g. /opt/erria), invoked over SSH by
# .github/workflows/deploy.yml. Implements issue #58's ordered sequence:
#
#   1. pull
#   2. migrate (abort here on failure — the previous containers are untouched and keep serving)
#   3. render the Keycloak realm import file (issue #132)
#   4. up -d
#   5. health check the public URL
#
# Also the local rehearsal script: deploy/README.md's manual runbook and this file run the same
# commands, so testing this locally (docs/adr/0008 and the PR for #58 record such a run) exercises
# the exact sequence CI runs on the VM.
#
# Requires DEPLOY_IMAGE_TAG (the commit SHA to deploy) and DEPLOY_DOMAIN (the host to health-check)
# already exported, and every other compose.deploy.yaml variable (POSTGRES_PASSWORD, etc.) already
# sourced from .env.

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

echo "==> Migration succeeded."

echo "==> Rendering the Keycloak realm import file for $DEPLOY_DOMAIN"
# Keycloak's realm importer does not resolve ${env.*} placeholders inside client fields like
# redirectUris/webOrigins (deploy/README.md — verified empirically, it fails the whole import),
# so this plain `sed` on the committed template has to happen out here rather than inside the
# container. Previously only deploy/README.md's manual runbook did this render, despite this
# script's own header claiming parity with that runbook — the CI-driven path (deploy.yml → this
# script) skipped it, so on a VM where no human had ever run the render by hand, `docker compose`
# bind-mounted a nonexistent host file and silently got an empty directory in the container
# instead (issue #132): Keycloak booted fine and served its default `master` realm, but the
# `erria` realm was never imported. Re-rendering on every deploy (not just once) keeps this file
# in sync with the template and DEPLOY_DOMAIN with no separate step to forget.
sed "s|DEPLOY_ORIGIN_PLACEHOLDER|https://${DEPLOY_DOMAIN}|g" \
  keycloak/realm-export.deploy.json.template > keycloak/realm-export.deploy.json

echo "==> Starting the new containers."
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
