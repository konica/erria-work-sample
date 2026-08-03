# Erria Outreach Agent

An AI-assisted sales outreach system for Mermaid Maritime Vietnam (an Erria Group business unit)
that drafts, tiers, and escalates outbound messages to accounts based on upstream triggers, with a
human in the loop for anything below full autonomy.

## Language

### Core entities

**Account**:
A company (a shipowner/operator) that Mermaid Maritime Vietnam is pursuing or serving. The unit
tiering, escalation, and history are tracked against.
_Avoid_: Client, Customer, Company

**Vessel**:
A specific ship belonging to an Account, referenced by trigger content (e.g. a compliance
deadline).
_Avoid_: Ship (fine in prose; entity/column names use Vessel)

**Contact**:
A named person at an Account who receives outreach (e.g. "Ms. Lan Pham, Technical
Superintendent").
_Avoid_: Recipient, Buyer

**Trigger**:
An upstream event or signal — supplied by an external, out-of-scope pipeline — that gives the
agent a reason to reach out to an Account (e.g. "life-raft service window approaching"). One
Trigger produces at most one drafted Message.
_Avoid_: Signal, Event, "hard trigger" (see Hard-Trigger Rule — a different concept that happens
to share the word "trigger")

**Message**:
A single unit in an Account's outreach thread — an agent-drafted outbound message, a sent message,
an inbound buyer reply, a human-authored reply, or a system note. A "draft" is simply a Message
with `status: pending_review`.
_Avoid_: Draft, Email, Reply

**Escalation**:
A record created only when a Hard-Trigger Rule fires (see Escalation invariant, below). Disables
agent-send for that Account's thread until a human resolves it.
_Avoid_: Alert, Flag

**Resolution**:
The record of how a human closed an Escalation — one Resolution per Escalation, 1:1.
_Avoid_: Closure, Outcome (Outcome Tag is a field on Resolution, not the Resolution itself)

### Tiering & escalation concepts

**Tier**:
An Account's current standing: 1 (agent sends autonomously — not yet implemented, see
[ADR-0002](docs/adr/0002-tier-1-autonomous-send-deferred.md)), 2 (agent drafts, human approves), or
3 (human-only, no agent drafting). Tracked as `Account.currentTier`. Tier 1 is only ever *earned*
via Clean Approvals — never granted by a Manual Tier Override (see
[ADR-0004](docs/adr/0004-tier-1-is-earned-never-set-manually.md)).
_Avoid_: Level, Stage

**Manual Tier Override**:
A human deliberately changing an Account's Tier as its own explicit action, with a required reason,
recorded as a distinctly-tagged Tier History entry. Only ever moves an Account to Tier 2 or Tier 3;
never to Tier 1. Never an automatic side effect of resolving an Escalation.
_Avoid_: Manual demotion (it can also restore an account to Tier 2), tier edit

**Tier Context**:
The tier a specific Message was governed by at the moment it was drafted — not necessarily the
Account's tier today. Usually equal to `Account.currentTier`, but can legitimately differ (see
[ADR-0003](docs/adr/0003-hard-trigger-rule-5-message-level-cap.md)).
_Avoid_: "Message tier" (ambiguous with Account tier)

**Rollout Overlay**:
The rule that holds every new Account at Tier 2 minimum regardless of score, until it earns Tier 1
via 2 Clean Approvals. Exists because Erria has no track record with AI-driven outreach yet.
_Avoid_: Rollout cap, trust overlay

**Hard-Trigger Rule**:
One of five fixed, engineer-only conditions (pricing question, technical/compliance question,
negative sentiment, relationship conflict, compliance-deadline content) that override tier and
always route to a human. Firing one always creates exactly one Escalation.
_Avoid_: Hard trigger, hard-escalation trigger, override rule

**Clean Approval**:
A Tier 2 draft sent without edits and with no negative signal on the Account since. Counted toward
Tier 1 promotion.
_Avoid_: Clean send, unedited approval

### Message lifecycle concepts

**Dossier**:
The assembled view of an Account's data (segment, relationship summary, vessel particulars,
trigger details) handed to the drafting call and shown in the console — a view, not a persisted
entity.
_Avoid_: Profile, "context" (too easily confused with this file's own subject)

**Abstain**:
The drafting call's own decision not to produce a message (`should_draft: false`) because the
dossier is too thin to draft anything credible. Distinct from an API failure — both route to
Needs Triage, but for different reasons.
_Avoid_: Reject, Skip

**Needs Triage**:
The state a Trigger or Message enters when drafting fails or abstains — surfaced to a human, not
silently dropped and not treated as an Escalation (no Hard-Trigger Rule fired).
_Avoid_: Failed, Errored

### Settings & audit concepts

**Audit Sample**:
A Tier 1 (autonomous-tier) sent message randomly selected at send time, per a configurable sample
rate, for a human to mark Fine or Concerning after the fact. Retrospective and non-blocking — it
never gates an individual send.
_Avoid_: Spot check, review sample

**Repeat Escalation**:
A human-set (never auto-detected) link from a new Escalation to an earlier Resolution, marking the
new issue as a recurrence of a past one.
_Avoid_: Duplicate escalation, related issue

**Setting Risk Level** (Freely Adjustable / Confirm-Required / Locked):
The three risk classes an admin-configurable value falls into: Freely Adjustable saves
immediately, Confirm-Required shows a two-step confirmation before applying, Locked is read-only
reference data an engineer edits in code, never an admin. Deliberately **not** called "Setting
Tier" — the spec never uses that phrase, and coining it would collide with the unrelated Account
Tier concept above.
_Avoid_: Setting tier, config level, permission level

## Escalation invariant

There is exactly one way an Escalation record is created: a Hard-Trigger Rule fires. The behavior
spec's Tier-3 demotion clause ("any negative signal... drops the account to Tier 3") is not a
separate mechanism — a negative signal *is* Hard-Trigger Rule 3 (negative sentiment). There is no
code path that moves an Account to Tier 3 without an Escalation existing to explain why.
