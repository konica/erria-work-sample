# Parallel Ticket Dispatch — Design

Status: Draft — pending a live test run of `scripts/dispatch-tickets.sh` (confirm its
background-launch line and `claude agents` visibility; see §6)
Last updated: 2026-08-04

## 1. Problem

18 issues are open with the `ready-for-agent` label (#10–#27), plus #40 which is `needs-triage`
and out of scope here. They read like a sequenced roadmap (schema prefactors, then features, then
UI screens) and in fact form a real dependency graph via GitHub's native issue dependencies — not
all of them can be worked at once. So far, tickets have been dispatched and merged one at a time
(one worktree branch + one PR per ticket, e.g. PRs #47–#52). This design describes how to dispatch
several tickets at once, safely, in background agent sessions, while an operator monitors progress.

## 2. Dependency graph (illustrative, as of 2026-08-04)

Computed from `issue_dependencies_summary.blocked_by` and the `dependencies/blocked_by` endpoint,
counting only open blockers:

| Wave | Tickets | Blocked by |
|---|---|---|
| 1 | #10, #11, #15, #20, #21, #22, #23 | nothing open |
| 2 | #12 | #10, #11 |
| 2 | #14 | #11 (plus already-closed #6, #43, #44) |
| 2 | #16 | #15 |
| 3 | #13 | #12 |
| 3 | #17 | #16, #12 |
| 3 | #24 | #23, #12, #16 |
| 4 | #18 | #17 |
| 4 | #19 | #17, #18, #14 (plus already-closed #43, #44) |
| 4 | #25 | #23, #24, #12 |
| 5 | #26 | #25, #20 (plus already-closed #43, #44) |
| 5 | #27 | #25 |

This table is a snapshot for illustration, not an input the dispatcher reads. The frontier query
(§3) is recomputed live from GitHub every time it runs, so it naturally reproduces this wave shape
as tickets close — and just as naturally absorbs new tickets a PM adds later, without anyone
updating a table.

## 3. Continuous frontier computation

An issue is dispatchable at the moment it is:

- labeled `ready-for-agent`
- open
- unassigned
- `issue_dependencies_summary.blocked_by == 0` (query per-issue via `gh api
  repos/konica/erria-work-sample/issues/<n>`, since `gh issue list` doesn't expose it)

This is the same frontier-query shape `docs/agents/issue-tracker.md` already describes for
wayfinder maps, applied here to implementation tickets instead of decision tickets — except here
it's evaluated live against GitHub every time the dispatch script (§6) runs, not once against a
fixed list. A ticket a PM adds today with no open blockers is dispatchable the very next time the
script runs; a ticket added with a `Blocked by: #N` line becomes dispatchable once #N closes.

## 4. Per-ticket dispatch

For each dispatchable ticket, up to the concurrency cap, one agent is dispatched to work it in its
own git worktree (branch named `worktree-ticket-<N>-<slug>`, matching the existing convention),
producing one PR per ticket — so parallel dispatch doesn't introduce a new branching model, just
runs more of the existing one at once. §6 covers exactly how that agent gets launched.

Each per-ticket agent is briefed to:

1. Claim the ticket: `gh issue edit <n> --add-assignee @me` (prevents a later run, or a second
   agent dispatched this same run, from double-dispatching the same ticket — assignment is the one
   piece of state the dispatcher relies on across runs, so this must happen first, before any other
   work).
2. Read the issue (`gh issue view <n> --comments`), `CONTEXT.md`, and any ADRs it touches.
3. Implement the ticket, following repo conventions and running the existing test suite.
4. Commit, push the worktree branch, and open a PR titled `Ticket #<n> — <title>`, matching the
   existing PR title pattern.
5. Leave the issue open — closing happens when the PR merges (by a human reviewer; §8), not when
   the agent finishes, so the frontier computation in §3 keeps meaning what it says.

Dispatchable tickets are launched together, with no staggering by file/schema overlap. Any overlap
(e.g. a shared Prisma schema touched by two tickets unblocked in the same run) surfaces as an
ordinary merge conflict on whichever PR is reviewed second — resolved at merge time, not upfront.

## 5. Monitoring — wants per-ticket visibility in `claude agents`

The operator wants each in-flight ticket to appear as its own entry when checking `claude agents`
from another terminal, not just one entry per dispatch run. That rules out fanning out via the `Agent`
tool from inside a single dispatcher session: `Agent`-spawned subagents are scoped to their parent
session and are explicitly documented as not independently visible to the user ("its final report
is not visible to the user... send a text message back to the user with a concise summary") — only
the one session that dispatched them would show up.

## 6. Dispatch mechanism: manual script

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

With both ruled out, the chosen mechanism is `scripts/dispatch-tickets.sh`, run manually whenever a
batch should be dispatched:

```
scripts/dispatch-tickets.sh              # auto-compute the frontier (§3), dispatch up to MAX=3
scripts/dispatch-tickets.sh 10 11 15     # or dispatch these specific ticket numbers
```

Either way, a candidate is skipped if it's already assigned or has an open blocker. For each ticket
it does dispatch, the script claims the issue (`gh issue edit <n> --add-assignee @me`), then
backgrounds a separate `claude -p` process per ticket — a genuinely independent OS-level process,
not a subagent fanned out from one session, so each should appear as its own entry in `claude
agents` (the goal in §5) without needing anything server-side. Worktree branch
`worktree-ticket-<n>-<slug>`, logs under `.claude/dispatch-logs/`, one PR per ticket per §4.

This is a manual, per-invocation tool, not a poller: nothing runs unattended between invocations,
and re-running it is how new PM tickets or newly-unblocked tickets get picked up. The one line that
starts each session (`claude -p "$prompt" > "$logfile" 2>&1 &`) is a best-effort default, not yet
verified against how sessions are actually started in this environment — confirm before relying on
it.

**Was the `Workflow` tool considered instead?** Yes, and it doesn't fit either of the two things
this needs. `Workflow` is a tool available *within* a Claude session (mine, in this conversation),
not a program invokable from an external terminal — so it can't be "a script you run manually" at
all. And its agents run as subagents of one `Workflow` task, tracked via `/workflows`, not as
independent entries in `claude agents` — the same visibility limitation as `Agent`-fan-out in §5,
for the same underlying reason (parent/child session scoping). Where `Workflow` would genuinely
help is orchestration logic — encoding the wave/dependency structure as a `pipeline()` so later
waves start the moment their blockers close, without re-running the script by hand — but that
solves a different problem (auto-advancing waves) than the one just solved here (a runnable,
per-ticket-visible dispatch mechanism), and would need to sit on top of this script, not replace it.

## 7. Stale claims (known gap, manual for now)

If a dispatched agent dies or stalls without ever opening a PR, its ticket stays assigned
indefinitely — the script always skips already-assigned tickets, so it silently occupies a claim
slot on every future run until someone notices. There is no automatic reclaim in this design: if a
ticket looks stuck (assigned, open, no linked PR, no recent activity), an operator unassigns it
manually, and the next script run picks it back up. An automatic timeout-based reclaim was
considered and deferred — it adds state to track claim time, and a real risk of two agents working
the same ticket if the timeout fires while the original agent is still alive but slow.

## 8. Out of scope

- #40 (`needs-triage`) is not part of this dispatch; it needs triage first, independent of this
  DAG.
- No change to the triage-label vocabulary, PR-as-request-surface policy, or the existing
  worktree/PR convention itself — this design only adds a way to dispatch several of those at once
  instead of one at a time.
- No auto-merge. PRs still go through human review and merge; the dispatcher only automates
  claiming and starting work, not landing it. The frontier depends on that human step (closing the
  issue) the same way it always has.
- Automatic reclaim of stale claims (§7) — deferred, manual for now.
- A standing, unattended dispatcher (§6) — `RemoteTrigger` was the only durable mechanism found and
  it isn't available on an individual account; not worth re-evaluating without a different account
  tier or a different provider entirely.
