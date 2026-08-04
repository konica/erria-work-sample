# MVP deployment design — one VM, docker-compose, public review URL

Status: accepted — supersedes the managed-PaaS deployment path for the MVP phase
Last updated: 2026-08-04
Decision record: [ADR-0007](../../adr/0007-mvp-deploys-to-one-vm-with-docker-compose.md)
Target state for later: [`docs/architecture/2026-08-02-azure-solution-architecture.md`](../../architecture/2026-08-02-azure-solution-architecture.md)
Application shape: [`docs/architecture/2026-08-02-application-architecture.md`](../../architecture/2026-08-02-application-architecture.md) §6
Behaviour grounding: [`docs/superpowers/specs/2026-08-01-outreach-agent-design.md`](2026-08-01-outreach-agent-design.md),
[`docs/superpowers/specs/2026-08-03-autonomous-send-design.md`](2026-08-03-autonomous-send-design.md)

## 0. What this deployment is for

A **stakeholder review deployment**: a public HTTPS URL where Erria staff can use the outreach console,
walk a trigger through drafting, approval and escalation, and give feedback — for about $44/month, with
no ability to email a real customer until that is deliberately switched on.

That last clause is the design constraint that shapes everything else. Every other property (cost,
simplicity, self-hosting) is negotiable. "A stakeholder cannot accidentally email a shipowner" is not.

## 1. Topology

One `Standard_B2s` VM (2 vCPU / 4 GiB) in **West Europe**, chosen for GDPR data residency —
Erria is Danish and the data includes EU business contacts.

```
        Internet
           │  HTTPS 443 (only published port pair, with 80 for ACME redirect)
           ▼
   ┌───────────────────────────────────────────────────────┐
   │  VM: Standard_B2s, West Europe, static public IP       │
   │                                                        │
   │   caddy ──────────────┬──────────────┐                │
   │   (TLS, reverse proxy)│              │                │
   │                       ▼              ▼                │
   │            console-api          keycloak              │
   │            (NestJS + SPA)       (OIDC, -Xmx512m)      │
   │                  │                   │                │
   │                  ▼                   │                │
   │              worker ◄────────────────┘                │
   │              (Fastify; also --job=<name>)             │
   │                  │                                    │
   │                  ▼                                    │
   │              postgres  (named volume on OS disk)      │
   └───────────────────────────────────────────────────────┘
              │                              │
              │ pg_dump nightly              │ HTTPS egress
              ▼                              ▼
        Azure Blob Storage            Claude API  ·  Microsoft Graph
                                                    (graph mode only)
```

Only Caddy publishes ports. Every other container binds to the compose network alone — not to
`0.0.0.0` on the host. Postgres in particular must not be reachable from the internet; this is the
single most consequential line in the compose file.

**Memory budget in 4 GiB** — the reason a B2s is adequate rather than optimistic:

| Container | Budget |
|---|---|
| postgres | ~400 MB (`shared_buffers` 128 MB; the dataset is small) |
| keycloak | ~800 MB (JVM heap capped at `-Xmx512m`) |
| console-api | ~250 MB |
| worker | ~200 MB |
| caddy | ~20 MB |
| OS + Docker daemon | ~500 MB |
| **Total** | **~2.2 GiB**, leaving headroom |

Add a 2 GiB swap file as insurance against a JVM spike, not as routine capacity.

**Burstable-CPU caveat.** B-series VMs accrue CPU credits and throttle when exhausted; the B2s
baseline is 40% of 2 vCPUs. Keycloak's start-up and `prisma migrate deploy` are the two credit-hungry
operations. This is acceptable for a console that idles between reviewers, but it should be the first
hypothesis if the app feels slow after a deploy rather than a mystery to debug from scratch.

**Scheduled jobs.** The two time-driven behaviours the behaviour spec requires — follow-up cadence
(§5) and audit-sample maintenance (§10) — run from the host crontab as
`docker compose run --rm worker --job=<name>`. Same image, same `--job` entrypoint the ACA Jobs design
specified, so no application code differs between this deployment and the managed target state.

### Relationship to the existing `compose.yaml`

A root `compose.yaml` already exists (issue #32) and states in its own header comment that it is **"not
a deployment artifact"** — it starts Postgres only, because local development runs the apps on the host
via `pnpm --filter <app> dev`. That file must keep working exactly as documented; developers rely on
`pnpm compose:up`, and CI uses Testcontainers rather than either file.

The deployment therefore adds a **compose overlay**, `compose.deploy.yaml`, applied as
`docker compose -f compose.yaml -f compose.deploy.yaml up -d`. The overlay contributes the
`console-api`, `worker`, `keycloak` and `caddy` services, and layers deployment-only concerns onto the
inherited `postgres` service — chiefly **removing its published port**, since the dev file maps
`${POSTGRES_PORT:-5432}:5432` to the host and the deployment must not expose Postgres to the internet.
Verify that with a port scan from off the box, not by reading the file (§10, milestone 1).

This is the base-plus-override pattern Compose documents for exactly this split, and it means the
`erria-pgdata` volume, the `pg_isready` healthcheck and the pinned `postgres:17` tag are inherited
rather than restated in two places that can drift.

**Two Dockerfiles are needed and do not yet exist** — nothing in the repository builds a container
image today. One multi-stage build per app (`apps/console-api`, `apps/worker`), both over the pnpm
workspace so `@erria/domain` and `@erria/db` resolve, with `prisma generate` run at build time and the
`console-web` Vite bundle emitted into the Console API image's static directory (application
architecture §6: the SPA is served by the same container).

## 2. Public URL and TLS

**Use a subdomain of a domain Erria already owns** (e.g. `outreach.erria.com`): one A record pointed at
the VM's static IP. Caddy then obtains and renews Let's Encrypt certificates automatically, with no
certificate configuration to write and no renewal cron to forget.

**Do not use the free `*.cloudapp.azure.com` hostname.** `cloudapp.azure.com` was **removed from the
Public Suffix List**, so certificate issuance for those names now counts against `azure.com`'s
registered-domain rate limit — a bucket shared with every other Azure tenant. Customers have been
blocked by unrelated tenants' issuance. A hostname whose TLS renewal depends on strangers' behaviour is
not a foundation for a stakeholder-facing URL.

The secondary reason is credibility. Stakeholders at a listed company are being asked to evaluate a
commercial tool; `erria-vm.westeurope.cloudapp.azure.com` reads as a scratch box and quietly
undercuts the review. A dedicated domain is ~$12/year if no subdomain is available.

Caddy config is correspondingly small — a site block per hostname, `reverse_proxy` to `console-api`,
and a matcher that blocks the Keycloak admin path (§4).

## 3. Send safety — `sandbox` mode is the default

**The problem.** The review URL is public. Any stakeholder with a login can click *Approve & send*. If
Message Dispatch is wired to Microsoft Graph, that keystroke emails a real shipowner, from a real Erria
mailbox, signed with a real colleague's name. The failure that matters in this system was never
downtime — it is one bad message damaging a commercial relationship, and a review environment is
precisely where an untrained hand meets a live send button.

**The mechanism.** `MessageDispatch` (application architecture §1: *"Thin channel adapter… No business
logic. Deliberately isolated"*) takes a mode:

| Mode | Behaviour |
|---|---|
| **`sandbox`** (default) | Persist the Message, transition it to sent, render it in the console and the audit trail. Call nothing external. |
| `graph` | Real send via Microsoft Graph (§5). Enabled deliberately by configuration; never the default, never the fallback. |

`sandbox` must be the value that applies when configuration is **absent or unparseable**, not merely
the documented default — a missing environment variable should degrade toward "email nobody," not
toward "email everybody."

Every flow stays fully demoable in `sandbox`: drafting, tiering, the five hard-trigger rules,
escalation and resolution, tier history, audit sampling, the queue and the send audit screen. The only
thing that does not happen is SMTP delivery.

**Second layer: seed data.** Seed only the fictional accounts the mockup already uses — Song Hong
Shipping, MV Song Hong Pioneer, Ms. Lan Pham. Then even a misconfigured `graph` mode has no real
recipient to reach. Two independent things must be wrong before a real person receives mail.

This is inexpensive only because the module boundary already existed. It is worth noting as a case where
the modular-monolith discipline of ADR-0001 paid off in a way nobody planned for.

## 4. Authentication on a public URL

A public URL removes the Azure doc's §7 IP allow-listing — stakeholders are on arbitrary networks in
Denmark and Vietnam. (This also resolves a tension already latent in that section, which recommended
allow-listing while acknowledging Vietnam-based reviewers.) Keycloak becomes the only gate, so it has
to be worth being the only gate:

- **No default or shared admin credentials.** A generated admin password in the secret store, and the
  bootstrap admin removed once real accounts exist.
- **The Keycloak admin console blocked at Caddy**, by path matcher, returning 404 to the internet.
  Administration happens over an SSH tunnel. Being unlinked from the UI is not access control.
- **Login rate-limiting** — Keycloak brute-force detection on, plus a Caddy rate limit on the token
  endpoint.
- **MFA on any account that can approve a send.** Approval is the action with commercial consequence;
  it is the one worth protecting, and the tier system already treats it as the trust boundary.
- **Distinct accounts per human, no shared logins.** `decidedBy` on an approval is only meaningful if
  it names a person, and both the audit trail and Clean Approval counting depend on it.

## 5. Outbound email — Microsoft Graph, and why not the alternatives

Deferred until milestone 5, but decided now because it constrains the mailbox and DNS work that has
lead time.

**Azure Communication Services Email cannot be used: it is outbound-only and does not receive.** This
system requires inbound mail as a first-class input — three of the five Hard-Trigger Rules fire on
buyer replies (pricing question, technical/compliance question, negative sentiment), the follow-up
cadence keys off "no reply after 5 business days" (spec §5), and a reply in Vietnamese is itself an
escalation condition. Microsoft's own guidance for ACS users needing replies is to monitor an Exchange
Online mailbox via Graph — i.e. to run Graph anyway, alongside ACS, for the half ACS cannot do.

**Microsoft Graph `sendMail` from a real Exchange Online mailbox** is therefore the choice, and it fits
the design rather than merely satisfying it. Spec §5 requires every message to be *"signed by a named
person at Mermaid Maritime Vietnam, not 'the Erria AI system.'"* Sending from that person's actual
mailbox makes the signature true instead of decorative: replies reach a real human, the thread appears
in their Sent Items, and the mail inherits Erria's existing SPF, DKIM, DMARC and domain reputation.
A third-party relay or ACS would send from a separate domain warming a cold reputation while signing as
someone whose mailbox it is not — the worst available combination for cold B2B outbound.

**Volume is not a constraint.** Exchange Online allows 10,000 recipients/day per mailbox and 30
messages/minute (a delay, not a rejection). The behaviour spec's scale is dozens to a few hundred
accounts with a handful of messages each.

**The security condition is not optional.** Graph's `Mail.Send` **application** permission is
**tenant-wide by default — it can send as any mailbox in Erria.** It must be constrained with an
Exchange **`ApplicationAccessPolicy`** scoped to the single outreach mailbox. An AI agent holding
unrestricted send-as-anyone across a listed company is not a risk worth carrying, and the remedy is one
`New-ApplicationAccessPolicy` command. Treat "policy exists and has been verified with
`Test-ApplicationAccessPolicy`" as a precondition of milestone 5, not a follow-up task.

DNS work with lead time: confirm SPF (**one** record for the domain — a second one breaks both), DKIM
selectors published, and DMARC at least `p=none` with a reporting address someone reads.

## 6. Data, backup, and honest recovery

Postgres data on a **named Docker volume** on the OS disk (E6, 64 GiB Standard SSD). Not a bind mount
into a home directory, so a careless `docker compose down -v` is the only way to lose it — and that
command should be documented as destructive in the runbook.

**Backup:** nightly `pg_dump` piped to Azure Blob Storage with a retention window, plus the compose
file and `.env` template in git. **A restore must be performed once, by hand, before milestone 5** —
an untested backup is not a backup, and this is the phase where testing it is free because the data is
fictional.

**Stated plainly:** there is no point-in-time restore. The managed target state gets a ~15-minute RPO as
a property of Flexible Server; here RPO is "since last night's dump" and RTO is "provision a VM, clone
the repo, `docker compose up -d`, restore the dump" — plausibly an hour or two, and unrehearsed until
someone rehearses it. For fictional review data that trade is obviously correct. **Before `graph` mode
accumulates real buyer correspondence, it stops being obviously correct** — that is the trigger in
ADR-0007's revisit list, and it is the one most likely to fire first.

## 7. Deploy pipeline

Deliberately small: **GitHub Actions → GHCR → SSH → `docker compose up -d`.**

`.github/workflows/ci.yml` already exists and runs lint, typecheck and the test suite on PR and on
push to `main`. It stays as it is; the deployment adds workflows rather than modifying it.

1. **Build & test** — the existing `ci.yml`, unchanged.
2. **Publish** on merge to `main` — build and push `console-api` and `worker` to **GHCR**, tagged with
   the commit SHA. GHCR rather than ACR because it is free with the repository and removes a $5.07/month
   line and an extra credential; the images are private to the repo.
3. **Deploy** — SSH to the VM, `docker compose -f compose.yaml -f compose.deploy.yaml pull`, run
   `prisma migrate deploy` as a one-off `run --rm`, then `up -d`. Pin by **commit SHA, never `latest`**,
   so what is running is identifiable and rollback is re-pinning the previous SHA.

**Migrations must be expand/contract.** `docker compose up -d` replaces containers without draining, so
old and new code briefly overlap against the new schema — the same constraint the managed design had,
for the same reason. Additive change first (nullable columns, new tables); the destructive half lands in
a later release once no old container remains. A failed migration must abort the deploy before
`up -d`, leaving the previous containers serving.

**Rollback is honest about its limits:** re-pinning the previous SHA restores code in seconds. It does
nothing for schema or data — that needs a reverse migration or the dump. Rollback buys investigation
time; it does not undo a destructive migration.

**Secrets** live in a `.env` file on the VM (`chmod 600`, outside the repo, contents recorded in the
team's password manager), injected by compose. GitHub Actions holds only the SSH deploy key and the
GHCR token. Azure Key Vault is deliberately not used at this stage: with no managed identity to
authenticate with, the VM would need a credential to fetch credentials, which adds a moving part
without removing the root secret.

## 8. Monitoring, sized for two people and one box

No Log Analytics workspace, no Application Insights, no agent — the workspace and ingestion were a
managed-design cost line ($2.99/GB at Analytics tier) with no counterpart here.

- **Container logs** via the `json-file` driver with `max-size` and `max-file` set, so a log loop fills
  a cap instead of the disk. `docker compose logs` is the query interface.
- **Restart policy** `unless-stopped` on every service, so a crash self-heals.
- **Healthchecks** in compose for postgres, console-api and keycloak, so `docker compose ps` reports
  something truthful.
- **An uptime check on the public URL** from any free external monitor, emailing the two team members.
  This is the single highest-value alert: it covers the VM, Docker, Caddy, TLS renewal and the app in
  one signal.
- **Disk-usage alert at 80%** via Azure Monitor's built-in VM metrics. On a single box with Postgres,
  Docker images and logs sharing one disk, exhaustion is the most likely self-inflicted outage.
- **An Azure Cost Management budget alert.** Still worth more than most infrastructure alerts here,
  because the Claude API bill is the unfamiliar recurring cost and can exceed the $44 infrastructure line.

### Autonomous-send observability — a gap inherited from §8 of the Azure doc

That document's alert list predates ADR-0006 and therefore assumes every send has a human watching it.
It does not mention autonomous sending at all. Whatever the platform, these are needed before milestone 5:

- **Scheduled-job silence** — a cron job that stops firing is invisible, and cron mails failures to a
  local mailbox nobody reads. The jobs dispatch follow-ups and maintain audit sampling. Alert on
  *absence* of a completion heartbeat, not on error output.
- **Kill-switch state change** — notify both team members whenever `autonomousSendingEnabled` flips,
  in either direction. It is the highest-consequence setting in the system.
- **Kill-switch read failure must fail closed.** If the setting cannot be read, hold for approval.
  Currently unstated anywhere.
- **Autonomous send volume anomaly** — a tripwire on an unexpected spike, not a cap. The design
  deliberately has no volume ceiling; this only asks a human to look.
- **Audit-sample review backlog** — sampling is worthless if nobody marks the samples. Alert on
  unreviewed samples older than a threshold.
- **Claude API spend threshold**, separate from the Azure budget alert, since it is a different vendor
  and likely the larger number.

## 9. Trigger source — the day-one blocker

The trigger-detection and ICP-scoring pipeline is **explicitly out of scope and does not exist** (spec
§2, §12: *"assumed to already produce the inputs this design consumes"*). Nothing reaches the queue
without it, so no deployment demonstrates anything.

**Resolution: a seed script plus a manual CSV import path** that creates Accounts, Contacts, Vessels and
Triggers from a spreadsheet. This is how a two-person team would really start, it needs no fabricated ML,
and it is what the pilot runs on. The CSV columns are the de facto contract with whatever pipeline
eventually replaces it.

## 10. Milestones

Each has an entry condition, an exit condition, and a human check. Ordering is fixed; durations are
deliberately not stated — there is no velocity data for this team, and inventing dates would make the
plan read as more certain than it is.

| # | Milestone | Entry | Exit — a human verifies | Cost/mo |
|---|---|---|---|---|
| 1 | **Provision** | Subscription, region, domain chosen | The public URL serves a placeholder over HTTPS with a valid certificate; SSH works; Postgres is **not** reachable from the internet | ~$44 |
| 2 | **Stack up** | M1 exit | Keycloak realm imported, migrations applied, seed data loaded, a named human logs in | ~$44 |
| 3 | **App live in `sandbox`** | M2 exit; layout tickets #43–#45 done | A stakeholder walks trigger → draft → approve → "sent" and an escalation end to end, and **nothing was emailed** | ~$44 |
| 4 | **Stakeholder review** | M3 exit | Feedback collected and triaged into issues | ~$44 |
| 5 | **`graph` mode, real recipients** | M4 exit **and** every §11 gate | First real message sends to a real contact, deliberately, watched | ~$44 |

Milestones 1–4 cost ~$44/month and **cannot email anyone**. That is the safe review environment.

Note that milestone 3 depends on the layout work (#43–#45): a stakeholder review of an unstyled console
tells you about the CSS, not about the product.

## 11. Gates before real email — and separately, before autonomous send

**Before `graph` mode (milestone 5):**

1. `ApplicationAccessPolicy` exists, scoped to the one outreach mailbox, verified with
   `Test-ApplicationAccessPolicy`.
2. SPF (single record), DKIM and DMARC confirmed on the sending domain.
3. A `pg_dump` restore performed by hand at least once.
4. Seed/fictional accounts purged or clearly partitioned from real ones.
5. MFA enforced on every account that can approve a send.
6. The mode is set explicitly; the fail-closed default has been tested by removing the variable.

**Before autonomous sending is switched on** — a separate, later decision, because the kill switch
defaults to off (autonomous-send design §6) and Tier 1 is only ever earned (ADR-0004):

1. All five gates of `evaluateAutonomousSend` observed firing correctly against real data — no contact
   email, kill switch, active escalation, compliance-deadline content, and confidence below high.
2. Hard-trigger rule accuracy reviewed by a human against real buyer replies, with no missed escalation
   in the reviewed window.
3. At least one account has legitimately earned Tier 1 through Clean Approvals, and a human has read
   that thread and judged the tone representative.
4. Audit sampling verified working — the design guarantees an account's **first** autonomous send is
   always sampled regardless of rate, so that sample must actually appear for review.
5. Both team members know how to switch it off, and the switch has been tested in the off direction.

A useful framing correction: the safety of deferring the autonomous path does **not** come from a
"grace period" while accounts earn Tier 1. The promotion threshold is a configurable setting (default 2
Clean Approvals, adjustable 1–4) and earning is **per account**, so the first account can reach Tier 1
quickly. The safety comes from the **org-wide kill switch defaulting to off** — a control the team
holds, not a timeline it waits out. That distinction matters because one of those can be relied upon.

## 12. Risks

Ranked by expected cost. Deliberately without invented monetary figures — Erria's deal sizes and any
regulatory exposure are not knowable from this repository, and fabricated numbers would make the
ranking look more rigorous than it is.

| Risk | Why it ranks here | Mitigation |
|---|---|---|
| A stakeholder emails a real customer from the review URL | Commercially irreversible; an apology does not unsend it | `sandbox` default that fails closed, fictional seed data, `graph` gated behind §11 |
| A poorly-toned autonomous message reaches a real buyer | The relationship damage the tier system exists to prevent | Kill switch off by default, §11 autonomous gates, first-send-always-sampled |
| Data loss from the single Postgres volume | No PITR; unrehearsed restore | Nightly `pg_dump` to Blob, restore rehearsed before M5, volume not bind-mounted |
| Public URL with Keycloak as the only gate | Internet-facing auth on a first-time deployment | §4 hardening: admin console blocked, MFA on approvers, rate limiting, no shared logins |
| Silent scheduled-job failure | Invisible by construction; cron mails nobody | Heartbeat-absence alerting (§8) |
| Disk exhaustion | Postgres, images and logs share one disk | Log size caps, 80% disk alert |
| VM loss / region incident | Single failure domain, RTO in hours | Documented rebuild runbook; accepted for MVP |
| Claude API cost exceeding infrastructure cost | Plausible at this infra price; unfamiliar spend | Separate spend threshold alert |

## 13. Corrections to the Azure solution architecture doc's cost model

Recorded here because they hold whenever that document is picked back up. All rates verified against the
Azure retail price API for West Europe, 2026-08-04.

The doc's §10 priced every container at **active** rates. Container Apps bills a min-replica container
at a **reduced idle rate** when it is not serving requests — $0.000004 vs $0.000034 per vCPU-second, an
88% discount on the vCPU line — and grants **180,000 vCPU-seconds + 360,000 GiB-seconds + 2M requests
free per subscription per calendar month**, shared across environments rather than granted per app.

| Line | §10 estimate | Verified |
|---|---|---|
| ACA: console + Keycloak + worker | $50–80 | **$30.43** |
| PostgreSQL Flexible Server B1ms + 32 GB | $20–35 | **$18.91** ($14.53 compute + $4.38 storage) |
| Container Registry, Basic | ~$5 | **$5.07** ✓ |
| Log Analytics, 2 GB/month | $10–20 | **$5.98** at Analytics ($2.99/GB); **$1.30** at Basic Logs ($0.65/GB) |
| **Two environments, total** | $100–160 | **~$68–90** |

Three findings worth carrying forward:

- **Staging at `min=1` wastes ~$32/month** doing nothing, because prod has already consumed the shared
  free grant. `min=0` costs $0.83. A cold start in staging is acceptable.
- **`B2s` is not a near-neighbour of `B1ms`** — $58.11/month against $14.53, a 4× step. The doc offers
  them as if interchangeable.
- **Private endpoints on a Container Apps environment trigger the Dedicated Plan Management fee** —
  $0.10/hour, **$73/month** — per Azure's billing documentation, *"regardless of whether you use the
  Consumption or Dedicated plans."* The doc's proposed endpoints are on Key Vault and Postgres, which are
  unaffected, so the current design is safe. But "put the console behind a private endpoint" is a
  $73/month decision, not a $7 one.

### Two irreversible choices, if that design is ever provisioned

Neither is presented as a decision in the current document, and both are permanent at server creation:

- **Postgres networking mode.** Either VNet injection *or* public-access-plus-private-endpoint, chosen
  once and **not changeable afterwards**. §7's "one VNet, everything private" is under-specified: VNet
  injection requires its **own delegated subnet** (`Microsoft.DBforPostgreSQL/flexibleServers`, minimum
  /28) that **no other service may share** — so the Container Apps environment cannot sit in it — plus an
  explicitly created and linked Private DNS zone (auto-created only via portal/CLI, never via Bicep).
  VNet-injected servers also cannot use Private Link by default. Getting this wrong means rebuilding the
  server and migrating the data. Related: workload-profile environments (now the default) need only a
  **/27** for ACA, not the /23 the legacy Consumption-only type required.
- **Geo-redundant backup can only be enabled at creation time.** It should therefore be enabled *because*
  it is irreversible — §9's entire regional-recovery story depends on it, for a few dollars a month. If
  the concern is that the restore runbook is untested, the remedy is testing the runbook.

One further correction: **user-assigned managed identities** should be created ahead of the container
apps. A system-assigned identity does not exist until after its app is created, which is circular against
the Key Vault role assignment the app needs at startup.
