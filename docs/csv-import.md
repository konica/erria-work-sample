# CSV trigger import — column contract

Status: accepted
Grounding: [issue #54](https://github.com/konica/erria-work-sample/issues/54),
[MVP deployment design §9](superpowers/specs/2026-08-04-mvp-deployment-design.md#9-trigger-source--the-day-one-blocker)
Script: [`packages/db/src/seed/import-triggers.ts`](../packages/db/src/seed/import-triggers.ts)

## Why this file exists

The trigger-detection / ICP-scoring pipeline is out of scope for this system (behaviour spec §2,
§12: its outputs are *"assumed to already produce the inputs this design consumes"*). Until that
pipeline exists, a CSV is how real trigger data gets into the system — the same way the real
pipeline eventually will, via `POST /internal/triggers` (see
[`docs/architecture/2026-08-02-application-architecture.md`](architecture/2026-08-02-application-architecture.md)
§5 Flow 1). **The columns below are that contract**, documented here rather than only in the
script, so a future integration knows exactly what shape of data to produce.

## Running it

```bash
pnpm --filter @erria/db run import:triggers <path/to/file.csv>
```

Reads `DATABASE_URL` from the workspace-root `.env` (same as `prisma.config.ts`); no need to
`export` it into the shell first.

## Columns

One row = one Trigger, plus the Account/Vessel/Contact it's about. All required columns must be
present in the header row, even if unused by a particular batch.

| Column | Required | Notes |
|---|---|---|
| `account_external_ref` | yes | Stable natural key from the source system. Upserts the Account — re-importing the same ref updates it in place instead of creating a duplicate. |
| `account_company_name` | yes | |
| `account_segment` | yes | e.g. `Offshore support vessel operator` |
| `account_hub` | yes | e.g. `Haiphong` |
| `account_icp_score` | yes | Integer 0–100 |
| `account_icp_band` | yes | One of `high`, `med`, `low` |
| `account_relationship_summary` | yes | Free text |
| `vessel_name` | no* | *If any `vessel_*` column is filled in, all three vessel columns are required. |
| `vessel_imo` | no* | Natural key — globally unique, upserts the Vessel. |
| `vessel_flag` | no* | |
| `contact_name` | no† | †If any `contact_*` column is filled in, `contact_name` and `contact_role` are required; `contact_email` stays optional even then. |
| `contact_role` | no† | |
| `contact_email` | no | |
| `trigger_category` | yes | e.g. `life-raft service window` |
| `trigger_description` | yes | Shown as the queue row's trigger line |
| `trigger_source` | yes | One of `crm`, `class_records`, `public_data`, `buyer_reply` |
| `trigger_confidence_label` | yes | One of `high`, `mid`, `low` |
| `trigger_verifiability_note` | yes | e.g. `Partly verifiable — service interval is illustrative` |
| `trigger_detected_at` | yes | ISO 8601 timestamp |

A minimal valid file:

```csv
account_external_ref,account_company_name,account_segment,account_hub,account_icp_score,account_icp_band,account_relationship_summary,vessel_name,vessel_imo,vessel_flag,contact_name,contact_role,contact_email,trigger_category,trigger_description,trigger_source,trigger_confidence_label,trigger_verifiability_note,trigger_detected_at
crm-001,Song Hong Shipping,Offshore support vessel operator,Haiphong,82,high,New account,MV Song Hong Pioneer,9482137,Vietnam,Ms. Lan Pham,Technical Superintendent,lan.pham@example.com,life-raft service window,Life-raft servicing approaching next window,public_data,mid,Partly verifiable,2026-08-01T00:00:00.000Z
```

Fields containing a comma, quote, or newline must be RFC4180-quoted (`"..."`, doubled `""` for a
literal quote) — standard CSV export behaviour from Excel/Google Sheets/etc.

## Validation and idempotency

- **Every row is validated before anything is written.** A malformed row is reported as
  `Row <n>, column "<column>": <reason>` (row numbers start at 2 — row 1 is the header). If *any*
  row is invalid, the whole import is rejected and nothing is written — there is no partial import
  to clean up afterward.
- **A missing required column** is reported the same way, against row 1.
- **Re-running the same file does not duplicate data.** Idempotency is by natural key:
  - Account by `account_external_ref`
  - Vessel by `vessel_imo`
  - Trigger by `(account, trigger_category, trigger_detected_at)` — matched rows are updated
    (description/source/confidence/verifiability/vessel), not re-inserted
- Each valid row's Account/Vessel/Contact/Trigger writes land in one database transaction.

## Scope: what this does not do

The import creates `Account`/`Vessel`/`Contact`/`Trigger` rows only. A Trigger it creates lands at
`status: 'new'` — same as one freshly received and not yet processed. It does **not** invoke
message drafting (no Claude API call, no `Message` row), unlike `POST /internal/triggers`, which
also drafts a message via the worker. This keeps the import a pure, offline data-loading tool with
no dependency on a running worker or a configured `ANTHROPIC_API_KEY`. Moving an imported trigger
into drafting today means feeding it through the existing pipeline
(`POST /internal/triggers` / `POST /internal/process-trigger/:triggerId`); a batch "process every
new trigger" job is future work, not part of this ticket.

For realistic demo data that already includes drafts, an active escalation, a resolved escalation,
and a drafting-abstained trigger — the states this repo's console actually needs to demo — use the
seed script instead:

```bash
pnpm --filter @erria/db run seed
```

It seeds four accounts drawn from the approved mockup (Song Hong Shipping, Truong Phat Marine, Dai
Duong Shipping, Vina Offshore Supply — never a real company, vessel, person, or email address) and
is idempotent: running it again against an already-seeded database is a safe no-op.
