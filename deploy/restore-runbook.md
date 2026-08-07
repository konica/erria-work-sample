# Restore runbook — Postgres, from a nightly dump

Written from a restore that was actually performed (issue #60), not from what a restore should look
like. The rehearsal log at the bottom records what was run, how long each step took, and — just as
importantly — which parts of this document are still unrehearsed.

## What you are recovering, and how much you can lose

ADR-0007 traded PostgreSQL Flexible Server's continuous backup for self-hosting on one VM. The
consequence, stated plainly:

| | |
|---|---|
| **RPO** (data you lose) | Everything written since last night's 02:30 UTC dump. There is no point-in-time restore. |
| **RTO**, database intact, app broken | Not this document — re-pin `DEPLOY_IMAGE_TAG` and redeploy (deploy/README.md, "Rolling back"). Tens of seconds. |
| **RTO**, database damaged, VM alive | Path B below. Minutes: download, restore, restart. |
| **RTO**, VM gone | Path C below. Realistically an hour or two, most of it provisioning and DNS/TLS propagation, not the restore itself. |

The backup is `deploy/scripts/backup-postgres.sh`, run nightly from `deploy/crontab`. Each run
stores one `pg_dump --format=custom` archive in Azure Blob Storage as
`erria-YYYYmmddTHHMMSSZ.dump`, and deletes archives older than `BACKUP_RETENTION_DAYS` (14 by
default). Two alerts watch it — one for a run that failed, one for a day with no successful run
at all. See `deploy/README.md`'s "Nightly backups" section for those.

**What is *not* in the dump**, and therefore cannot be restored from it:

- `.env` — the VM's real secrets. It is in the team password manager and nowhere else. Without it
  nothing in Path C starts.
- Keycloak's realm data lives in a **separate database (`keycloak`) on the same server**, and the
  nightly dump covers only `POSTGRES_DB`. Reviewer/admin accounts are created by hand
  (`deploy/README.md`), so after a rebuild they are re-created by hand — losing them is an
  inconvenience, not data loss. Say so out loud rather than discovering it mid-incident.
- Caddy's issued certificates (`caddy-data`). Caddy re-issues from Let's Encrypt on first boot.

---

## Path A — verify a dump into a scratch database

Run this **when nothing is wrong**, as a drill, and any time you want to know whether a particular
archive is good. It touches no live data: everything happens in a throwaway database alongside the
real one, on the same Postgres server.

```bash
cd /opt/erria
set -a && . ./.env && set +a

# 1. What is in the container? Newest last.
TOKEN=$(curl -sf -H 'Metadata: true' \
  'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F' \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

curl -sf -H "Authorization: Bearer $TOKEN" -H 'x-ms-version: 2021-08-06' \
  "https://${BACKUP_STORAGE_ACCOUNT}.blob.core.windows.net/${BACKUP_CONTAINER}?restype=container&comp=list&prefix=erria-" \
  | grep -o '<Name>[^<]*</Name>' | sed 's|</*Name>||g' | sort

# 2. Download the one you want.
DUMP=erria-20260807T023000Z.dump        # <- pick from the list above
curl -sf -H "Authorization: Bearer $TOKEN" -H 'x-ms-version: 2021-08-06' \
  -o "/tmp/${DUMP}" \
  "https://${BACKUP_STORAGE_ACCOUNT}.blob.core.windows.net/${BACKUP_CONTAINER}/${DUMP}"
ls -l "/tmp/${DUMP}"

# 3. Is it readable at all? This is the check the nightly job already ran before uploading;
#    running it again here is what proves the bytes survived the round trip.
docker compose -f compose.yaml -f compose.deploy.yaml exec -T postgres \
  pg_restore --list < "/tmp/${DUMP}" | grep 'TABLE DATA'
```

The token is the VM's own managed identity, so **these commands only work on the VM.** From a
laptop, log in with `az login` and use `az storage blob list --auth-mode login` /
`az storage blob download --auth-mode login` instead — your own account needs a blob data role on
the container, which by default it does not have (only the VM's identity does; see
`infra/terraform/storage.tf`).

Then restore into a scratch database and compare row counts against the live one:

```bash
COUNTS="select table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text from information_schema.tables where table_schema = 'public' order by table_name"
DC="docker compose -f compose.yaml -f compose.deploy.yaml"

# Exact counts, not pg_stat_user_tables' n_live_tup — that column is a stats-collector estimate
# and can be wrong by exactly the amount you are trying to detect.
$DC exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$COUNTS" > /tmp/counts-live.txt

$DC exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c 'create database erria_restore_check'
$DC exec -T postgres pg_restore --username="$POSTGRES_USER" --dbname=erria_restore_check \
  --no-owner --single-transaction < "/tmp/${DUMP}"

$DC exec -T postgres psql -U "$POSTGRES_USER" -d erria_restore_check -tAc "$COUNTS" > /tmp/counts-restored.txt
diff -u /tmp/counts-live.txt /tmp/counts-restored.txt && echo "ROW COUNTS MATCH"

# Clean up — the scratch database is a full second copy of the data on the same 64 GiB disk.
$DC exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c 'drop database erria_restore_check'
rm -f "/tmp/${DUMP}"
```

A count difference against the *live* database is expected and fine if rows were written after the
dump was taken — the dump is a snapshot of 02:30, not of now. What must not differ is a table that
is empty in the restore and populated live.

**`--single-transaction` matters.** Without it a restore that hits an error part-way leaves the
target half-populated; with it, the whole restore either applies or does not. **`--no-owner`**
avoids failing on role names that may not exist on whichever server you are restoring to.

---

## Path B — restore over the live database, VM alive

Use this when the data is wrong or gone but the box is fine — a bad migration that dropped
something, a destructive query, `docker compose down -v`.

**Stop writing first.** The dump cannot be restored into a database that other processes are
connected to and changing.

```bash
cd /opt/erria
set -a && . ./.env && set +a
DC="docker compose -f compose.yaml -f compose.deploy.yaml"

# 1. Stop everything that writes. Postgres itself stays up — it is the thing doing the restore.
#    Caddy stays up too, so the site returns an error rather than nothing.
$DC stop console-api worker

# 2. Download and verify the archive (Path A, steps 1-3). Do not skip the verify. Finding out an
#    archive is unreadable *after* renaming the live database away is a worse afternoon.

# 3. Keep the damaged database rather than dropping it — it is the only evidence of what went
#    wrong, and on this disk you can afford a copy. Rename needs zero connections to it.
$DC exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${POSTGRES_DB}' and pid <> pg_backend_pid()"
$DC exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -c "alter database ${POSTGRES_DB} rename to ${POSTGRES_DB}_damaged_$(date -u +%Y%m%d)"

# 4. Fresh, empty target, then restore into it.
$DC exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "create database ${POSTGRES_DB}"
$DC exec -T postgres pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
  --no-owner --single-transaction < "/tmp/${DUMP}"

# 5. Back up.
$DC up -d --wait
curl -sf "https://${DEPLOY_DOMAIN}/health" && echo

# 6. Sanity-check the data a human recognises, not just that the API is up.
$DC exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  'select name, "currentTier" from accounts order by name'
```

**Do not run `prisma migrate deploy` before restoring.** The dump contains the whole schema *and*
the `_prisma_migrations` bookkeeping rows, so a migrated-then-restored database fails immediately —
verified, and the first error you get is `type "AuditReviewStatus" already exists` on the very
first `CREATE TYPE`. Restore into an empty database and the schema arrives with the data. If the
running images are *newer* than the dump's schema, run `prisma migrate deploy` **after** the
restore (deploy/README.md's migration step), which is the ordinary expand/contract path ADR-0008
describes.

Once the app is healthy and you have looked at the recovered data, drop the renamed database — it
is a full copy of the data on the same disk the disk-usage alert watches:

```bash
$DC exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "drop database ${POSTGRES_DB}_damaged_<date>"
```

---

## Path C — rebuild from nothing

The VM is gone: deleted, region-level failure, or unrecoverable. This is the honest disaster story
for a single-VM deployment, and the reason ADR-0007's revisit list exists. Written down here
before it is needed rather than worked out under pressure.

**You need, before you start:** the Azure subscription, the deploy SSH key, `.env` from the team
password manager, and the backup storage account — which survives a `terraform destroy` on purpose
(`prevent_destroy` in `infra/terraform/storage.tf`; the dumps are the one thing in the module that
must not go away with the rest of it).

1. **Provision.** `infra/terraform` — see `infra/terraform/README.md`. Do not `terraform destroy`
   the old resource group first if it still exists; you may want its disk.
   ```bash
   cd infra/terraform
   export TF_VAR_admin_ssh_public_key="$(cat ~/.ssh/erria-deploy.pub)"
   terraform init && terraform apply
   terraform output public_ip_address
   ```
2. **Point DNS** at the new IP (`manage_dns_in_azure = false` means this is a manual step at
   whatever provider holds the zone). TLS cannot be issued until this resolves, so do it early —
   propagation, not the restore, is usually the long pole in this path.
3. **Clone and configure**, on the new VM:
   ```bash
   sudo mkdir -p /opt/erria && sudo chown "$USER" /opt/erria
   git clone https://github.com/konica/erria-work-sample.git /opt/erria
   cd /opt/erria
   # .env from the password manager, NOT from .env.deploy.example with values re-guessed.
   # POSTGRES_PASSWORD in particular must match nothing in particular — the restore brings its
   # own roles — but every other value must be the real one.
   vim .env && chmod 600 .env
   set -a && . ./.env && set +a
   sed "s|DEPLOY_ORIGIN_PLACEHOLDER|https://${DEPLOY_DOMAIN}|g" \
     keycloak/realm-export.deploy.json.template > keycloak/realm-export.deploy.json
   ```
4. **Bring up Postgres only**, and nothing else. The image creates an empty `POSTGRES_DB` on first
   boot of the fresh volume, which is exactly the empty target a restore wants.
   ```bash
   docker compose -f compose.yaml -f compose.deploy.yaml up -d --wait postgres
   ```
5. **Restore**, following Path A steps 1–3 to fetch and verify the newest archive — from your
   laptop with `az storage blob download --auth-mode login`, because the new VM's identity has no
   role on the old backup container until step 1's `terraform apply` grants it. Then:
   ```bash
   docker compose -f compose.yaml -f compose.deploy.yaml exec -T postgres \
     pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
     --no-owner --single-transaction < "/tmp/${DUMP}"
   ```
   **Skip the migration step** for the same reason as Path B: the dump carries the schema.
6. **Bring the rest up** — the ordinary sequence from `deploy/README.md` ("Bringing the stack up")
   from `docker compose ... pull` onward, minus the migration.
7. **Re-create the Keycloak accounts by hand.** The realm imports empty of users by design
   (`deploy/README.md`, "Keycloak realm"). This is the step people forget: the app is up, the data
   is there, and nobody can log in.
8. **Re-install cron.** `crontab deploy/crontab`, then confirm the *next* nightly backup actually
   lands — a rebuilt box with no working backup is where the next incident starts.
   `sudo mkdir -p /var/log/erria && sudo chown "$USER" /var/log/erria` first; cron's redirects do
   not create that directory.
9. **Confirm the two Blob alerts still point at the new VM.** `terraform apply` recreates them
   scoped to the new VM resource, but the custom metrics do not exist until the first cron tick, so
   the absence alert will fire once in the first 24 hours if step 8 was missed. That is the alert
   doing its job.

---

## `docker compose down -v` destroys the database

Said in three places on purpose, because it is one flag away from a command people run routinely:

- `docker compose down` — stops and removes containers. Volumes survive. Safe.
- `docker compose down -v` — **also deletes `erria-pgdata`, and with it every Account, Message,
  Trigger, Escalation and Resolution.** No prompt, no undo. On the deployment it also deletes
  `caddy-data`, so the next boot re-issues certificates from Let's Encrypt and can hit their rate
  limits if it happens repeatedly.
- `pnpm compose:reset` **is** `down -v` followed by `up`. That is its purpose in development. Never
  run it on the VM.

Recovery from `down -v` on the deployment is Path B, and it costs everything written since 02:30
UTC. In development it costs nothing: `pnpm compose:up` and `pnpm --filter @erria/db run seed`.

---

## Rehearsal log

**2026-08-07 — restore performed by hand, into a scratch database, row counts verified.**

Against a `postgres:17` container from this repo's own `compose.yaml` — the same image tag
`compose.deploy.yaml` inherits — seeded with `pnpm --filter @erria/db run seed` (the four fictional
accounts). Path A's restore-and-compare sequence, run by hand and timed.

| Step | Elapsed |
|---|---|
| `pg_dump --format=custom --compress=6` (12 tables) | **739 ms**, 41,795 bytes |
| `pg_restore --list` verification | **474 ms** |
| `create database erria_restore_check` | **1,512 ms** |
| `pg_restore --single-transaction --no-owner` | **708 ms** |
| Whole sequence, including both row-count queries and the diff | **4.5 s** |

Row counts matched exactly, all twelve tables:

```
_prisma_migrations=3  accounts=4   audit_samples=0        contacts=4
escalations=2         llm_calls=0  messages=5             resolutions=1
settings=0            triggers=4   tier_history_events=8  vessels=4
```

**Failure modes deliberately simulated in the same session**, because a backup that has only ever
been observed succeeding has not been tested:

- Archive truncated to 12,000 bytes → `pg_restore --list` exits 1,
  `could not read from input file: end of file`.
- Archive truncated to 30,000 bytes — **above** the nightly job's 20,480-byte size floor → same
  failure. This is the case the size floor cannot catch, and the reason the job runs
  `pg_restore --list` as well as checking the size.
- Restore into a database that already has the schema → fails on the first statement,
  `type "AuditReviewStatus" already exists`. Hence "do not run `prisma migrate deploy` first"
  above; that instruction is an observation, not a precaution.
- Also confirmed: `pg_restore --list` reads a `--format=custom` archive from **stdin**, with no
  filename and no seekable file, which is what lets the nightly job verify a host-side dump using
  the `pg_restore` inside the container.

**The nightly script itself was then run against that same real Postgres container**, with only the
Azure calls (IMDS, Blob REST, custom metrics) replaced at the `curl` boundary — so the `pg_dump`,
`pg_restore --list` and TOC-parsing halves were the real thing, not stubs:

| Run | Result |
|---|---|
| Normal run | `verified dump size_bytes=41795 toc_entries=12`, one blob PUT, the HEAD read-back, the size metric, one expired 2020 dump deleted, `backup OK`, exit 0 |
| `BACKUP_MIN_BYTES=999999999` | Rejected on the size floor, **no blob PUT at all**, failure metric published, exit 1 |
| `POSTGRES_DB=nosuchdb` | `pg_dump: error: … database "nosuchdb" does not exist`, nothing uploaded, exit 1 |
| A real but empty database | `dump has no data entry for the accounts table`, nothing uploaded, exit 1 — the check the size floor cannot make |

The 15 cases in `deploy/scripts/backup-postgres.test.mjs` cover the rest of the control flow, where
driving the real thing is not practical — upload rejected, uploaded blob a different size than sent,
IMDS with no token, retention deleting only expired blobs the script itself named.

### What this rehearsal does not establish

Being explicit, since the point of the exercise is an honest recovery story:

- **The elapsed times are for ~35 rows in a 42 KB archive.** They establish that the procedure is
  correct, not how long a real restore takes. Dump and restore scale with data; the fixed costs
  (`create database`, container round-trips) do not. Re-time this against real data before `graph`
  mode, per §11 of the deployment design.
- **The Blob round trip was not exercised against a real storage account.** Everything up to and
  including the `curl` invocations was, but the VM's managed identity is what authenticates them and
  there was no VM. So the untested parts are specifically: that the identity has the role it needs,
  that a Block Blob PUT of this size succeeds in one call, and that the container listing parses as
  expected against real Azure XML rather than the fixture. **First thing to do once the VM exists:**
  run `deploy/scripts/backup-postgres.sh` by hand, then Path A against the blob it produced. That
  single pass closes this gap.
- **Path C has never been run.** Its individual steps are each drawn from procedures that work
  (`infra/terraform`, `deploy/README.md`'s bring-up, Path A's download), but the sequence as a
  whole is written, not rehearsed, and the provisioning step needs a live subscription to time.
- Restoring the **`keycloak` database** is not covered anywhere, by design: it is not in the dump.
