#!/usr/bin/env node
// One-command local environment setup for the Erria outreach agent.
//
//   pnpm bootstrap            install deps, ensure .env, start Postgres + migrate, build
//   pnpm bootstrap --start    do all of the above, then run all three apps
//
// Cross-platform by design: it is plain Node (no dependencies) so it runs the same
// on Windows (PowerShell), macOS, Linux, and the sandbox. See README "Getting started".

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in setup.test.mjs)
// ---------------------------------------------------------------------------

/** Parse a .env file's contents into a key/value object. */
export function parseEnvFile(contents) {
  const out = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * True when `node_modules` exists but the marker files pnpm writes on a
 * successful install are missing — the shape a partial or cross-platform
 * install leaves behind (e.g. a Linux install carried onto a Windows checkout:
 * no `.bin` shims, no `.modules.yaml`). Absent node_modules is NOT broken —
 * a normal `pnpm install` handles that.
 */
export function isBrokenInstall(nodeModulesPath) {
  if (!existsSync(nodeModulesPath)) return false;
  const hasBin = existsSync(join(nodeModulesPath, '.bin'));
  const hasModulesYaml = existsSync(join(nodeModulesPath, '.modules.yaml'));
  return !hasBin || !hasModulesYaml;
}

/**
 * True when a workspace package's build output is missing — e.g.
 * `packages/db/dist/index.js`. `dev` is `tsx watch`, which runs an app's own
 * source but never builds its workspace deps, so a skipped or stale `pnpm
 * build` surfaces as `ERR_MODULE_NOT_FOUND` deep in a child process instead
 * of here.
 */
export function isDistMissing(distEntryPath) {
  return !existsSync(distEntryPath);
}

/**
 * Scan `docker ps` output for a container already publishing `port`, and
 * report whether it belongs to this repo's own compose project (`erria`,
 * pinned in `compose.yaml`) — safe to reuse — or is an unrelated leftover
 * that would make Compose fail with "port is already allocated".
 *
 * Expects one container per line, formatted as `name|composeProject|ports`
 * (see the `docker ps --format` call in `startPostgres`).
 */
export function findPortConflict(psOutput, port, ownProject = 'erria') {
  const marker = `:${port}->`;
  for (const raw of psOutput.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [name, project, ports = ''] = line.split('|');
    if (ports.includes(marker)) return { name, reusable: project === ownProject };
  }
  return null;
}

/**
 * Extract the migration name from `prisma migrate status` output when it
 * reports a failed migration, e.g.:
 *
 *   Following migration have failed:
 *   20260803052443_init
 *
 * Returns null for clean output (nothing to resolve).
 */
export function parseFailedMigrationName(statusOutput) {
  const lines = statusOutput.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => /migrations? have failed/i.test(line));
  if (markerIndex === -1) return null;
  for (let i = markerIndex + 1; i < lines.length; i++) {
    const name = lines[i].trim();
    if (name) return name;
  }
  return null;
}

/** Every table name a migration's SQL creates, in the order they appear. */
export function extractCreatedTables(migrationSql) {
  const tables = [];
  const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"([^"]+)"/gi;
  let match;
  while ((match = re.exec(migrationSql))) tables.push(match[1]);
  return tables;
}

/**
 * True when every table a failed migration's SQL would have created already
 * exists in the database — the signature of an aborted `migrate deploy` that
 * completed its DDL before the bookkeeping row was marked failed, safe to
 * resolve with `prisma migrate resolve --applied`. False (not just unproven)
 * when the migration creates no tables at all — nothing here confirms an
 * `ALTER TYPE`/`ALTER TABLE`-only migration actually completed, so that case
 * is left to the raw Prisma error instead of a false "safe" signal.
 */
export function tablesSatisfied(createdTables, existingTables) {
  if (createdTables.length === 0) return false;
  const existing = new Set(existingTables);
  return createdTables.every((table) => existing.has(table));
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c(1, s);
let stepN = 0;
const step = (msg) => console.log(`\n${bold(`[${++stepN}] ${msg}`)}`);
const info = (msg) => console.log(`    ${msg}`);
const warn = (msg) => console.log(c(33, `    ! ${msg}`));
const fail = (msg) => {
  console.error(c(31, `\n✗ ${msg}`));
  process.exit(1);
};

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

// pnpm is a `.cmd` shim on Windows, which CreateProcess can't launch directly, so
// route through `cmd.exe /c` there. We pass args as a real argv (not `shell: true`,
// which concatenates them and trips DEP0190); every arg here is a static literal.
// On POSIX (Linux/macOS) the command runs directly — pnpm/docker resolve via PATH.
// `isWin` is a parameter so both branches can be unit-tested on either platform.
export function platformCommand(cmd, args, isWin = IS_WIN) {
  if (isWin) return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd, ...args]];
  return [cmd, args];
}

function run(cmd, args, opts = {}) {
  const [file, fileArgs] = platformCommand(cmd, args);
  return new Promise((resolve, reject) => {
    const child = spawn(file, fileArgs, { cwd: ROOT, stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`)),
    );
  });
}

/** Run a command, resolving to its exit code (or -1 if it could not start). Never rejects. */
function probe(cmd, args) {
  const [file, fileArgs] = platformCommand(cmd, args);
  return new Promise((resolve) => {
    const child = spawn(file, fileArgs, { cwd: ROOT, stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** Run a command, resolving to its combined stdout+stderr text. Never rejects. */
function captureOutput(cmd, args) {
  const [file, fileArgs] = platformCommand(cmd, args);
  return new Promise((resolve) => {
    const child = spawn(file, fileArgs, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', () => resolve(output));
    child.on('close', () => resolve(output));
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function checkPrerequisites() {
  const problems = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) problems.push(`Node.js >= 24 required (found ${process.versions.node}).`);
  else info(`Node.js ${process.versions.node}`);

  if ((await probe('pnpm', ['--version'])) !== 0) {
    problems.push('pnpm not found on PATH. Install pnpm 10 (see https://pnpm.io/installation).');
  } else {
    info('pnpm present');
  }

  if ((await probe('docker', ['--version'])) !== 0) {
    problems.push('docker CLI not found on PATH. Install Docker (Rancher Desktop or Docker Desktop).');
  } else {
    info('docker CLI present');
  }

  if (problems.length) fail(`Missing prerequisites:\n  - ${problems.join('\n  - ')}`);
}

function ensureEnv() {
  const envPath = join(ROOT, '.env');
  const examplePath = join(ROOT, '.env.example');
  if (existsSync(envPath)) {
    info('.env already exists — leaving it untouched');
    return;
  }
  if (!existsSync(examplePath)) fail('.env is missing and .env.example was not found to copy from.');
  copyFileSync(examplePath, envPath);
  info('Created .env from .env.example');
  warn('ANTHROPIC_API_KEY in .env is a placeholder — worker needs a real key to draft messages');
  warn('(a trigger still tiers and persists fine; drafting fails and the trigger goes to needs_triage).');
}

function workspaceNodeModules() {
  const dirs = [join(ROOT, 'node_modules')];
  for (const group of ['apps', 'packages']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(base, entry.name, 'node_modules'));
    }
  }
  return dirs;
}

async function install() {
  if (isBrokenInstall(join(ROOT, 'node_modules'))) {
    warn('Existing node_modules looks broken (missing .bin/.modules.yaml) — likely a cross-platform');
    warn('or partial install. Removing every node_modules and reinstalling cleanly.');
    for (const dir of workspaceNodeModules()) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }
  await run('pnpm', ['install']);
}

function readPostgresPort() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return '5432';
  return parseEnvFile(readFileSync(envPath, 'utf8')).POSTGRES_PORT || '5432';
}

async function checkPortConflict() {
  const port = readPostgresPort();
  const psOutput = await captureOutput('docker', [
    'ps',
    '-a',
    '--format',
    '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Ports}}',
  ]);
  const conflict = findPortConflict(psOutput, port);
  if (!conflict) return;
  if (conflict.reusable) {
    info(`Port ${port} is already held by this repo's own \`${conflict.name}\` container — reusing it.`);
    return;
  }
  fail(
    `Port ${port} is already bound by "${conflict.name}", which is not part of this repo's \`erria\` ` +
      `compose project. Inspect it before touching it — it may hold data no seed script can regenerate:\n\n` +
      `    docker ps -a --format '{{.Names}} {{.Status}} {{.Ports}}'\n` +
      `    docker exec ${conflict.name} psql -U erria -d erria_dev -tAc \\\n` +
      `      "select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc"\n\n` +
      `Back it up, then remove it and re-run \`pnpm bootstrap\`:\n\n` +
      `    docker exec ${conflict.name} pg_dump -U erria -d erria_dev > backup.sql\n` +
      `    docker rm -f ${conflict.name}`,
  );
}

/**
 * `compose:up` failed. Check whether it's the known "aborted migrate deploy
 * left the bookkeeping row failed, but every table it creates already
 * exists" case, and if so, print Prisma's documented hotfix instead of the
 * raw Compose/Prisma error. Re-throws the original error whenever the
 * evidence doesn't clearly support that diagnosis.
 */
async function diagnoseMigrationFailure(error) {
  const statusOutput = await captureOutput('pnpm', ['--filter', '@erria/db', 'exec', 'prisma', 'migrate', 'status']);
  const name = parseFailedMigrationName(statusOutput);
  if (!name) throw error;

  const migrationSqlPath = join(ROOT, 'packages/db/prisma/migrations', name, 'migration.sql');
  if (!existsSync(migrationSqlPath)) throw error;
  const createdTables = extractCreatedTables(readFileSync(migrationSqlPath, 'utf8'));

  const tablesOutput = await captureOutput('docker', [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'erria',
    '-d',
    'erria_dev',
    '-tAc',
    "select table_name from information_schema.tables where table_schema='public'",
  ]);
  const existingTables = tablesOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!tablesSatisfied(createdTables, existingTables)) throw error;

  fail(
    `Migration "${name}" is marked failed, but every table it creates (${createdTables.join(', ')}) already ` +
      `exists — the DDL completed before the bookkeeping row was marked failed. Resolve it with Prisma's ` +
      `documented hotfix, then re-run \`pnpm bootstrap\`:\n\n` +
      `    pnpm --filter @erria/db exec prisma migrate resolve --applied "${name}"`,
  );
}

async function startPostgres() {
  if ((await probe('docker', ['info'])) !== 0) {
    const howto = IS_WIN
      ? 'Start Rancher Desktop (or Docker Desktop) and wait for the engine, then re-run `pnpm bootstrap`.'
      : 'Start the Docker daemon (Docker Desktop, `sudo systemctl start docker`, or Colima), then re-run `pnpm bootstrap`.';
    fail(`Docker engine is not reachable.\n  ${howto}`);
  }
  await checkPortConflict();
  info('Docker engine reachable — bringing up Postgres and applying migrations');
  try {
    await run('pnpm', ['compose:up']);
  } catch (error) {
    await diagnoseMigrationFailure(error);
  }
}

function printReady(willStart) {
  console.log(c(32, `\n✓ Local environment is ready.`));
  console.log(`
  Health checks once the apps run:
    console-api  http://localhost:3000/health
    worker       http://localhost:3100/health
    console-web  http://localhost:5173
`);
  if (!willStart) {
    console.log(`  Start everything with:  ${bold('pnpm bootstrap --start')}`);
    console.log(`  Stop Postgres with:     ${bold('pnpm compose:down')}\n`);
  }
}

async function startApps() {
  const dbDistEntry = join(ROOT, 'packages/db/dist/index.js');
  if (isDistMissing(dbDistEntry)) {
    fail(
      '`@erria/db` has not been built (packages/db/dist/index.js is missing). ' +
        'Run `pnpm build`, then re-run `pnpm bootstrap --start`.',
    );
  }
  step('Starting apps (Ctrl-C to stop)');
  const envFromFile = existsSync(join(ROOT, '.env'))
    ? parseEnvFile(readFileSync(join(ROOT, '.env'), 'utf8'))
    : {};
  // The apps read process.env and never load .env themselves — inject it here.
  const childEnv = { ...process.env, ...envFromFile };

  const apps = [
    { label: 'api  ', filter: 'console-api', color: 36 },
    { label: 'worker', filter: 'worker', color: 33 },
    { label: 'web  ', filter: 'console-web', color: 32 },
  ];

  const children = apps.map((app) => {
    const [file, fileArgs] = platformCommand('pnpm', ['--filter', app.filter, 'dev']);
    const child = spawn(file, fileArgs, {
      cwd: ROOT,
      env: childEnv,
      // POSIX: give each app its own process group so shutdown can signal the whole
      // tree (pnpm → `node --watch` → node). Not on Windows — `detached` would open a
      // separate console window there; we use `taskkill /T` instead.
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tag = c(app.color, `[${app.label}]`);
    const pipe = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) console.log(`${tag} ${line}`);
      });
      stream.on('end', () => {
        if (buf) console.log(`${tag} ${buf}`);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    return child;
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nStopping apps…');
    for (const child of children) {
      if (child.pid === undefined) continue;
      // pnpm dev spawns a `node --watch` grandchild that holds the port; kill the
      // whole tree, not just the direct child.
      if (IS_WIN) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM'); // negative pid → the child's process group
        } catch {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already exited */
          }
        }
      }
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {}); // run until interrupted
}

async function main() {
  const willStart = process.argv.slice(2).includes('--start');

  console.log(bold('Erria outreach agent — local setup'));
  step('Checking prerequisites');
  await checkPrerequisites();
  step('Ensuring .env exists');
  ensureEnv();
  step('Installing dependencies');
  await install();
  step('Starting local dependencies (Docker + Postgres)');
  await startPostgres();
  step('Building workspace packages');
  await run('pnpm', ['build']);

  printReady(willStart);
  if (willStart) await startApps();
}

// Only run when executed directly (not when imported by the test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
