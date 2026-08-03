# Tier 1 Autonomous Send — Design

Status: Approved design — pending implementation plan
Last updated: 2026-08-03
Grounding: [`2026-08-01-outreach-agent-design.md`](2026-08-01-outreach-agent-design.md) (behavior
spec — §3 tiering, §4 hard triggers, §5 tone, §7 error handling, §10 audit-sampling, §11 settings),
[ADR-0002](../../adr/0002-tier-1-autonomous-send-deferred.md) and
[ADR-0005](../../adr/0005-clean-approvals-counted-promotion-action-deferred.md) (both superseded by
this design), [ADR-0003](../../adr/0003-hard-trigger-rule-5-message-level-cap.md) and
[ADR-0004](../../adr/0004-tier-1-is-earned-never-set-manually.md) (both upheld and extended).

## 1. What this closes

The behavior spec has always defined Tier 1 as "agent sends autonomously," but nothing behind that
sentence was ever designed. Two ADRs deferred it and one screen was left without a data source:

- **ADR-0002** made a Tier 1 recommendation throw rather than guess at unbuilt behavior.
- **ADR-0005** counted Clean Approvals but never performed the promotion, because promoting an
  account into a tier whose behavior did not exist would make ADR-0002's throw reachable in normal
  operation.
- The Send Audit screen samples Tier 1 sends (§10). With no Tier 1 sends, it had nothing to show.

This design supplies the missing behavior, which lets all three resolve.

**What it deliberately does not add:** no hold window before an autonomous send (§10 is explicit
that gating defeats the purpose), no volume caps, no per-account autonomy toggle (Tier 1 is earned,
never granted — ADR-0004), no audit-sample eligibility rules and no response SLA (both remain
deferred in §11).

## 2. The send gate

A Tier 1 account's draft must clear five gates to send without a human reading it. Four of them,
when tripped, **hold that one message at Tier 2** — it drafts and waits for approval, and
`Account.currentTier` is untouched. This is not a new mechanism: it is exactly what §4 rule 5
already does, and what [ADR-0003](../../adr/0003-hard-trigger-rule-5-message-level-cap.md)
established as the pattern. Tier 1 grants the agent *permission* to send autonomously, not an
obligation to.

| # | Gate | Trips when | Outcome |
|---|---|---|---|
| 1 | **Kill switch** | autonomous sending is paused org-wide (§6 below) | hold at Tier 2 |
| 2 | **Escalation** | the account has an active Escalation with `agentSendDisabled` | hold at Tier 2 |
| 3 | **Rule 5** | the message would cite a specific vessel's compliance/recertification deadline | hold at Tier 2 |
| 4 | **Confidence** | the drafting call reports `confidence_label: "mid"` | hold at Tier 2 |
| 5 | **Recipient** | the account has no contact email | `needs_triage` |

Gate 5 is the one exception to the hold pattern, and for a concrete reason: holding a message for
approval assumes a human can approve it, and there is nothing to approve when there is no address
to send to. That is a data problem, so it routes to triage the way §7 routes every other "the agent
cannot proceed and a human must" case.

Low confidence never reaches these gates at all — §7 already resolves it upstream: the agent does
not draft, and the account is flagged for triage.

Each hold records which gate fired in `Message.hardRuleFlags`, so a reviewer opening a held message
can see why it is in front of them rather than having gone out.

## 3. Promotion

Promotion becomes real, on exactly the bar §3 already sets — **both** conditions, not either:

1. `Account.cleanApprovalsCount >= Setting.tier1PromotionThreshold`, and
2. the account independently qualifies for Tier 1 on score alone — concretely, the existing tiering
   function's **base** tier (before the rollout overlay caps it) is 1, which is §3's "high ICP fit +
   high-confidence trigger + no relationship conflict."

Stating condition 2 in terms of the base tier matters, because the rollout overlay exists precisely
to suppress that base recommendation until the account has a record. Promotion is the moment the
overlay stops applying — so the question being asked is "would this account have qualified on score
if we had trusted it from the start?", and the answer must come from the same calculation that
answered "no" every time until now.

On promotion: `Account.currentTier = 1`, and a `TierHistoryEvent(promote)` whose reason names both
conditions, so the timeline says *why* this account was trusted rather than just that it was.

**An account's first autonomous send is always audit-sampled**, regardless of the configured rate.
This is an addition to §10's uniform 10%, and the reasoning is that the rates are not describing the
same risk: the first message an account sends with nobody reading it is the single riskiest message
it will ever send, and leaving that to a dice roll is a strange place to economise. After the first,
the account falls into normal §10 sampling.

## 4. What a demotion costs

§3 drops an account to Tier 3 on any negative signal. That handles the present incident, but it says
nothing about the account's *earned progress* — and without a rule, an account with four Clean
Approvals that gets a complaint, drops to Tier 3, and is later restored to Tier 2 by hand would
re-qualify for Tier 1 on its very next clean send. The negative signal would have cost it nothing
durable.

So: opening an Escalation resets `Account.cleanApprovalsCount` to zero **only when the rule that
fired indicates damaged trust**.

| Rule that fired | Counter | Why |
|---|---|---|
| `negative_sentiment` | **reset to 0** | A complaint, opt-out, or factual correction is trust actually damaged. Tier 1 is re-earned from scratch. |
| `relationship_conflict` | **reset to 0** | The agent contacted someone it should not have. The account experienced unwanted outreach, whatever the cause. |
| `pricing_question` | kept | §9: "a pricing question is a buying signal, not a complaint." |
| `technical_compliance_question` | kept | Engaged interest the agent simply cannot answer. |
| `non_english_language` | kept | A language barrier, not a failure of judgment. |
| `classification_uncertain` | kept | The *system* was unsure. Charging the account for that would be perverse. |

The reset is stated in the `TierHistoryEvent` reason either way — including when it does *not*
happen, so the timeline distinguishes "escalated, progress kept" from "escalated, progress lost".

Zeroing the counter for a pricing question would punish exactly the behavior Erria wants from a
prospect, which is why this is split by rule rather than applied to every trip to Tier 3.

## 5. Autonomous follow-ups

§5 allows at most 2 follow-ups, at least 5 business days apart, each **adding new information** and
never a bare "just checking in." Autonomous follow-ups are allowed, but only when that rule can be
satisfied *demonstrably*.

The cadence job (the `followup-cadence` entrypoint already stubbed for Azure Container Apps Jobs)
selects accounts with a sent message, no reply, the configured interval elapsed, and fewer than
`Setting.maxFollowups` follow-ups so far. For each:

```
newFactsSince(account, lastSentAt) -> Fact[]

  []       -> the sequence ends. Trigger.status = 'sequence_ended'.
              Nothing is sent. No Claude call is made. No task is created
              for anyone.

  [facts]  -> draft a follow-up citing ONLY these facts
              -> through the §2 gates -> send autonomously, or hold
```

**The division of labour is the point.** Whether something new exists is a *data* question, and
ordinary code answers it. How to say it is a *language* question, and that is Claude's. The model is
never asked "do you have anything new to say?", because that is a question a drafting model has every
incentive to answer optimistically, and answering it wrongly produces precisely the filler message
§5 forbids.

A **new fact** is one of exactly these, dated after the account's last sent message — an
enumerated list, not a judgment call, so that "nothing new" is a computable answer rather than an
opinion:

| Source | What counts |
|---|---|
| A new `Trigger` row | The upstream pipeline detected something else about this account. |
| A changed `Vessel` record | New or corrected vessel particulars for a vessel already in the thread. |
| A changed `Account.relationshipSummary` | The dossier's account-level narrative was updated. |

Anything not on this list is not a new fact, however interesting. Station availability — the
example §5 itself gives — reaches the system as a `Trigger`, which is why the trigger row is the
first entry rather than a special case: the pipeline that finds reasons to make contact is the same
pipeline that finds reasons to follow up.

Extending this list later is a deliberate, reviewable change. Widening it accidentally is what would
turn autonomous follow-ups back into "just checking in."

Two properties follow from doing it in this order. The common case — no news — costs **zero tokens**
and cannot invent news. And when a follow-up does go out, the facts it cites are facts the system
located, not facts the model recalled.

Ending a sequence is a normal outcome, not a failure. Some accounts will receive one message and
then silence, which is the correct behavior when there is genuinely nothing further worth saying.

## 6. The kill switch

One setting stops all autonomous sending org-wide. While paused, Tier 1 accounts keep their earned
tier and their messages simply drop into the approval queue (gate 1) — the system degrades to Tier 2
behavior rather than stopping.

**Pausing and resuming are deliberately asymmetric:**

- **Pausing takes effect immediately**, with no confirmation step. An emergency stop that makes you
  confirm is a worse emergency stop. Someone who has just spotted tone drift across several sends
  should be one click from stopping it.
- **Resuming requires the confirmation step** of §11's confirm-required class. Resuming is the
  direction that can cause harm, so it is the direction that gets friction.

Pausing also captures a short free-text reason. This is operational state, not the settings change
log that §11 deliberately cut — the point is that whoever finds the system paused can see why
without asking, which matters most for a two-person team where the other person may be asleep.

**The default is off.** Autonomous sending is switched on deliberately, once, by a human — the same
posture the rollout overlay takes toward individual accounts, applied to the capability itself.

Dispatch re-checks the switch immediately before sending, so pausing stops messages already in
flight rather than only future ones.

## 7. Data model changes

No new tables.

| Change | Field | Notes |
|---|---|---|
| `Setting` | `autonomousSendingEnabled` (bool, default **false**) | The kill switch. Off until deliberately enabled. |
| `Setting` | `autonomousPauseReason` (text, nullable) | Why it is currently paused. Cleared on resume. |
| `Trigger.status` | new value `sequence_ended` | The follow-up sequence found nothing new and stopped. |
| `Message.hardRuleFlags` | new values `low_confidence_hold`, `autonomous_paused_hold` | Which gate held a message, alongside the existing rule-5 flag. |

`AuditSample` needs no change — its rows finally get a producer.

## 8. Error handling

**An autonomous message is written as `status = 'approved'` with
`decidedBy = 'system (autonomous)'` before dispatch is attempted.** This is a deliberate reuse: it
means Plan 2's stuck-send reconciliation sweep already covers autonomous sends that fail to
dispatch, with no changes to that sweep at all. It also keeps "who decided to send this?" answerable
and honest, rather than leaving `decidedBy` null and implying nobody did.

| Failure | Behavior |
|---|---|
| Drafting call fails or times out on a Tier 1 trigger | §7 / architecture §4.4 pattern: `needs_triage`, nothing sent. Never "send anyway." |
| Dispatch fails | The message sits `approved` with no `sent_at`; the reconciliation sweep retries once, then flags for a human. |
| Kill switch flipped between drafting and dispatch | Dispatch's re-check catches it; the message holds for approval instead. |
| `newFactsSince` throws | The sequence is left open and retried on the next job run. A follow-up that never sends is a missed opportunity; a follow-up sent on bad data is a bad message. |

## 9. Testing

- **Gate matrix** — each of the five gates trips independently, holds the message at Tier 2, and
  leaves `Account.currentTier` unchanged. The recipient gate routes to `needs_triage` instead.
- **Promotion** — requires both conditions; neither alone promotes. The first autonomous send is
  sampled even when the configured rate would not have selected it.
- **Counter reset** — one case per row of §4's table, asserting the counter and the recorded reason.
- **Follow-ups** — with no new facts, nothing is sent, the sequence is marked ended, and **the Claude
  client mock is asserted never to have been called**. With new facts, the draft is built from those
  facts only.
- **Kill switch** — paused holds; pausing needs no confirmation; resuming does; a switch flipped
  mid-flight stops the send at dispatch.
- **Sampling** — the randomness is injected rather than global, so the rate is testable without
  relying on chance.

## 10. Documents this changes

- **ADR-0002** (autonomous send deferred) and **ADR-0005** (promotion action deferred) are
  superseded by a new ADR recording that both deferrals are lifted and why.
- **ADR-0003** (rule 5 is a message-level cap) and **ADR-0004** (Tier 1 earned, never manual) are
  both upheld — this design extends ADR-0003's pattern to four more gates, and relies on ADR-0004
  for why promotion is the only route to Tier 1.
- **The behavior spec** needs §3 amended: it asserts "agent sends autonomously" with none of §2's
  gate, §4's demotion cost, or §6's kill switch behind it. The spec is the primary deliverable, so
  the rules that govern autonomous sending belong in it rather than only here.
