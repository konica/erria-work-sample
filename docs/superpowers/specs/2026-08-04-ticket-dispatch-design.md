# Parallel Ticket Dispatch — Design

Status: Draft — §5/§6 pending verification (see §6) before this can be marked approved
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

This table is a snapshot for illustration, not an input the dispatcher reads. The dispatcher (§3)
recomputes the frontier live from GitHub on every poll, so it naturally reproduces this wave shape
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
it's evaluated on a recurring schedule (§6) against live GitHub state, not once against a fixed
list. A ticket a PM adds today with no open blockers is dispatchable on the very next poll; a
ticket added with a `Blocked by: #N` line becomes dispatchable the poll after #N closes.

## 4. Per-ticket dispatch

For each dispatchable ticket, up to the concurrency cap (§6), one agent is dispatched to work it in
its own git worktree (branch named `worktree-ticket-<N>-<slug>`, matching the existing convention),
producing one PR per ticket — so parallel dispatch doesn't introduce a new branching model, just
runs more of the existing one at once. Exactly how that agent is launched (a separately-triggered
`RemoteTrigger` run per ticket, or an `Agent` call with `isolation: "worktree"` fanned out from one
dispatcher tick) is the open question in §6; the steps below are the same either way.

Each per-ticket agent is briefed to:

1. Claim the ticket: `gh issue edit <n> --add-assignee @me` (prevents the next poll, or a second
   agent this same poll, from double-dispatching the same ticket — assignment is the one piece of
   state the dispatcher relies on across polls, so this must happen first, before any other work).
2. Read the issue (`gh issue view <n> --comments`), `CONTEXT.md`, and any ADRs it touches.
3. Implement the ticket, following repo conventions and running the existing test suite.
4. Commit, push the worktree branch, and open a PR titled `Ticket #<n> — <title>`, matching the
   existing PR title pattern.
5. Leave the issue open — closing happens when the PR merges (by a human reviewer; §8), not when
   the agent finishes, so the frontier computation in §3 keeps meaning what it says.

Dispatchable tickets are launched together, with no staggering by file/schema overlap. Any overlap
(e.g. a shared Prisma schema touched by two tickets unblocked in the same poll) surfaces as an
ordinary merge conflict on whichever PR is reviewed second — resolved at merge time, not upfront.

## 5. Monitoring — wants per-ticket visibility in `claude agents`

The operator wants each in-flight ticket to appear as its own entry when checking `claude agents`
from another terminal, not just one entry per poll. That rules out fanning out via the `Agent`
tool from inside a single dispatcher session: `Agent`-spawned subagents are scoped to their parent
session and are explicitly documented as not independently visible to the user ("its final report
is not visible to the user... send a text message back to the user with a concise summary") — only
the one session that dispatched them would show up.

## 6. Scheduled dispatch loop — mechanism pending verification

Two candidate mechanisms were considered for making the dispatcher itself durable (independent of
any chat session, so it keeps running after this conversation ends):

- **`CronCreate`** — ruled out. Its actual contract is session-scoped: jobs live only in the
  session that created them, are gone when that session exits, auto-expire after 7 days regardless,
  and only fire while that session's REPL is idle. That contradicts "runs independent of any chat
  session," so it can't be the durable dispatcher.
- **`RemoteTrigger`** (the API behind the `schedule` skill) — a server-side routine with its own
  `claude.ai` URL, genuinely independent of any session. This is the intended mechanism, but two
  things about it are **unverified**:
  1. Whether a single triggered run can be parameterized per-invocation (e.g. "work ticket #14"),
     which is required if each ticket gets its own separately-triggered run rather than one run
     fanning out internally.
  2. Whether each triggered run shows up as its own independent entry in `claude agents`, which is
     the whole point of choosing this mechanism over `Agent`-based fan-out (§5).

Both attempts to check this from the current (background, worktree-isolated) session failed —
`RemoteTrigger list` returned `Unable to get organization UUID`, and the `schedule` skill reported
it couldn't connect to the claude.ai account. This looks like an environment limitation of this
particular session rather than a fundamental block, so **the operator will verify from their own
interactive terminal** (where the account is connected) before this section is finalized:

- Confirm `RemoteTrigger`/`/schedule` connects and can create a routine at all.
- Confirm a routine run can be parameterized per-invocation with a specific ticket number.
- Confirm each run appears as an independent entry in `claude agents`.

Pending that, the intended shape (subject to the above being confirmed) is: a dispatcher tick
computes the frontier (§3) and current in-flight count, then fires one separately-parameterized
`RemoteTrigger` run **per dispatchable ticket** (up to the cap of 5 in flight), instead of one run
that internally fans out via `Agent`. If per-invocation parameterization turns out not to be
possible, this design falls back to the `Agent`-fan-out shape from the previous revision, with the
per-ticket visibility gap in §5 accepted rather than solved.

## 7. Stale claims (known gap, manual for now)

If a dispatched agent dies or stalls without ever opening a PR, its ticket stays assigned
indefinitely — the in-flight count in §6 keeps counting it, and it silently occupies one of the 5
concurrency slots. There is no automatic reclaim in this design: if a ticket looks stuck (assigned,
open, no linked PR, no recent activity), an operator unassigns it manually, and the next poll picks
it back up. An automatic timeout-based reclaim was considered and deferred — it adds dispatcher-side
state to track claim time, and a real risk of two agents working the same ticket if the timeout
fires while the original agent is still alive but slow.

## 8. Out of scope

- #40 (`needs-triage`) is not part of this dispatch; it needs triage first, independent of this
  DAG.
- No change to the triage-label vocabulary, PR-as-request-surface policy, or the existing
  worktree/PR convention itself — this design only adds a way to dispatch several of those
  continuously instead of one at a time.
- No auto-merge. PRs still go through human review and merge; the dispatcher only automates
  claiming and starting work, not landing it. The frontier depends on that human step (closing the
  issue) the same way it always has.
- Automatic reclaim of stale claims (§7) — deferred, manual for now.
