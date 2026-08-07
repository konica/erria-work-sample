// Tests for deploy/scripts/backup-postgres.sh (issue #60).
//
// The acceptance criterion this exists for is specific: "a zero-byte or truncated dump is treated
// as a failure, not a success". That is a claim about a shell script's control flow, so these
// tests run the real script — no reimplementation of its logic in JavaScript — with `docker` and
// `curl` replaced by stubs earlier on PATH. The stubs record every invocation to a log file, so
// each test asserts on what the script *did*: which blob it uploaded (or didn't), which Azure
// Monitor metric it published, and which expired dumps it deleted.
//
// `docker` stands in for both halves of the container work: `docker compose exec ... pg_dump`
// (whose stdout the stub fills with a fixture) and `docker compose exec ... pg_restore --list`
// (whose exit status and stdout the fixture controls). `curl` stands in for IMDS token fetches,
// the Blob REST calls, and lib-azure-metric.sh's metric publish.
//
// Run with `pnpm test:backup` (node --test). Same node:test-and-stubs shape as
// scripts/setup.test.mjs and scripts/dispatch-tickets.test.mjs.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backup-postgres.sh');

/**
 * A `pg_restore --list` table of contents with one TABLE DATA entry per table — the exact line
 * shape postgres:17's pg_restore prints (`<id>; 0 <oid> TABLE DATA public <table> <owner>`),
 * copied from a real dump of the seeded dev database rather than guessed at.
 */
function toc(tables) {
  return tables.map((t, i) => `${3600 + i}; 0 ${16500 + i} TABLE DATA public ${t} erria`).join('\n');
}

const ALL_TABLES = [
  '_prisma_migrations',
  'accounts',
  'audit_samples',
  'contacts',
  'escalations',
  'llm_calls',
  'messages',
  'resolutions',
  'settings',
  'tier_history_events',
  'triggers',
  'vessels',
];

let workDir;

/**
 * Writes the two stubs onto a directory that goes first on PATH.
 *
 * Both are driven by files in the same directory rather than by environment variables, so a test
 * can change one stub's behaviour without re-deriving the whole environment: `dump.bin` is what
 * pg_dump emits, `toc.txt` what pg_restore --list emits, `pg_restore.rc` its exit status,
 * `head-size` the Content-Length the blob HEAD reports back, and `curl-fail` a newline-separated
 * list of URL substrings the curl stub should fail on.
 */
before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'erria-backup-test-'));
  const binDir = path.join(workDir, 'bin');

  const dockerStub = `#!/usr/bin/env bash
# Stub for \`docker compose ... exec -T postgres <pg_dump|pg_restore>\`.
echo "docker $*" >> "$STUB_LOG"
for arg in "$@"; do
  case "$arg" in
    pg_dump) cat "$STUB_DIR/dump.bin"; exit 0 ;;
    pg_restore) cat "$STUB_DIR/toc.txt"; exit "$(cat "$STUB_DIR/pg_restore.rc")" ;;
  esac
done
exit 0
`;

  const curlStub = `#!/usr/bin/env bash
# Stub for every curl the script makes: the two IMDS token fetches, the Blob PUT/HEAD/GET/DELETE
# calls, and lib-azure-metric.sh's metrics POST. Recognised by URL, because that is what
# distinguishes them — the script's own header/flag choices are asserted from the log line.
url=""
method="GET"
prev=""
for arg in "$@"; do
  case "$prev" in -X) method="$arg" ;; esac
  case "$arg" in
    --head) method=HEAD ;;
    http*) url="$arg" ;;
  esac
  prev="$arg"
done
echo "curl $method $url" >> "$STUB_LOG"

if [ -f "$STUB_DIR/curl-fail" ]; then
  while read -r pattern; do
    [ -n "$pattern" ] || continue
    case "$url" in *"$pattern"*) exit 22 ;; esac
  done < "$STUB_DIR/curl-fail"
fi

case "$url" in
  *169.254.169.254*oauth2/token*)
    echo '{"access_token":"stub-token","expires_in":"3599"}' ;;
  *169.254.169.254*metadata/instance/compute*)
    echo '{"resourceId":"/subscriptions/s/resourceGroups/erria-review/providers/Microsoft.Compute/virtualMachines/vm","location":"centralus"}' ;;
  *monitoring.azure.com*)
    : ;;
  *comp=list*)
    cat "$STUB_DIR/listing.xml" ;;
  *)
    # A blob PUT/HEAD/DELETE. HEAD is the only one the script reads headers back from — it reports
    # head-size if the test wrote one, otherwise the real size of what was "uploaded".
    if [ "$method" = HEAD ]; then
      if [ -s "$STUB_DIR/head-size" ]; then
        size="$(cat "$STUB_DIR/head-size")"
      else
        size="$(wc -c < "$STUB_DIR/dump.bin" | tr -d ' ')"
      fi
      printf 'HTTP/1.1 200 OK\\r\\nContent-Length: %s\\r\\n\\r\\n' "$size"
    fi ;;
esac
exit 0
`;

  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'docker'), dockerStub);
  writeFileSync(path.join(binDir, 'curl'), curlStub);
  chmodSync(path.join(binDir, 'docker'), 0o755);
  chmodSync(path.join(binDir, 'curl'), 0o755);
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/**
 * Runs the real script with the stubs on PATH.
 *
 * @param {object} fixture
 * @param {number} [fixture.dumpBytes] size of the fake pg_dump output
 * @param {string[]} [fixture.tables] tables the fake TOC lists
 * @param {number} [fixture.pgRestoreRc] exit status of the fake pg_restore --list
 * @param {string[]} [fixture.blobs] blob names the fake container listing returns
 * @param {string[]} [fixture.curlFail] URL substrings whose curl call should fail
 * @param {number} [fixture.headSize] Content-Length the blob HEAD reports, if not the dump's size
 * @param {Record<string,string>} [fixture.env] extra environment for the script
 */
async function runBackup(fixture = {}) {
  const {
    dumpBytes = 41795,
    tables = ALL_TABLES,
    pgRestoreRc = 0,
    blobs = [],
    curlFail = [],
    headSize = null,
    env = {},
  } = fixture;

  const stubDir = mkdtempSync(path.join(workDir, 'run-'));
  const stubLog = path.join(stubDir, 'calls.log');

  writeFileSync(path.join(stubDir, 'dump.bin'), Buffer.alloc(dumpBytes, 0x41));
  writeFileSync(path.join(stubDir, 'toc.txt'), `${toc(tables)}\n`);
  writeFileSync(path.join(stubDir, 'pg_restore.rc'), String(pgRestoreRc));
  writeFileSync(path.join(stubDir, 'curl-fail'), `${curlFail.join('\n')}\n`);
  writeFileSync(path.join(stubDir, 'head-size'), headSize === null ? '' : String(headSize));
  writeFileSync(path.join(stubDir, 'listing.xml'), containerListing(blobs));
  writeFileSync(stubLog, '');

  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    const result = await execFileAsync('bash', [SCRIPT], {
      env: {
        PATH: `${path.join(workDir, 'bin')}:${process.env.PATH}`,
        STUB_DIR: stubDir,
        STUB_LOG: stubLog,
        BACKUP_STORAGE_ACCOUNT: 'erriareviewbackups',
        BACKUP_CONTAINER: 'pg-backups',
        BACKUP_RETENTION_DAYS: '14',
        POSTGRES_USER: 'erria',
        POSTGRES_DB: 'erria',
        ...env,
      },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
    code = error.code ?? 1;
  }

  return { code, stdout, stderr, calls: readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean) };
}

function containerListing(names) {
  const blobs = names.map((n) => `<Blob><Name>${n}</Name></Blob>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${blobs}</Blobs></EnumerationResults>`;
}

/** YYYYmmdd `daysAgo` days before now, UTC — how the script names and ages its blobs. */
function stampDaysAgo(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const uploads = (calls) => calls.filter((c) => /^curl PUT https:\/\/[^ ]*\.blob\./.test(c));
const deletes = (calls) => calls.filter((c) => c.startsWith('curl DELETE https://'));
// The POST to the custom-metrics endpoint, not the IMDS token fetch that *names* that endpoint in
// its url-encoded `resource=` parameter — both lines contain the string "monitoring.azure.com".
const metricPosts = (calls) => calls.filter((c) => /^curl POST https:\/\/[^ ]*\.monitoring\.azure\.com/.test(c));

describe('backup-postgres.sh', () => {
  it('dumps, verifies, uploads, and reports the dump size', async () => {
    const { code, stdout, calls } = await runBackup();

    assert.equal(code, 0, stdout);
    assert.match(stdout, /backup OK erria-\d{8}T\d{6}Z\.dump/);
    assert.equal(uploads(calls).length, 1);
    assert.match(uploads(calls)[0], /\/pg-backups\/erria-\d{8}T\d{6}Z\.dump$/);
    // The size metric publishes; the failure metric does not.
    assert.equal(metricPosts(calls).length, 1);
    assert.doesNotMatch(stdout, /FAILED/);
  });

  it('dumps the database named by POSTGRES_DB, as POSTGRES_USER', async () => {
    const { calls } = await runBackup({ env: { POSTGRES_DB: 'erria', POSTGRES_USER: 'erria' } });
    const dumpCall = calls.find((c) => c.includes('pg_dump'));
    assert.match(dumpCall, /--username=erria/);
    assert.match(dumpCall, /--dbname=erria/);
    // --format=custom is load-bearing: it is what makes `pg_restore --list` verification and a
    // restore into a differently-named scratch database possible at all.
    assert.match(dumpCall, /--format=custom/);
  });

  // --- The acceptance criterion: a bad dump is a failure, not a success ---------------------

  it('fails on a zero-byte dump and uploads nothing', async () => {
    const { code, stderr, calls } = await runBackup({ dumpBytes: 0 });

    assert.equal(code, 1);
    assert.match(stderr, /dump is 0 bytes, below the 20480-byte floor/);
    assert.equal(uploads(calls).length, 0, 'a zero-byte dump must never reach Blob Storage');
    assert.equal(metricPosts(calls).length, 1, 'the failure metric must publish');
  });

  it('fails on a dump that is under the size floor but not empty', async () => {
    const { code, stderr, calls } = await runBackup({ dumpBytes: 4096 });

    assert.equal(code, 1);
    assert.match(stderr, /dump is 4096 bytes, below the 20480-byte floor/);
    assert.equal(uploads(calls).length, 0);
  });

  it('fails on a truncated dump that is large enough to pass the size floor', async () => {
    // The case the size floor cannot catch, and the reason the structural check exists: real
    // postgres:17 pg_restore exits 1 with "could not read from input file: end of file" here.
    const { code, stderr, calls } = await runBackup({ dumpBytes: 30000, pgRestoreRc: 1 });

    assert.equal(code, 1);
    assert.match(stderr, /pg_restore --list could not read the dump — truncated or corrupt/);
    assert.equal(uploads(calls).length, 0);
    assert.equal(metricPosts(calls).length, 1);
  });

  it('fails on a structurally valid dump of an unmigrated database', async () => {
    const { code, stderr, calls } = await runBackup({ tables: ['_prisma_migrations'] });

    assert.equal(code, 1);
    assert.match(stderr, /no data entry for the accounts table/);
    assert.equal(uploads(calls).length, 0);
  });

  it('fails when the upload itself is rejected', async () => {
    const { code, stderr } = await runBackup({ curlFail: ['/pg-backups/erria-'] });

    assert.equal(code, 1);
    assert.match(stderr, /upload of erria-\d{8}T\d{6}Z\.dump to pg-backups failed/);
  });

  it('fails when the blob that landed is a different size from the local dump', async () => {
    // A 201 on the PUT is not proof: this is the truncation failure one step later, in Blob
    // Storage rather than on disk, and it must not be reported as a successful backup.
    const { code, stderr } = await runBackup({ dumpBytes: 41795, headSize: 40000 });

    assert.equal(code, 1);
    assert.match(stderr, /uploaded blob is 40000 bytes but the local dump is 41795/);
  });

  it('fails, and reports the failure metric, when IMDS has no storage token', async () => {
    const { code, stderr, calls } = await runBackup({ curlFail: ['oauth2/token'] });

    assert.equal(code, 1);
    assert.match(stderr, /could not read a storage token from IMDS/);
    assert.equal(uploads(calls).length, 0, 'nothing is dumped or uploaded without credentials');
    assert.equal(calls.filter((c) => c.includes('pg_dump')).length, 0);
  });

  it('fails when BACKUP_STORAGE_ACCOUNT is unset', async () => {
    const { code, stderr } = await runBackup({ env: { BACKUP_STORAGE_ACCOUNT: '' } });

    assert.equal(code, 1);
    assert.match(stderr, /BACKUP_STORAGE_ACCOUNT is not set/);
  });

  // --- Retention ----------------------------------------------------------------------------

  it('deletes dumps older than the retention window and keeps the rest', async () => {
    const expired = `erria-${stampDaysAgo(20)}T023000Z.dump`;
    const alsoExpired = `erria-${stampDaysAgo(15)}T023000Z.dump`;
    const kept = `erria-${stampDaysAgo(13)}T023000Z.dump`;
    const keptToday = `erria-${stampDaysAgo(0)}T023000Z.dump`;

    const { code, stdout, calls } = await runBackup({
      blobs: [expired, alsoExpired, kept, keptToday],
    });

    assert.equal(code, 0, stdout);
    const deleted = deletes(calls).map((c) => c.split('/').pop());
    assert.deepEqual(deleted.sort(), [alsoExpired, expired].sort());
    assert.match(stdout, /retention applied cutoff=\d{8} deleted=2 retention_days=14/);
  });

  it('honours a shorter retention window', async () => {
    const blobs = [`erria-${stampDaysAgo(5)}T023000Z.dump`, `erria-${stampDaysAgo(1)}T023000Z.dump`];
    const { code, calls } = await runBackup({ blobs, env: { BACKUP_RETENTION_DAYS: '3' } });

    assert.equal(code, 0);
    assert.deepEqual(
      deletes(calls).map((c) => c.split('/').pop()),
      [blobs[0]],
    );
  });

  it('never deletes a blob it did not name, however old it looks', async () => {
    // The container is private and holds only this script's dumps today, but a delete loop is
    // exactly the code that must not widen its own blast radius later.
    const strangers = [
      'keycloak-20200101T000000Z.dump',
      'erria-20200101.dump',
      'erria-20200101T000000Z.dump.bak',
      'notes/erria-20200101T000000Z.dump',
    ];
    const { code, calls } = await runBackup({ blobs: strangers });

    assert.equal(code, 0);
    assert.deepEqual(deletes(calls), []);
  });

  it('reports a retention failure without failing the run', async () => {
    // A prune that cannot run is not data loss — the dump is already uploaded and verified, so
    // exiting non-zero would suppress the crontab's heartbeat and make the absence alert claim
    // there is no backup today. The failure metric fires instead: someone looks, and the
    // heartbeat keeps telling the truth.
    const { code, stdout, stderr, calls } = await runBackup({ curlFail: ['comp=list'] });

    assert.equal(code, 0);
    assert.equal(uploads(calls).length, 1, 'the dump still landed in Blob Storage');
    assert.match(stdout, /uploaded erria-\d{8}T\d{6}Z\.dump/);
    assert.match(stderr, /could not list pg-backups — retention was not applied this run/);
    assert.match(stderr, /backup stored erria-\d{8}T\d{6}Z\.dump but reported a problem/);
    assert.equal(metricPosts(calls).length, 2, 'size metric plus the failure metric');
  });

  it('reports a delete failure without failing the run', async () => {
    const expired = `erria-${stampDaysAgo(20)}T023000Z.dump`;
    const { code, stderr, calls } = await runBackup({
      blobs: [expired],
      curlFail: [expired],
    });

    assert.equal(code, 0);
    assert.equal(deletes(calls).length, 1, 'it tried');
    assert.match(stderr, new RegExp(`could not delete expired dump ${expired}`));
  });
});
