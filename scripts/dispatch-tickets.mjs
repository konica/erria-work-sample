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

export function selectBatch(issues, max) {
  return issues
    .filter((issue) => issue.state === 'OPEN' && issue.assignees.length === 0 && issue.blockedBy === 0)
    .sort((a, b) => a.number - b.number)
    .slice(0, max);
}

export function buildPrompt({ number, title, branch, repo }) {
  return `Implement GitHub issue #${number} in this repo (${repo}): "${title}".

- Work in an isolated git worktree on branch ${branch}.
- Read the issue (\`gh issue view ${number} --comments\`), plus CONTEXT.md and any ADRs it references.
- Follow the repo's existing conventions and run the test suite.
- Commit, push ${branch}, and open a PR titled "Ticket #${number} — ${title}".
- Leave issue #${number} open -- it gets closed when the PR merges, not by you.`;
}
