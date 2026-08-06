import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseEnvFile,
  isBrokenInstall,
  isDistMissing,
  findPortConflict,
  parseFailedMigrationName,
  extractCreatedTables,
  tablesSatisfied,
  platformCommand,
} from './setup.mjs';

test('platformCommand: POSIX runs the command directly', () => {
  const [file, args] = platformCommand('pnpm', ['--filter', 'worker', 'dev'], false);
  assert.equal(file, 'pnpm');
  assert.deepEqual(args, ['--filter', 'worker', 'dev']);
});

test('platformCommand: Windows routes through cmd.exe /c', () => {
  const [file, args] = platformCommand('pnpm', ['install'], true);
  assert.match(file, /cmd\.exe$/i);
  assert.deepEqual(args, ['/d', '/s', '/c', 'pnpm', 'install']);
});

test('parseEnvFile: parses KEY=VALUE pairs', () => {
  const env = parseEnvFile('DATABASE_URL=postgresql://erria:erria@localhost:5432/erria_dev\nWORKER_PORT=3100\n');
  assert.equal(env.DATABASE_URL, 'postgresql://erria:erria@localhost:5432/erria_dev');
  assert.equal(env.WORKER_PORT, '3100');
});

test('parseEnvFile: skips blanks and comments', () => {
  const env = parseEnvFile('# a comment\n\n   \nCONSOLE_API_PORT=3000\n# trailing comment\n');
  assert.deepEqual(env, { CONSOLE_API_PORT: '3000' });
});

test('parseEnvFile: keeps = that appears inside the value', () => {
  const env = parseEnvFile('DATABASE_URL=postgres://u:p@h:5432/db?schema=public&x=1\n');
  assert.equal(env.DATABASE_URL, 'postgres://u:p@h:5432/db?schema=public&x=1');
});

test('parseEnvFile: trims whitespace and strips surrounding quotes', () => {
  const env = parseEnvFile('  A = "spaced value" \nB=\'single\'\n');
  assert.equal(env.A, 'spaced value');
  assert.equal(env.B, 'single');
});

test('parseEnvFile: ignores lines with no = sign', () => {
  const env = parseEnvFile('NOT_A_PAIR\nGOOD=1\n');
  assert.deepEqual(env, { GOOD: '1' });
});

test('parseEnvFile: tolerates CRLF line endings', () => {
  const env = parseEnvFile('A=1\r\nB=2\r\n');
  assert.deepEqual(env, { A: '1', B: '2' });
});

// isBrokenInstall operates on a real directory, so drive it with temp fixtures.
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'erria-setup-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('isBrokenInstall: absent node_modules is not broken (a normal install handles it)', () => {
  withTempDir((dir) => {
    assert.equal(isBrokenInstall(join(dir, 'node_modules')), false);
  });
});

test('isBrokenInstall: a healthy install (.bin + .modules.yaml present) is not broken', () => {
  withTempDir((dir) => {
    const nm = join(dir, 'node_modules');
    mkdirSync(join(nm, '.bin'), { recursive: true });
    writeFileSync(join(nm, '.modules.yaml'), 'hoistPattern: ["*"]\n');
    assert.equal(isBrokenInstall(nm), false);
  });
});

test('isBrokenInstall: node_modules missing .bin is broken', () => {
  withTempDir((dir) => {
    const nm = join(dir, 'node_modules');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, '.modules.yaml'), 'hoistPattern: ["*"]\n');
    assert.equal(isBrokenInstall(nm), true);
  });
});

test('isBrokenInstall: node_modules missing .modules.yaml is broken', () => {
  withTempDir((dir) => {
    const nm = join(dir, 'node_modules');
    mkdirSync(join(nm, '.bin'), { recursive: true });
    assert.equal(isBrokenInstall(nm), true);
  });
});

test('isDistMissing: true when the build output is absent', () => {
  withTempDir((dir) => {
    assert.equal(isDistMissing(join(dir, 'dist', 'index.js')), true);
  });
});

test('isDistMissing: false once the build output exists', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.js'), 'export {};\n');
    assert.equal(isDistMissing(join(dir, 'dist', 'index.js')), false);
  });
});

test('findPortConflict: no containers means no conflict', () => {
  assert.equal(findPortConflict('', '5432'), null);
});

test('findPortConflict: a container from this repo\'s own compose project is reusable', () => {
  const ps = 'erria-postgres-1|erria|0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp';
  assert.deepEqual(findPortConflict(ps, '5432'), { name: 'erria-postgres-1', reusable: true });
});

test('findPortConflict: an unrelated container holding the port is not reusable', () => {
  const ps = 'some-old-postgres||0.0.0.0:5432->5432/tcp';
  assert.deepEqual(findPortConflict(ps, '5432'), { name: 'some-old-postgres', reusable: false });
});

test('findPortConflict: containers bound to other ports do not conflict', () => {
  const ps = 'erria-keycloak-1|erria|0.0.0.0:8080->8080/tcp\nerria-postgres-1|erria|0.0.0.0:5432->5432/tcp';
  assert.deepEqual(findPortConflict(ps, '8080'), { name: 'erria-keycloak-1', reusable: true });
  assert.equal(findPortConflict(ps, '9999'), null);
});

test('parseFailedMigrationName: extracts the name listed below "have failed"', () => {
  const status = [
    'Following migration have failed:',
    '20260803052443_init',
    '',
    'Read more about how to resolve migration issues: https://pris.ly/d/migrate-resolve',
  ].join('\n');
  assert.equal(parseFailedMigrationName(status), '20260803052443_init');
});

test('parseFailedMigrationName: returns null for a clean, up-to-date schema', () => {
  assert.equal(parseFailedMigrationName('Database schema is up to date!\n'), null);
});

test('extractCreatedTables: pulls every quoted CREATE TABLE name in order', () => {
  const sql = 'CREATE TABLE "accounts" (\n  "id" TEXT NOT NULL\n);\n\nCREATE TABLE "vessels" (\n  "id" TEXT NOT NULL\n);\n';
  assert.deepEqual(extractCreatedTables(sql), ['accounts', 'vessels']);
});

test('extractCreatedTables: returns [] for a migration with no CREATE TABLE', () => {
  const sql = 'ALTER TYPE "LlmCallPurpose" ADD VALUE \'handoff_generation\';\n';
  assert.deepEqual(extractCreatedTables(sql), []);
});

test('tablesSatisfied: true when every table the migration creates already exists', () => {
  assert.equal(tablesSatisfied(['accounts', 'vessels'], ['accounts', 'vessels', 'contacts']), true);
});

test('tablesSatisfied: false when a created table is missing', () => {
  assert.equal(tablesSatisfied(['accounts', 'vessels'], ['accounts']), false);
});

test('tablesSatisfied: false when the migration creates no tables (nothing to verify)', () => {
  assert.equal(tablesSatisfied([], ['accounts']), false);
});
