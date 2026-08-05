# Ticket title/body format standard — design

## Problem

`bugs/screensheets/different-ticket-format.png` shows the issue list with three title shapes in
play at once: `NN — Title` (the to-tickets convention), plain titles with no prefix, and plain
titles with an ad-hoc module-scope prefix (`console-web:`, `RBAC:`). Auditing all 49 issues
confirms it's isolated to one batch:

- **#1–#63** (minus bugs): `NN — Title`, produced by the `to-tickets` skill. `NN` is a
  locally-tracked build-order sequence embedded in the title text — it is **not** the GitHub issue
  number (e.g. issue `#43` is titled `41 — App chrome…`, because bug tickets filed in between
  consumed issue numbers without consuming a sequence number). Bodies use
  `## What to build` / `## Acceptance criteria` / `## Blocked by`.
- **#35, #40, #68**: plain descriptive titles, no prefix. These are bug reports filed outside
  `to-tickets` (via `/triage` or by hand), not vertical slices of a plan, so they were never meant
  to carry a sequence number. Bodies use `## What's wrong` (+ optional `## Reproduction` /
  `## Cause`) / `## Acceptance criteria` / `## Blocked by`.
- **#75–#79** (the Keycloak/OIDC epic): five vertical slices with real blocking edges between them
  — structurally identical to the `NN —` batches — but titled ad hoc, three different ways. This
  is the actual defect: an epic that should have gone through `to-tickets` got hand-titled instead,
  and nothing stopped a module-scope prefix from leaking into the title.

The body template was never the problem — it's already consistent across all three groups. The
gap is purely: (a) no written rule says module scope doesn't belong in the title, and (b) nothing
forces every plan-derived epic through the one skill that produces the numbered form.

## Decision

Two canonical title shapes, chosen by ticket origin, and module-scope prefixes are never part of
a title:

| Origin | Title shape | Example |
| --- | --- | --- |
| Vertical slice of a plan/spec/epic (`to-tickets` output) | `NN — Title` | `64 — Keycloak realm and client definitions committed to the repo` |
| Bug report found during dev/QA (`/triage` or ad hoc) | `Title` (no prefix) | `Account Queue table renders unstyled` |

`NN` continues the single running sequence already in use (highest so far: `63`), regardless of
which GitHub issue number it lands on — consistent with existing precedent. Module/package scope
(`console-api:`, `RBAC:`) belongs in the body's `## What to build` line, not the title; it's
already how #77 and #79's bodies name their module, so nothing is lost by dropping it from the
title.

Bodies keep their two existing templates (feature vs. bug) as-is — no change needed there.

## Retroactive fix

Retitle #75–#79 to continue the sequence in issue-number order (their existing blocking edges
already respect that order): `#75→64`, `#76→65`, `#77→66`, `#78→67`, `#79→68`. Bodies, labels, and
blocking edges are untouched — title only.

## Enforcement

`.claude/` and `.agents/` are both gitignored in this repo (Claude Code/agent skills are per-user
local config here, not committed code), so a `SKILL.md` under either would never reach a teammate
or a fresh clone — it'd be invisible to exactly the people this is meant to protect. The enforcement
has to live in the files that are actually tracked and already read by every entry point:

- **`docs/agents/issue-tracker.md`** — `to-tickets`, `/triage`, and `/wayfinder` already read this
  doc for this repo's tracker setup, so its Conventions section gets a title-format rule: the two
  shapes above, and the "next `NN`" lookup (`gh issue list --state all --json title --jq` a regex
  for the leading `NN —`, take the max, +1).
- **Root `CLAUDE.md`, "Agent skills"** — gets a fourth entry, `### Ticket format`, mirroring the
  existing `issue-tracker.md` / `triage-labels.md` / `domain.md` entries, so it's visible to anyone
  (human or agent) reading the repo's top-level instructions before touching the tracker — including
  the case that broke down for #75–#79: a title typed by hand outside `to-tickets`.

A local `.claude/skills/ticket-format/SKILL.md` is included too, for this machine's own session —
harmless, but understood to be a convenience copy, not the shared mechanism.

## Out of scope

- Renumbering or retitling #35, #40, #68 — they're bugs, correctly unnumbered already.
- Changing the body templates — already consistent.
- Retiring the `NN —` convention in favor of e.g. GitHub's native issue number — that would break
  legibility of build order across 63 existing tickets for no stated benefit.
