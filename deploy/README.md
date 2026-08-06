# Deployment overlay — runbook

`compose.deploy.yaml` (root) is the deployment overlay for the single-VM MVP deployment
(ADR-0007, [`docs/superpowers/specs/2026-08-04-mvp-deployment-design.md`](../docs/superpowers/specs/2026-08-04-mvp-deployment-design.md)).
It adds `caddy`, `keycloak`, `console-api` and `worker` to the `postgres` service `compose.yaml`
already defines, and removes Postgres's published port. `compose.yaml` itself is unmodified and
`pnpm compose:up` keeps working exactly as documented — this file changes nothing about local
development.

This ticket (#57) covers the overlay itself: bringing the five services up together, with
Postgres unreachable from the internet, Caddy as the only published port pair, healthchecks and
`restart: unless-stopped` everywhere, and pinned app images. It deliberately does **not** cover:
provisioning the VM/DNS/TLS domain (#56), the publish/deploy CI workflows (#58), Keycloak
hardening — admin console blocking, MFA, rate limiting, security headers (#59) — nightly backups
(#60), or monitoring (#61/#62). Those tickets build on what this one establishes.

## Bringing the stack up

On the VM, with the repo checked out (e.g. at `/opt/erria`):

```bash
cp .env.deploy.example .env   # then fill in every CHANGE_ME value — see below
chmod 600 .env                # contains real credentials; keep it out of the repo and off any backup that isn't itself secured
set -a && . ./.env && set +a

# Render the Keycloak realm with the real deploy domain. Keycloak's realm importer does not
# resolve ${env.*} placeholders inside client fields like redirectUris/webOrigins (verified
# empirically — it fails the whole import), so this is a plain `sed` on the committed
# template, done here rather than inside the container. The rendered file is gitignored.
sed "s|DEPLOY_ORIGIN_PLACEHOLDER|https://${DEPLOY_DOMAIN}|g" \
  keycloak/realm-export.deploy.json.template > keycloak/realm-export.deploy.json

docker compose -f compose.yaml -f compose.deploy.yaml pull

# caddy is `build:`, not `image:` (issue #59 — stock caddy:2.9-alpine has no rate-limiting
# handler, so deploy/Caddy.Dockerfile compiles one in). `pull` above skips it; build it
# explicitly rather than relying on `up -d`'s implicit build-if-missing, so a redeploy that
# changed the Caddyfile or Dockerfile always picks up the change instead of reusing a stale
# local image.
docker compose -f compose.yaml -f compose.deploy.yaml build caddy

# Postgres needs to actually be up (and its network need to exist) before a migration can
# reach it — bring just that up first.
docker compose -f compose.yaml -f compose.deploy.yaml up -d --wait postgres

# Migrations need the Prisma CLI, which the runtime images deliberately exclude (see
# apps/console-api/Dockerfile's `migrate` stage comment) — build that stage locally and run it
# once, against the network `postgres` above is already on.
docker build -f apps/console-api/Dockerfile --target migrate -t erria-migrate:local .
docker run --rm --network erria_default \
  --env DATABASE_URL="postgresql://${POSTGRES_USER:-erria}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-erria}" \
  erria-migrate:local

docker compose -f compose.yaml -f compose.deploy.yaml up -d --wait
```

The CI-driven version of this same sequence — `deploy/deploy.sh`, invoked by
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) after
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) pushes new images — is issue
#58; see "CI-driven deploy" below. Run the manual sequence above by hand until the VM this targets
(#56) actually exists and those repo variables are set.

## CI-driven deploy (issue #58)

Merging to `main` runs `publish.yml` (builds and pushes `console-api`/`worker` to GHCR tagged with
the commit SHA — never `latest`; path-filtered per app so an unrelated app's sources don't trigger
a rebuild, with a registry-side retag when a rebuild is skipped so the SHA tag still exists for the
step below to pull), then `deploy.yml` SSHes to the VM and runs `deploy/deploy.sh`, which is the
same pull → migrate → up -d → health-check sequence documented above, with one load-bearing
property: **a failed migration aborts before `up -d`**, so the previous containers keep serving
rather than the deploy limping forward on a schema neither revision fully matches.

`deploy.yml` needs these set once the VM exists (#56), under
**Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
|---|---|---|
| `DEPLOY_SSH_KEY` | Secret | Private half of the deploy SSH key |
| `DEPLOY_SSH_HOST` | Variable | The VM's static public IP or hostname (terraform's `public_ip_address` output) |
| `DEPLOY_SSH_USER` | Variable | The deploy user (terraform's `admin_username`, `deploy` by default) |
| `DEPLOY_SSH_KNOWN_HOSTS` | Variable | `ssh-keyscan <host>` output, captured once by hand — pinned rather than accepted on first connect, since a CI runner has no independent way to verify a host key itself |
| `DEPLOY_PATH` | Variable | The repo checkout path on the VM, e.g. `/opt/erria` |

No application secret lives in GitHub for any of this — GitHub Actions holds only the SSH key
above and the GHCR push (the automatic `GITHUB_TOKEN`, not a stored credential). Everything
`compose.deploy.yaml` needs — `POSTGRES_PASSWORD`, `ANTHROPIC_API_KEY`, and the rest — stays only
in the VM's own `.env`, exactly as "Environment variables" below already describes.

## Rolling back

Re-pin `DEPLOY_IMAGE_TAG` to the previous commit SHA and re-run the deploy (re-run
`deploy.yml` with `workflow_dispatch` isn't wired up — for now, this is `ssh` to the VM and run
`DEPLOY_IMAGE_TAG=<previous sha> bash deploy/deploy.sh` by hand, or push a revert commit so
`publish.yml`/`deploy.yml` do it). Code reverts in the time it takes to pull two images and
restart the containers — tens of seconds.

**That is the entire scope of what rollback undoes.** It restores *code*, nothing else. If the
migration that shipped alongside the bad revision only added things (ADR-0008's expand phase),
the old code never noticed the addition and rollback is complete. If the bad revision's migration
had already *removed* something — which ADR-0008 says should never happen in the same release as
the code that stops needing it, but a rule is not an enforcement mechanism — rolling back the code
does not restore what the migration dropped. That needs a reverse migration (only possible if
nothing downstream already depended on the removal) or a restore from the nightly `pg_dump`
(deployment design §6), and both are slower and more manual than re-pinning a SHA.

Say this plainly to anyone reading this file expecting rollback to be a general undo button: it
buys time to investigate a bad deploy. It does not undo a destructive migration.

## Verifying Postgres is not reachable from the internet

**Required before this ticket is considered done — from a machine that is not the VM itself**,
not by reading `compose.deploy.yaml` and trusting the `ports: !override []` line:

```bash
nmap -p 5432 <the VM's public IP>          # expect: filtered or closed, not open
# or, without nmap:
nc -zv -w 3 <the VM's public IP> 5432      # expect: connection refused/timed out
```

Record the result (command and output) in the PR. Locally, before a public IP exists, the closest
available check is confirming nothing on the host is listening on 5432 at all:

```bash
docker compose -f compose.yaml -f compose.deploy.yaml ps postgres   # PORTS column: empty
ss -ltn | grep 5432                                                  # no line for the compose stack
```

## Recording memory usage

Once the stack has been up long enough to reach steady state (past Keycloak's JVM start and any
migration):

```bash
docker stats --no-stream
```

Record each service's usage against the budget in issue #57 in the PR description.

## Installing the cron jobs

```bash
crontab deploy/crontab
```

See [`crontab`](crontab) for the schedule and why the two jobs are staggered rather than
simultaneous. Both job bodies are stubs today (`apps/worker/src/jobs/run-job.ts`) — this only
wires the invocation up; a stub run still exits 0, so
`docker compose -f compose.yaml -f compose.deploy.yaml run --rm worker --job=followup-cadence`
succeeding is what "cron entries run both worker jobs successfully" means until the real job
bodies land.

## Certificate persistence

`caddy-data` and `caddy-config` are named volumes, so `docker compose ... down` (without `-v`)
followed by `up -d` reuses the previously issued certificate instead of re-issuing — verify with:

```bash
docker compose -f compose.yaml -f compose.deploy.yaml down
docker compose -f compose.yaml -f compose.deploy.yaml up -d --wait
docker compose -f compose.yaml -f compose.deploy.yaml logs caddy | grep -i certificate
# expect no new "obtain" / ACME issuance log lines, only the existing certificate being loaded
```

`docker compose ... down -v` is destructive here too — same caveat the base `compose.yaml`
documents for `erria-pgdata` — since it also discards the certificate volumes.

## Keycloak realm

`keycloak/realm-export.deploy.json.template` defines the `erria` realm, the
`console-web`/`console-api` clients, and the `reviewer`/`admin` realm roles — no hostname is
hardcoded in the committed template; `DEPLOY_ORIGIN_PLACEHOLDER` stands in for the redirect URI
and web origin. "Bringing the stack up" above renders it into `keycloak/realm-export.deploy.json`
(gitignored) with a plain `sed`, using `DEPLOY_ORIGIN` derived from `.env`'s `DEPLOY_DOMAIN`,
before Keycloak ever reads the file. Unlike the dev fixture (`keycloak/realm-export.json`, #75),
it seeds **no users** — per #59, reviewer/admin accounts on the public deployment are created by
hand through the admin console once the realm exists, each a distinct account with its own
password, never a fixture-seeded default.

The realm's `CONFIGURE_TOTP` required action is a **default action** (verified locally against
this exact template — see the PR), so the first login of any hand-created account is forced
through OTP enrollment before it reaches the app; there is no separate "make this account use
MFA" step. Every account in this realm can approve a send (`reviewer` and `admin` both can —
`messages.controller.ts` has no role restriction on approve/reject), so requiring OTP for the
whole realm is exactly "MFA for any account that can approve a send," not a broader ask.

### Creating reviewer/admin accounts (admin console, over the SSH tunnel)

The admin console is never reachable over the public hostname — Caddy returns a bare 404 for
`/auth/admin*` (`deploy/Caddyfile`), and Keycloak's port is bound to the VM's own loopback
interface (`compose.deploy.yaml`), not published to the internet. Reach it by tunnelling to that
loopback port:

```bash
ssh -L 8080:127.0.0.1:8080 <vm-user>@<vm-host>
# then, on the machine that ran the command above:
open http://localhost:8080/auth/admin
```

Log in with `KC_BOOTSTRAP_ADMIN_USERNAME`/`KC_BOOTSTRAP_ADMIN_PASSWORD` from `.env`, then for each
reviewer/admin: Users → Add user → set username/email → Credentials tab → set a temporary
password (`resetPasswordAllowed: true` lets them change it on first login) → Role mapping → assign
`reviewer` or `admin`. Leave `CONFIGURE_TOTP` in the user's required actions (it's there by
default) — that's what forces the OTP-enrollment screen on their first login. Hand each person
their own username and temporary password out of band (password manager, not email/Slack in the
clear); never reuse one login for two reviewers (`decidedBy` on an approval is only meaningful if
it names one person — see `CONTEXT.md`'s Clean Approval entry).

### Removing the bootstrap admin

`KC_BOOTSTRAP_ADMIN_USERNAME`/`PASSWORD` exists only to create the first real admin account —
Keycloak documents it as a one-time bootstrap credential, not a standing login. Once at least one
named `admin` account above can log in and manage users, remove it over the same SSH tunnel,
authenticated as that **named** admin (not as the bootstrap account itself — it is about to be
deleted, and a session authenticated as the account it's deleting loses authorization the moment
the delete succeeds, so this order avoids fighting your own session):

```bash
# --password omitted deliberately: kcadm prompts interactively so the value never lands in
# shell history. Realm is master — the bootstrap admin lives there, not in erria.
docker compose -f compose.yaml -f compose.deploy.yaml exec keycloak \
  /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/auth \
  --realm master --user <your-named-admin-username>

docker compose -f compose.yaml -f compose.deploy.yaml exec keycloak \
  /opt/keycloak/bin/kcadm.sh get users -r master -q username="$KC_BOOTSTRAP_ADMIN_USERNAME" \
  --fields id --format csv --noquotes
# then, with the id printed above:
docker compose -f compose.yaml -f compose.deploy.yaml exec keycloak \
  /opt/keycloak/bin/kcadm.sh delete users/<id-from-previous-command> -r master
```

(Verified against a local Keycloak container: this exact `get` → `delete` pair removes the
bootstrap admin and the account can no longer authenticate afterward.) Then remove
`KC_BOOTSTRAP_ADMIN_USERNAME`/`PASSWORD` from the VM's `.env` (they only take effect on container
creation, not on every restart, so leaving stale values there is inert but confusing) and rotate
the password manager entry to reflect that the account no longer exists.

## Verifying the Keycloak hardening (issue #59)

**Required before this ticket is considered done — from a machine that is not the VM itself**,
against the live `https://<DEPLOY_DOMAIN>`, the same standard the Postgres check above holds to.
Record each command and its output in the PR.

```bash
# Admin console: 404 from the internet, on every admin path, not just the top one.
curl -so /dev/null -w '%{http_code}\n' https://<domain>/auth/admin
curl -so /dev/null -w '%{http_code}\n' https://<domain>/auth/admin/master/console/
curl -so /dev/null -w '%{http_code}\n' https://<domain>/auth/admin/realms/erria/users
# expect 404 on all three, and confirm separately that the admin console IS reachable over the
# SSH tunnel (see "Creating reviewer/admin accounts" above) — the internet block and the tunnel
# path are independent layers and both need to be shown working, not just the block.

# Security headers, on both a Keycloak-routed and a console-api-routed path (deploy/Caddyfile
# applies `header` before either reverse_proxy, but confirm rather than trust the config).
curl -sD - -o /dev/null https://<domain>/auth/realms/erria/.well-known/openid-configuration
curl -sD - -o /dev/null https://<domain>/
# expect Strict-Transport-Security, X-Content-Type-Options: nosniff, and
# Content-Security-Policy: frame-ancestors 'none' on both — each header exactly once. Keycloak
# ships its own default copies of the first two plus X-Frame-Options; deploy/Caddyfile's
# `header_down` lines on both Keycloak-facing reverse_proxy blocks strip those before they reach
# the client, verified locally against a real Keycloak container (without `header_down`, the
# response carries two Strict-Transport-Security lines and two X-Content-Type-Options lines,
# not one — worth re-checking here if either reverse_proxy block is ever edited).

# Rate limiting on the token endpoint: the 11th request within a minute from one IP should 429.
for i in $(seq 1 11); do
  curl -so /dev/null -w '%{http_code}\n' \
    https://<domain>/auth/realms/erria/protocol/openid-connect/token
done
# expect ten responses (401/400 for a bodyless POST — this is only testing the rate limit, not
# submitting real credentials) followed by 429.
```

**Brute-force lockout** — demonstrate against one of the real reviewer/admin accounts created
above (never against a real login you still need immediately afterward; the account is
temporarily locked out for up to 15 minutes per `realm-export.deploy.json.template`'s
`maxFailureWaitSeconds`):

```bash
for i in 1 2 3; do
  curl -s -X POST https://<domain>/auth/realms/erria/protocol/openid-connect/token \
    -d grant_type=password -d client_id=console-web \
    -d username=<a-real-username> -d password=wrong
done
```

Then immediately retry with the *correct* password and confirm it is also rejected while the
lockout window is active (`{"error":"invalid_grant","error_description":"Invalid user
credentials"}` even though the password is right — verified locally this way, since Keycloak
26's password-grant response does not otherwise distinguish "wrong password" from "locked out").
Check `attack-detection/brute-force/users/<id>` via kcadm for the authoritative
`disabled`/`failedLoginNotBefore` state if the token endpoint's response is ambiguous.

**MFA enforcement** — create one throwaway test account (`reviewer` role, so it doesn't pollute
real `decidedBy` data), and confirm the browser login flow stops at an OTP-enrollment screen
before reaching the console, on that account's very first login. Delete the throwaway account
afterward.

**Unauthenticated access** — confirm a request to a console route with no session (a fresh
private/incognito window against `https://<domain>/`) redirects to the Keycloak login page rather
than rendering any account data, and that hitting an API route directly
(`curl https://<domain>/api/accounts`) returns 401, not data. This is `AuthGuard` (#76/#78)
exercised end-to-end through the hardened Caddy/Keycloak path this ticket adds, rather than new
behavior of its own — the check here is that nothing in this ticket's changes broke it.

**Realm export contains no secrets** — grep confirms it, but state the check explicitly since
it's the acceptance criterion:

```bash
grep -iE 'password|secret|credentials' keycloak/realm-export.deploy.json.template
# expect no match other than field *names* like otpPolicyType — no value that is itself a secret
```

## Environment variables

See `.env.deploy.example` (root) for the full list. It is a template only — every value in it is
a placeholder or a safe default for a variable that genuinely has one; nothing in it is a secret
that works against anything real, so it is safe to commit (mirroring `.env.example`'s existing
`compose.yaml`/`.env.example` entries in `.gitguardian.yaml`).
