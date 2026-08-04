# Parallel Ticket Dispatch — Design

Status: Approved design — pending implementation plan
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

For each dispatchable ticket, up to the concurrency cap (§6), the polling session spawns one
`Agent` call with `isolation: "worktree"`. This mirrors the existing convention — worktree branch
named `worktree-ticket-<N>-<slug>`, one PR per ticket — so parallel dispatch doesn't introduce a
new branching model, just runs more of the existing one at once.

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

## 5. Monitoring

Per-ticket agents are subagents of whichever polling session dispatched them, not independent
top-level `claude` sessions — they report back to that session when done. Since each poll is its
own short-lived session (§6), this means results are relayed from a session that itself exits soon
after dispatching, rather than appearing as separate entries in the operator's own top-level
agent-monitoring view. This is a known trade-off of dispatching via the `Agent` tool; revisit if
that separation turns out to matter in practice once this is running.

## 6. Scheduled dispatch loop

A standing scheduled job (built with the `schedule` skill / a `CronCreate` routine) runs every
**30 minutes**, independent of any chat session, and on each tick:

1. Computes the frontier (§3) live from GitHub.
2. Counts tickets currently **in flight** — `ready-for-agent`, open, and assigned (claimed by a
   prior tick but not yet merged/closed).
3. Dispatches new tickets from the frontier up to a total in-flight cap of **5**, i.e. it launches
   `min(cap - in_flight, |frontier|)` agents this tick. If more tickets are dispatchable than the
   remaining cap allows, lowest issue number goes first.
4. Exits. The next tick repeats independently — there is no explicit "wave" state to advance; the
   frontier and in-flight count fully describe what to do next.

This replaces manually triggering each wave: new tickets a PM adds, and tickets that unblock as
PRs merge, are picked up automatically within one poll interval, with no operator action required
to advance to the next batch of work.

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
