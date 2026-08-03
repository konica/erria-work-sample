# Application Architecture — Erria Outreach Agent

Status: Draft — pending user review
Last updated: 2026-08-02
Grounding: [`docs/superpowers/specs/2026-08-01-outreach-agent-design.md`](../superpowers/specs/2026-08-01-outreach-agent-design.md)
(behavior spec), [`docs/architecture/2026-08-02-azure-solution-architecture.md`](2026-08-02-azure-solution-architecture.md)
(cloud/infra — starting assumption, refined below), [`ideation/open-design-brief-landing-login.md`](../../ideation/open-design-brief-landing-login.md)
(auth), [`brainstorm/mockup/Erria-outreach-agent-v06/outreach-console.html`](../../brainstorm/mockup/Erria-outreach-agent-v06/outreach-console.html)
(UI/data shape of record)

## 0. Scope and how to read this document

This is the **application-architecture layer**: the internal module boundaries, the data model,
the API contracts between the console frontend and its backend, and the Claude API integration —
for the single deployable system the Azure doc already scoped as "console + worker + scheduled
jobs" on one PostgreSQL database. It assumes that infra decision as a starting point and refines
it where the application's actual behavior (documented in the behavior spec and shown in the
mockup) demands more precision than "a worker calls Claude and writes to the database."

**Explicitly not designed here** (see §12 for the full list, matching the behavior spec's own
non-goals in its §12):

- The upstream trigger-detection / ICP-scoring ML pipeline. This design treats a `Trigger` record
  and an `Account.icp_score` as inputs that arrive from that pipeline, not as something this system
  computes.
- Cloud/infra topology, Azure service selection, networking, DR, or cost — that is the companion
  Azure doc's job, and is treated here as a decided constraint (one Postgres database, a console
  app, an orchestration worker, scheduled Container Apps Jobs).
- Auth/session mechanics — Keycloak/OIDC is decided; this doc only notes where the console API
  reads the authenticated principal (e.g. `decided_by` on an approval) and does not design login.
- RBAC / access control, and the settings change log that depends on it — the behavior spec (§11,
  §12) explicitly defers both together for a two-person team.
- The actual outbound message channel (SMTP/Graph/etc.) implementation — treated as a thin,
  swappable adapter behind one interface (§2, Message Dispatch module), because the behavior spec
  doesn't specify Erria's mail infrastructure and it isn't this design's job to invent it.

## 1. Modular monolith, not services — why, concretely

The Azure doc already ruled out microservices for infra reasons (one team, no ops bandwidth). At
the application layer the same conclusion follows independently from the domain itself: every
module below shares one transaction boundary (an approval simultaneously touches a `Message`, an
`Account`'s tier counters, and a `TierHistoryEvent` — splitting that across service boundaries
would trade a single Postgres transaction for a distributed-consistency problem this team doesn't
need to solve). So this is **one codebase, two runtime processes, sharing an internal domain
library**:

- **Console API process** — synchronous, human-driven request/response. Thin: reads state, writes
  human decisions, delegates anything that calls Claude or sends mail to the worker.
- **Orchestration Worker process** — same container image, two invocation modes: (a) a small
  internal HTTP server for on-demand work triggered by the Console API (approve → send, inbound
  reply → classify), and (b) the same image invoked with a different entrypoint argument by Azure
  Container Apps **scheduled Jobs** for three time-driven behaviors: follow-up cadence checks
  (§5), audit-sample queue maintenance (§10), and a **stuck-send reconciliation sweep** (§5 Flow 2)
  — this is exactly the Azure doc's §2 "Orchestration worker (Container App, scale-to-zero) +
  scheduled Jobs" sketch, made concrete.

Both processes import the same **domain modules** as an internal library — this is where "clear
internal module boundaries" actually lives, not in network topology:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Domain modules (library)                     │
│                                                                       │
│  ┌──────────────────┐  ┌───────────────────┐  ┌──────────────────┐ │
│  │ Tiering &         │  │ Message Drafting   │  │ Escalation &      │ │
│  │ Escalation module │◄─┤ module (Claude:    │  │ Resolution module │ │
│  │ (§3–4, §7)        │  │ drafting calls)     │  │ (§9)             │ │
│  └────────┬──────────┘  └─────────┬──────────┘  └────────┬─────────┘ │
│           │                       │                       │          │
│  ┌────────▼──────────┐  ┌─────────▼──────────┐  ┌─────────▼────────┐ │
│  │ Audit-Sampling     │  │ Message Dispatch    │  │ Settings module  │ │
│  │ module (§8, §10)   │  │ module (channel      │  │ (§11)            │ │
│  │                    │  │ adapter, thin)       │  │                  │ │
│  └────────────────────┘  └─────────────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
        ▲                                                    ▲
        │ imports                                            │ imports
┌───────┴────────┐                                  ┌─────────┴──────────┐
│ Console API     │  serves the SPA + REST API       │ Orchestration       │
│ process         │  (human actions, reads)           │ Worker process      │
│ (sync, thin)    │                                    │ (Claude calls,      │
└─────────────────┘                                    │ scheduled jobs)     │
                                                        └─────────────────────┘
```

### Module responsibilities and dependencies

| Module | Responsibility | Depends on | Why the dependency exists |
|---|---|---|---|
| **Tiering & Escalation** | Computes tier recommendations (base score × rollout overlay, §3), evaluates the 5 hard-trigger rules (§4) against inbound replies, applies promotion/demotion, writes `TierHistoryEvent`. | Message Drafting module (to invoke hard-trigger *classification*, which is a Claude call) | Classifying "does this reply ask about pricing" is a natural-language judgment call, not a keyword match — it needs an LLM call, but the *rule* (pricing → escalate) is this module's business logic, not the drafting module's. |
| **Message Drafting** | Owns every Claude API call: drafting outbound copy (tone rules §5) and classifying inbound replies against hard-trigger categories (§4). Persists the request/response pair for audit. Implements the resilience pattern (§7 below). | Nothing else in the domain layer (leaf module) — this is the only place `@anthropic-ai/sdk` is imported | Keeping every Claude call in one module means one place to change model version, one place to enforce the timeout/retry contract, one place to log for cost tracking (ties to Azure doc §8's Claude-call dependency tracking). |
| **Escalation & Resolution Lifecycle** | Creates `Escalation` records when a hard trigger fires, disables agent-send on that thread, records `Resolution` on close (§9), manages the human-set repeat-escalation link. | Tiering & Escalation (an escalation is a hard-trigger outcome) | An escalation is *caused by* the tiering module's rule evaluation; this module owns what happens *after* that fact, keeping "did a rule fire" separate from "what does closing it look like." |
| **Audit-Sampling** | Rolls the dice at Tier-1 send time per the configured sample rate (§10), creates `AuditSample` rows, records human fine/concerning verdicts. | Settings module (reads `tier1_audit_sample_rate`) | The rate is admin-configurable; sampling logic shouldn't hardcode it. |
| **Message Dispatch** | Thin channel adapter — takes an approved or human-authored message body and actually sends it (placeholder: SMTP/Graph). No business logic. | Nothing | Deliberately isolated so channel changes (e.g. Erria switches mail providers) never touch tiering, drafting, or escalation logic. |
| **Settings** | Owns the three-tier settings model (§11): basic (save-immediately), advanced (two-step confirm), locked (read-only reference). Single source of truth other modules read from. | Nothing (leaf module) | Every other module reads settings, none should own them — otherwise "what's the current sample rate" has more than one answer. |
| **Console API process** | HTTP surface for the SPA: read endpoints (queue, detail, history, settings) and human-action endpoints (approve, reject, edit, resolve, mark-fine/concerning, settings save). Never calls Claude directly. | All domain modules (as a consumer, read-mostly) + enqueues work on the Worker for anything requiring a Claude call or a send | Keeping Console API "thin" (no LLM calls, no long-running work) is what keeps human-facing requests fast and keeps Claude resilience logic in exactly one place (the Drafting module, invoked only from the Worker). |
| **Orchestration Worker process** | Invokes Message Drafting (new triggers, inbound classification) and Message Dispatch (actual sends); runs the two scheduled jobs. | All domain modules (as the actual executor) | This is where "calling Claude and writing to the database" lives, per the Azure doc's §2 role for the worker — now specified down to which domain modules it calls and in what order (see §5 flows below). |

## 2. Data model

Grounded directly in the mockup's `DETAIL`, `ESCALATIONS`, `AUDIT`, `RESOLUTIONS`, and `state`
objects, and in the behavior spec's §3 tiering fields, §9 Resolution record, §10 audit sample,
and §11 settings.

### Entities

**Account** — the account row shown in Queue/Escalations/Audit and the header of Account Detail.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `company_name` | text | |
| `segment` | text | e.g. "Offshore support vessel operator" |
| `hub` | text | e.g. "Haiphong" — shown as `segment · hub` in the dossier |
| `icp_score` | int 0–100 | from upstream ICP pipeline (non-goal to compute) |
| `icp_band` | enum(`high`,`med`,`low`) | derived from score, cached for the ICP-meter UI |
| `relationship_summary` | text | free text shown in dossier ("New account · first contact 12 Jul 2026 · 1 prior message") |
| `current_tier` | int(1,2,3) | the single source of truth the queue sorts/filters on |
| `tier_rationale` | text | the "why" line under the tier badge — regenerated on every tier change |
| `clean_approvals_count` | int, default 0 | spec §3's promotion counter — incremented only on send-without-edit with no negative signal since |
| `created_at`, `updated_at`, `last_activity_at` | timestamptz | |

**Vessel** (1 Account → N Vessel)

| Field | Type |
|---|---|
| `id` | uuid PK |
| `account_id` | FK → Account |
| `name` | text (e.g. "MV Song Hong Pioneer") |
| `imo` | text |
| `flag` | text |

**Contact** (1 Account → N Contact) — the buyer shown as "Ms. Lan Pham, Technical Superintendent."

| Field | Type |
|---|---|
| `id` | uuid PK |
| `account_id` | FK → Account |
| `name` | text |
| `role` | text |
| `email` | text, nullable |

**Trigger** — the assumed upstream input (spec §2), persisted once received.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | FK → Account | |
| `vessel_id` | FK → Vessel, nullable | |
| `category` | text | e.g. "life-raft service window", "EPIRB battery expiry" |
| `description` | text | shown as the queue row's trigger line |
| `source` | enum(`crm`,`class_records`,`public_data`,`buyer_reply`) | drives the dossier's "confidence" / "verifiability" copy |
| `confidence_label` | enum(`high`,`mid`,`low`) | |
| `verifiability_note` | text | e.g. "Partly verifiable — service interval is illustrative" |
| `detected_at` | timestamptz | |
| `status` | enum(`new`,`processing`,`drafted`,`superseded`,`needs_triage`) | `needs_triage` = Claude drafting failed/abstained, spec §7 |

**Message** — one unified thread entity covering agent drafts, sent messages, inbound buyer
replies, and system notes. This is the mockup's `thread` array and `DETAIL[id].draft` merged into
one persisted model, because a "draft" is just a `Message` in `pending_review` status.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | FK → Account | |
| `trigger_id` | FK → Trigger, nullable | the trigger this outbound message responds to |
| `escalation_id` | FK → Escalation, nullable | set for inbound messages / handoff notes tied to an escalation |
| `role` | enum(`agent_draft`,`agent_sent`,`buyer_inbound`,`system_note`,`human_reply`) | |
| `body` | text | current body (edited value if edited) |
| `original_body` | text, nullable | pre-edit body, kept for the audit trail and to invalidate clean-approval credit |
| `edited` | bool, default false | drives spec §3's "no edits" clean-approval condition |
| `status` | enum(`pending_review`,`approved`,`rejected`,`sent`,`needs_triage`) | |
| `tier_context` | int(1,2,3) | tier the account was at when this was generated — not necessarily `current_tier` today |
| `confidence_meta` | jsonb | `{model, prompt_version, abstain, confidence_label, latency_ms}` — from the Drafting module |
| `hard_rule_flags` | jsonb array | e.g. `["compliance_deadline_content"]` — which §4 rule(s) capped this message's tier |
| `decided_by`, `decided_at` | text / timestamptz, nullable | human who approved/rejected |
| `sent_at` | timestamptz, nullable | |
| `channel` | enum(`email`) | placeholder for future channels |
| `is_followup`, `followup_sequence_number` | bool / int, nullable | spec §5's max-2-followups cadence |
| `created_at` | timestamptz | |

**Escalation** — spec §4/§9; the mockup's `ESCALATIONS[id]` object, persisted.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | FK → Account | |
| `trigger_message_id` | FK → Message, nullable | the inbound reply that fired the hard trigger |
| `hard_trigger_rule` | enum — see below | |
| `reason_summary` | text | the escalation banner's headline |
| `detail` | text | the banner's body copy |
| `recommended_next_step` | text | agent-suggested handoff text (spec §6's "Internal handoff to human AE") |
| `recommended_next_step_edited` | text, nullable | human edit, if any |
| `agent_send_disabled` | bool, default true | spec §9: "once a thread has escalated, agent-send is permanently disabled for it" |
| `status` | enum(`active`,`resolved`) | |
| `repeat_of_resolution_id` | FK → Resolution, nullable | **human-set only**, never auto-detected (spec §9) |
| `created_at`, `resolved_at` | timestamptz | |

`hard_trigger_rule` enum: `pricing_question`, `technical_compliance_question`,
`negative_sentiment`, `relationship_conflict`, `compliance_deadline_content`,
`non_english_language` (spec §7's language-escalation case), `conflicting_signals` (spec §7's
CRM-conflict case), `classification_uncertain` (this design's resilience fallback — see §4 below).

**Resolution** — spec §9's Resolution record; 1:1 with the `Escalation` it closes.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `escalation_id` | FK → Escalation, unique | 1:1 |
| `account_id` | FK → Account | denormalized for the "resolutions for this account" query used by repeat-escalation linking |
| `action_type` | enum(`mark_resolved`,`compose_send`) | |
| `action_taken` | text | free text, e.g. "Sent quote — life-raft servicing + exchange option" |
| `followup_message_id` | FK → Message, nullable | if a reply was sent as part of closing |
| `followup_sent_at` | timestamptz, nullable | |
| `outcome_tag` | enum(`closed_won`,`re_engaged`,`no_response`,`churned`,`closed_no_action`) | fixed enum per spec §9 |
| `time_to_resolution` | interval | derived: `resolved_at − escalation.created_at` |
| `resolved_by` | text | |
| `created_at` | timestamptz | |

**TierHistoryEvent** — the Audit Trail / Tier History tab's timeline.

| Field | Type |
|---|---|
| `id` | uuid PK |
| `account_id` | FK → Account |
| `event_type` | enum(`create`,`clean_approval`,`promote`,`demote`,`escalate`,`hold_at_tier`,`current_draft`,`manual_override`) |
| `from_tier`, `to_tier` | int, nullable |
| `occurred_at` | timestamptz |
| `reason` | text |
| `related_message_id` | FK → Message, nullable |
| `related_escalation_id` | FK → Escalation, nullable |

**AuditSample** — spec §10.

| Field | Type |
|---|---|
| `id` | uuid PK |
| `message_id` | FK → Message, unique | the sent Tier-1 message |
| `account_id` | FK → Account |
| `sampled_at` | timestamptz |
| `review_status` | enum(`unreviewed`,`fine`,`concerning`) |
| `reviewed_by`, `reviewed_at` | text / timestamptz, nullable |
| `notes` | text, nullable |

**Setting** — spec §11's basic/advanced fields. A single-row table (no per-user or per-business-unit
scoping — one business unit, no RBAC per the spec's explicit v1 scope).

| Field | Type | Default |
|---|---|---|
| `id` | int PK, always `1` | |
| `tier1_promotion_threshold` | int 1–4 | 2 |
| `tier1_audit_sample_rate` | int percent | 10 |
| `max_followups` | int 1–5 | 2 |
| `min_days_between_followups` | int 3–14 | 5 |
| `sentiment_confidence_floor` | enum(`Low`,`Medium`,`High`) | `Medium` |
| `updated_at` | timestamptz | |

The five locked hard-trigger rules (spec §11) and the rollout-overlay toggle are **not** rows in
this table — they are constants in the Tiering & Escalation module's code, shown to the Settings
screen as read-only reference data. Making them DB rows would imply they're editable, which
contradicts the spec's explicit "engineer-only" classification.

**LlmCall** — not shown in the mockup UI, but necessary for the Claude-integration requirement
(§4) to be auditable rather than a black box. One row per Claude API call.

| Field | Type |
|---|---|
| `id` | uuid PK |
| `purpose` | enum(`draft_generation`,`hard_trigger_classification`) |
| `account_id` | FK → Account, nullable |
| `message_id` | FK → Message, nullable |
| `model_id` | text (e.g. `claude-sonnet-5`) |
| `prompt_version` | text |
| `request_tokens`, `response_tokens` | int |
| `latency_ms` | int |
| `outcome` | enum(`success`,`timeout`,`error`,`retried_success`) |
| `error_detail` | text, nullable |
| `created_at` | timestamptz |

### Relationships at a glance

```
Account 1──N Vessel
Account 1──N Contact
Account 1──N Trigger ──1──N Message
Account 1──N Message
Account 1──N Escalation ──1──1 Resolution
Resolution 1──N Escalation   (via repeat_of_resolution_id — a resolution can be
                               the "prior case" for more than one later escalation)
Account 1──N TierHistoryEvent
Message 1──0/1 AuditSample
```

This is straightforwardly relational, which is exactly what the Azure doc's §3 already argued for
Postgres — the repeat-escalation link (`Escalation.repeat_of_resolution_id → Resolution.id`) is the
one relationship that needs real referential integrity, and it's a plain foreign key.

## 3. API contracts (console frontend ↔ Console API)

Not a full OpenAPI spec, but concrete request/response shapes for the actions the mockup actually
exercises (`decide`, `saveEdit`, `markResolved`, `sendReply`, `commitLink`, `markSend`,
`saveBasic`/`confirmAdvanced`).

**`GET /api/queue?tier=&page=`** → paginated `AccountQueueRow[]`, matching the mockup's flat
sorted/paginated list (`queueSorted`, `PER_PAGE = 20`):
```json
{ "items": [{ "accountId", "company", "vessel", "contact", "triggerSummary",
              "icpBand", "tier", "tierWhy", "lastActionAt" }],
  "total": 48, "page": 1, "pageSize": 20 }
```

**`GET /api/accounts/:id`** → the Account Detail payload (dossier + current message/escalation +
tier panel), i.e. everything `renderDossier` + `outreachSection` need in one call.

**`PATCH /api/accounts/:id/messages/:messageId`** — edit a pending draft.
```json
// request
{ "body": "Hi Ms. Pham, ..." }
// response
{ "message": { "id", "body", "edited": true, "originalBody": "..." } }
```

**`POST /api/accounts/:id/messages/:messageId/approve`** — the mockup's `decide(id,'approved')`.
```json
// request: {}  (decidedBy comes from the OIDC session, not the body)
// response
{ "message": { "id", "status": "approved", "decidedBy": "Minh Tran", "decidedAt": "..." } }
```
Returns immediately after marking the decision; the actual send is dispatched to the worker
asynchronously (see flow 2 in §5) so the human-facing request stays fast.

**`POST /api/accounts/:id/messages/:messageId/reject`**
```json
{ "reason": null }  →  { "message": { "id", "status": "rejected" } }
```

**`POST /api/accounts/:id/escalations/:escId/resolve`** — covers both mockup actions
(`markResolved` and `sendReply`) under one endpoint, discriminated by `actionType`:
```json
// mark resolved (no reply sent)
{ "actionType": "mark_resolved",
  "actionTaken": "Marked resolved — no action needed",
  "outcomeTag": "closed_no_action" }

// compose & send
{ "actionType": "compose_send",
  "actionTaken": "Sent reply to buyer",
  "followupBody": "Thanks for flagging — here's an indicative quote...",
  "outcomeTag": "re_engaged" }

// response (either case)
{ "resolution": { "id", "actionType", "outcomeTag", "timeToResolution": "2d 4h" },
  "escalation": { "id", "status": "resolved" } }
```

**`POST /api/accounts/:id/escalations/:escId/link`** / **`DELETE .../link`** — the mockup's
`commitLink` / `unlinkEscalation`.
```json
{ "resolutionId": "res_abc123" }  →  { "escalation": { "repeatOfResolutionId": "res_abc123" } }
```

**`PATCH /api/accounts/:id/tier`** — manual tier override, resolved per spec §9: resolving an
escalation never auto-restores tier, so this is the explicit, separate action a human takes if an
account should move after handling one. Requires a reason; always writes a `TierHistoryEvent`.
```json
// request
{ "tier": 2, "reason": "Pricing question resolved, no other open issues on this account" }
// response
{ "account": { "id", "currentTier": 2 },
  "tierHistoryEvent": { "id", "eventType": "manual_override", "fromTier": 3, "toTier": 2,
                          "reason": "...", "occurredAt": "..." } }
```

**`GET /api/audit-samples?status=&page=`** and **`POST /api/audit-samples/:id/mark`** — the
mockup's Send Audit screen and `markSend`.
```json
{ "verdict": "concerning" }  →  { "auditSample": { "id", "reviewStatus": "concerning" } }
```

**`GET /api/settings`** / **`PUT /api/settings/basic`** (saves immediately) /
**`PUT /api/settings/advanced`** (returns `{ requiresConfirmation: true, diff: [...] }` per the
mockup's `confirmB` two-step flow) / **`POST /api/settings/advanced/confirm`** (applies).

**`GET /api/accounts/:id/tier-history`** → `TierHistoryEvent[]` for the Tier History tab.

## 4. Claude API integration — first-class architectural concern

This system makes exactly **two kinds** of Claude calls, both owned by the Message Drafting
module, both invoked only from the Orchestration Worker (never from the human-facing Console API
request path).

### 4.1 Model choice

**`claude-sonnet-5`** for both call types. Reasoning: this is a two-person team's first AI
initiative at "dozens to a few hundred accounts, a handful of messages per account per week" (per
the Azure doc's own cost calibration) — a few hundred Claude calls a day at most. Claude Sonnet 5
gives near-Opus quality on structured drafting and classification tasks at roughly a fifth of
Opus-tier pricing, which matters because the Azure doc already flags Claude API cost as plausibly
comparable to or larger than the Azure infra bill at this volume. Using one model for both call
types (rather than a cheaper model for classification) keeps operational surface area small for a
two-person team — one model version to track migrations for, one place to re-tune prompts when
Anthropic ships a new release. If volume grows and classification cost becomes a real line item,
the natural follow-up (not built now) is moving the classification call to `claude-haiku-4-5`,
since it's a narrower, more mechanical task than drafting.

### 4.2 Call 1 — Message Drafting

Given `Account` + `Trigger` + dossier fields + the tone rules from spec §5 as a system prompt,
produce a candidate outbound message plus a structured self-report of confidence.

**Structured output approach: `output_config.format` (JSON schema), not tool-choice forcing and
not prefill.** Prefill is a non-option regardless of preference — assistant-turn prefills return a
400 on every current-generation model (Claude Sonnet 5 included). Forced tool use
(`tool_choice: {"type": "tool", "name": "..."}`) would also work, but `output_config.format` is the
more direct fit here: this is a single structured-extraction call with no multi-step tool loop, and
`client.messages.parse()` (Python/TypeScript) validates the response against the schema
automatically rather than requiring the app to unpack a synthetic tool-call arguments object. The
requested schema:

```json
{
  "type": "object",
  "properties": {
    "should_draft": { "type": "boolean" },
    "draft_text": { "type": "string" },
    "confidence_label": { "type": "string", "enum": ["high", "mid", "low"] },
    "abstain_reason": { "type": ["string", "null"] }
  },
  "required": ["should_draft", "draft_text", "confidence_label", "abstain_reason"],
  "additionalProperties": false
}
```

`should_draft: false` (with `draft_text` empty and `abstain_reason` populated) is how the model
implements spec §7's "dossier confidence too low to draft anything credible → agent does not
draft; flags the account for human triage" — the module reads this field and, when false, sets
`Trigger.status = 'needs_triage'` and `Message.status = 'needs_triage'` instead of creating a
pending-review draft. This is a model-reported abstention, which is why the resilience section
below (§4.4) treats *API failure* as a separate, symmetrical fallback to the same triage state.

### 4.3 Call 2 — Hard-trigger classification

Given an inbound buyer reply, classify it against the five hard-trigger categories in spec §4 plus
language detection (spec §7). Same `output_config.format` approach:

**Trust boundary, stated explicitly:** the inbound reply body is buyer-controlled text — an
external party can write anything in it, including content trying to manipulate the classifier
(e.g. text engineered to look like a system instruction). It is always placed in the **user turn**
of the request, never concatenated into or merged with the cached system prompt (§4.5), which
holds only Erria's own tone/trigger-definition text. This isn't a new restriction so much as making
explicit what the cached-prefix design in §4.5 already implies: the system prompt is fixed content
this system authored, the user turn is untrusted input, and the two must never mix.

```json
{
  "type": "object",
  "properties": {
    "fires": { "type": "boolean" },
    "rule": { "type": ["string", "null"],
      "enum": ["pricing_question", "technical_compliance_question", "negative_sentiment",
               "relationship_conflict", "non_english_language", null] },
    "confidence": { "type": "string", "enum": ["high", "mid", "low"] },
    "language_detected": { "type": "string" }
  },
  "required": ["fires", "rule", "confidence", "language_detected"],
  "additionalProperties": false
}
```

The `sentiment_confidence_floor` setting (spec §11) is applied in the Tiering & Escalation module
*after* this call returns — the classifier reports its own confidence; the module compares it
against the admin-configured floor to decide whether `negative_sentiment` actually fires. This
keeps the tunable threshold out of the prompt (which would require a new Claude call per settings
change to verify) and in ordinary application code.

### 4.4 Resilience — the explicit requirement

Both call types share one wrapper in the Drafting module, implementing exactly the pattern spec
§7 already establishes for low dossier confidence, extended to API failure:

1. **Per-request timeout of ~20 seconds** (`client.messages.create(..., { timeout: 20_000 })` in
   the TypeScript SDK — note the SDK's timeout unit is milliseconds, not seconds). This is well
   short of the SDK's 10-minute default, appropriate for a short (≤150-word) structured output on a
   low-volume path where a human is often waiting on a queue to populate.
2. **At most one retry**, and only for transient failures — network errors and 5xx/`overloaded`.
   Explicitly override the SDK's default `max_retries: 2` down to `max_retries: 1` (or handle the
   single retry manually) so a stuck request cannot silently consume the full
   `timeout × (max_retries + 1)` wall-clock budget the SDK otherwise allows.
3. **Never retry on 401/403/429** — those mean a bad key, a permission problem, or a quota/rate
   limit, none of which a second identical request fixes. These raise an alert (ties directly to
   the Azure doc's §8 monitoring line: "distinguishing rate-limit/auth errors from transient
   network errors is useful here, since the former needs a human to fix a key or quota, not a
   retry").
4. **On any failure that survives the single retry** — timeout, repeated 5xx, or a model
   `refusal` stop reason — degrade to the **same triage state spec §7 defines for low confidence**:
   the account is not drafted, `Trigger.status = 'needs_triage'`, and a `TierHistoryEvent` records
   why. This is a deliberate design choice: the system has exactly one "I don't know what to do,
   ask a human" state, used identically whether the reason is "the model wasn't confident" or "the
   API call failed" — a two-person team debugging an incident doesn't need two different recovery
   paths to remember.
5. **For hard-trigger classification specifically**, fail-*closed* applies to two distinct cases,
   not just outright API failure: (a) the call itself fails/times out, or (b) the call succeeds but
   returns `confidence: "low"` — either way, the module does not trust `fires: false` at face value.
   Both create an `Escalation` with `hard_trigger_rule = 'classification_uncertain'` and route to a
   human, rather than letting an unclassified or low-confidence reply through as if no hard trigger
   fired. This mirrors spec §7's existing "conflicting signals → treat as an escalation trigger,
   never resolve the conflict silently" principle — a reply the system couldn't confidently
   classify is exactly that kind of conflict, whether the uncertainty came from a failed call or a
   low-confidence one.
6. Every call — success, timeout, or error — writes one `LlmCall` row, feeding both debugging and
   the cost-tracking dashboard the Azure doc's §8 flags as a needed app feature.

### 4.5 Prompt caching

The system prompt for drafting (tone/structure rules, spec §5, plus the account/dossier framing
instructions) and for classification (the five hard-trigger rule definitions, spec §4) are long,
stable text that doesn't change per call — a textbook prompt-caching candidate. Both go in the
`system` block with `cache_control: {"type": "ephemeral", "ttl": "1h"}` (the 1-hour TTL, not the
5-minute default) rather than TTL-tuning for maximum hit rate: at "a handful of messages per
account per week," the gap between calls during business hours can easily exceed 5 minutes even
though there are dozens of calls a day, and the 1-hour TTL keeps the cache warm across those gaps
without needing a scheduled pre-warm job. Claude Sonnet 5's cacheable-prefix minimum is 1024
tokens, comfortably below the size of a tone-rules-plus-hard-trigger-definitions system prompt.
Volatile content (the specific account's dossier, trigger, and — for classification — the inbound
reply text) goes in the `messages` array after the cached system block, never interpolated into
the system prompt itself, so a per-account detail never invalidates the shared cache prefix.

## 5. Key flows

### Flow 1 — a trigger arrives and becomes a Tier 2 draft awaiting approval

1. The upstream trigger-detection pipeline (external, non-goal) calls `POST /internal/triggers`
   with the account/vessel reference, trigger category, description, source, and confidence label.
2. Console API validates the payload, upserts `Account`/`Vessel` if new, and persists a `Trigger`
   row with `status = 'new'`.
3. Console API calls the Worker's `POST /internal/process-trigger/:triggerId` (a synchronous
   internal call — the worker wakes from scale-to-zero on this call, per the Azure doc's §2 model).
4. **Tiering & Escalation module** computes the recommendation: for a brand-new account this is
   always Tier 2 minimum regardless of score (spec §3's rollout overlay); if the trigger content
   cites a specific vessel's compliance deadline, the Tier-2 cap (spec §4 rule 5) applies
   independently, producing the same outcome via a different rule (as in the spec's own §6 worked
   example). It writes `Account.current_tier = 2`, `tier_rationale`, and a `TierHistoryEvent`.
5. **Message Drafting module** builds the prompt (cached system prompt + this trigger's specific
   details) and calls Claude per §4.2.
6. On `should_draft: true`: persists a `Message` (`role = 'agent_draft'`, `status = 'pending_review'`,
   `tier_context = 2`, `hard_rule_flags` set if a §4 rule capped it, `confidence_meta` populated).
   `Trigger.status = 'drafted'`.
7. On `should_draft: false` or any failure surviving retry: per §4.4, `Trigger.status = 'needs_triage'`,
   no `Message` row created for review, and a `TierHistoryEvent` records the reason.
8. The draft now appears in `GET /api/queue` and the Review worklist — Console API's queue query is
   simply "accounts with a `Message` in `pending_review`."

### Flow 2 — a human approves and it sends

1. A BDR opens Account Detail (`GET /api/accounts/:id`), reviews the draft, optionally edits it
   (`PATCH .../messages/:messageId`, which sets `edited = true` and preserves `original_body`).
2. Clicks Approve → `POST .../messages/:messageId/approve`. Console API sets
   `Message.status = 'approved'`, `decided_by`/`decided_at` from the session, and returns
   immediately — the request does not block on sending.
3. Console API asynchronously invokes the Worker's dispatch path for this message. This call can
   fail (network blip, worker cold-start timeout) after `status` is already `'approved'` — with
   nothing else watching for that, the message would be silently stuck "approved" forever, never
   sent and never flagged. Fix: the **stuck-send reconciliation sweep**, a third responsibility on
   the same scheduled job that already runs follow-up cadence checks, queries for
   `Message.status = 'approved'` older than a few minutes with no `sent_at`, and re-invokes
   dispatch. If a message fails this reconciled retry too, it's flagged for human attention (a
   `TierHistoryEvent`-style note on the account, surfaced the same way a low-confidence draft is)
   rather than retried indefinitely.
4. **Message Dispatch module** sends the email via the channel adapter; on success sets
   `Message.status = 'sent'`, `sent_at = now()`.
5. **Tiering & Escalation module** re-evaluates promotion: if `Message.tier_context == 2`,
   `edited == false`, and no negative signal has occurred on this account since, it increments
   `Account.clean_approvals_count`. If the new count meets `Setting.tier1_promotion_threshold`
   **and** the account's ICP score independently qualifies for Tier 1 (spec §3 — promotion needs
   both conditions, not just the approval count), it promotes: `Account.current_tier = 1`, a
   `TierHistoryEvent(promote)`.
6. If instead `Message.tier_context == 1` (an autonomous send, not this flow's Tier-2 path), the
   **Audit-Sampling module** rolls against `Setting.tier1_audit_sample_rate`; on a hit, creates an
   `AuditSample` row at send time (spec §10 — "logged into an audit-sample queue at send time").
7. The console shows "Approved — sending" then, once the async dispatch confirms, the sent state.

### Flow 3 — a hard trigger fires mid-conversation and creates an escalation

1. A buyer reply arrives via an inbound-mail adapter (out of scope for detail; treated as an
   external caller of `POST /internal/inbound-messages` with `{accountId, body, receivedAt}`).
2. Console API persists a `Message(role = 'buyer_inbound', status = 'sent')` and invokes the
   Worker's classification path.
3. **Message Drafting module** runs the hard-trigger classification call (§4.3) against the reply
   body.
4. Say the reply asks for pricing. **Tiering & Escalation module** reads `fires: true,
   rule: "pricing_question"` and creates an **Escalation** (`account_id`, `trigger_message_id` =
   the inbound message, `hard_trigger_rule = 'pricing_question'`, `reason_summary`, `detail`,
   `agent_send_disabled = true`, `status = 'active'`). It sets `Account.current_tier = 3`
   regardless of the account's prior tier (spec §4: hard triggers "override tier, always") and
   writes a `TierHistoryEvent(escalate, from_tier: <prior>, to_tier: 3)`.
5. **Message Drafting module** is invoked again, this time to produce the internal handoff /
   recommended-next-step text (spec §6's worked example — "Internal handoff to human AE" — is
   never sent to the buyer, only shown to the human). Stored as `Escalation.recommended_next_step`.
6. The account now surfaces in `GET /api/escalations`; the Console shows the escalation banner,
   the recommended next step, and disables any further agent-authored send for this thread.
7. If the classification call itself fails or times out (§4.4 point 5): the module still creates an
   `Escalation`, but with `hard_trigger_rule = 'classification_uncertain'` — the system cannot
   verify no hard trigger fired, so per spec §7's conflicting-signal principle it escalates rather
   than silently letting the reply go unhandled.

### Flow 4 — a human marks an escalation resolved, then a later escalation is linked as a repeat

1. A BDR opens the Escalation tab, writes an action taken, and either "Mark resolved" or "Compose &
   send reply" → `POST .../escalations/:escId/resolve` with `actionType`, `actionTaken`,
   `outcomeTag`, and (for compose-send) `followupBody`.
2. Console API creates one **Resolution** row (1:1 with the Escalation), sets
   `Escalation.status = 'resolved'`, `resolved_at = now()`. `time_to_resolution` is derived from
   `resolved_at − Escalation.created_at` (informational only — spec §9 notes no response SLA is
   currently policy-set).
3. If `actionType == 'compose_send'`, the human-authored reply is dispatched via the same Message
   Dispatch module used for approved drafts (it's still just "send an email"; Claude is not
   involved — the human wrote the text), and the sent message is linked via
   `Resolution.followup_message_id`.
4. Weeks later, a new escalation opens on the same account for what looks like the same underlying
   issue (e.g. a billing dispute resurfacing). The BDR opens it; the Escalation Detail view offers
   "Is this a repeat of a past issue?" populated from `GET` on this account's prior Resolutions.
5. The BDR selects the earlier Resolution and confirms → `POST .../escalations/:newEscId/link`
   `{resolutionId}`. Console API sets `Escalation.repeat_of_resolution_id`. This is **entirely
   human-set** — per spec §9, "don't build this as an automated 'same issue' detector for v1;
   reliably matching issues is a judgment call." No Claude call is involved in this step at all.
6. The UI now shows the repeat-escalation banner, cross-referencing the linked Resolution.
7. Resolving the escalation (step 2) does not by itself change `Account.current_tier` — see §7. If
   the BDR judges the account should move (e.g. back to Tier 2), that's a separate, explicit
   `PATCH /api/accounts/:id/tier` call from the account's own page, not an automatic side effect of
   this flow.

## 6. Tech stack

**TypeScript (Node.js 24) across both processes, in an npm/pnpm workspace monorepo** —
`packages/domain` (the six modules in §1, as plain TypeScript with no framework dependency, so they
unit-test in isolation), `apps/console-api`, `apps/worker`, sharing `packages/domain` and a
`packages/db` (Prisma client + schema).

- **Why one language for both processes:** the modular-monolith argument in §1 only holds if the
  domain modules are literally shared code, not re-implemented per process. A two-person team also
  benefits from one language's tooling, one dependency-update cadence, and one hiring profile,
  rather than splitting API-in-language-X / worker-in-language-Y for no architectural reason.
- **Why TypeScript specifically:** the Anthropic TypeScript SDK (`@anthropic-ai/sdk`) is
  first-class and actively maintained, with direct support for the structured-output path (§4.2)
  used here; a single-language stack also lets the console frontend and backend share types
  (e.g. the `Message`/`Escalation` shapes in §3) without a code-generation step.
- **Why Node 24, not 22:** Node 22 entered Maintenance LTS in October 2025 (EOL April 2027); Node
  24 is the current Active LTS line (through April 2028). For a project starting now, Node 24 gives
  a longer runway before the first forced upgrade, at no cost — no code-level difference forces the
  choice either way.
- **API framework: NestJS.** NestJS's module system is a direct, enforced mechanism for exactly
  the "clear internal module boundaries, justified by responsibility and testability" requirement
  this design keeps returning to — each domain module in §1 maps to a NestJS module with an
  explicit provider/injection graph, so a dependency between (say) Escalation and Tiering is a
  constructor injection the compiler checks, not a convention someone can quietly violate. This is
  a stronger and cheaper guarantee for a two-person team than relying on code review alone.
- **ORM: Prisma 7**, targeting the Azure doc's already-decided PostgreSQL Flexible Server, using
  the `@prisma/adapter-pg` driver adapter — mandatory as of Prisma 7, not an optional perf tweak,
  since Prisma dropped the Rust query-engine binary in favor of a TypeScript/WASM query compiler.
  This matters specifically for the worker: it scales to zero between calls, and removing the
  ~15MB Rust engine binary is what takes Prisma's cold-start cost from roughly 800ms down to well
  under 100ms — a real, load-bearing reason to pin the current major rather than an older one.
  Prisma's migration workflow matches the Azure doc's §6 CI/CD plan directly ("database migrations
  run as a one-off Container Apps Job... invoked before the new revision receives traffic" — that
  job is `prisma migrate deploy` using the same container image; this remains Prisma's own
  documented recommendation for production migrations).
- **Frontend:** a React + TypeScript SPA (Vite 8 build), compiled to static assets and served by the
  same Console API container — matching the Azure doc's §2 explicit choice to keep frontend and
  API as one deployable unit rather than splitting onto Static Web Apps. The existing mockup's
  visual system (`design-system/tokens.css`, the tier-badge/status conventions) carries over
  unchanged; only the hand-rolled vanilla-JS state machine in the mockup gets replaced by real API
  calls against the contracts in §3.
- **Worker invocation modes:** the same worker container image runs as (a) a long-lived internal
  HTTP server (Fastify, deliberately lighter than Nest here since this surface has no human-facing
  routing concerns) for on-demand calls from Console API, and (b) invoked with a `--job=<name>`
  argument by Azure Container Apps scheduled Jobs for the two cron behaviors (follow-up cadence,
  audit-sample maintenance) — one image, two entrypoints, matching the Azure doc's §2 sketch
  exactly rather than introducing a second image or a queueing service the Azure doc explicitly
  ruled out (§7: "no service mesh / event-streaming platform").
- **Testing:** Vitest for domain-module unit tests (tiering rules, hard-trigger rule tables, and
  the resilience wrapper in §4.4 are all pure-enough logic to test without a live Claude call —
  Claude responses are mocked/recorded fixtures); Prisma against a local/CI Postgres (via
  Testcontainers) for integration tests of the data model and the flows in §5.

## 7. Resolved: tier restoration after a hard-trigger escalation

Previously an open question; now decided (spec §9). Resolving a hard-trigger escalation — e.g. a
pricing question, which isn't necessarily a negative signal at all — does **not** automatically
restore the account's pre-escalation tier. Resolving the `Escalation` closes that record only and
never touches `Account.current_tier`. If the account should move afterward (e.g. back to Tier 2
now that the pricing conversation is handled), a human does that explicitly via
**`PATCH /api/accounts/:id/tier`** (§3), which requires a short reason and always writes a
`TierHistoryEvent(manual_override)`. This keeps the behavior simple — one human-initiated action
for "close this escalation," a separate one for "change this account's tier" — rather than
building automatic tier-recovery heuristics that would have to guess whether a given hard trigger
was "healthy" or not.

## 8. Explicit non-goals (restated for scanability)

| Not designed here | Where it belongs |
|---|---|
| Trigger-detection / ICP-scoring ML pipeline | Assumed upstream input (behavior spec §2, §12) |
| Cloud/infra topology, Azure service selection, cost, DR | [Azure solution architecture doc](2026-08-02-azure-solution-architecture.md) |
| Login/logout UI and OIDC flow mechanics | [Landing/login design brief](../../ideation/open-design-brief-landing-login.md) — Keycloak already decided |
| RBAC / access control | Behavior spec §11–§12 — deliberately deferred with the settings change log |
| Outbound mail channel implementation (SMTP/Graph/etc.) | Treated as a swappable adapter behind the Message Dispatch module; not specified further |
| Health-pulse metrics snapshot, business-unit switcher | Behavior spec §12 — explicitly out of scope for v1, not deprioritized |
