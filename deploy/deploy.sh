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
realm_file=keycloak/realm-export.deploy.json

# The directory described above is still sitting on every VM that deployed before this render
# step existed, and a `>` redirect cannot write into one — the deploy aborts here with
# "Is a directory", *after* migrations have run (issue #137). So the fix for #132 could not
# apply itself to precisely the VMs showing #132's symptom until this cleanup existed.
# `rmdir`, not `rm -rf`: the only thing that belongs here is the empty directory Docker
# creates for a missing bind-mount source. A non-empty one means something this script does
# not understand is at that path, and failing loudly beats deleting it.
if [ -d "$realm_file" ]; then
  echo "==> Removing the empty directory Docker left at $realm_file (issue #137)"
  rmdir "$realm_file"
fi

# Rendered to a temp file first so the result can be compared against what is already on disk.
# `up -d --wait` below only recreates a container when its *compose config* changes, and this
# bind mount's config string is identical whether the host path is a directory, a stale file or
# a correct one — so a deploy that fixes the file but reuses the running Keycloak goes green
# while still serving without the `erria` realm. That is #132's symptom again, now silent.
rendered="$(mktemp)"
sed "s|DEPLOY_ORIGIN_PLACEHOLDER|https://${DEPLOY_DOMAIN}|g" \
  keycloak/realm-export.deploy.json.template > "$rendered"

if [ -f "$realm_file" ] && cmp -s "$rendered" "$realm_file"; then
  rm -f "$rendered"
  realm_changed=""
else
  mv "$rendered" "$realm_file"
  realm_changed=1
fi

if [ -n "$realm_changed" ]; then
  echo "==> Realm file changed — recreating Keycloak so 'start --import-realm' re-reads it."
  "${COMPOSE[@]}" up -d --wait --force-recreate keycloak
fi

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
