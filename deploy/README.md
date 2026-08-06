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

The admin console itself is reachable at `https://<domain>/auth/admin` until #59 blocks it at
Caddy; until then, treat it as available only because no port scan has found it yet, not because
anything is actually restricting it.

## Environment variables

See `.env.deploy.example` (root) for the full list. It is a template only — every value in it is
a placeholder or a safe default for a variable that genuinely has one; nothing in it is a secret
that works against anything real, so it is safe to commit (mirroring `.env.example`'s existing
`compose.yaml`/`.env.example` entries in `.gitguardian.yaml`).
