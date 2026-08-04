#!/usr/bin/env node
// Manually dispatch up to MAX ready-for-agent tickets as background `claude` processes.
//
//   node scripts/dispatch-tickets.mjs              auto-compute the frontier, dispatch up to MAX
//   node scripts/dispatch-tickets.mjs 10 11 15     dispatch exactly these ticket numbers
//
// Each dispatched ticket: claimed via assignee, worked in its own git worktree branch
// (worktree-ticket-<n>-<slug>, matching existing PRs #47-#52), one PR per ticket.
// See docs/superpowers/specs/2026-08-04-ticket-dispatch-design.md for the design.

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in dispatch-tickets.test.mjs)

export function slugify(title) {
  return title
    .replace(/^\d+\s*[—-]\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function branchNameFor(number, title) {
  return `worktree-ticket-${number}-${slugify(title)}`;
}
