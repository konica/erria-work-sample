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
# `deploy/deploy.sh` (the CI-driven path below) runs this same render on every deploy too
# (issue #132) — a VM that only ever went through that path never needed this manual step, but
# it's included here so the fully-manual sequence stays self-contained.
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
same pull → migrate → render realm → up -d → health-check sequence documented above, with one
load-bearing property: **a failed migration aborts before `up -d`**, so the previous containers
keep serving rather than the deploy limping forward on a schema neither revision fully matches.

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
simultaneous. `followup-cadence` runs its real body (`apps/worker/src/jobs/followup-cadence.ts`);
`audit-sample-maintenance` is still a stub (`apps/worker/src/jobs/run-job.ts`) — a stub run still
exits 0, so `docker compose -f compose.yaml -f compose.deploy.yaml run --rm worker
--job=audit-sample-maintenance` succeeding is what "the cron entry ran successfully" means until
that job's real body lands. Each entry chains a heartbeat publish with `&&` — see "Autonomous-send
alerting" under Monitoring below (issue #62) for what that heartbeat covers and how to verify it.

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

### Creating accounts in bulk (UAT rounds)

For a round of user-acceptance testing, `deploy/scripts/create-uat-accounts.sh` does what the
admin-console walkthrough below does, for a list of people, in one command — on the VM, from the
repo checkout, with `.env` sourced:

```bash
cd /opt/erria
set -a && . ./.env && set +a
printf 'uat-alice alice@example.com reviewer\nuat-bob bob@example.com admin\n' > testers.txt
deploy/scripts/create-uat-accounts.sh testers.txt      # prints one temporary password per account
deploy/scripts/create-uat-accounts.sh --delete testers.txt   # when UAT finishes
```

Each account gets its own randomly generated temporary password, printed to stdout and written
nowhere else — hand them out of band, exactly as the manual route below requires. Re-running is
safe: existing usernames are skipped rather than aborting the batch. The script reports what each
tester's first login will actually involve by reading the realm's own `CONFIGURE_TOTP` setting, so
it stays honest if that policy changes.

The admin-console walkthrough below remains the manual fallback, and is still the right route for
creating a single named reviewer/admin rather than a batch of testers.

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

## Monitoring (issue #61)

Sized for two people and one box, same constraint the deployment design's §8 states: no Log
Analytics workspace, no Application Insights, no agent — those were a managed-design cost line
with no counterpart here. Grafana, Prometheus, distributed tracing, an SRE/SLO program and an
on-call rotation are deliberately not built either; the below is already more than two people
will actively watch.

### Log rotation

Every service in `compose.deploy.yaml` has a `logging:` block (`json-file` driver, `max-size` ×
`max-file`) — 30 MB per service, 50 MB for `caddy` (it sees every public request, including
whatever the rate limiter is busy rejecting). `docker compose logs` is the query interface; there
is no separate log-shipping pipeline to operate.

**Verify a deliberate log flood fills the cap without filling the disk:**

```bash
docker compose -f compose.yaml -f compose.deploy.yaml exec worker \
  sh -c 'for i in $(seq 1 200000); do echo "log flood line $i"; done'
# then, on the host:
docker inspect --format '{{.LogPath}}' $(docker compose -f compose.yaml -f compose.deploy.yaml ps -q worker)
# expect the file (and its .1/.2 rotations) to stop growing at ~10 MB each, 3 files total —
# never an unbounded single file eating the disk.
```

### External uptime check — human-run, highest-value single alert

This needs a third-party account this repo can't create on anyone's behalf, which is why it's a
manual step rather than code:

1. Sign up for a free uptime monitor (e.g. UptimeRobot, Freshping, or Better Uptime's free tier —
   any of them cover this).
2. Add an HTTPS monitor against `https://<DEPLOY_DOMAIN>/health` (console-api's own health route,
   the same one `deploy/deploy.sh`'s post-deploy check already hits), checked every 5 minutes.
3. Add both team members' emails as alert contacts on that monitor.

This one check covers the VM, Docker, Caddy, TLS termination and the app in a single signal —
deliberately the first thing set up, before anything more sophisticated.

**Verify by stopping the stack:**

```bash
docker compose -f compose.yaml -f compose.deploy.yaml stop caddy
# wait for the monitor's check interval to elapse, confirm both team members get an alert email,
# then bring it back:
docker compose -f compose.yaml -f compose.deploy.yaml start caddy
```

### Disk-usage alert at 80%

**There is no host-level Azure Monitor metric for guest disk-space-used, on any VM size, with or
without an agent** — verified against Azure's own VM metrics reference (2026-08): the host-level
metrics for `Microsoft.Compute/virtualMachines` include disk *throughput* (`Disk Read/Write
Bytes`, IOPS, latency, queue depth) but nothing about how full the disk is. Guest free-space is a
guest-OS metric, and guest-OS metrics are collected only through an agent — which issue #61 rules
out. (`Available Memory Bytes`/`Available Memory Percentage` are the one guest-shaped metric that
actually *is* host-level and agent-free; see "Memory and CPU-credit metrics" below.)

The workaround costs one curl call, not a daemon: `deploy/scripts/report-disk-usage.sh` runs from
cron every 5 minutes (`deploy/crontab`), reads `df` locally, and publishes the result as a custom
Azure Monitor metric using the VM's own system-assigned managed identity over IMDS
(`deploy/scripts/lib-azure-metric.sh`) — nothing runs between ticks, so this isn't "an agent" in
the sense the ticket rules out. `infra/terraform/monitoring.tf`'s `azurerm_monitor_metric_alert.disk_usage`
fires at 80% (`var.disk_usage_alert_threshold_percent`) via the `ops` action group.

**Verify it actually fires**, after `terraform apply` and once the VM has run at least one cron
tick (so the custom metric exists — before that, `skip_metric_validation = true` is what lets the
alert resource itself get created, since Terraform can't validate a metric nothing has emitted
yet):

```bash
ssh <vm-user>@<vm-host> "fallocate -l 50G /home/<vm-user>/filler.img"
# wait for the next 5-minute cron tick, confirm the alert fires and both team members get an
# email, then remove it immediately — this is a review VM with a real disk budget:
ssh <vm-user>@<vm-host> "rm /home/<vm-user>/filler.img"
```

### TLS expiry, independent of Caddy

Caddy renews Let's Encrypt certificates automatically, but "automatically" is a claim worth
verifying independently rather than trusting Caddy's own renewal logs. `deploy/scripts/report-tls-expiry.sh`
runs once daily from cron, reads the certificate Caddy is actually presenting over the wire via
`openssl s_client`, and publishes days-remaining as a custom metric the same way the disk check
does. `azurerm_monitor_metric_alert.tls_expiry` fires at 14 days remaining
(`var.tls_expiry_alert_threshold_days`) — comfortable slack before a 90-day certificate Caddy
renews around day 60 would actually lapse.

**Verify manually**, since forcing a real certificate to near-expiry isn't practical to rehearse:

```bash
./deploy/scripts/report-tls-expiry.sh   # run by hand with DEPLOY_DOMAIN exported/sourced from .env
# expect a line like "tls_days_remaining=87 domain=<domain>" — confirm that number in the Azure
# portal (Monitor → Metrics → scope to the VM → namespace "erria/host" → "TLS Certificate Days
# Remaining") matches, then lower var.tls_expiry_alert_threshold_days temporarily (e.g. above
# 87) and re-apply to confirm the alert fires against a real certificate, restoring 14 afterward.
```

### Memory and CPU-credit metrics

Both are host-level `Microsoft.Compute/virtualMachines` platform metrics — collected automatically
for this VM with nothing to enable, at **Azure portal → Monitor → Metrics → scope to the VM**:

- **Available Memory Bytes** / **Available Memory Percentage** — the guest-shaped metric that
  happens to be host-level and agent-free (unlike disk-space, above).
- **CPU Credits Remaining** / **CPU Credits Consumed** — B-series (burstable) VMs only. **Current
  caveat:** `infra/terraform/variables.tf`'s `vm_size` default is `Standard_D2als_v6`, a
  non-burstable SKU chosen because `Standard_B2s` was `RegionIsOfferRestricted` on this
  subscription (see `infra/terraform/README.md`) — these two metrics will show no data until
  either that restriction lifts and the SKU reverts to a B-series, or this note is deleted because
  it no longer applies. Re-check with `az vm list-skus` before assuming CPU credits are being
  tracked.

No Terraform resource is needed for either — this section exists so a human knows where to look,
which is also this ticket's "visible in the portal" acceptance criterion in full.

### Autonomous-send alerting (issue #62)

§8's target state predates autonomous sending and says nothing about it — this closes that gap
for this deployment. Six alerts, all routed through `azurerm_monitor_action_group.ops` except the
spend one (routed to `budget`'s action group, since it's a spend concern for that audience rather
than an operational one):

- **Scheduled-job silence** — `followup-cadence` and `audit-sample-maintenance` (`deploy/crontab`)
  each chain `deploy/scripts/report-job-heartbeat.sh "<name>"` with `&&` after the job itself, so a
  heartbeat only publishes when the job actually completed. `azurerm_monitor_metric_alert.followup_cadence_heartbeat`
  / `.audit_sample_maintenance_heartbeat` fire when a job's heartbeat metric shows zero data points
  over the last 24 hours (`aggregation = "Count"`, `operator = "LessThan"`, `threshold = 1`) — the
  failure mode is silence, not error output, so absence of data is exactly what's being watched
  for.
- **Kill-switch flips, in either direction** — `report-autonomous-alerting-metrics.sh` (every 5
  minutes) publishes `autonomousSendingEnabled` as a 0/1 metric.
  `azurerm_monitor_metric_alert.autonomous_kill_switch_state` fires (Activated) when it crosses to
  1 and auto-resolves (Resolved, also notified) when it crosses back to 0 — one rule, both
  directions, both notifications going to the same two people.
- **Kill-switch read failure fails closed** — code-level, not an alert:
  `packages/domain/src/settings/read-settings-fail-closed.ts` wraps every read of the kill switch;
  a thrown error is logged and treated as "off" (hold for approval), the same posture the switch
  already takes when it's simply paused. Covered by
  `packages/domain/src/dispatch/dispatch-message.integration.spec.ts`'s "holds an autonomous
  message for approval when the kill switch cannot be read" test.
- **Autonomous send volume anomaly** — a tripwire, not a cap (the design deliberately has no
  ceiling). `azurerm_monitor_metric_alert.autonomous_send_volume_anomaly` uses Dynamic Thresholds
  (`dynamic_criteria`, `alert_sensitivity = "Medium"`) against the `Autonomous Sends` metric rather
  than a fixed number, since there's no sensible fixed number for a metric whose whole point is
  not having one.
- **Audit-sample review backlog** — `azurerm_monitor_metric_alert.audit_sample_backlog` fires when
  the oldest unreviewed `AuditSample` has waited longer than
  `var.audit_sample_backlog_alert_threshold_hours` (default 48h).
- **Claude API spend threshold** — `azurerm_monitor_metric_alert.claude_api_spend`, separate from
  `budget.tf`'s Azure budget alert. The value is an *estimate* from `LlmCall` token counts at list
  pricing (`apps/worker/src/jobs/report-alerting-metrics.ts`), not the vendor's invoice — nothing
  in this codebase calls an Anthropic billing API.
- **Telemetry tagging** — `dispatch-message.ts`'s sandbox-dispatch log line carries `tier=autonomous`
  or `tier=human_approved`, the same `decidedBy` discriminator every metric above filters on, so
  `docker compose logs worker | grep 'tier=autonomous'` isolates autonomous-tier activity directly.

**Verify the heartbeat mechanism** by disabling a job (the acceptance criterion is explicit about
this):

```bash
# Temporarily comment out the followup-cadence line in the installed crontab (crontab -e), or
# rename the worker's --job flag so it doesn't match, then wait a day and confirm:
#   - no new line in /var/log/erria/followup-cadence-heartbeat.log
#   - the "Followup Cadence Heartbeat" metric (Monitor → Metrics, namespace "erria/host") shows
#     no new data point
#   - azurerm_monitor_metric_alert.followup_cadence_heartbeat fires and both team members get an
#     email
# then restore the crontab entry.
```

**Verify the kill-switch alert fires in both directions**, from the Settings screen or via
`SettingsService`: pause autonomous sending (immediate, no confirmation) and confirm an
"Activated" email arrives within 5 minutes; resume it (confirmation step) and confirm a "Resolved"
email arrives within another 5 minutes.

### Where do I look when it breaks

One page, meant to be read top to bottom during an actual incident:

1. **App unreachable / uptime alert fired** — `ssh` to the VM, `docker compose -f compose.yaml -f
   compose.deploy.yaml ps`. A service not `Up (healthy)` names the problem directly. `docker
   compose ... logs <service> --tail 200` next.
2. **Disk-usage alert fired** — `df -h /` on the VM. `docker system df` breaks down what Docker
   itself is using; `du -sh /var/lib/docker/containers/*/*.log` finds an individual container log
   that outgrew its cap (shouldn't happen given the caps above, but confirms it if it does).
   `docker compose ... down` then `up -d` is the fastest way to reclaim space from anything that
   isn't the caps themselves (dangling images, old log rotations past `max-file`).
3. **TLS-expiry alert fired** — check `docker compose ... logs caddy | grep -i certificate` for
   what Caddy itself thinks happened. A failed ACME renewal is almost always port 80 being
   unreachable (NSG/firewall changed) or Let's Encrypt rate limits from too many redeploys.
4. **Memory pressure / OOM-killed container** — `docker stats --no-stream` for current usage
   against the per-service `mem_limit`s in `compose.deploy.yaml`; Keycloak's JVM start is the
   single biggest and most credit-hungry moment on the box.
5. **A scheduled job silently stopped running** — `/var/log/erria/*.log` on the VM (cron redirects
   every job's output there, per `deploy/crontab`); an empty or stale-dated file is the tell. Since
   issue #62, the heartbeat-absence alerts (see "Autonomous-send alerting" above) catch this
   independently of anyone reading logs — check whether `followup_cadence_heartbeat` or
   `audit_sample_maintenance_heartbeat` actually fired before assuming nobody noticed.
6. **Autonomous-send alert fired** (kill-switch flip, volume anomaly, audit backlog, or Claude
   spend) — see "Autonomous-send alerting" above for what each one watches; `docker compose ...
   logs worker | grep 'tier=autonomous'` isolates the autonomous-tier activity the alert is about
   from human-approved sends in the same log stream.
7. **Nothing above explains it** — `docker compose -f compose.yaml -f compose.deploy.yaml logs
   --since 1h` across every service, then work backwards from whichever timestamp lines up with
   when the alert fired.

## Environment variables

See `.env.deploy.example` (root) for the full list. It is a template only — every value in it is
a placeholder or a safe default for a variable that genuinely has one; nothing in it is a secret
that works against anything real, so it is safe to commit (mirroring `.env.example`'s existing
`compose.yaml`/`.env.example` entries in `.gitguardian.yaml`).
