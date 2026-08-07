#!/usr/bin/env bash
#
# Creates (or removes) UAT test accounts in the `erria` realm, so a round of user-acceptance
# testing can be handed a set of logins in one command (issue #141). deploy/README.md's
# "Creating reviewer/admin accounts" walks the same thing through the admin console by hand —
# fine for one account, but it does not scale to a UAT round and is easy to get half-right: a
# user created but never granted a role logs in successfully to a console that shows nothing.
#
# Each account gets a freshly generated random temporary password. That is deliberate and not a
# convenience: per issue #59 this deployment seeds no credential that anyone could derive from
# the repo, and a script with a default or caller-supplied shared password would put that back.
# Passwords are printed to stdout and written nowhere else — hand them out of band (password
# manager, not email or Slack in the clear) and never reuse one login for two testers, because
# `decidedBy` on an approval is only meaningful if it names one person.
#
# Run on the VM as the deploy user, with .env already sourced:
#
#   cd /opt/erria
#   set -a && . ./.env && set +a
#   deploy/scripts/create-uat-accounts.sh testers.txt
#   deploy/scripts/create-uat-accounts.sh --delete testers.txt     # throwaway cleanup
#
# testers.txt holds one `username email role` per line; role is `reviewer` or `admin` (the only
# two realm roles that exist). Blank lines and `#` comments are ignored.

set -euo pipefail

REALM=erria
# Matches KC_HTTP_RELATIVE_PATH in compose.deploy.yaml. This is the container's own loopback, not
# the public hostname — the admin API is never reachable from the internet (Caddy 404s
# /auth/admin* and Keycloak binds to the VM's loopback), which is exactly why this runs on the VM.
KC_SERVER=http://localhost:8080/auth

usage() {
  cat <<'USAGE'
Usage: create-uat-accounts.sh [--delete] <accounts-file>

  <accounts-file>   one "username email role" per line; role is reviewer|admin
  --delete          remove the listed accounts instead of creating them

Requires KC_BOOTSTRAP_ADMIN_USERNAME and KC_BOOTSTRAP_ADMIN_PASSWORD in the environment
(source the VM's .env first) and must be run from the repo checkout on the VM.
USAGE
}

mode=create
while [ $# -gt 0 ]; do
  case "$1" in
    --delete) mode=delete; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) printf '!! unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ $# -ne 1 ]; then
  usage >&2
  exit 2
fi

# Resolved before the cd below, so a relative path on the command line still works.
accounts_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -r "$accounts_file" ] || { echo "!! cannot read account list: $1" >&2; exit 2; }

: "${KC_BOOTSTRAP_ADMIN_USERNAME:?set KC_BOOTSTRAP_ADMIN_USERNAME — source the VM's .env first (see deploy/README.md)}"
: "${KC_BOOTSTRAP_ADMIN_PASSWORD:?set KC_BOOTSTRAP_ADMIN_PASSWORD — source the VM's .env first (see deploy/README.md)}"

# compose.yaml / compose.deploy.yaml are resolved relative to the repo root, same as deploy.sh.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

COMPOSE=(docker compose -f compose.yaml -f compose.deploy.yaml)

# `exec -T` inherits this script's stdin. Every kcadm call therefore gets </dev/null, and the
# account-file loop below reads on fd 3 — without both, the first kcadm invocation swallows the
# rest of the account list and the loop silently processes exactly one entry.
kcadm() {
  "${COMPOSE[@]}" exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@" < /dev/null
}

# Empty output means "no such user" — callers test for that rather than trusting an exit code,
# since `get users` succeeds with an empty result set.
user_id() {
  kcadm get users -r "$REALM" -q username="$1" -q exact=true --fields id --format csv --noquotes \
    2>/dev/null | tr -d '\r' | head -n1
}

echo "==> Authenticating against $KC_SERVER as $KC_BOOTSTRAP_ADMIN_USERNAME" >&2
kcadm config credentials --server "$KC_SERVER" --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" > /dev/null

# The realm is created by Keycloak's --import-realm on first boot. Before the #138 deploy it did
# not exist at all, and every operation below would have failed confusingly against `master`.
if ! kcadm get "realms/$REALM" --fields realm > /dev/null 2>&1; then
  echo "!! realm '$REALM' does not exist on this Keycloak." >&2
  echo "   It is imported from keycloak/realm-export.deploy.json at container start — check that" >&2
  echo "   the deploy rendered that file and that Keycloak was recreated (see deploy/deploy.sh)." >&2
  exit 1
fi

created=0
skipped=0
deleted=0

if [ "$mode" = create ]; then
  printf '%-24s %-32s %-9s %s\n' USERNAME EMAIL ROLE "TEMPORARY PASSWORD"
fi

while read -r username email role _rest <&3; do
  case "$username" in ''|'#'*) continue ;; esac

  if [ "$mode" = delete ]; then
    id="$(user_id "$username")"
    if [ -z "$id" ]; then
      echo "-- $username: not found, skipping" >&2
      skipped=$((skipped + 1))
      continue
    fi
    kcadm delete "users/$id" -r "$REALM" > /dev/null
    echo "-- $username: deleted" >&2
    deleted=$((deleted + 1))
    continue
  fi

  if [ -z "$email" ] || [ -z "$role" ]; then
    echo "!! $username: each line needs 'username email role'" >&2
    exit 1
  fi
  case "$role" in
    reviewer|admin) ;;
    *) echo "!! $username: role must be reviewer or admin, got '$role'" >&2; exit 1 ;;
  esac

  # Checked before creating anything: `create users` fails on a duplicate username, and under
  # `set -e` that would abort the whole batch — so a partially-successful run could not simply be
  # re-run. Skipping instead makes this safe to repeat.
  if [ -n "$(user_id "$username")" ]; then
    echo "-- $username: already exists, skipping" >&2
    skipped=$((skipped + 1))
    continue
  fi

  password="$(openssl rand -base64 18 | tr -d '\n')"

  kcadm create users -r "$REALM" \
    -s username="$username" -s email="$email" -s enabled=true -s emailVerified=true > /dev/null

  # A user that exists but has no password or no role is worse than no user at all: the tester
  # either cannot log in or logs in to an empty console with no hint why. Roll back rather than
  # leave one behind.
  if ! kcadm set-password -r "$REALM" --username "$username" \
        --new-password "$password" --temporary > /dev/null \
     || ! kcadm add-roles -r "$REALM" --uusername "$username" --rolename "$role" > /dev/null
  then
    echo "!! $username: created but could not be fully provisioned — removing it again" >&2
    id="$(user_id "$username")"
    [ -n "$id" ] && kcadm delete "users/$id" -r "$REALM" > /dev/null 2>&1 || true
    exit 1
  fi

  printf '%-24s %-32s %-9s %s\n' "$username" "$email" "$role" "$password"
  created=$((created + 1))
done 3< "$accounts_file"

if [ "$mode" = delete ]; then
  echo "==> Deleted $deleted account(s), skipped $skipped." >&2
  exit 0
fi

echo "==> Created $created account(s), skipped $skipped." >&2

# Reported from the realm's live configuration rather than hardcoded: whether the first login
# forces authenticator enrollment depends on CONFIGURE_TOTP's defaultAction, which issue #139
# changes. Describing what testers will actually see keeps this from going stale silently.
totp_default="$(kcadm get authentication/required-actions/CONFIGURE_TOTP -r "$REALM" \
  --fields defaultAction --format csv --noquotes 2>/dev/null | tr -d '\r" ' | tail -n1)"

echo "==> Tell each tester what their first login will look like:" >&2
echo "     - they must change the temporary password above" >&2
if [ "$totp_default" = "true" ]; then
  echo "     - they must then enrol an authenticator app (CONFIGURE_TOTP is a realm default" >&2
  echo "       action), so they need one to hand before starting" >&2
else
  echo "     - no authenticator enrolment: CONFIGURE_TOTP is not a default action on this realm" >&2
fi
echo "==> Remove throwaway accounts when UAT finishes:  $0 --delete <accounts-file>" >&2
