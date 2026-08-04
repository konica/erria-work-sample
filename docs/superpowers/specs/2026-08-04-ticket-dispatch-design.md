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

## 2. Dependency graph (as of 2026-08-04)

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

A ticket's wave number is one more than the maximum wave number of its blockers. This table is a
snapshot — before dispatching a wave, recompute it, because a blocker might close (or a new ticket
might appear) between waves.

## 3. Frontier computation

Before dispatching a wave, an issue is dispatchable when all of:

- labeled `ready-for-agent`
- open
- unassigned
- `issue_dependencies_summary.blocked_by == 0` (query per-issue via `gh api
  repos/konica/erria-work-sample/issues/<n>`, since `gh issue list` doesn't expose it)

This is the same frontier-query shape `docs/agents/issue-tracker.md` already describes for
wayfinder maps, applied here to implementation tickets instead of decision tickets.

## 4. Per-ticket dispatch

For each ticket in the current wave, the orchestrating session spawns one `Agent` call with
`isolation: "worktree"`. This mirrors the existing convention — worktree branch named
`worktree-ticket-<N>-<slug>`, one PR per ticket — so parallel dispatch doesn't introduce a new
branching model, just runs more of the existing one at once.

Each per-ticket agent is briefed to:

1. Claim the ticket: `gh issue edit <n> --add-assignee @me` (prevents a second wave or a rerun from
   double-dispatching the same ticket).
2. Read the issue (`gh issue view <n> --comments`), `CONTEXT.md`, and any ADRs it touches.
3. Implement the ticket, following repo conventions and running the existing test suite.
4. Commit, push the worktree branch, and open a PR titled `Ticket #<n> — <title>`, matching the
   existing PR title pattern.
5. Leave the issue open — closing happens when the PR merges, not when the agent finishes, so the
   frontier computation in §3 keeps meaning what it says.

All tickets in a wave are dispatched together, with no staggering by file/schema overlap. Any
overlap (e.g. a shared Prisma schema touched by more than one wave-1 ticket) surfaces as an ordinary
merge conflict on whichever PR is reviewed second — resolved at merge time, not upfront.

## 5. Monitoring

Per-ticket agents are subagents of the orchestrating session, not independent top-level `claude`
sessions — they report back to that session when done, and results are relayed from there rather
than appearing as separate entries in the operator's own agent-monitoring view. This is a known
trade-off of dispatching via the `Agent` tool rather than having the operator start one top-level
session per ticket themselves; revisit if that separation turns out to matter in practice.

## 6. Wave gate

A wave is complete, and the next wave's frontier may be computed, only once every PR from the
current wave is **merged to main** and its issue closed. Blocked-by resolution depends on the
issue being closed, but the next wave's code depends on the current wave's code actually being in
`main` — an agent reporting "done" isn't sufficient on its own, since its PR might still be open.
This checkpoint is a deliberate manual gate (matching the "manual wave-by-wave" dispatch choice)
rather than an automatic rollover.

## 7. Out of scope

- #40 (`needs-triage`) is not part of this dispatch; it needs triage first, independent of this
  DAG.
- No change to the triage-label vocabulary, PR-as-request-surface policy, or the existing
  worktree/PR convention itself — this design only adds a way to run several of those in parallel.
- No autonomous/self-scheduling dispatcher. Each wave is triggered on request; automating that is a
  possible future iteration once this pattern is validated, not part of this design.
