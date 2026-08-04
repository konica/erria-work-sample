#!/usr/bin/env node
// Manually dispatch up to MAX ready-for-agent tickets as background `claude` processes.
//
//   node scripts/dispatch-tickets.mjs              auto-compute the frontier, dispatch up to MAX
//   node scripts/dispatch-tickets.mjs 10 11 15     dispatch exactly these ticket numbers
//
// Each dispatched ticket: claimed via assignee, worked in its own git worktree branch
// (worktree-ticket-<n>-<slug>, matching existing PRs #47-#52), one PR per ticket.
// See docs/superpowers/specs/2026-08-04-ticket-dispatch-design.md for the design.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

// ---------------------------------------------------------------------------
// IO (not unit-tested — thin wrappers around `gh`/`claude`; verify by running)

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
}

function repoNameWithOwner() {
  return ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
}

function blockedByCountFor(repo, number) {
  const issue = ghJson(['api', `repos/${repo}/issues/${number}`]);
  return issue.issue_dependencies_summary.blocked_by;
}

function fetchFrontier(repo) {
  const issues = ghJson([
    'issue', 'list',
    '--state', 'open',
    '--label', 'ready-for-agent',
    '--json', 'number,state,assignees,title',
  ]);
  return issues.map((issue) => ({ ...issue, blockedBy: blockedByCountFor(repo, issue.number) }));
}

function fetchByNumbers(repo, numbers) {
  return numbers.map((number) => {
    const issue = ghJson(['issue', 'view', String(number), '--json', 'number,state,assignees,title']);
    return { ...issue, blockedBy: blockedByCountFor(repo, number) };
  });
}

function claim(number) {
  execFileSync('gh', ['issue', 'edit', String(number), '--add-assignee', '@me']);
}

function dispatchOne(issue, repo, logDir) {
  const branch = branchNameFor(issue.number, issue.title);
  const prompt = buildPrompt({ number: issue.number, title: issue.title, branch, repo });
  const logFd = openSync(join(logDir, `ticket-${issue.number}.log`), 'a');
  const child = spawn('claude', ['-p', prompt], { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  return { branch, pid: child.pid };
}

function main() {
  const max = Number(process.env.MAX ?? 3);
  const logDir = process.env.LOG_DIR ?? '.claude/dispatch-logs';
  mkdirSync(logDir, { recursive: true });

  const repo = repoNameWithOwner();
  const requested = process.argv.slice(2).map(Number);
  const issues = requested.length > 0 ? fetchByNumbers(repo, requested) : fetchFrontier(repo);
  const batch = selectBatch(issues, max);

  for (const issue of batch) {
    claim(issue.number);
    const { branch, pid } = dispatchOne(issue, repo, logDir);
    console.log(`Dispatched #${issue.number} (${issue.title}) on ${branch} -- PID ${pid}`);
  }

  console.log(`Dispatched ${batch.length} ticket(s) this run.`);
}

// Only run when executed directly (not when imported by the test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
