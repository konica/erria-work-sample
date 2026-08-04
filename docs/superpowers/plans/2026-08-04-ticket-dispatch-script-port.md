# Ticket Dispatch Script (Node Port) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the prototype `scripts/dispatch-tickets.sh` into a tested Node script (`scripts/dispatch-tickets.mjs` + `scripts/dispatch-tickets.test.mjs`), matching the repo's existing `scripts/setup.mjs` / `scripts/setup.test.mjs` pattern.

**Architecture:** Extract the script's decision logic into four small, pure, exported functions — `slugify`, `branchNameFor`, `selectBatch`, `buildPrompt` — each covering one rule from the design doc (branch naming, frontier/cap selection, prompt content). Unit-test each directly with `node:test`. Wire them into a thin, untested `main()` that shells out to `gh` for real GitHub state and backgrounds one detached `claude -p` process per dispatched ticket, exactly like the bash prototype did.

**Tech Stack:** Node >=24 built-ins only (`node:test`, `node:assert/strict`, `node:child_process`, `node:fs`, `node:path`, `node:url`) — no new dependencies. Shells out to the `gh` and `claude` CLIs.

## Global Constraints

- Node >=24 (`package.json` `engines.node`).
- Tests use `node:test` + `node:assert/strict`, matching `scripts/setup.test.mjs`.
- Only pure helpers are unit-tested; IO (`gh`/`claude` calls, `main()`) is manually verified, matching `scripts/setup.mjs`'s existing split.
- Branch naming: `worktree-ticket-<n>-<slug>` (existing convention, PRs #47–#52).
- Frontier definition (design doc §2): `ready-for-agent` label, open, unassigned, `issue_dependencies_summary.blocked_by === 0`.
- Default concurrency cap: `MAX=3`, overridable via env var (design doc §5).
- A dispatched ticket's issue stays open; it closes only when its PR merges (design doc §3 step 5) — the script must never close an issue itself.
- One dispatched `claude` process per ticket, detached, own log file under `.claude/dispatch-logs/` (design doc §5).
- Do not invoke the finished script against real GitHub issues during plan execution — it claims real issues and spawns real background processes. Live verification is the user's own manual step (already tracked in PR #65's test plan).

---

### Task 1: Naming helpers — `slugify` and `branchNameFor`

**Files:**
- Create: `scripts/dispatch-tickets.mjs`
- Create: `scripts/dispatch-tickets.test.mjs`

**Interfaces:**
- Produces: `slugify(title: string): string` — strips a leading `"<number> — "` or `"<number> - "` prefix, lowercases, replaces runs of non-`[a-z0-9]` with `-`, trims leading/trailing `-`, truncates to 40 chars.
- Produces: `branchNameFor(number: number, title: string): string` — returns `` `worktree-ticket-${number}-${slugify(title)}` ``.

- [ ] **Step 1: Write the failing tests**

Create `scripts/dispatch-tickets.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/dispatch-tickets.test.mjs`
Expected: FAIL — `Cannot find module './dispatch-tickets.mjs'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/dispatch-tickets.mjs`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/dispatch-tickets.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/dispatch-tickets.mjs scripts/dispatch-tickets.test.mjs
git commit -m "feat: add slugify/branchNameFor helpers for the Node dispatch script"
```

---

### Task 2: Batch selection — `selectBatch`

**Files:**
- Modify: `scripts/dispatch-tickets.mjs`
- Modify: `scripts/dispatch-tickets.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 (independent pure function; same file).
- Produces: `selectBatch(issues: Issue[], max: number): Issue[]`, where `Issue` is `{ number, state, assignees, blockedBy, ...rest }` — `state` is GitHub's `"OPEN"`/`"CLOSED"` string, `assignees` is an array (only `.length` matters), `blockedBy` is a number. Filters to open + unassigned + unblocked, sorts ascending by `number`, and returns at most `max`, preserving whatever other fields (e.g. `title`) were on the input objects.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/dispatch-tickets.test.mjs`:

```js
import { selectBatch } from './dispatch-tickets.mjs';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/dispatch-tickets.test.mjs`
Expected: FAIL — `selectBatch is not a function` (not exported yet).

- [ ] **Step 3: Write the minimal implementation**

Add to `scripts/dispatch-tickets.mjs`, after `branchNameFor`:

```js
export function selectBatch(issues, max) {
  return issues
    .filter((issue) => issue.state === 'OPEN' && issue.assignees.length === 0 && issue.blockedBy === 0)
    .sort((a, b) => a.number - b.number)
    .slice(0, max);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/dispatch-tickets.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/dispatch-tickets.mjs scripts/dispatch-tickets.test.mjs
git commit -m "feat: add selectBatch for frontier filtering and cap enforcement"
```

---

### Task 3: Prompt builder — `buildPrompt`

**Files:**
- Modify: `scripts/dispatch-tickets.mjs`
- Modify: `scripts/dispatch-tickets.test.mjs`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 directly (independent pure function; same file).
- Produces: `buildPrompt({ number: number, title: string, branch: string, repo: string }): string`.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/dispatch-tickets.test.mjs`:

```js
import { buildPrompt } from './dispatch-tickets.mjs';

test('buildPrompt: names the issue number, title, branch, and repo', () => {
  const prompt = buildPrompt({
    number: 12,
    title: 'An approved message actually sends',
    branch: 'worktree-ticket-12-an-approved-message-actually-sends',
    repo: 'konica/erria-work-sample',
  });
  assert.match(prompt, /Implement GitHub issue #12 in this repo \(konica\/erria-work-sample\)/);
  assert.match(prompt, /"An approved message actually sends"/);
  assert.match(prompt, /worktree-ticket-12-an-approved-message-actually-sends/);
});

test('buildPrompt: instructs leaving the issue open for the PR merge to close it', () => {
  const prompt = buildPrompt({ number: 12, title: 'x', branch: 'b', repo: 'r' });
  assert.match(prompt, /Leave issue #12 open/);
});

test('buildPrompt: instructs the PR title format', () => {
  const prompt = buildPrompt({ number: 12, title: 'An approved message actually sends', branch: 'b', repo: 'r' });
  assert.match(prompt, /"Ticket #12 — An approved message actually sends"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/dispatch-tickets.test.mjs`
Expected: FAIL — `buildPrompt is not a function` (not exported yet).

- [ ] **Step 3: Write the minimal implementation**

Add to `scripts/dispatch-tickets.mjs`, after `selectBatch`:

```js
export function buildPrompt({ number, title, branch, repo }) {
  return `Implement GitHub issue #${number} in this repo (${repo}): "${title}".

- Work in an isolated git worktree on branch ${branch}.
- Read the issue (\`gh issue view ${number} --comments\`), plus CONTEXT.md and any ADRs it references.
- Follow the repo's existing conventions and run the test suite.
- Commit, push ${branch}, and open a PR titled "Ticket #${number} — ${title}".
- Leave issue #${number} open -- it gets closed when the PR merges, not by you.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/dispatch-tickets.test.mjs`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/dispatch-tickets.mjs scripts/dispatch-tickets.test.mjs
git commit -m "feat: add buildPrompt for per-ticket dispatch instructions"
```

---

### Task 4: CLI wiring, cleanup, and doc/package updates

**Files:**
- Modify: `scripts/dispatch-tickets.mjs`
- Modify: `package.json`
- Delete: `scripts/dispatch-tickets.sh`
- Modify: `docs/superpowers/specs/2026-08-04-ticket-dispatch-design.md`

**Interfaces:**
- Consumes: `slugify`, `branchNameFor` (Task 1), `selectBatch` (Task 2), `buildPrompt` (Task 3) — all from `scripts/dispatch-tickets.mjs`.
- Produces: a runnable CLI (`node scripts/dispatch-tickets.mjs [ticket...]`), not itself unit-tested (IO-only, matching `scripts/setup.mjs`'s split between tested pure helpers and untested `main()`).

- [ ] **Step 1: Add the IO functions and `main()`**

Add to `scripts/dispatch-tickets.mjs`, after `buildPrompt`, and add the new imports to the top of the file:

```js
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
```

```js
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
```

- [ ] **Step 2: Run the existing unit tests to confirm nothing broke**

Run: `node --test scripts/dispatch-tickets.test.mjs`
Expected: PASS (14 tests) — `main()` and the IO functions are not directly tested, but adding them must not
break the pure-function tests from Tasks 1–3.

- [ ] **Step 3: Verify the file has no syntax errors and is executable**

Run: `node --check scripts/dispatch-tickets.mjs && chmod +x scripts/dispatch-tickets.mjs`
Expected: no output from `--check` (syntax OK)

Do **not** run `node scripts/dispatch-tickets.mjs` against the real repo as part of this step — it claims
real GitHub issues and spawns real background `claude` processes. Live verification (confirming the
background-launch approach and `claude agents` visibility) is the user's own manual step, already
tracked in PR #65's test plan checklist.

- [ ] **Step 4: Remove the bash prototype**

```bash
git rm scripts/dispatch-tickets.sh
```

- [ ] **Step 5: Add package.json scripts**

Modify `package.json` — add these two entries inside the existing `"scripts"` object (alongside
`"test:setup": "node --test scripts/setup.test.mjs"`):

```json
    "dispatch": "node scripts/dispatch-tickets.mjs",
    "test:dispatch": "node --test scripts/dispatch-tickets.test.mjs",
```

- [ ] **Step 6: Update the design doc's script references**

Modify `docs/superpowers/specs/2026-08-04-ticket-dispatch-design.md` — replace every
`scripts/dispatch-tickets.sh` reference and the `claude -p "$prompt" > "$logfile" 2>&1 &` code
comment in §5 with the Node equivalents:

- `scripts/dispatch-tickets.sh` → `scripts/dispatch-tickets.mjs` (appears in the code block and
  prose of §5, and in the `Status:` header line).
- The code block:
  ```
  scripts/dispatch-tickets.sh              # auto-compute the frontier (§2), dispatch up to MAX=3
  scripts/dispatch-tickets.sh 10 11 15     # or dispatch these specific ticket numbers
  ```
  becomes:
  ```
  node scripts/dispatch-tickets.mjs              # auto-compute the frontier (§2), dispatch up to MAX=3
  node scripts/dispatch-tickets.mjs 10 11 15     # or dispatch these specific ticket numbers
  ```
- The sentence about the launch line becomes: "The `spawn('claude', ['-p', prompt], { detached:
  true, ... })` call in `dispatchOne()` is a best-effort default, not yet verified against how
  sessions are actually started in this environment — confirm before relying on it."

- [ ] **Step 7: Commit**

```bash
git add scripts/dispatch-tickets.mjs scripts/dispatch-tickets.test.mjs package.json \
        docs/superpowers/specs/2026-08-04-ticket-dispatch-design.md
git rm --cached scripts/dispatch-tickets.sh 2>/dev/null || true
git commit -m "feat: wire the Node dispatch script's CLI and remove the bash prototype"
```

---

## Self-Review Notes

- **Spec coverage:** §2 (frontier) → `fetchFrontier`/`fetchByNumbers` + `selectBatch`'s `blockedBy`/`assignees`/`state` filters. §3 (per-ticket dispatch: claim, worktree branch, PR, leave-open) → `claim()`, `branchNameFor`, `buildPrompt`. §5 (manual script, MAX cap, log dir, detached process) → `main()`/`dispatchOne()`. §6 (stale claims stay manual) → no code changes needed; nothing in this plan auto-reclaims. §7 (no auto-merge, no auto-close) → `buildPrompt` explicitly instructs leaving the issue open.
- **Placeholder scan:** no TBD/TODO; every step shows real code or a concrete command with expected output.
- **Type consistency:** `Issue` shape (`number, state, assignees, blockedBy`, plus `title` once fetched) is used identically by `selectBatch` (Task 2), `dispatchOne`/`main` (Task 4), and the fetch functions (Task 4). `buildPrompt`'s parameter names (`number, title, branch, repo`) match how `dispatchOne` calls it.
