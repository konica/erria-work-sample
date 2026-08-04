# Parallel Ticket Dispatch — Design

Status: Approved — live-tested; `claude agents` visibility confirmed (§5)
Last updated: 2026-08-04

## 1. Problem

18 issues are open with the `ready-for-agent` label (#10–#27), plus #40 which is `needs-triage`
and out of scope here. They form a real dependency graph via GitHub's native issue dependencies —
not all of them can be worked at once, and a PM adding new tickets later only makes that graph
bigger, not something that can be hard-coded. So far, tickets have been dispatched and merged one at
a time (one worktree branch + one PR per ticket, e.g. PRs #47–#52). This design describes how to
dispatch several tickets at once, safely, in background agent sessions, while an operator monitors
progress.

## 2. Continuous frontier computation

An issue is dispatchable at the moment it is:

- labeled `ready-for-agent`
- open
- unassigned
- `issue_dependencies_summary.blocked_by == 0` (query per-issue via `gh api
  repos/konica/erria-work-sample/issues/<n>`, since `gh issue list` doesn't expose it)

This is the same frontier-query shape `docs/agents/issue-tracker.md` already describes for
wayfinder maps, applied here to implementation tickets instead of decision tickets — except here
it's evaluated live against GitHub every time the dispatch script (§5) runs, not once against a
fixed list. A ticket a PM adds today with no open blockers is dispatchable the very next time the
script runs; a ticket added with a `Blocked by: #N` line becomes dispatchable once #N closes.

## 3. Per-ticket dispatch

For each dispatchable ticket, up to the concurrency cap, one agent is dispatched to work it in its
own git worktree (branch named `worktree-ticket-<N>-<slug>`, matching the existing convention),
producing one PR per ticket — so parallel dispatch doesn't introduce a new branching model, just
runs more of the existing one at once. §5 covers exactly how that agent gets launched.

Each per-ticket agent is briefed to:

1. Claim the ticket: `gh issue edit <n> --add-assignee @me` (prevents a later run, or a second
   agent dispatched this same run, from double-dispatching the same ticket — assignment is the one
   piece of state the dispatcher relies on across runs, so this must happen first, before any other
   work).
2. Read the issue (`gh issue view <n> --comments`), `CONTEXT.md`, and any ADRs it touches.
3. Implement the ticket, following repo conventions and running the existing test suite.
4. Commit, push the worktree branch, and open a PR titled `Ticket #<n> — <title>`, matching the
   existing PR title pattern.
5. Leave the issue open — closing happens when the PR merges (by a human reviewer; §7), not when
   the agent finishes, so the frontier computation in §2 keeps meaning what it says.

Dispatchable tickets are launched together, with no staggering by file/schema overlap. Any overlap
(e.g. a shared Prisma schema touched by two tickets unblocked in the same run) surfaces as an
ordinary merge conflict on whichever PR is reviewed second — resolved at merge time, not upfront.

## 4. Monitoring — wants per-ticket visibility in `claude agents`

The operator wants each in-flight ticket to appear as its own entry when checking `claude agents`
from another terminal, not just one entry per dispatch run. That rules out fanning out via the `Agent`
tool from inside a single dispatcher session: `Agent`-spawned subagents are scoped to their parent
session and are explicitly documented as not independently visible to the user ("its final report
is not visible to the user... send a text message back to the user with a concise summary") — only
the one session that dispatched them would show up.

## 5. Dispatch mechanism: manual script

Two ways of making the dispatcher durable/automatic (independent of any chat session, running
unattended) were evaluated and both rejected:

- **`CronCreate`** — session-scoped: jobs live only in the session that created them, are gone
  when that session exits, auto-expire after 7 days regardless, and only fire while that session's
  REPL is idle. Not independent of a chat session at all, so it can't be a standing dispatcher.
- **`RemoteTrigger`** (the API behind the `schedule` skill) — a genuinely durable server-side
  routine, but it requires an org-linked account: `RemoteTrigger list` failed here with `Unable to
  get organization UUID`, and `/schedule` couldn't connect to the account at all. **Not suitable for
  an individual account**, so dropped rather than pursued further — no amount of retrying from a
  different session fixes an account-tier limitation.

With both ruled out, the chosen mechanism is `scripts/dispatch-tickets.mjs`, run manually whenever a
batch should be dispatched:

```
node scripts/dispatch-tickets.mjs              # auto-compute the frontier (§2), dispatch up to MAX=3
node scripts/dispatch-tickets.mjs 10 11 15     # or dispatch these specific ticket numbers
```

Either way, a candidate is skipped if it's already assigned or has an open blocker. For each ticket
it does dispatch, the script claims the issue (`gh issue edit <n> --add-assignee @me`), then runs
`claude --bg '<prompt>'` for it — the `claude` CLI's own flag for registering a background agent
job and returning immediately, which is what makes each dispatched ticket appear as its own entry
in `claude agents` (the goal in §4), manageable with `claude attach`/`claude logs`/`claude stop`.

Getting here took one real dispatch to surface: the first cut used `claude -p '<prompt>'`
backgrounded with Node's own `spawn(..., { detached: true })`, on the assumption that any
detached OS process running `claude` would show up. It didn't — `-p`/`--print` registers the
session as `"kind": "interactive"` in the agent registry (confirmed via `claude agents --json`),
which the `claude agents` view doesn't surface. Live-dispatching tickets #11, #53, and #54 with
that version proved this directly: `ps` and `claude agents --json` both showed the three processes
running and genuinely making progress (non-zero CPU, each had moved into its own worktree), but
none of them appeared as a `"kind": "background"` entry. `claude --bg` itself pointed at the fix
when tried together with `-p`: *"--bg and --print conflict: --print never starts the interactive
session that `claude agents` attaches to... drop --print: `claude --bg '<task>'`."* Switched to
that (prompt passed positionally, no `-p`), confirmed with a throwaway dispatch that it registers
as `"kind": "background"` with a proper job id, and the three already-running `-p`-launched
sessions were left alone to finish rather than killed mid-work.

One consequence of this fix: `claude --bg` handles its own backgrounding and returns in ~2 seconds,
so the script no longer manages a detached child process or a log file itself — `dispatchOne()`
just runs it and parses the job id out of its `backgrounded · <id>` output (`parseJobId()`,
unit-tested). Progress and output for a dispatched ticket now come from `claude logs <id>` (or
`claude attach <id>`), not `.claude/dispatch-logs/`.

This is a manual, per-invocation tool, not a poller: nothing runs unattended between invocations,
and re-running it is how new PM tickets or newly-unblocked tickets get picked up. Its decision logic
(`slugify`, `branchNameFor`, `selectBatch`, `buildPrompt`, `parseJobId`) is unit-tested in
`scripts/dispatch-tickets.test.mjs`, matching this repo's existing `scripts/setup.mjs` convention.

One known operational gap this surfaces: a `claude --bg` job can end up `"state": "blocked"` if it
hits a permission decision with nobody attached to answer it (observed on an unrelated pre-existing
background job while investigating this). This script doesn't pass any `--permission-mode`, so a
dispatched ticket can in principle sit blocked the same way — checking `claude agents` for a
`blocked` state and running `claude attach <id>` to unblock it is, for now, part of the same manual
oversight §6 already asks for with stale claims, not a separate mechanism.

**Was the `Workflow` tool considered instead?** Yes, and it doesn't fit either of the two things
this needs. `Workflow` is a tool available *within* a Claude session (mine, in this conversation),
not a program invokable from an external terminal — so it can't be "a script you run manually" at
all. And its agents run as subagents of one `Workflow` task, tracked via `/workflows`, not as
independent entries in `claude agents` — the same visibility limitation as `Agent`-fan-out in §4,
for the same underlying reason (parent/child session scoping). Where `Workflow` would genuinely
help is orchestration logic — encoding the dependency structure as a `pipeline()` so later tickets
start the moment their blockers close, without re-running the script by hand — but that solves a
different problem (auto-advancing as blockers clear) than the one just solved here (a runnable,
per-ticket-visible dispatch mechanism), and would need to sit on top of this script, not replace it.

## 6. Stale claims (known gap, manual for now)

If a dispatched agent dies or stalls without ever opening a PR, its ticket stays assigned
indefinitely — the script always skips already-assigned tickets, so it silently occupies a claim
slot on every future run until someone notices. There is no automatic reclaim in this design: if a
ticket looks stuck (assigned, open, no linked PR, no recent activity), an operator unassigns it
manually, and the next script run picks it back up. An automatic timeout-based reclaim was
considered and deferred — it adds state to track claim time, and a real risk of two agents working
the same ticket if the timeout fires while the original agent is still alive but slow.

## 7. Out of scope

- #40 (`needs-triage`) is not part of this dispatch; it needs triage first, independent of this
  DAG.
- No change to the triage-label vocabulary, PR-as-request-surface policy, or the existing
  worktree/PR convention itself — this design only adds a way to dispatch several of those at once
  instead of one at a time.
- No auto-merge. PRs still go through human review and merge; the dispatcher only automates
  claiming and starting work, not landing it. The frontier depends on that human step (closing the
  issue) the same way it always has.
- Automatic reclaim of stale claims (§6) — deferred, manual for now.
- A standing, unattended dispatcher (§5) — `RemoteTrigger` was the only durable mechanism found and
  it isn't available on an individual account; not worth re-evaluating without a different account
  tier or a different provider entirely.
