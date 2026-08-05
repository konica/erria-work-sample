#!/usr/bin/env bash
# Local-dev entrypoint: start Keycloak with the realm imported, then set the seeded users'
# passwords from an env var instead of a value baked into realm-export.json (#75 — "no secret
# values committed"; a hardcoded credential in the JSON tripped GitGuardian on the first pass).
set -euo pipefail

/opt/keycloak/bin/kc.sh start-dev --import-realm &
KC_PID=$!

# Poll the management port the same way the compose healthcheck does — no curl/wget in this
# image, so speak HTTP over bash's /dev/tcp directly.
echo "dev-entrypoint: waiting for Keycloak to report ready..."
until
  { exec 3<>/dev/tcp/127.0.0.1/9000; } 2>/dev/null &&
    printf 'GET /health/ready HTTP/1.1\r\nhost: localhost\r\nConnection: close\r\n\r\n' >&3 &&
    grep -q '"status": "UP"' <&3
do
  sleep 1
done
echo "dev-entrypoint: Keycloak ready, setting seeded users' passwords"

KCADM=/opt/keycloak/bin/kcadm.sh
"$KCADM" config credentials --server http://127.0.0.1:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"

for username in minh.tran huy.dinh; do
  "$KCADM" set-password -r erria --username "$username" --new-password "$KEYCLOAK_SEED_PASSWORD"
done
echo "dev-entrypoint: seeded passwords set"

wait "$KC_PID"
