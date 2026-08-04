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
  warn('ANTHROPIC_API_KEY in .env is a placeholder — set a real key when the SDK is wired up.');
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

async function startPostgres() {
  if ((await probe('docker', ['info'])) !== 0) {
    const howto = IS_WIN
      ? 'Start Rancher Desktop (or Docker Desktop) and wait for the engine, then re-run `pnpm bootstrap`.'
      : 'Start the Docker daemon (Docker Desktop, `sudo systemctl start docker`, or Colima), then re-run `pnpm bootstrap`.';
    fail(`Docker engine is not reachable.\n  ${howto}`);
  }
  info('Docker engine reachable — bringing up Postgres and applying migrations');
  await run('pnpm', ['compose:up']);
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
