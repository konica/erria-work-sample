import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnvFile, isBrokenInstall } from './setup.mjs';

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
