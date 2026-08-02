# Outreach Agent Behavior Design — Mermaid Maritime Vietnam

Status: Draft — pending user review
Last updated: 2026-08-02
Scenario grounding: see [`ideation/scenario-research.md`](../../../ideation/scenario-research.md)

**2026-08-02 addition**: sections 10–12 formalize three gaps found during mockup review (v02→v04):
escalation resolution/lifecycle, the Tier 1 audit-sampling mechanic foreshadowed in §8, and
admin-configurable settings. These cover priorities 1–3 from that review; a health-pulse metrics
snapshot and a business-unit switcher (priorities 4–5) are confirmed out of scope for v1, not just
deprioritized. See `ideation/open-design-brief-v4-settings-audit.md` for that round's UI brief.

**2026-08-02, later same day**: v05 mockup review found the Settings/Send Audit/repeat-escalation
implementation fully consistent with §10–12 (no bugs), plus four UX fixes and one scope decision:
the settings change log is cut for v1 (§12), and access control for Settings is explicitly
deferred alongside it, not addressed separately. See `ideation/open-design-brief-v5-fixes.md`.

## 1. Purpose and scope

This document designs the behavior of an AI outreach agent for **Mermaid Maritime Vietnam**,
Erria Group's SOLAS safety/life-saving/firefighting equipment distributor in Vietnam. It covers
exactly what the work sample asks for: **account tiering, escalation triggers, and message
tone/structure** — not the trigger-detection ML pipeline or dossier-generation internals, which
are assumed to already produce the inputs this design consumes (a scored account + a dossier).

The agent qualifies leads; humans close. Nothing in this design lets the agent make a commercial
commitment, quote a price, or have the final word on an escalated conversation.

## 2. Inputs the agent receives (assumed upstream)

- **Account record**: company, vessel(s), buyer contact if known, relationship history with Erria.
- **Trigger**: the detected event (e.g. an upcoming service window, a new-vessel delivery, a
  competitor-loss signal) with a confidence/verifiability label — not a bare assertion.
- **ICP fit score**: how well the account matches Mermaid's target profile (vessel type, flag,
  O&G vs. merchant, existing-customer status).
- **Dossier**: a short internal brief compiled from CRM + public data, used to inform tone and
  content, never quoted verbatim to the recipient.

## 3. Tiering framework

**Score = ICP fit × trigger clarity × relationship status.** This produces a base tier
recommendation:

| Tier | Meaning | Base condition |
|---|---|---|
| 1 | Agent sends autonomously | High ICP fit + high-confidence trigger + no relationship conflict |
| 2 | Agent drafts, human approves before sending | Default for new accounts; moderate score; ambiguous trigger |
| 3 | Human-only, agent does not draft outbound copy | Existing relationship, strategic/large account, negative signal, or any hard-escalation condition below |

**Rollout overlay (why this isn't just the base score):** Erria has never run AI-driven outreach
before. The base score alone would let a strong first trigger send a fully autonomous cold message
on day one, with no track record to justify that trust. So:

- **Every new account starts at Tier 2 minimum**, regardless of score, until it has **≥2
  human-approved messages sent with no edits and no negative signal**.
- Promotion to Tier 1 happens only after that bar is met, and only for accounts whose score
  independently qualifies for Tier 1.
- **Demotion is immediate and one-directional per incident**: any negative signal (complaint,
  opt-out, a factual correction from the recipient, a flat "not interested") drops the account to
  Tier 3, regardless of prior tier, until a human clears it.

This means Tier 1 is *earned*, not assigned — a deliberate, conservative choice appropriate to a
two-person team introducing AI outreach into a business that has never had it, rather than an
engineering nicety.

## 4. Hard escalation triggers (override tier, always)

These fire regardless of an account's current tier and immediately route to a human:

1. **Recipient asks about pricing or commercial terms.** The agent has no authority to quote.
2. **Recipient asks a technical or compliance question outside the agent's verified knowledge**
   (e.g. class-society-specific requirements the dossier doesn't cover).
3. **Any negative-sentiment reply, complaint, or opt-out request** — escalate and stop all further
   outreach to that account until a human reviews.
4. **Any sign of an existing or active Erria relationship** not already reflected in the account
   record — err toward treating an unknown relationship as a reason to stop, not guess.
5. **Any message that would cite a specific vessel's compliance/recertification deadline** is
   capped at Tier 2 minimum — never sent fully autonomously — because referencing a recipient's
   own compliance data is exactly the case that can read as helpful *or* as surveillance/fear-
   selling depending on execution (see §5). A human reviews the specific framing before every such
   message, even from an otherwise-earned Tier 1 account.

Rule 5 is the direct answer to this job's stated test: "what makes outreach welcome vs. spam." It
exists because our research found the underlying regulatory-urgency claims are real but easy to
overstate (see `scenario-research.md` §2) — the agent is not allowed to make that judgment call
alone.

## 5. Message tone and structure

**Principles:**

- **Lead with a factual, verifiable observation, not a pitch.** State what's true before asking
  for anything.
- **Hedge unverified specifics.** Never assert an exact recertification date as fact unless the
  dossier confirms it from Erria's own service records. Default phrasing: "may be approaching its
  next scheduled service window," not "is due on [date]."
- **Disclose the data source when referencing vessel-specific information** — "per our service
  records" or "per publicly available vessel particulars" — never implies the agent is tracking
  the recipient without their knowledge.
- **No manufactured urgency.** Where real regulatory urgency exists (e.g. PSC detention risk),
  state it plainly and factually; never use fear-based framing ("your vessel could be detained!").
- **Low-pressure close.** Offer information or availability, not a demand for a call.

**Structure:**

- First message: ≤150 words, one clear factual hook, one clear low-pressure ask.
- Follow-up cadence: maximum 2 follow-ups, ≥5 business days apart, each one **adding new
  information** (e.g. updated availability), never a bare "just checking in."
- Every message signed by a named person at Mermaid Maritime Vietnam, not "the Erria AI system."

## 6. Worked example (fictional, illustrative only)

**Account:** Song Hong Shipping (fictional mid-size Vietnamese offshore support vessel operator) —
vessel *MV Song Hong Pioneer*. No prior relationship with Erria on record.

**Trigger:** Publicly available vessel particulars and class-society records indicate the vessel's
life-raft equipment is approaching a typical service interval; no engagement found in Erria's CRM.
(Sourced from public/class data, not Erria's own service history — this is a cold account with no
prior relationship, so there is no internal service record to draw on.)

**Buyer:** Ms. Lan Pham, Technical Superintendent.

**Tiering decision:** New account → Tier 2 minimum (rollout overlay applies regardless of score).
Compliance-deadline content → Tier 2 cap applies independently (rule 5) — both point to the same
outcome here, so the agent drafts and a human reviews before sending.

**Draft first message (for human approval):**

> Subject: Quick note on MV Song Hong Pioneer's life-raft service window
>
> Hi Ms. Pham,
>
> I hope this finds you well. Based on publicly available vessel particulars, it looks like MV
> Song Hong Pioneer's life-raft equipment may be approaching a typical service interval.
>
> If it would help, we'd be glad to check availability at our Vung Tau station and share a few
> dates — no obligation, just flagging it in case it's useful for your maintenance planning.
>
> Happy to help however is most useful.
>
> Best regards,
> [Name], Mermaid Maritime Vietnam

**If no reply after 5 business days — follow-up (adds new information):**

> Subject: Re: MV Song Hong Pioneer service window — station availability update
>
> Hi Ms. Pham,
>
> Following up briefly — we now have open slots at our Vung Tau station in [date range] for
> life-raft servicing, including the standard exchange-service option (1–2 hour turnaround) if
> minimizing vessel downtime is a priority.
>
> No pressure at all if the timing doesn't work — just wanted to make sure this reached you in
> case it's useful.
>
> Best,
> [Name]

**Escalation event:** Ms. Pham replies asking for pricing on the servicing + exchange option.
**Hard trigger 1 fires** (pricing question) → agent stops drafting, generates an internal handoff:

> Internal handoff to human AE:
> Song Hong Shipping / MV Song Hong Pioneer — Ms. Lan Pham replied asking for pricing on
> life-raft servicing + exchange service. Escalating per hard-trigger rule (pricing question).
> Full conversation history attached. Recommended next step: AE sends quote and confirms service
> dates.

## 7. Error handling and edge cases

- **Dossier confidence too low to draft anything credible** → agent does not draft; flags the
  account for human triage instead of guessing.
- **Conflicting signals** (e.g. trigger suggests outreach, but relationship field shows an open
  Erria contract) → treat as an escalation trigger (rule 4), never resolve the conflict silently.
- **Recipient replies in Vietnamese or another language** → escalate to human rather than
  auto-translate and continue autonomously; tone risk is too high to self-manage across a language
  the agent's tone rules weren't validated against.
- **Account previously demoted to Tier 3 for a negative signal** → stays there until a human
  explicitly clears it; no automatic time-based recovery.

## 8. Evaluation approach

- **Pre-send review sampling**: even at Tier 1, a fixed percentage of autonomous sends are
  logged for retrospective human spot-check (not blocking, but tracked) to catch tone drift early.
- **Track edit rate on Tier 2 drafts** as the core promotion signal — not just "was it sent," but
  "was it sent unedited."
- **Track escalation-trigger firing rates** by category — a rule that never fires may be
  miscalibrated; a rule firing constantly may indicate the tiering score upstream is too generous.

## 10. Escalation resolution & lifecycle

The original design specified what fires a hard escalation (§4) but not what closing one looks
like or what gets recorded — mockup review surfaced this as the single most-corroborated gap.
This section formalizes it.

**Actions available on an active escalation:**

- **Mark resolved** — closes the thread without a system-logged reply (e.g. resolved by phone, or
  determined no reply is needed). Still requires an outcome tag.
- **Compose & send reply** — a human writes and sends the reply directly. Once a thread has
  escalated, agent-send is permanently disabled for it; only a human can act on it from that point.

**Every closure creates one Resolution record**, capturing:

- **Human action taken** (free text, e.g. "Sent quote," "Escalated to AE — billing dispute
  handoff")
- **Follow-up sent** — the message content and timestamp, if one was sent
- **Outcome tag** — a fixed enum (closed-won / re-engaged / no-response / churned /
  closed-no-action), not free text, so outcomes are reportable later
- **Time-to-resolution**, from escalation time to resolution time, shown against a response SLA if
  one is set (see §12 — no SLA is currently policy-set, so this is informational, not a compliance
  measure, until that decision is made)

**Resolving a hard-trigger escalation does not automatically restore the account's prior tier.**
§3's demotion rule ("stays there until a human explicitly clears it") is written for *negative-signal*
demotions specifically. A hard-trigger escalation (§4) is a different case — it can be a perfectly
healthy signal (a pricing question is a buying signal, not a complaint) that simply requires human
handling for that one thread. To keep this simple rather than building two different auto-recovery
rules: resolving the escalation closes that record only. It does **not** change `Account.current_tier`
one way or the other. If the account should move to a different tier as a result (e.g. back to
Tier 2 now that the pricing conversation is handled), **a human does that as an explicit, separate
action** — a manual tier change, available from the account's own page, requiring a short reason.
This is logged as its own `TierHistoryEvent` entry, the same way every other tier change is, so a
manual override is auditable and never a silent edit — consistent with tiers being "earned/justified,
not arbitrary" (§3). Automatic tier-recovery logic is deliberately not built for v1.

**Repeat-escalation flag:** if an account has a prior Resolution record whose underlying issue
plausibly matches a new escalation (e.g. a billing dispute resurfacing after an earlier AE
handoff), the new escalation should be marked as a **repeat escalation on the same issue** rather
than presented identically to a first-time one. Don't build this as an automated "same issue"
detector for v1 — reliably matching issues is a judgment call, not a deterministic match. Instead,
make it a human-set flag available when opening an escalation ("Related to a prior resolution —
link it"). This closes a specific gap found in review: an account showing both a resolved record
and a new active escalation on the same underlying dispute, with no link between the two.

**Content correction:** any UI copy describing where the close action lives must not name a
specific other tab (e.g. "closing an escalation on the Draft review tab") — which tab shows the
close action depends on the account's current state. Use tab-state-agnostic language instead, e.g.
"Closing an active escalation logs a record here."

## 11. Tier 1 audit-sampling

§8 already called for "a fixed percentage of autonomous sends... logged for retrospective human
spot-check" — this section specifies the actual mechanic, since the original spec named the need
without designing it.

- A fixed percentage (default **10%**, adjustable per §12) of Tier 1 autonomous sends are
  automatically logged into an **audit-sample queue** at send time, not triggered by a complaint.
- This is retrospective and non-blocking: the message has already sent by the time a human reviews
  it. Sampling exists to catch tone drift early across many sends, not to gate any individual Tier
  1 send — gating would defeat the purpose of Tier 1 autonomy.
- A human reviewing a sampled send marks it **fine** or **concerning**. A concerning flag does
  **not** by itself demote the account — only a real negative signal per §3 does that — but it
  creates a record the team can look for patterns across (e.g. one trigger type or message
  template repeatedly flagged).
- The sample rate, and which Tier 1 sends are eligible for sampling (e.g. excluding the
  highest-tenure accounts once they have a long clean history), are admin-configurable — see §12.

## 12. Admin-configurable settings

Settings are deliberately split by risk rather than offered as one undifferentiated list:

**Freely adjustable, no confirmation needed:**
- Tier 1 promotion threshold — clean approvals required before Tier 1 (integer, 1–4, default 2)
- Tier 1 audit-sample rate (percentage, default 10%)

**Adjustable with a confirmation step** (real customer-facing consequences):
- Follow-up cadence — max follow-ups per account (1–5, default 2) and minimum days between (3–14,
  default 5). Confirmation copy must state that a change applies to outreach going forward, not
  retroactively.
- Sensitivity thresholds behind hard triggers (e.g. negative-sentiment confidence floor) — these
  are signal-detection thresholds, tunable because they affect precision, not the rule itself.

**Locked, engineer-only:**
- The hard escalation trigger rules themselves (§4, rules 1–5) — e.g. "pricing questions escalate"
  is a policy decision with real commercial/reputational risk if loosened, not a tuning knob.
- Whether the rollout overlay applies at all (§3) — a risk-appetite decision, not a setting.

**Deferred, not v1:**
- ICP fit scoring weights — needs real usage data to tune responsibly before it's exposed at all.
- **A settings change log.** v04's mockup included one (who/what/when/old→new), but on review this
  was cut for v1: a change log only means something once there's also a concept of *who* is allowed
  to change settings, and this design deliberately isn't building access control yet either (a
  two-person team sharing one login has no one to distinguish from whom). Logging changes without
  that distinction gives an appearance of accountability the system can't actually back up. Revisit
  both together — not the log alone — if the team grows past two people or introduces role
  separation.

## 13. Explicit non-goals

- This design does not specify the trigger-detection or ICP-scoring ML pipeline.
- This design does not cover the human-review/escalation console UI (see the separate Open Design
  briefs for that, including `ideation/open-design-brief-v4-settings-audit.md` and
  `ideation/open-design-brief-v5-fixes.md` for the settings and audit-sampling screens specified in
  §11–12).
- A health-pulse metrics snapshot and a business-unit switcher (raised during mockup review as
  lower-priority findings) are intentionally not designed here, and are explicitly out of scope for
  the first version of the outreach agent, not just deprioritized.
- Access control / RBAC for the Settings screen is intentionally not designed here — see §12's note
  on why the change log was cut alongside it, not independently.
- Numeric SOLAS recertification intervals used anywhere in supporting materials are illustrative,
  not asserted as verified facts (see `scenario-research.md`).
