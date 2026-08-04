import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slugify, branchNameFor, selectBatch } from './dispatch-tickets.mjs';

test('slugify: strips a leading "<number> — " prefix and lowercases', () => {
  assert.equal(slugify('12 — An approved message actually sends'), 'an-approved-message-actually-sends');
});

test('slugify: strips a leading "<number> - " prefix (hyphen variant)', () => {
  assert.equal(slugify('20 - Settings screen'), 'settings-screen');
});

test('slugify: replaces punctuation and collapses repeats', () => {
  assert.equal(slugify('10 — Contact ingestion, prefactor!!'), 'contact-ingestion-prefactor');
});

test('slugify: truncates to 40 characters', () => {
  const long = '99 — ' + 'a'.repeat(60);
  const result = slugify(long);
  assert.equal(result.length, 40);
  assert.equal(result, 'a'.repeat(40));
});

test('branchNameFor: builds the worktree-ticket-<n>-<slug> branch name', () => {
  assert.equal(
    branchNameFor(12, '12 — An approved message actually sends'),
    'worktree-ticket-12-an-approved-message-actually-sends',
  );
});

function issue(overrides) {
  return { number: 1, state: 'OPEN', assignees: [], blockedBy: 0, title: 'stub', ...overrides };
}

test('selectBatch: filters out closed issues', () => {
  const result = selectBatch([issue({ number: 1, state: 'CLOSED' }), issue({ number: 2 })], 5);
  assert.deepEqual(result.map((i) => i.number), [2]);
});

test('selectBatch: filters out already-assigned issues', () => {
  const result = selectBatch([issue({ number: 1, assignees: [{ login: 'someone' }] }), issue({ number: 2 })], 5);
  assert.deepEqual(result.map((i) => i.number), [2]);
});

test('selectBatch: filters out blocked issues', () => {
  const result = selectBatch([issue({ number: 1, blockedBy: 2 }), issue({ number: 2 })], 5);
  assert.deepEqual(result.map((i) => i.number), [2]);
});

test('selectBatch: sorts ascending by issue number', () => {
  const result = selectBatch([issue({ number: 23 }), issue({ number: 10 }), issue({ number: 15 })], 5);
  assert.deepEqual(result.map((i) => i.number), [10, 15, 23]);
});

test('selectBatch: caps at max, keeping the lowest numbers', () => {
  const result = selectBatch([issue({ number: 10 }), issue({ number: 11 }), issue({ number: 15 })], 2);
  assert.deepEqual(result.map((i) => i.number), [10, 11]);
});

test('selectBatch: preserves extra fields like title on the returned issues', () => {
  const result = selectBatch([issue({ number: 10, title: 'Contact ingestion prefactor' })], 5);
  assert.equal(result[0].title, 'Contact ingestion prefactor');
});
