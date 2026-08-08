#!/usr/bin/env bash
#
# Nightly `pg_dump` of the deployment's Postgres to Azure Blob Storage, with a retention window
# (issue #60). This is the whole of ADR-0007's backup story: self-hosting gave up Flexible
# Server's continuous backup and ~15-minute RPO, so RPO here is "since last night's dump" and the
# restore path is `deploy/restore-runbook.md`, rehearsed rather than assumed.
#
# **The dump is written to a local file and verified before it is uploaded, not piped straight to
# Blob.** A pipe is one command shorter and cannot be checked: `pg_dump | upload` reports success
# for a dump that died three tables in, because the uploader only ever sees a stream that ended.
# Since the failure this ticket is explicitly about is "a cron job that uploads a 0-byte file
# every night looks exactly like a working backup", the temp file is the point — three checks run
# against it before anything is uploaded (see "Verify" below), and it is deleted on the way out
# whether the run succeeded or not.
#
# Talks to Blob Storage over the REST API with the VM's own system-assigned managed identity, the
# same IMDS mechanism deploy/scripts/lib-azure-metric.sh already uses for custom metrics — so this
# adds no azcopy/az-CLI install to the box and holds no storage key anywhere. The identity needs
# "Storage Blob Data Contributor" on the backup container (infra/terraform/storage.tf).
#
# Two alerts watch this, and they are deliberately different signals (issue #60):
#
#   - "Postgres Backup Failure" — published by this script when a run fails. Fires within minutes.
#     Tells you the job ran and something went wrong.
#   - "Postgres Backup Heartbeat" — published by deploy/scripts/report-job-heartbeat.sh, chained
#     with `&&` in deploy/crontab so it only publishes after a *successful* run.
#     infra/terraform/monitoring.tf alerts on the *absence* of it over 24 hours. Tells you no
#     good backup happened — including the case this script never ran at all, which produces no
#     failure metric because nothing executed to publish one.
#
# The second one is the one that matters most: cron mails failures to a local mailbox nobody
# reads, and a job that silently stopped firing has no output to mail in the first place.
#
# Run via cron nightly (deploy/crontab) with .env sourced — see that file for the exact entry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib-azure-metric.sh
. "${SCRIPT_DIR}/lib-azure-metric.sh"

# `docker compose` needs the two compose files, which live at the repo root — resolved from this
# script's own location rather than inherited from cron's `cd`, so running it by hand from
# anywhere (which the restore rehearsal does) behaves identically to the cron entry.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

COMPOSE=(docker compose -f compose.yaml -f compose.deploy.yaml)

# Same defaults compose.deploy.yaml's DATABASE_URL uses, for the same reason: the deployed values
# come from .env and these only cover the case where one is absent.
POSTGRES_USER="${POSTGRES_USER:-erria}"
POSTGRES_DB="${POSTGRES_DB:-erria}"

BACKUP_CONTAINER="${BACKUP_CONTAINER:-pg-backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# A floor, not a size expectation. A `--format=custom` dump of an empty-but-migrated schema is
# already several KB of TOC, so anything under this is a truncated or failed dump rather than a
# quiet week — the structural check below is what actually judges the contents.
BACKUP_MIN_BYTES="${BACKUP_MIN_BYTES:-20480}"

# Tables whose data must be present in the dump's table of contents. Deliberately a handful of
# core entities from CONTEXT.md rather than every model: this check exists to catch a dump taken
# against the wrong (or an empty, unmigrated) database, which is a failure mode a size floor
# cannot see, not to track the schema as it grows. Physical table names (snake_case plural, per
# the Prisma schema's @@map), not the CONTEXT.md entity names — `pg_restore --list` prints what
# is in the database.
BACKUP_REQUIRED_TABLES="${BACKUP_REQUIRED_TABLES:-accounts contacts triggers messages}"

# Azure Storage REST API version. Pinned rather than omitted — the service defaults to a very old
# version for requests that send no x-ms-version, and bearer-token (managed identity) auth needs
# 2017-11-09 or later.
BLOB_API_VERSION='2021-08-06'

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BLOB_NAME="erria-${STAMP}.dump"
WORK_DIR="$(mktemp -d)"
DUMP_FILE="${WORK_DIR}/${BLOB_NAME}"

PROBLEM=0

# Records a problem and logs it. Callers that cannot continue call `exit 1` immediately after;
# callers that can (retention — see below) do not, and the run still ends 0.
fail() {
  echo "backup-postgres: $*" >&2
  PROBLEM=1
}

# Publishes the failure metric once, on any path out that reported a problem — including the
# `set -e` exits from the commands below, which is why this is an EXIT trap rather than an
# explicit call at each failure site. It deliberately does not change the exit status: the status
# decides whether deploy/crontab's `&&` publishes the success heartbeat, and that is a separate
# question from whether anything went wrong (see the retention section at the bottom).
# `|| true` because failing to *report* a failure must not mask the original exit status.
on_exit() {
  local status=$?
  rm -rf "$WORK_DIR"
  if [ "$status" -ne 0 ] || [ "$PROBLEM" -ne 0 ]; then
    publish_azure_metric 'Postgres Backup Failure' 1 || true
    if [ "$status" -ne 0 ]; then
      echo "$(date -u +%FT%TZ) backup FAILED — no dump was stored (blob=${BLOB_NAME})" >&2
    else
      echo "$(date -u +%FT%TZ) backup stored ${BLOB_NAME} but reported a problem — see above" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

# Checked here rather than with `${VAR:?}` at the top so the trap above is already installed and a
# misconfigured VM still raises the failure alert instead of exiting silently into a log file.
if [ -z "${BACKUP_STORAGE_ACCOUNT:-}" ]; then
  fail "BACKUP_STORAGE_ACCOUNT is not set — source .env first (see deploy/crontab), or export it directly"
  exit 1
fi

BLOB_BASE="https://${BACKUP_STORAGE_ACCOUNT}.blob.core.windows.net/${BACKUP_CONTAINER}"

# Managed-identity token for Storage, not for Monitor — a different audience from
# lib-azure-metric.sh's, so it is fetched separately rather than shared.
storage_token() {
  curl -sf -H 'Metadata: true' \
    'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F' \
    | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4
}

# `|| true` so the explicit check below is what reports the problem: without it, `set -o pipefail`
# turns a failed IMDS call into a bare non-zero exit and the operator gets no line explaining which
# of the several things this script needs was missing.
TOKEN="$(storage_token || true)"
if [ -z "$TOKEN" ]; then
  fail "could not read a storage token from IMDS — is this running on the VM, with 'Storage Blob Data Contributor' assigned to its identity? (infra/terraform/storage.tf)"
  exit 1
fi

blob_curl() {
  local method="$1" url="$2"
  shift 2
  # HEAD goes through --head, not `-X HEAD`: with -X, curl still expects a response body and waits
  # for one that a HEAD response never sends, so the call hangs until a timeout instead of
  # returning headers. --head is the flag that actually means HEAD.
  local -a verb
  if [ "$method" = HEAD ]; then verb=(--head); else verb=(-X "$method"); fi
  curl -sf "${verb[@]}" "$url" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-ms-version: ${BLOB_API_VERSION}" \
    "$@"
}

# --- Dump ---------------------------------------------------------------------------------------
#
# --format=custom, not plain SQL: it is compressed (so the upload is smaller), it restores with
# pg_restore into a differently-named scratch database without editing the file (which is exactly
# what the restore rehearsal does), and — the reason it matters here — it carries a header and a
# table of contents that `pg_restore --list` can validate, which a plain .sql file cannot offer.
echo "$(date -u +%FT%TZ) dumping ${POSTGRES_DB} as ${POSTGRES_USER} -> ${BLOB_NAME}"
"${COMPOSE[@]}" exec -T postgres \
  pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=6 \
  > "$DUMP_FILE"

# --- Verify -------------------------------------------------------------------------------------
#
# Three checks, each catching something the others cannot: a size floor (0-byte/near-empty file),
# a structural read of the archive (truncated or corrupt mid-file), and a content assertion
# (a technically-valid dump of the wrong or an unmigrated database).
SIZE_BYTES="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
if [ "$SIZE_BYTES" -lt "$BACKUP_MIN_BYTES" ]; then
  fail "dump is ${SIZE_BYTES} bytes, below the ${BACKUP_MIN_BYTES}-byte floor — treating as a failed dump, not a small one. Nothing was uploaded."
  exit 1
fi

# pg_restore lives in the Postgres container, not on the host (the VM has Docker and nothing else
# — see infra/terraform/cloud-init.yaml.tftpl), so the archive is streamed back into the container
# to be read. `--list` reads only the header and TOC, so it costs a fraction of a real restore
# while still failing on a file whose bytes stop early.
#
# Verified against postgres:17 rather than assumed, both halves of it: `pg_restore --list` does
# read a `--format=custom` archive from stdin (no filename argument, no seekable file needed for
# a TOC read), and it exits 1 with "could not read from input file: end of file" on an archive
# truncated to 30 KB — which is *above* the size floor above, so this check is what catches a
# truncation the floor cannot. See deploy/restore-runbook.md's rehearsal log.
if ! TOC="$("${COMPOSE[@]}" exec -T postgres pg_restore --list 2>&1 < "$DUMP_FILE")"; then
  fail "pg_restore --list could not read the dump — truncated or corrupt. Nothing was uploaded. pg_restore said: ${TOC}"
  exit 1
fi

for table in $BACKUP_REQUIRED_TABLES; do
  if ! printf '%s\n' "$TOC" | grep -qE "TABLE DATA public +${table}( |\$)"; then
    fail "dump has no data entry for the ${table} table — this looks like a dump of an empty or unmigrated database, not of the deployment. Nothing was uploaded."
    exit 1
  fi
done

echo "$(date -u +%FT%TZ) verified dump size_bytes=${SIZE_BYTES} toc_entries=$(printf '%s\n' "$TOC" | grep -c 'TABLE DATA' || true)"

# --- Upload -------------------------------------------------------------------------------------
#
# -T streams the file rather than reading it into memory the way --data-binary would, and implies
# PUT; the method is still passed explicitly so blob_curl's signature stays uniform.
if ! blob_curl PUT "${BLOB_BASE}/${BLOB_NAME}" \
  -H 'x-ms-blob-type: BlockBlob' \
  -H 'Content-Type: application/octet-stream' \
  -T "$DUMP_FILE" > /dev/null; then
  fail "upload of ${BLOB_NAME} to ${BACKUP_CONTAINER} failed"
  exit 1
fi

# Read back what actually landed rather than trusting a 201. An upload that reported success but
# stored fewer bytes than we sent is the same failure as a truncated dump, one step later, and
# a HEAD costs nothing.
REMOTE_SIZE="$(blob_curl HEAD "${BLOB_BASE}/${BLOB_NAME}" \
  | grep -i '^content-length:' | tr -dc '0-9' || true)"
if [ "$REMOTE_SIZE" != "$SIZE_BYTES" ]; then
  fail "uploaded blob is ${REMOTE_SIZE:-unreadable} bytes but the local dump is ${SIZE_BYTES} — the blob in Blob Storage is not a complete dump"
  exit 1
fi

echo "$(date -u +%FT%TZ) uploaded ${BLOB_NAME} bytes=${SIZE_BYTES} container=${BACKUP_CONTAINER} account=${BACKUP_STORAGE_ACCOUNT}"
# Not fatal, and not guarded by `set -e` reaching in and aborting the run: the dump is stored at
# this point, so a Monitor outage must not stop retention from running or suppress the heartbeat.
publish_azure_metric 'Postgres Backup Size Bytes' "$SIZE_BYTES" \
  || fail "could not publish the dump-size metric — the dump itself is stored and verified"

# --- Retention ----------------------------------------------------------------------------------
#
# Old dumps are deleted here rather than by an Azure Blob lifecycle-management policy, which is
# the more declarative option and was the alternative considered. Two reasons for the script: the
# delete path is then the same one the nightly run exercises and the test suite covers
# (deploy/scripts/backup-postgres.test.mjs), instead of a rule whose first real execution is
# whenever Azure next evaluates it — up to 48 hours later, which makes "verify old dumps are
# actually deleted" a two-day wait rather than one run.
#
# Failures below are reported but do NOT fail the run, and this is deliberate: the dump is already
# uploaded and verified at this point, so exiting non-zero would suppress deploy/crontab's success
# heartbeat and tell the absence alert "there is no backup today" when there demonstrably is one.
# A broken prune raises the failure alert instead (someone looks) while the heartbeat still says a
# good dump landed — the two alerts stay honest about two different things. What eventually fills
# is a Blob container, not this VM's disk, so the disk-usage alert is unaffected either way.
CUTOFF="$(date -u -d "${BACKUP_RETENTION_DAYS} days ago" +%Y%m%d)"

prune_old_dumps() {
  local listing names name stamp deleted=0
  if ! listing="$(blob_curl GET "${BLOB_BASE}?restype=container&comp=list&prefix=erria-")"; then
    fail "could not list ${BACKUP_CONTAINER} — retention was not applied this run, so dumps older than ${BACKUP_RETENTION_DAYS} days may still be there"
    return 0
  fi

  # One <Name> per blob. Pagination (<NextMarker>) is not followed: a single page returns up to
  # 5,000 blobs and the retention window keeps this container two orders of magnitude below that,
  # so a second page would itself be the anomaly worth noticing rather than something to handle.
  #
  # Anything that is not exactly a dump this script named is left alone — the regex is the guard
  # that keeps a delete loop pointed at a container of other people's data from ever matching
  # something it did not create.
  names="$(printf '%s' "$listing" | grep -o '<Name>[^<]*</Name>' | sed 's|<Name>||; s|</Name>||' || true)"

  for name in $names; do
    if [[ ! "$name" =~ ^erria-([0-9]{8})T[0-9]{6}Z\.dump$ ]]; then
      continue
    fi
    stamp="${BASH_REMATCH[1]}"
    # Numeric, not lexicographic: both sides are YYYYmmdd so they order identically either way,
    # but 10# makes the intent explicit and sidesteps any leading-zero octal reading.
    if [ "$((10#$stamp))" -ge "$((10#$CUTOFF))" ]; then
      continue
    fi
    if blob_curl DELETE "${BLOB_BASE}/${name}" > /dev/null; then
      echo "$(date -u +%FT%TZ) deleted expired dump ${name} (older than ${BACKUP_RETENTION_DAYS} days)"
      deleted=$((deleted + 1))
    else
      fail "could not delete expired dump ${name}"
    fi
  done

  echo "$(date -u +%FT%TZ) retention applied cutoff=${CUTOFF} deleted=${deleted} retention_days=${BACKUP_RETENTION_DAYS}"
}

prune_old_dumps

if [ "$PROBLEM" -eq 0 ]; then
  echo "$(date -u +%FT%TZ) backup OK ${BLOB_NAME}"
fi
