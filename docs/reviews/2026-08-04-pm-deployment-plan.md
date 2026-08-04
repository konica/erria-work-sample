# Production Deployment Plan — Erria Outreach Agent
## Sequencing, Milestones, and Tier 1 Deferral Strategy

**Date:** 2026-08-04  
**Status:** Product deployment plan — pending leadership review and sequencing decision  
**For:** Mermaid Maritime Vietnam (Erria Group) — two-person team, first AI initiative

---

## Executive Summary

The outreach agent's rollout strategy creates a unique deployment advantage: **no account can reach autonomous send (Tier 1) on day one.** Every new account starts at Tier 2 minimum, regardless of score, until it earns ≥2 clean human-approved messages. This constraint means:

- **All messages require human approval for 1–3 weeks post-launch** while accounts earn their way to Tier 1.
- **Tier 1-specific infrastructure is deferrable,** not needed at cutover.
- **The first deployment can be narrower and safer** than a feature-complete system.
- **The kill switch defaults OFF;** autonomous sending is enabled once, deliberately, after early data.

This plan sequences the deployment to exploit that window: ship the essentials for safe human-mediated outreach, gather two weeks of approval data to tune the system, then enable autonomy.

---

## 1. Deployment Milestones

### Milestone 1: Foundation (Target: Week 0–1, day of launch)
**Entry condition:** Code is tested locally and passes security/compliance review (no PII in logs, Claude API key in Key Vault, CORS scoped).  
**Exit condition:** System is live in production; first account can be scored, message drafted, and queued for human approval.

**What ships:**
- Azure infrastructure (single West Europe region, Container Apps + Postgres + Keycloak)
- Console API: `POST /internal/triggers` endpoint (wired to worker)
- Console web: Account Queue page (read-only, shows queue of pending approvals)
- Worker: drafting flow and Claude API integration (real call, real model)
- Postgres Flexible Server with migrations applied
- Application Insights + Log Analytics for observability
- Keycloak auth (internal staff login, no admin UI exposed)

**What is NOT shipped:**
- Approve/edit/send UI or endpoints
- Hard-trigger escalation detection or UI
- Tier 1 autonomous sending logic (intentionally throws `NotImplementedFlowError` if it fires)
- Kill switch or audit sampling UI
- Scheduled jobs (follow-up cadence, audit maintenance)

**Azure infrastructure cost at this milestone:** ~$100–120/month (console + worker + Keycloak all running; worker scales to zero, console always on)

**Claude API cost:** Depends on account volume; estimate $30–80/month for dozens to ~100 accounts over first two weeks.

**Dependency:** Azure subscription created, Key Vault provisioned, Anthropic API key available, DNS/SSL configured.

---

### Milestone 2: Human-Mediated Approval Flow (Target: Week 1–2, 5–7 days post-launch)
**Entry condition:** Foundation is live and healthy; first account has a pending message waiting for approval.  
**Exit condition:** A human can approve, edit, or reject a message; approved messages send; edit/rejection is logged.

**What ships:**
- Console API: `POST /api/messages/:messageId/approve`, `POST /api/messages/:messageId/reject`, `PUT /api/messages/:messageId/edit` (save edited copy and send flag)
- Console web: Review page becomes functional — shows pending messages, diffs edits, logs approvals
- Worker: `POST /internal/send/:messageId` endpoint (queues for dispatch)
- Database: `Message.decidedBy` and `Message.editedFrom` fields populated correctly

**What is NOT shipped:**
- Hard-trigger escalation (still absent)
- Tier 1 autonomy (still throws if encountered)
- Escalation UI/Escalations page
- Audit Sampling UI

**Azure infrastructure cost:** No change (~$100–120/month)

**Goal:** Gather approval velocity data (how many messages per day, how much editing happens, how long approval takes). This data informs tuning before Tier 1 is enabled.

**Dependency:** Approval flow code complete and tested end-to-end in staging.

---

### Milestone 3: Escalation Flow & Tier 1 Preparation (Target: Week 2–3, 10–14 days post-launch)
**Entry condition:** Approval flow is stable; first account is approaching or has reached 2 clean approvals; no live production incidents in first two weeks.  
**Exit condition:** Escalation detection is live (messages fire escalation rules and create Escalation records); Escalations page shows active escalations; kill switch and audit sampling UI are built but kill switch remains OFF.

**What ships:**
- Worker: Hard-trigger rule detection (rules 1–5: pricing, technical, negative sentiment, relationship conflict, compliance deadline)
- Console API: `GET /api/escalations`, `POST /api/escalations/:escalationId/resolve` endpoint (closes with outcome tag)
- Console web: Escalations page functional (shows active escalations, resolution UI, repeat-escalation linking)
- Kill switch (manual override): `Setting.autonomousSendingEnabled` (default OFF), `Setting.autonomousPauseReason` for documentation
- Audit sampling UI: Shows sampled Tier 1 sends (still empty; no Tier 1 sends yet)
- Tier 1 send gates: Kill switch, active escalation, rule 5, confidence, recipient address — all implemented in worker, hold messages at Tier 2 if they trip
- Tier 1 promotion logic: Increments `Account.cleanApprovalsCount` on clean sends; promotes to Tier 1 when threshold met AND base tier qualifies

**What is NOT shipped yet:**
- Scheduled jobs (follow-up cadence, audit maintenance, stuck-send reconciliation)
- Tier 1 autonomous sends (kill switch is OFF, so no messages send autonomously yet)

**Azure infrastructure cost:** +$5–10/month for scheduled job infrastructure (Container Apps Jobs) = ~$105–130/month total

**Database schema additions:** Covered by migration; no new tables added (only flags on existing tables per design spec §7).

**Operational milestone:** This is the point where you **verify in production that escalation detection works correctly** before enabling autonomy. Run 2–3 days of live escalations with kill switch OFF. A human should see pricing questions, negative replies, and relationship conflicts correctly routed.

**Dependency:** Escalation logic tested in staging against sample data; killer switch verified to be in OFF position.

---

### Milestone 4: Enable Tier 1 Autonomy (Target: Week 3–4, 15–21 days post-launch, after first account earns Tier 1)
**Entry condition:**
- ≥1 account has earned ≥2 clean approvals and independently qualifies for Tier 1 by score
- Escalation handling has run error-free for ≥5 business days in production
- Approval velocity is well-understood (no surprise volume patterns)
- No high-severity bugs in escalation or approval flow in past week
- Leadership review and sign-off on go/no-go criteria (below)

**Exit condition:** `Setting.autonomousSendingEnabled = true` (human deliberately flips this switch); first Tier 1 account sends a message autonomously; audit sample captures it.

**What ships:**
- Kill switch set to ON by human decision (not automatic)
- Tier 1 autonomous send flow: Worker routes Tier 1 messages through five gates; approved and autonomous messages send with no human review
- First autonomous send always audit-sampled (100% sample of first send per account), then falls into normal ~10% sample rate
- Audit maintenance job runs: processes sampled sends, human marks Fine/Concerning
- Stuck-send reconciliation job runs: retries failed sends, flags unreachable ones

**What is NOT shipped:**
- Follow-up cadence job (still stubbed; follow-ups require new facts to exist before drafting)

**Azure infrastructure cost:** No change (~$105–130/month); all pieces are now operational

**Business cost:** Now exposed to autonomous send risk. This is why the go/no-go criteria matter (see §4).

**Dependency:** Kill switch code verified; audit sampling infrastructure tested end-to-end in staging.

---

### Milestone 5: Follow-Up Cadence (Target: Week 4–5, 20–28 days post-launch)
**Entry condition:** Tier 1 sending is live and autonomous sends have completed without severe tone/compliance issues for ≥5 days.  
**Exit condition:** Follow-up cadence job runs daily; accounts with no reply after N business days receive a follow-up if new facts exist; sequences ending is logged.

**What ships:**
- Follow-up cadence job (`followup-cadence` Container Apps Job): Runs daily, checks for no-reply messages past threshold, calls `newFactsSince()` to detect new facts (new Trigger, updated Vessel, updated relationship summary), drafts follow-ups from new facts only, routes through send gates, sends or holds
- Sequence-ending: If no new facts, `Trigger.status = 'sequence_ended'`, nothing sent, no Claude call made

**What is NOT shipped:**
- Admin UI for follow-up cadence settings (already available as a freely-adjustable setting per spec §11, just not yet UI-exposed; teams can ask for it via API or direct database edit if needed)

**Azure infrastructure cost:** No change (~$105–130/month); job was already in milestone 3

**Operational change:** Expect first accounts to exhaust their sequence by now (1st message + up to 2 follow-ups over 2 weeks means some threads will be complete). Monitor that sequences are ending appropriately, not repeating unnecessarily.

---

## 2. What Is Needed At Each Milestone vs. Deferrable

| Component | M1 | M2 | M3 | M4 | M5 | Notes |
|---|---|---|---|---|---|---|
| **Console + API (Tier 2 draft/review)** | ✓ | ✓ | ✓ | ✓ | ✓ | Core day-1 feature |
| **Worker drafting (Claude API)** | ✓ | ✓ | ✓ | ✓ | ✓ | Every message needs a draft |
| **Postgres Flexible Server** | ✓ | ✓ | ✓ | ✓ | ✓ | Single instance, B1ms (Burstable) |
| **Keycloak auth** | ✓ | ✓ | ✓ | ✓ | ✓ | Internal staff login |
| **Approve/edit/send endpoints** | — | ✓ | ✓ | ✓ | ✓ | Needed before any message can leave |
| **Review page UI** | — | ✓ | ✓ | ✓ | ✓ | Human-facing approval console |
| **Hard-trigger escalation rules** | — | — | ✓ | ✓ | ✓ | Deferred 2 weeks (safe during Tier 2) |
| **Escalations page UI** | — | — | ✓ | ✓ | ✓ | Deferred 2 weeks |
| **Tier 1 send gates** | — | — | ✓ | ✓ | ✓ | Built but kill switch OFF |
| **Tier 1 promotion logic** | — | — | ✓ | ✓ | ✓ | Increments counter; promotes when conditions met |
| **Kill switch UI** | — | — | ✓ | ✓ | ✓ | Built but OFF; human decision to enable |
| **Audit sampling UI** | — | — | ✓ | ✓ | ✓ | Shows sampled Tier 1 sends (empty until M4) |
| **Scheduled jobs (cadence, audit, stuck)** | — | — | ✓ | ✓ | ✓ | Job infrastructure deployed; jobs run |
| **Follow-up cadence logic** | — | — | — | — | ✓ | Deferred 3+ weeks; sequences end anyway during M4 |
| **Audit maintenance job** | — | — | ✓ | ✓ | ✓ | Runs but empty queue until M4 |
| **Stuck-send reconciliation job** | — | — | ✓ | ✓ | ✓ | Runs; catches dispatch failures |
| **Admin settings UI (follow-up cadence, sample rate, promotion threshold)** | — | — | — | — | — | Deferred v2; teams use API or ask PM if needed |
| **Access control / RBAC** | — | — | — | — | — | Deferred v2 (two-person team, shared login) |
| **Settings change log** | — | — | — | — | — | Deferred v2 (cut per spec §11) |
| **Business reporting dashboard** | — | — | — | — | — | Deferred v2 (simple queries sufficient for now) |
| **Multi-region, auto-failover** | — | — | — | — | — | Out of scope (single region, manual DR) |

### The Deferral Thesis

**Why escalation can wait 2 weeks (Tier 2 shield):** During Tier 2, all messages go to a human anyway. If a hard-trigger rule fails to fire (false negative), the human still reads it and can handle it manually. If a hard-trigger rule mis-fires (false positive), an escalation gets created unnecessarily, but it's low-cost to manually clear. Escalation detection on day 1 adds risk (new code path, new failure mode) for almost no benefit during the Tier 2 window.

**Why follow-up cadence can wait 3+ weeks (sequences end anyway):** A Tier 1 account sending 3 messages (1 initial + 2 follow-ups) over ~2 weeks during the cadence job's build/test/deploy window means most sequences are already at their natural end by M5. The cadence job is operational polish, not a blocker.

**Why Tier 1 audit sampling UI can wait if nothing else does (no sends to sample):** Until the first account reaches Tier 1 and sends autonomously, the audit sample queue is empty. The UI is rendering an empty view. Audit sampling can land in M3 with the other Tier 1 prep and sit idle until M4 when it matters.

---

## 3. Cutover / Pilot Approach — Safe Deployment Against Real Accounts

### The Risk Model

The failure mode that matters is **not downtime** — it is **a bad message reaching a real customer and damaging a commercial relationship.** An outreach message with tone problems, false urgency, or unwanted surveillance framing can harm Mermaid's reputation and lose a deal.

### Phased Real-World Rollout

**Week 0 (Launch week):** 
- Deploy Milestone 1 to production
- Begin with **internal testing** — Erria/Mermaid staff send themselves test triggers to validate the queue and drafting
- After 24 hours of internal testing with no errors, **enable external scoring** (upstream pipeline begins sending real account triggers)
- **Constraint:** All incoming triggers route to Tier 2 (enforced by rollout overlay in code)
- **Goal:** Accumulate 10–20 real accounts in the queue with draft messages ready

**Week 1 (M2 goes live):**
- Deploy Milestone 2 (approval/edit/send endpoints and UI)
- A human sales operator (BDR/AE) begins approving queued messages
- **Key action:** Human *always* reads and has the option to edit before sending anything
- **Monitoring:** Capture data on editing frequency, edit types (tone fixes? fact corrections?), approval time
- **Goal:** Send 20–40 real outreach messages; zero untoward replies; gathering velocity and editing patterns

**Week 2 (M3 goes live):**
- Deploy Milestone 3 (escalation detection, Tier 1 infrastructure, kill switch)
- Kill switch remains OFF in code (no Tier 1 autonomy yet)
- **First escalations arrive in production** (inbound replies to week 1 messages)
- Verify that hard-trigger rules fire correctly (pricing question → escalation, complaint → escalation, technical question → escalation, etc.)
- **Goal:** Validate rule accuracy against real replies over 5–7 business days; 0 false negatives on severity matters

**Week 3+ (First account reaches Tier 1):**
- By now, the most active accounts will have 1–2 clean approvals
- Once any account reaches 2 clean approvals AND independently qualifies by score, it is automatically promoted to Tier 1 in code
- **Human decision point:** Review the first account's full thread, confirm tone/accuracy, and make the deliberate choice: **flip the kill switch to ON**
- **First autonomous send:** The first message from that promoted account routes through all five gates; if all pass, it sends with no human review
- **Audit sampling:** That first message is 100% sampled (always captured for retrospective review) + normal 10% from then on

### Why This Approach Is Safe

1. **Tier 2 acts as a safety net for 2–3 weeks.** All messages require a human to read them before any leave the system.
2. **Escalation detection is verified live before autonomy is enabled.** By the time you flip the kill switch, you have real data that hard triggers are working.
3. **The kill switch is OFF by default.** You don't stumble into autonomy; you make a deliberate choice to enable it.
4. **First Tier 1 message is always sampled and will be reviewed.** It is not flying blind.
5. **Team has already handled 30–50 real messages manually** — they understand edge cases, reply patterns, and escalation triggers in context.

---

## 4. Go/No-Go Criteria for Enabling Autonomous Send (Kill Switch ON)

These are **concrete and checkable**, not aspirational. Someone (e.g., the PM or BDR lead) must sign off on each before the switch flips.

### Must-Have Criteria (All must be TRUE)

**A. Tier 1 send gates all fire correctly in production (5+ business days of live testing):**
- Confidence gate: A message drafted with low confidence is held, not sent. ✓ Verify with logs showing `hardRuleFlags: ['low_confidence_hold']` on ≥1 message
- Escalation gate: Message with an active escalation on the account is held. ✓ Verify with logs
- Rule 5 gate (compliance deadline): Message citing a vessel's deadline is held for review. ✓ Verify in logs or manually send a compliance message and observe it held
- Recipient gate: Message with no contact email routes to `needs_triage`. ✓ Verify with a test account missing email
- Kill switch itself: With kill switch OFF, any Tier 1 message is held. Turn switch ON, same message sends. ✓ Verify toggle behavior

**B. Hard-trigger escalation is accurate on real data (verified by the BDR/operations person):**
- No missed high-severity escalations in the past 5 business days (pricing questions, complaints, technical questions, relationship conflicts). ✓ Manual audit by ops: review all inbound replies, confirm each was escalated if it should have been
- False-positive rate is acceptable (e.g., <5% of escalations are purely informational with no action needed). ✓ Check `Resolution.outcomeTag` distribution; if most are "closed-no-action," rules are too sensitive
- Repeat-escalation linking is working (if same account escalates again on same topic, link is created). ✓ Verify on a test escalation (can be scripted or manual)

**C. Approval velocity is understood and sustainable:**
- A human can approve a message in <2 minutes on average (data from M2 logs). ✓ Check `Message.createdAt` vs. `Message.approvedAt` over the past 5 business days
- Edit rate is <30% (threshold for "most messages go out as drafted"). ✓ Count `Message.decidedBy` records where `decidedBy != 'original_draft'`
- No backlog forming: messages do not wait >4 hours for approval on average. ✓ Check approval SLA data from Application Insights

**D. First account approaching Tier 1 has a clean, representative thread:**
- The account has ≥2 human-approved messages with no edits. ✓ Verify count of clean approvals in database
- No negative signals on that account (no escalations, no complaints in replies). ✓ Check Account tier history; should show no demotions
- The messages exchanged are representative of the tone you want (one BDR/ops person reads the thread and says "yes, this is the tone I want to scale"). ✓ Manual sign-off from the ops person
- The account independently qualifies for Tier 1 by score (ICP fit + trigger clarity + relationship status). ✓ Check base-tier calculation (not overlay-capped) for that account

**E. Infrastructure is healthy and has not had unplanned outages in past 7 days:**
- Console app CPU/memory utilization <80% typical, <95% peak. ✓ Check Application Insights metrics
- Worker scale-to-zero is working (scales back down when no jobs running). ✓ Verify in Azure Container Apps logs
- Postgres is responding in <100ms typical, with no connection pool exhaustion. ✓ Check dependency tracking in Application Insights
- Claude API calls have <2% rate-limit or auth errors. ✓ Review LlmCall failure logs; none should be auth (that's a key problem) or persistent rate-limiting (that's a quota problem)

### Go/No-Go Decision

**GO (all must be true):**
- All five must-have criteria passed
- PM and ops lead have both reviewed and signed off
- No open high-severity bugs in approval or escalation flow
- No PII leaks observed in logs (spot-check logs for any customer data that shouldn't be there)

**NO-GO (any true, kill switch stays OFF):**
- Any must-have criterion is not met or is unclear
- An escalation rule is missing (e.g., you only detect 4 of 5 hard triggers)
- Edit rate is >50% (too many messages need fixing before sending)
- Any approval message is delayed >12 hours on average (human bottleneck is likely)
- An account with a complaint or negative reply was not escalated (false negative on hard trigger)
- Infrastructure is not healthy or had an unplanned outage in past 3 days

---

## 5. Operational Cadence — Two-Person Team, Realistic Frequency

### Daily (During business hours, ~30 min)

**Queue review (morning, 9–15 min):**
- One person opens the Review page, glances at pending approval count from the sidebar badge
- If >3 messages pending, spend 15 min approving/editing/sending them
- If <3 messages pending, skip (they will accumulate organically as upstream pipeline sends triggers)

**Escalation triage (if new escalations, ~15 min):**
- Check Escalations page; if any active escalations newer than yesterday, read them
- Decide: reply? escalate to AE? close with no action? Log the action
- If escalation is from a large account or a complaining customer, handle immediately; otherwise batch at end of day

### Weekly (Thursday or Friday, after market close, ~1 hour)

**Tier 1 audit sampling review:**
- Open Audit Sample queue
- If ≥5 Tier 1 sends have been sampled in the past week, spend 20–30 min marking them Fine/Concerning
- Look for patterns: if same trigger type or message template is repeatedly marked Concerning, flag for tone review

**Metrics snapshot (refresh in Slack or shared doc):**
- Pull from Application Insights or a simple SQL query:
  - Accounts in queue: _
  - Messages approved this week: _
  - Escalations opened: _
  - Tier 1 promotes this week: _
  - Autonomy switch status: ON/OFF
- If anything looks off (unusually high escalation rate, zero promotes, etc.), note it for team sync

**Kill switch status & operational notes:**
- If kill switch is currently paused, confirm the pause reason is still valid and hasn't been forgotten
- If any alerts fired (5xx errors, Claude API failures, Postgres near capacity), review and document resolution

### Monthly (or as-needed re-assessment, ~2 hours)

**Tier 1 readiness & deferral review:**
- If Tier 1 is OFF: are the preconditions met to enable it? (first account at 2 clean approvals? no severe issues?)
- If Tier 1 is ON: what is the Tier 1 send volume? is the 10% audit sample rate catching issues? do you need to adjust anything?
- Are there patterns in edits (certain trigger types always edited?) or escalations (certain rules firing too much?) worth tuning?

**Settings review:**
- Tier 1 promotion threshold: still 2 clean approvals, or does data suggest it should be 3?
- Audit sample rate: still 10%, or do you want to increase it if volume is low, or decrease if volume is high and sample queue is backlogged?
- Follow-up cadence: max 2 follow-ups, 5 business days apart — is that working, or do you see accounts timing out before you can follow up?

**Cost review:**
- Azure infrastructure bill: still ~$100–130/month, or has usage shifted?
- Claude API bill: expected to be $50–300/month; is it tracking? (This is the likely cost driver once Tier 1 autonomy kicks in, so watch it)
- Any surprises? If bill is >$500/month suddenly, investigate (possibly a runaway job or draft loop)

### No Fixed Schedule (As-Needed)

**Retraining on edge cases:**
- When an escalation reveals a gap (e.g., a message that should have been escalated but wasn't), note it
- Track if it's a rule-tuning issue (sensitivity threshold) or a rule-logic issue (should never have been missed)
- Escalate to engineer if it's a code issue; doc as a known limitation if it's a threshold-tuning decision

**Incident response:**
- 5xx errors, Claude API outages, or Postgres down → page the engineer immediately (no "check Thursday")
- Kill switch will be paused if unusual messages are observed in audit sample

---

## 6. Risks, Ranked by Expected Cost

Each risk includes a **mitigation** — not a guarantee it won't happen, but an action that reduces its likelihood or impact.

### Tier 1: Reputational / Commercial (Highest cost if it happens)

**Risk 1.1: A badly-toned or factually-wrong Tier 1 message reaches a customer and damages a relationship.**

*Why it matters:* An autonomous message with tone drift (e.g., fear-based framing, implied surveillance) or false information (e.g., citing a compliance deadline that's wrong) can lose a prospect or upset a customer. Erria has no prior AI outreach experience, so the risk is real.

*Expected cost if it happens:* Loss of deal (~$10k–100k depending on vessel type/relationship); reputation damage in a tight maritime industry community.

*Likelihood without mitigation:* ~10–15% by month 2 if you enable Tier 1 without careful vetting.

*Mitigation:*
- Keep kill switch OFF until ≥5 business days of escalation live testing (verifies rules are catching real issues)
- Require the first Tier 1 account to have a clean, human-reviewed thread before promoting
- Audit-sample 100% of first Tier 1 sends from each account (until a small cohort of Tier 1 accounts builds history)
- BDR/ops person spot-reads audit samples weekly; if Concerning flags appear, pause and investigate
- Confidence gate in code: never send Tier 1 without high confidence from Claude (mid-confidence holds for review)

*Residual risk:* ~2–3% by month 2 with full mitigation (model hallucination, unforeseen tone drift, rules miss a category).

---

**Risk 1.2: Escalation rule mis-detects a situation and either misses a real issue (false negative) or over-escalates (false positive).**

*Why it matters:* A missed pricing question means the agent keeps drafting when a human should take over (lost commercial opportunity, wasted tokens). Over-escalating floods the review queue with noise.

*Expected cost if it happens:* False negatives: lost deals or wasted time drafting replies to pricing questions. False positives: ~1–2 min lost per over-escalation × volume.

*Likelihood without mitigation:* ~20–30% that at least one rule is significantly miscalibrated by month 1.

*Mitigation:*
- Live testing of escalation rules for 5+ business days in production before enabling Tier 1 (real replies validate rule accuracy)
- BDR/ops person manually audits all escalations over that window: "Did this need to be escalated? Was anything missed?"
- Sensitivity thresholds (e.g., confidence floor for negative sentiment detection) are tunable per spec §11 without code release
- Track escalation firing rates in Application Insights as a leading indicator (if a rule fires every message, it's too sensitive)

*Residual risk:* ~5–8% that a rule is still miscalibrated by month 2 (rules are trained on limited data, and new account types may behave differently).

---

### Tier 2: Operational / Availability

**Risk 2.1: Azure infrastructure outage (Container Apps, Postgres, or network) takes the system down for hours, causing a backlog of messages.**

*Why it matters:* While it's down, no new messages can be drafted or approved. Accounts pile up in the queue. When it comes back, the backlog is large.

*Expected cost if it happens:* ~1–2 hours of lost productivity for BDR/ops staff; ~20–50 messages stuck in queue during outage; reputation damage only if an external customer deadline is missed (unlikely in first month).

*Likelihood without mitigation:* ~5–10% in first month (Azure single-region is reliable, but new systems have teething issues).

*Mitigation:*
- Automated daily backups of Postgres with geo-redundant storage (built into Flexible Server; enables recovery in hours, not days)
- Application Insights alerts on 5xx errors + console app CPU/memory (early warning before overload)
- IaC-based infrastructure (Bicep); rebuild in a different region if needed (runbook exercise, ~2–3 hours)
- Single region is a trade-off: no live failover, but RTO ~2–4 hours is acceptable for an internal tool (not customer-facing)

*Residual risk:* ~2–3% of a multi-hour outage in first month (standard Azure reliability).

---

**Risk 2.2: Claude API rate-limiting or quota exceeded; drafting starts failing silently (messages route to needs_triage without explanation).**

*Why it matters:* If the API hits a limit and the team doesn't notice, messages stop drafting. BDR staff see a bunch of "needs triage" flags without knowing why.

*Expected cost if it happens:* ~20–40 messages routed to triage instead of drafted; 1–2 hours debugging to realize it's a quota issue; loss of momentum if not caught quickly.

*Likelihood without mitigation:* ~5–8% (Anthropic quotas are usually generous, but unexpected usage can hit limits).

*Mitigation:*
- Application Insights alert on Claude API 401/429 errors (auth/quota failures are distinct from transient network errors)
- Alert triggers an email to the team immediately (not a daily report)
- Team checks `LlmCall` logs weekly for unusual failure rates (0% failures is the baseline; >1% warrants investigation)
- Set a monthly budget alert in Azure Cost Management (Claude bill exceeding $300 should trigger review)

*Residual risk:* ~2–3% that a limit is hit without alerting (edge case in alert logic).

---

### Tier 3: Data / Compliance

**Risk 3.1: PII leakage in logs (customer contact info, account data, message content reaching Application Insights or Log Analytics when it shouldn't).**

*Why it matters:* GDPR applies (Erria is Danish, data includes EU business contacts). Leaking customer contact info or message content in logs violates data minimization principles and could trigger a breach notification.

*Expected cost if it happens:* GDPR fine (up to 4% of global revenue, though for a small company it's usually €5k–50k), reputational damage, possible customer notification.

*Likelihood without mitigation:* ~10–15% (logging is often done carelessly; PII slips in accidentally).

*Mitigation:*
- Code review before M1 launch: spot-check logs for any customer names, email addresses, or message content. None should be logged at INFO level (DEBUG is OK if masked)
- Application Insights ingestion cap + data retention limit (90 days by default; enough for debugging, not long-term archive)
- Data residency: keep primary storage in West Europe (aligned with GDPR principle of least distance)
- No PII in error messages or exceptions (e.g., do not log "Failed to send to customer@example.com"; log "Failed to send message to contact on account ABC123" instead)
- Spot-check logs monthly (PM or engineer reviews a sample of logged errors and warns if any PII detected)

*Residual risk:* ~1–2% that a PII leak is undetected by month 2 (code review and log sampling are not foolproof).

---

**Risk 3.2: An incorrect message is sent to the wrong contact because of a data entry error (e.g., same company, different contact; message for one vessel sent to the wrong person).**

*Why it matters:* An outreach message to the wrong person at a company can confuse prospects and waste a relationship opportunity.

*Expected cost if it happens:* Loss of deal (~$10k–50k), relationship repair effort.

*Likelihood without mitigation:* ~3–5% (data entry errors happen; depends on upstream pipeline quality).

*Mitigation:*
- BDR/ops person spot-checks a few sent messages monthly to confirm recipient is correct
- Dossier view in console shows contact name and email before sending (last chance to catch a mis-entry)
- Message drafting happens on a per-account basis; if contact data is stale, it's the upstream pipeline's problem (not this system's)

*Residual risk:* ~1% (mostly out of this system's control; depends on data quality upstream).

---

### Tier 4: Engineering / Technical Debt

**Risk 4.1: Stuck-send reconciliation job never runs or fails silently; messages marked approved but not actually sent are never retried or surfaced.**

*Why it matters:* A message that fails dispatch (Claude API call succeeds, but SMTP fails) sits in the database as `approved` with no `sent_at`. If the job that retries it doesn't run, the message is lost and the account doesn't get outreach.

*Expected cost if it happens:* ~5–10% of sends fail (network blip, SMTP timeout); without reconciliation, those are lost. Low revenue impact, but ops confusion ("Why didn't that message send?").

*Likelihood without mitigation:* ~10–15% (scheduled jobs often silently fail if not monitored).

*Mitigation:*
- Stuck-send job runs daily; logs all retries and final dispositions
- Alert if job does not complete in past 24 hours (Application Insights schedule trigger alert)
- Manual spot-check weekly: query the database for `status = 'approved'` with no `sent_at` and age >24h; should be zero or very few

*Residual risk:* ~2–3% that stuck-send job silently fails for a day or two before being noticed.

---

**Risk 4.2: Tier 1 promotion logic never fires (accounts get clean approvals but never promote to Tier 1); Tier 1 feature is ready but unused.**

*Why it matters:* If promotion doesn't happen, the system never reaches Tier 1 autonomy even though the infrastructure is built. It defeats the purpose of the deployment.

*Expected cost if it happens:* Wasted engineering effort; team continues manual approvals indefinitely even when they shouldn't have to.

*Likelihood without mitigation:* ~5–10% (off-by-one errors, logic not being tested before M3 deploys).

*Mitigation:*
- Test promotion logic in staging against sample data before M3 deployment: create an account with 2 clean approvals and confirm `Account.currentTier` becomes 1
- Code review the promotion logic; ensure both conditions (clean approval count AND base tier) are checked, not just one
- Log every promotion event to Application Insights with account ID, clean approval count, base tier score (so you can see if promotions are happening)

*Residual risk:* ~1% with testing + logging (easy to verify).

---

## 7. What to Defer or Cut Entirely

### A. Defer to v1.1 (Month 2–3): Lower-risk, higher-complexity features

**Admin settings UI** (`docs/superpowers/specs/2026-08-01-outreach-agent-design.md` §11):
- Tier 1 promotion threshold, audit sample rate, follow-up cadence, sensitivity thresholds are all configurable
- Right now, change them via direct database edit or API call (works fine for a two-person team)
- UI is nice-to-have but adds complexity (forms, validation, change logging, potential for user error)
- **Cost of deferral:** Team asks PM to update settings; PM runs a SQL query or curl command. ~5 min per change, ~1–2 per month expected
- **When to reconsider:** Once Tier 1 is stable (month 2) and the team wants to tune sample rates or cadence without asking the PM

**Access control / RBAC:**
- Right now, one login for the team (two people sharing credentials)
- No need to distinguish "who changed the settings" until there are multiple people/roles
- Spec §11 explicitly defers this alongside the change log
- **Cost of deferral:** Team awareness that anyone with access can make any change. Low risk with two people
- **When to reconsider:** If team grows >2 people or external staff need read-only access

**Escalation response SLA tracking:**
- Spec §9 records time-to-resolution on every closed escalation, but deliberately as *information*, not a compliance measure (no target SLA yet)
- No data yet on how long escalations actually take; any number set now would be invented
- **Cost of deferral:** No SLA alerting; team doesn't know if they're slow to respond until they look at the data monthly
- **When to reconsider:** After month 1, plot the distribution of resolution times and set a realistic target

**Business-unit switcher** (spec §12 explicitly out of scope):
- System assumes Mermaid Maritime Vietnam only
- Adding the ability to switch between business units (ECS, Cathay Seal, Nordic Marine Partner) is out of scope for v1
- **Cost of deferral:** Hard-coded to one business unit; will need a schema change later (but likely a small one)
- **When to reconsider:** If Erria rolls this out to another business unit (month 3+)

### B. Defer to v1.5 (Month 3–4): Nice-to-have reporting

**In-app reporting dashboard (business metrics snapshot):**
- Tier distribution: how many accounts at Tier 1, 2, 3?
- Escalation volumes: how many per week? trends?
- Approval velocity: average approval time? edit rate?
- Audit sample results: how many Concerning flags vs. Fine?
- All of this is available via SQL queries or Application Insights today
- Dashboard would be a read-only page querying the database
- **Cost of deferral:** Team writes SQL/runs queries manually. ~15–30 min weekly. Low friction
- **When to reconsider:** If the team grows or executive reporting is needed (month 3+)

**Health-pulse metrics snapshot:**
- Spec §12 explicitly out of scope for v1
- A snapshot of "is the system healthy right now?" would be useful, but can be inferred from daily checks
- **Cost of deferral:** No single-page system health view; team infers it from Application Insights + daily manual checks
- **When to reconsider:** If the system grows to multi-region or multi-tenant (unlikely in first month)

### C. Cut Entirely (Unlikely to be needed, or explicitly out of scope per spec)

**Compliance certifications (SOC2, ISO 27001, HIPAA):**
- Spec §0 explicitly states these do not apply (this is an internal B2B sales tool, not handling health or payment data)
- GDPR applies, but ordinary data-protection hygiene (encryption, access control, retention) is sufficient
- **Cost of cutting:** None; these were never planned
- **Reconsider:** If Erria ever sells this tool to external customers or moves to a regulated industry

**Multi-region active-active deployment:**
- Spec §0 and §9 explicitly recommend single region + manual recovery
- Erria is a Danish company serving Vietnamese staff with internal-only users; latency is not a factor
- Multi-region adds cost ($200–300/month) and operational complexity (data sync, failover logic) for near-zero benefit
- **Cost of cutting:** Accepted ~2–4 hour RTO in case of regional outage. That's reasonable for an internal tool
- **Reconsider:** If Erria needs global availability (unlikely given business model) or 99.99% SLA (unjustified for internal tool)

**Real-time notifications (WebSocket/SignalR for live message updates):**
- Not in the spec; added complexity, not needed for batch-approval workflow
- Polling the Review page every few minutes is sufficient (approval is not latency-sensitive)
- **Cost of cutting:** BDR staff refresh the page manually or wait for natural page load. Low friction at this scale
- **Reconsider:** If Erria wants to scale to a larger ops team with many users wanting real-time notifications

---

## 8. Summary: Deployment Sequencing & Cost Profile

### Timeline

| Milestone | Target | Key Deliverable | Infrastructure Cost | Claude API Cost | Dev Days Estimate |
|---|---|---|---|---|---|
| **M1: Foundation** | Week 0–1 | Queue, draft, Tier 2 approval pending | ~$100–120/mo | ~$30–80/mo | ~15–20 |
| **M2: Approval Flow** | Week 1–2 | Approve/edit/send endpoints & UI | ~$100–120/mo | ~$50–100/mo | ~10–15 |
| **M3: Escalation & Tier 1 Prep** | Week 2–3 | Hard triggers, kill switch, audit sampling (OFF) | ~$105–130/mo | ~$60–120/mo | ~15–20 |
| **M4: Enable Tier 1** | Week 3–4 | Kill switch ON; first autonomous sends | ~$105–130/mo | ~$100–300/mo* | ~5 (flip switch) |
| **M5: Follow-Up Cadence** | Week 4–5 | Automated follow-ups with new-facts logic | ~$105–130/mo | ~$150–400/mo* | ~10–15 |

*Claude API cost scales with Tier 1 autonomous volume (follows account growth and new-fact detection; could exceed Azure infrastructure cost)

### Cost by Phase

**Pre-launch (Dev/Testing):** No recurring Azure or Claude cost; one-time dev effort ~70–90 days over ~6–8 weeks

**Post-M1 (Tier 2 only, human-mediated):** 
- Azure: ~$100–120/month
- Claude API: ~$30–100/month (drafting only; volume depends on incoming triggers)
- **Total: ~$130–220/month**

**Post-M4 (Tier 1 enabled):**
- Azure: ~$105–130/month
- Claude API: ~$100–400/month (now includes autonomous sends, potentially higher volume)
- **Total: ~$205–530/month** (Claude API is likely the dominant cost)

### Key Decisions to Make Now (Before M1 Launch)

1. **Approve the phase 1 + 2 scope:** Queue, drafting, approval flow. Defer escalation until M3.
2. **Confirm the Tier 2 window duration:** Plan for 2–3 weeks of human-only approvals before first Tier 1 send. This is safe and lets you gather tuning data.
3. **Designate the kill switch owner:** Who will flip the switch from OFF to ON at M4? (Likely PM + ops lead together, after reviewing go/no-go criteria.)
4. **Budget for Claude API variability:** Tier 1 autonomy will increase API usage (and cost). Plan for $150–400/month by month 2.
5. **Set escalation live-testing duration:** 5–7 business days of real escalations before enabling Tier 1. Block calendar time for ops person to do detailed audit of rule accuracy.

---

## 9. Appendix: Risk Mitigation Checklist

### Before M1 Launch

- [ ] Code review: no PII in logs (spot-check key logging paths)
- [ ] Security: Claude API key in Key Vault, not .env
- [ ] CORS scoped to internal origin only (or IP allow-list)
- [ ] Database backups configured and tested (restore drill)
- [ ] Application Insights alerting set up (5xx errors, Claude API failures)
- [ ] Team trained on production log access and alerting
- [ ] Rollback plan clear (how to redeploy previous version if needed)

### Before M2 Launch

- [ ] Approval flow end-to-end tested in staging with sample data
- [ ] Editing logic tested (confirm edits are saved and version tracked)
- [ ] Send endpoint tested (message actually reaches SMTP / email service)

### Before M3 Launch

- [ ] Escalation rules tested against sample data (each of 5 rules fires in isolation)
- [ ] Kill switch code tested (OFF = Tier 1 message held; ON = Tier 1 message sends)
- [ ] Tier 1 promotion logic tested (clean approval count incremented correctly; promotion fires when both conditions met)

### Before M4 (Kill Switch ON)

- [ ] Go/no-go criteria reviewed and signed off by PM + ops lead
- [ ] First account's thread reviewed by ops lead ("tone is acceptable to scale")
- [ ] Escalation rules verified accurate on ≥5 days of real production data
- [ ] Approval velocity stable and understood (no backlog forming)
- [ ] Infrastructure healthy for past 7 days (no unexplained outages)

---

## 10. Glossary & Key References

- **Tier 1 rollout overlay:** `docs/superpowers/specs/2026-08-01-outreach-agent-design.md` §3 — every new account starts at Tier 2 minimum until ≥2 clean approvals
- **Hard-trigger rules:** `2026-08-01-outreach-agent-design.md` §4 — five conditions that override tier and escalate to human
- **Tier 1 send gates:** `docs/superpowers/specs/2026-08-03-autonomous-send-design.md` §2 — five conditions; any failure holds the message at Tier 2
- **Kill switch:** `2026-08-03-autonomous-send-design.md` §6 — org-wide pause for autonomous sending; defaults OFF
- **Clean approval:** `CONTEXT.md` — a Tier 2 message sent without edits and with no negative signal on the account
- **ADR-0004 (Tier 1 earned, never manual):** `docs/adr/0004-tier-1-is-earned-never-set-manually.md` — promotion is the only route to Tier 1; humans cannot grant it by hand
- **Azure architecture:** `docs/architecture/2026-08-02-azure-solution-architecture.md` — single region, Container Apps, Postgres Flexible Server, ~$100–160/month infrastructure cost
- **Current implementation status:** `README.md` — Plan 1 (Flow 1 end-to-end, Tier 2 only) is built; no escalation, no Tier 1, no scheduled jobs yet

---

**Document prepared by:** Product Management  
**Review requested from:** Engineering lead, BDR/operations lead, Erria leadership  
**Next step:** Align on milestone scope and kill-switch decision-making process; begin M1 build if approved.
