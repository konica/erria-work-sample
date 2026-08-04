import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slugify, branchNameFor } from './dispatch-tickets.mjs';

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
