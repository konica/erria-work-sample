# UAT test-case suite — review deployment

Ticket #146, first of a four-ticket run (#146 writes the cases → #81 automates them → #82 runs the
automation against the live deployment → #83 packages the result for stakeholders). Owned jointly:
PM scopes and signs off, QA writes the cases (this document), DevOps confirms the test accounts and
review-env access below actually work.

- **Environment:** https://erria-outreach.duckdns.org/
- **Fixture data:** the four accounts seeded by #54 (`packages/db/src/seed/seed.ts`) — this suite
  does not add or invent seed data.
- **Accounts:** provisioned by #141's `deploy/scripts/create-uat-accounts.sh` from the list in
  [`uat-round-1-testers.txt`](uat-round-1-testers.txt) (usernames only — the script prints a fresh
  temporary password per account at run time; see that file's own note).
- **Domain vocabulary:** Account, Vessel, Contact, Trigger, Message, Escalation, Resolution, Tier,
  Needs Triage, Clean Approval, per `CONTEXT.md`. Test cases use these terms deliberately, not
  synonyms, so a reviewer checking a case against the glossary can tell at a glance whether the
  screen got the concept right.

## Known gaps — read before running this suite

These were found while writing the cases against the actual seeded data and the actual console
code (not assumed from the spec), and change what this UAT round can and cannot exercise. Call
these out to PM/DevOps rather than silently writing cases that will fail for reasons that have
nothing to do with the feature under test.

1. **Three of the four seed accounts have no path to their Account Detail screen in the console as
   built.** The Account Queue (`QueuePage`) only lists accounts with a Message in `pending_review`
   status (`queue.service.ts`) — only **Song Hong Shipping** qualifies. The sidebar's "Review" and
   "Escalations" nav items show live counts (from `GET /api/nav-counts`) but have no click handler
   (`Sidebar.tsx` passes no `onClick` for them; `screens.ts` notes "no path yet: there's no router
   in this ticket"), and there is no URL-based deep link or account search anywhere in
   `console-web`. So **Truong Phat Marine**, **Dai Duong Shipping**, and **Vina Offshore Supply**
   cannot currently be reached by a tester clicking through the deployed console. The Escalation,
   Resolution & outcome, and Needs Triage cases below are written to the intended behavior and are
   marked **BLOCKED** with this reason — they cannot pass a UAT round until a navigation path
   exists. Recommend filing that as a fast-follow before #82 tries to automate this suite against
   the live deployment, since automation hits the same wall a human tester does.
2. **Needs Triage does not render as its own state even where the panel is reachable.**
   `AccountDetailPage`'s Work tab only branches on "is there an active escalation" vs. "is there a
   pending message" — anything else (including Vina Offshore Supply's abstained,
   `needs_triage`-status trigger) falls into the generic "Nothing awaiting review on this account"
   empty state, and `AccountDetail`'s own API type has no field for trigger status at all. This is
   exactly the failure mode the domain glossary warns about under **Needs Triage** ("an easy one to
   get silently wrong" — the ticket's own words) — it is not merely unreachable (gap 1), it does not
   exist as a distinct screen state yet. TC-TRIAGE-1 documents the intended behavior and records
   this as a **product gap**, not a seed-data gap.
3. **Tier 1 (autonomous send) is scoped out of this round, correctly per the ticket, but for a
   more specific reason than "not implemented."** ADR-0002 (deferred) is superseded by
   [ADR-0006](../adr/0006-autonomous-send-designed-deferrals-lifted.md) — autonomous send **is**
   designed and built (`SettingsPage`'s kill switch, `SendAuditPage`, `TierBadge`'s "Tier 1 ·
   Autonomous" state all exist in the console). What is actually missing is seed data: none of the
   four accounts is at Tier 1, so no account has ever sent autonomously, and `SendAuditPage` reads
   this from `AuditSample` rows that only a real Tier 1 send produces. TC-AUDIT-1 below tests the
   real, current, correct behavior — the empty state — rather than "audit sample records are
   visible" as the acceptance criteria bullet names it verbatim. Getting an account to Tier 1
   requires 2 clean approvals plus the promotion path in #54's spec, which is out of scope for a
   seed-data ticket that already shipped; note it here rather than quietly redefining the AC.
4. **Several cases mutate the one seeded row they test and cannot be re-run without a reseed.**
   Song Hong Shipping has exactly one pending draft; approving, rejecting, or editing-then-approving
   it are mutually exclusive against a single UAT pass (TC-WORK-1/2/3). Likewise, resolving Truong
   Phat Marine's escalation (once gap 1 is fixed) removes it from the "active escalation" state
   the case needs. `pnpm --filter @erria/db run seed` is idempotent and will refuse to reseed while
   any of the four `externalRef`s already exist (`seed.ts`), so restoring a clean pass requires
   dropping and recreating the review database, not just re-running the seed command. Plan one full
   suite pass per reseed, and sequence the mutating cases last within a pass.

## Coverage matrix

| Seed account (#54) | Tier / state | Test cases | Reachable via console UI today? |
| --- | --- | --- | --- |
| Song Hong Shipping | Tier 2, pending draft | TC-QUEUE-1, TC-QUEUE-2, TC-INFO-1, TC-WORK-1, TC-WORK-2, TC-WORK-3, TC-HIST-1 | Yes |
| Truong Phat Marine | Tier 3, active escalation (pricing, Hard-Trigger Rule) | TC-ESC-1, TC-ESC-2 | **No — gap 1** |
| Dai Duong Shipping | Tier 3, resolved escalation (negative sentiment) | TC-RES-1 | **No — gap 1** |
| Vina Offshore Supply | Abstain / Needs Triage, no Message | TC-TRIAGE-1 | **No — gaps 1 and 2** |

No seed account is at Tier 1 — see gap 3. `SendAuditPage` and `SettingsPage` cases (TC-AUDIT-1,
TC-SET-1/2/3) don't map to a specific seed account; they exercise system-wide state instead.

## Login

### TC-LOGIN-1 — Reviewer can log in and reach the console
- **Preconditions:** a `reviewer`-role account from `uat-round-1-testers.txt`, first login (temp
  password not yet changed).
- **Steps:**
  1. Open https://erria-outreach.duckdns.org/ in a private/incognito window.
  2. Click **Log in**.
  3. On the Keycloak login page, enter the username and the temporary password handed out
     out-of-band.
  4. Set a new password when prompted. Enrol an authenticator app if prompted (the script's own
     output reports whether this realm requires it — see #141).
- **Expected result:** lands on the Account Queue screen. Sidebar shows Queue, Review, Escalations,
  Audit Trail, and (under "Admin") Send Audit — but **not** Settings.
- **Domain terms exercised:** none (auth precondition for everything below).
- **Status:** Ready.

### TC-LOGIN-2 — Admin sees the admin-only Settings nav item
- **Preconditions:** an `admin`-role account from `uat-round-1-testers.txt`.
- **Steps:** log in as above with the admin account.
- **Expected result:** same as TC-LOGIN-1, plus a **Settings** item at the bottom of the sidebar.
- **Domain terms exercised:** Setting Risk Level (visibility gate, not the levels themselves — see
  TC-SET-*).
- **Status:** Ready.

### TC-LOGIN-3 — Unauthenticated visitors are gated, not shown the console
- **Preconditions:** logged out, or a fresh private window.
- **Steps:** open https://erria-outreach.duckdns.org/ without logging in.
- **Expected result:** the landing/gate screen renders ("Erria Outreach Agent" wordmark, **Log in**
  button) — never the Account Queue or any account data.
- **Domain terms exercised:** none.
- **Status:** Ready.

## Queue (`QueuePage`)

### TC-QUEUE-1 — The pending-draft row is visible and actionable
- **Preconditions:** logged in as reviewer or admin.
- **Steps:**
  1. Land on the Account Queue (default screen after login).
  2. Locate the row for **Song Hong Shipping**.
- **Expected result:** the row shows company "Song Hong Shipping", vessel "MV Song Hong Pioneer",
  contact "Ms. Lan Pham", an ICP fit meter in the high band (score 82), a "Tier 2" badge, the tier
  rationale ("New account — Tier 2 minimum until 2 clean approvals (1 of 2)"), and the trigger
  summary text. Clicking the row opens Account Detail for Song Hong Shipping, landing on its
  actionable ("Draft review") tab.
- **Domain terms exercised:** Account, Vessel, Contact, Trigger, Tier, Message (the row represents
  one pending draft Message).
- **Status:** Ready.

### TC-QUEUE-2 — Accounts without a pending draft do not appear in the queue
- **Preconditions:** logged in; all four seed accounts exist.
- **Steps:** count the rows in the Account Queue.
- **Expected result:** exactly one row (Song Hong Shipping). Truong Phat Marine, Dai Duong Shipping,
  and Vina Offshore Supply are absent — correct given `QueuePage` only lists Messages in
  `pending_review` status, but worth confirming explicitly since it's also the visible symptom of
  gap 1 above. If a second row ever appears here without a corresponding seed change, that's a
  regression worth flagging on its own.
- **Domain terms exercised:** Message (`pending_review` status is what makes a row appear at all).
- **Status:** Ready.

## Account Detail — Account info tab (Ticket #117 — 77, Ticket #136)

### TC-INFO-1 — Trust block and ICP fit meter render for the queue's pending draft
- **Preconditions:** Song Hong Shipping open from TC-QUEUE-1.
- **Steps:** click the **Account info** tab.
- **Expected result:** a "Can I trust this trigger?" trust block shows confidence "Moderate" (the
  seeded `confidenceLabel: 'mid'`) and the verifiability note text about the illustrative 12-month
  service interval; an ICP fit row shows the meter in the high band and "82 / 100"; Segment
  "Offshore support vessel operator"; Hub "Haiphong"; vessel "MV Song Hong Pioneer · IMO 9482137 ·
  Vietnam"; contact "Ms. Lan Pham"; the relationship summary text; and a tier panel showing the
  Tier 2 badge with its rationale.
- **Domain terms exercised:** Dossier (this tab is the assembled dossier view), Trigger, Tier,
  Vessel, Contact.
- **Status:** Ready.

## Account Detail — Work tab (draft review, Tier 2)

These three are mutually exclusive against Song Hong Shipping's single seeded draft — see gap 4.
Run only one per UAT pass unless the review database is reseeded between them.

### TC-WORK-1 — Approve a draft as-is (golden path)
- **Preconditions:** Song Hong Shipping open, Work tab ("Draft review"), draft not yet edited.
- **Steps:** read the agent draft body, then click **Approve & send**.
- **Expected result:** the decision area shows "Approved · sending". Per the domain glossary, an
  unedited Tier 2 approval is a **Clean Approval** candidate — it should count toward this
  account's promotion progress (currently "1 of 2"); confirming the count actually advances
  requires revisiting the account's Tier history/rationale after the approval is processed, which
  is a reasonable follow-on check rather than part of this same case.
- **Domain terms exercised:** Message, Clean Approval.
- **Status:** Ready.

### TC-WORK-2 — An edited draft is flagged as not counting toward Clean Approval (edge case)
- **Preconditions:** Song Hong Shipping open, Work tab, draft not yet edited.
- **Steps:**
  1. Click **Edit**, change the draft body, click **Save changes**.
  2. Click **Approve & send**.
- **Expected result:** after saving, a policy tag reads "Edited by a human. This send will not
  count toward the account's clean-approval progress." Approving afterward still shows "Approved ·
  sending", but the Clean Approval count must not advance.
- **Domain terms exercised:** Message, Clean Approval (the negative case — this is the "interesting
  edge" the ticket asks for on this screen).
- **Status:** Ready.

### TC-WORK-3 — Reject a draft
- **Preconditions:** Song Hong Shipping open, Work tab, draft not yet edited or approved.
- **Steps:** click **Reject**.
- **Expected result:** the decision area shows "Rejected — returned to the agent, not sent". The
  message is not sent and does not count as a Clean Approval either way.
- **Domain terms exercised:** Message.
- **Status:** Ready.

## Account Detail — Tier history tab

### TC-HIST-1 — Tier history timeline renders Song Hong Shipping's clean-approval event
- **Preconditions:** Song Hong Shipping open.
- **Steps:** click the **Tier history** tab.
- **Expected result:** a timeline entry reads "Clean approval recorded" with the reason "First
  outreach approved without edits — clean approval 1 of 2", timestamped, not tagged **Manual**
  (it's system-driven, not a Manual Tier Override).
- **Domain terms exercised:** Tier, Clean Approval, Manual Tier Override (its absence, correctly,
  on a system-driven entry).
- **Status:** Ready.

## Escalation (`EscalationPanel`)

### TC-ESC-1 — Viewing an active Hard-Trigger escalation
- **Preconditions:** logged in; Truong Phat Marine's Account Detail, Work tab (labeled
  "Escalation" for a Tier 3 account).
- **Steps:** open the tab and read the panel.
- **Expected result:** an escalation banner reads "Hard trigger · pricing question" with the reason
  "Pricing question — human required"; a "Recommended next step" section shows the agent-suggested
  text about an indicative quote; a notice reads "Agent send is disabled for this thread — only you
  can act"; no "repeat escalation" prompt appears (this is the account's first escalation, so
  `priorResolutions` is empty).
- **Domain terms exercised:** Hard-Trigger Rule, Escalation, Tier (3, escalated).
- **Status:** **BLOCKED — gap 1.** No console navigation path reaches Truong Phat Marine (it has no
  `pending_review` Message, so it never appears in the Queue, and the sidebar's Escalations nav
  item has no click handler).

### TC-ESC-2 — Resolving an escalation requires an outcome
- **Preconditions:** same as TC-ESC-1.
- **Steps:** click **Mark resolved** without selecting an outcome.
- **Expected result:** an inline error reads "Choose an outcome before closing this escalation." —
  the escalation is not resolved.
- **Domain terms exercised:** Escalation, Resolution (outcome is a required field on it).
- **Status:** **BLOCKED — gap 1** (same reason as TC-ESC-1).

## Resolution & outcome (`ResolutionSection`)

### TC-RES-1 — A resolved escalation renders its outcome
- **Preconditions:** logged in; Dai Duong Shipping's Account Detail, "Resolution & outcome" tab.
- **Steps:** open the tab.
- **Expected result:** one resolution row: human action "Escalated to AE — billing dispute
  handoff", follow-up sent "No", outcome badge "No response", and a time-to-resolution value.
  Tier remains 3 afterward (resolving an escalation never restores tier automatically — the
  Escalation invariant in `CONTEXT.md`).
- **Domain terms exercised:** Escalation, Resolution, Tier (its rationale text still cites the
  escalation even though the escalation itself is resolved).
- **Status:** **BLOCKED — gap 1.** No console navigation path reaches Dai Duong Shipping.

## Needs Triage

### TC-TRIAGE-1 — The abstain path renders distinctly from an Escalation
- **Preconditions:** logged in; Vina Offshore Supply's Account Detail, Work tab.
- **Steps:** open the account and read the Work tab.
- **Expected result (intended):** the tab should indicate this account has a trigger that the
  drafting call abstained on (`needs_triage`) — visibly distinct from both an Escalation banner and
  from "nothing going on here at all", per the domain glossary's explicit warning that Needs Triage
  is easy to get silently wrong.
- **Actual result (as built):** falls into the same generic "Nothing awaiting review on this
  account" empty state as any account with no escalation and no pending message — indistinguishable
  from an account that simply has no trigger. `AccountDetail`'s API response has no field carrying
  trigger status at all.
- **Domain terms exercised:** Needs Triage, Abstain, Escalation (the contrast this case is checking
  for).
- **Status:** **FAILS AS BUILT — gaps 1 and 2.** Even once navigation reaches this account (gap 1),
  the screen does not yet distinguish Needs Triage from "nothing pending" (gap 2). Recommend filing
  a product bug rather than treating this as a documentation gap — it is exactly the scope bullet
  the ticket names as high-risk.

## Send Audit (`SendAuditPage`)

### TC-AUDIT-1 — Empty state, correctly, since no account has reached Tier 1
- **Preconditions:** logged in as reviewer or admin.
- **Steps:** open **Send Audit** from the sidebar.
- **Expected result:** the empty state reads "No sampled sends yet. Sampling starts once Tier 1
  accounts send autonomously — until then this queue stays empty by design, not broken." No stats
  row, no filter chips, no table.
- **Domain terms exercised:** Audit Sample, Tier (1, specifically its absence in the current seed
  set).
- **Status:** Ready, but see gap 3 — this tests the empty state, not "audit sample records are
  visible" as the acceptance criteria phrase it. Getting real rows here requires an account to
  reach Tier 1 first, which no current seed data does.

## Settings (`SettingsPage`) — one case per Setting Risk Level

### TC-SET-1 — Freely Adjustable: Basic settings save immediately
- **Preconditions:** logged in as admin; Settings open.
- **Steps:** in the **Basic** section, change "Clean approvals required before Tier 1", click
  **Save**.
- **Expected result:** the hint "Saves immediately — no confirmation" is shown next to the button,
  and no confirmation step appears — the change applies on click.
- **Domain terms exercised:** Setting Risk Level (Freely Adjustable).
- **Status:** Ready.

### TC-SET-2 — Confirm-Required: Advanced settings show a two-step confirmation
- **Preconditions:** logged in as admin; Settings open, "Advanced" section expanded.
- **Steps:**
  1. Change "Max follow-ups per account" (or another Advanced field).
  2. Click **Save (requires confirm)**.
  3. Observe the confirmation panel; click **Confirm & apply**.
- **Expected result:** step 2 does not save the change — it opens a confirm panel listing the
  field-level diff (`field: from → to`) and a notice. Only clicking **Confirm & apply** in step 3
  applies it. Clicking **Cancel — nothing saved** instead leaves the setting unchanged.
- **Domain terms exercised:** Setting Risk Level (Confirm-Required).
- **Status:** Ready.

### TC-SET-3 — Locked: hard-trigger rules and the rollout overlay are read-only reference
- **Preconditions:** logged in as admin; Settings open.
- **Steps:** scroll to the **Locked** section.
- **Expected result:** each of the five Hard-Trigger Rules and the "New-account Tier 2 rollout
  overlay" row are listed with a "Locked — policy decision" note, and there is no input, button, or
  other affordance to change them from the UI.
- **Domain terms exercised:** Setting Risk Level (Locked), Hard-Trigger Rule, Rollout Overlay.
- **Status:** Ready.

## Explicitly out of scope for this round

- **Tier 1 / autonomous send end-to-end** — see gap 3. The Settings kill switch (pause/resume) is
  in scope and covered implicitly by TC-SET-1 touching the same page, but a dedicated pause/resume
  case and an actual autonomous send are not written here; they need a Tier 1 account to exist
  first, and getting one there is a seeding change, not a test-writing one.
- **Manual Tier Override** (`ChangeTierPanel`) — not named in the ticket's scope list; left out
  rather than added speculatively.

## Sign-off

PM sign-off confirming this scope matches what stakeholders expect to review should be recorded as
a comment on issue #146 — not in this file — per the ticket's acceptance criteria.
