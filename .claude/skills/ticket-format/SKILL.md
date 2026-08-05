---
name: ticket-format
description: Use before creating a new GitHub issue, retitling an existing one, or breaking an epic/spec into tickets on konica/erria-work-sample — defines the two canonical ticket title shapes for this repo and the lookup for the next sequence number. Prevents ad-hoc titles (module-scope prefixes like "console-api:", "RBAC:", or a mix of numbered/unnumbered titles within one epic).
---

# Ticket title format

This repo's issues use exactly two title shapes, chosen by where the ticket came from. Never
introduce a third — in particular, never prefix a title with a module/package/component name
(`console-api:`, `console-web:`, `RBAC:`, …). If the module matters, say so in the body's
`## What to build` line instead.

## Shape 1 — vertical slice of a plan, spec, or epic

`NN — Title`

Used for every ticket produced by the `to-tickets` skill (or an equivalent manual breakdown of a
spec/epic into blocked-by-ordered vertical slices). `NN` is a single sequence shared across the
whole repo's history — it is **not** the GitHub issue number and does not reset per epic. Issue
numbers drift away from it whenever bug tickets (shape 2) consume issue numbers in between.

**Finding the next `NN`:**

```bash
gh issue list --state all --json title --limit 200 \
  --jq '[.[].title | capture("^(?<n>[0-9]+) — ") | .n | tonumber] | max'
```

Use `max + 1` for the next ticket. If breaking an epic into several tickets at once, assign them
consecutively in blocking order (blockers get the lower numbers).

## Shape 2 — bug report

`Title` — no prefix, no number.

Used for defects found during development or QA and filed via `/triage` or by hand — anything that
isn't a vertical slice of a plan. This is already how #35, #40, and #68 are titled; keep doing it.
Do not retroactively number these — they were never part of a sequenced batch.

## Deciding which shape applies

- Filing one ticket for a bug you just found → shape 2.
- Breaking a spec, design doc, or epic into multiple tickets with blocking edges between them →
  shape 1, run through `to-tickets` if that skill is available so numbering and the
  `## What to build` / `## Acceptance criteria` / `## Blocked by` body template are applied
  consistently. If titling by hand instead (`to-tickets` unavailable), still use shape 1 and look
  up `NN` yourself with the command above — this is the case that broke down for issues #75–#79.

## Body templates (unchanged, stated here for completeness)

- Feature/vertical-slice: `## What to build`, `## Acceptance criteria`, `## Blocked by`.
- Bug: `## What's wrong` (optionally `## Reproduction`, `## Cause`), `## Acceptance criteria`,
  `## Blocked by`.

See `docs/agents/issue-tracker.md` for the tracker mechanics (`gh` invocations, labels, wayfinder).
