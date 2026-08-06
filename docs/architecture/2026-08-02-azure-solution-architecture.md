# Azure Solution Architecture — Erria Outreach Agent

Status: **Target state, deferred.** Superseded for the MVP / stakeholder-review phase by
[ADR-0007](../adr/0007-mvp-deploys-to-one-vm-with-docker-compose.md) and
[`docs/superpowers/specs/2026-08-04-mvp-deployment-design.md`](../superpowers/specs/2026-08-04-mvp-deployment-design.md),
which deploy to a single VM running docker-compose for ~$44/month. This document remains the
destination for when the MVP outgrows one box; ADR-0007 lists the triggers to come back to it.

**Two corrections apply before anything here is provisioned** — §10's cost model priced idle
containers at active rates and overstates the total by roughly 2×, and §3/§7 omit two choices that are
**permanent at Postgres server creation** (networking mode, geo-redundant backup). Both are detailed,
with rates verified against the Azure retail price API, in §13 of the MVP deployment design. §8's alert
list originally predated [ADR-0006](../adr/0006-autonomous-send-designed-deferrals-lifted.md) and
covered autonomous sending nowhere; issue #62 closed that gap — see §8's own "Autonomous-send
alerting" bullet.

Last updated: 2026-08-04 (status and corrections; body otherwise as written 2026-08-02)
Scope grounding: [`docs/superpowers/specs/2026-08-01-outreach-agent-design.md`](../superpowers/specs/2026-08-01-outreach-agent-design.md),
[`ideation/scenario-research.md`](../../ideation/scenario-research.md),
[`ideation/open-design-brief-landing-login.md`](../../ideation/open-design-brief-landing-login.md),
[`design-system/DESIGN.md`](../../design-system/DESIGN.md)

## 0. Scale calibration — read this before the rest

This document deliberately does **not** follow a default enterprise-cloud checklist. Erria's
outreach agent is a two-person team's first AI initiative, operating on one business unit
(Mermaid Maritime Vietnam) with **dozens to a few hundred accounts** and **a handful of human
reviewers** (BDR/ops staff) using a web console during business hours. It is not a
million-request-a-day system, and nothing below is sized as if it were.

Concretely, this means:

- **Single Azure region**, not multi-region active-active. 99.99% availability targets, live
  cross-region failover, and global load balancing are enterprise-scale answers to a problem this
  team doesn't have. A single-region deployment with good backups and an IaC-driven rebuild plan
  is the right amount of resilience for a tool a handful of people use, not a customer-facing
  revenue system.
- **No dedicated ops/SRE program.** Every choice below favors managed PaaS the engineer on the
  team can operate part-time, over anything that requires cluster babysitting, node patching, or
  an on-call rotation.
- **No compliance program** (SOC2, HIPAA, etc.) is proposed — none applies to an internal B2B
  sales tool handling business contact data, not health or payment data. The one real regulatory
  consideration is **GDPR**, because Erria is a Danish company and the data includes EU business
  contacts; that's addressed with ordinary data-protection hygiene (encryption, access control,
  retention), not a formal program.
- Every section below states explicitly what is **not** being recommended and why, per the task's
  requirement — not as an afterthought, but because the instinct to over-build is real and worth
  countering out loud.

## 1. Architecture at a glance

One Azure region (recommend **West Europe** or **North Europe** — see §7), one resource group per
environment (`staging`, `prod`), and a deliberately small number of distinct Azure service
*types* — using **Azure Container Apps as the single compute platform** for everything that runs
code, rather than spreading the footprint across App Service + Functions + AKS + VMs. Fewer
service types means less for a two-person team to learn and operate, even if a single-purpose
service would theoretically be a marginally better fit for one component.

```
                              ┌─────────────────────────────┐
   Browser (BDR/ops staff)   │   Azure Container Apps Env    │
        │                    │   (single VNet-integrated)    │
        │  HTTPS              │                              │
        ▼                    │  ┌────────────┐  ┌─────────┐ │        ┌──────────────┐
  Console (SPA + API) ───────┼─▶│ Console app │  │ Keycloak│ │◀──────▶│ Azure Key     │
  Container App               │  │ (web+API)   │  │(min=1)  │ │        │ Vault         │
                              │  └─────┬──────┘  └────┬────┘ │        └──────────────┘
                              │        │               │      │
                              │  ┌─────▼───────────────▼────┐ │
                              │  │ Orchestration worker      │ │──── HTTPS ───▶ Claude API
                              │  │ (Container App, scale-to-  │ │              (Anthropic,
                              │  │  zero) + scheduled Jobs    │ │               internet egress)
                              │  │ (follow-up cadence, audit  │ │
                              │  │  sampling)                 │ │
                              │  └─────┬──────────────────────┘ │
                              └────────┼──────────────────────┘
                                       │ private endpoint / VNet integration
                                       ▼
                         Azure Database for PostgreSQL
                         Flexible Server (Burstable, single instance)
```

Everything in the environment shares one **Log Analytics workspace** and one **Application
Insights** resource for observability (§8), and one **Azure Container Registry** for images (§6).

## 2. Compute: console + orchestration layer

**Recommendation: Azure Container Apps (ACA), Consumption plan, three workloads in one
environment:**

1. **Console app** (web console + API) — the human-facing review/escalation/settings UI and its
   backing API. Keep the frontend and API as one deployable unit (a server-rendered app or an SPA
   served alongside its API from the same container) rather than splitting them across two Azure
   services (e.g. Static Web Apps + Container Apps). This is a deliberate simplification: splitting
   them would save a small amount on frontend hosting (Static Web Apps has a free tier) but adds a
   second public domain, extra CORS configuration, and a second Keycloak redirect URI to keep in
   sync — not worth it for a handful of users. Run with **min replicas = 1** so reviewers never hit
   a cold start when they open the console.
2. **Orchestration worker** — calls the Claude API to draft messages, evaluates hard-escalation
   triggers, applies tiering/promotion logic, and writes results back to the database. Run with
   **min replicas = 0** (scale-to-zero) since it's invoked by console actions (approve/send) and by
   scheduled jobs, not by constant traffic — this is real cost savings at this usage level, not a
   theoretical one.
3. **Scheduled Container Apps Jobs** (cron trigger) for the two time-driven behaviors the design
   spec requires: follow-up cadence checks (§5 of the behavior spec — "no reply after N business
   days") and periodic audit-sample queue maintenance (§10). Using ACA Jobs for this means the team
   doesn't need to also learn/operate Azure Functions or Logic Apps just for a cron job — one less
   service type.

Keycloak also runs as a fourth ACA workload — see §4.

**Why not AKS:** AKS would require the team to own cluster upgrades, node-pool patching, and
Kubernetes-level networking/RBAC — real, ongoing operational work with no corresponding benefit at
this scale. Nothing about this workload (three lightweight services, low and bursty traffic, no
need for custom scheduling, sidecars, or multi-tenant isolation) justifies that cost. ACA gives the
same "put a container image in, get autoscaling and revisions out" experience without a cluster to
manage — it's the deliberately simpler choice, not a compromise.

**Why not plain App Service:** App Service is a legitimate, even simpler alternative for the
console app alone (a single "git push to deploy" web app with no Dockerfile needed if the team
prefers code-based deploys). It's a reasonable fallback if the team wants to avoid containers
entirely. It's not the primary recommendation here because the orchestration worker and scheduled
jobs are a more natural fit for ACA's consumption-based, scale-to-zero model, and running the whole
system on one platform (ACA) rather than splitting the console onto App Service and the worker onto
something else again multiplies the number of service types the team has to operate.

**Why not Azure Functions for the orchestration layer:** Functions would work for the
event-triggered pieces (approve → draft, send → audit-sample) but the design spec's escalation and
tiering logic is stateful business logic best expressed as normal application code with normal
testing, not scattered across function bindings. Keeping it as one worker service inside the same
ACA environment as the console is simpler to reason about and debug end-to-end.

## 3. Database

**Recommendation: Azure Database for PostgreSQL Flexible Server, Burstable tier (B1ms or B2s), single
instance, VNet-integrated (no public endpoint).**

The data model — accounts, tier state, escalations, resolutions, settings, audit-sample records —
is straightforwardly relational with real referential integrity needs (a Resolution belongs to an
Escalation belongs to an Account; the repeat-escalation flag in §9 of the behavior spec links two
Resolution/Escalation rows to each other). This is exactly what a relational database is for.

- **Burstable B1ms** (1 vCore, 2 GiB RAM) is enough for a database serving a handful of concurrent
  users and low write volume; it can be resized up in minutes if usage grows.
- Enable **automated backups** (7–35 day retention) and **geo-redundant backup storage** — cheap
  insurance for disaster recovery (§9) without needing a live standby.
- Keep it **VNet-integrated with no public endpoint**; only the ACA environment's subnet can reach
  it.

**Why not Azure SQL Database (serverless):** SQL Database serverless with auto-pause is a
legitimate alternative that could shave a few more dollars off idle-time cost, since the console is
realistically only used during Danish/Vietnamese business hours. It's not the primary
recommendation because auto-pause introduces a cold-start delay (several seconds to resume) on the
first request after idle — an avoidable rough edge for a small user base where the marginal cost
difference (a few dollars a month) doesn't justify it. Worth revisiting only if cost becomes a
real pressure point.

**Why not Cosmos DB:** Cosmos DB is built for massive-scale, globally distributed, flexible-schema
workloads. This system has neither: the schema is well-understood and relational, the scale is
small, and there's no multi-region write requirement. Using Cosmos here would mean paying for
capabilities that don't apply and building an application-side join/consistency model the database
would otherwise give for free.

**Why not an elastic pool / data warehouse:** No multiple-tenant-database or analytics-at-scale
need exists yet. If Erria later wants cross-business-unit reporting, that's a future extension, not
a v1 architecture concern (also explicitly out of scope per the behavior spec's non-goals).

## 4. Keycloak hosting

Keycloak (OIDC) is the already-decided identity provider (per
[`open-design-brief-landing-login.md`](../../ideation/open-design-brief-landing-login.md)); this
section is about *where it runs*, not whether to use it.

**Recommendation: Keycloak as a single container in the same Azure Container Apps environment,
min replicas = 1, backed by its own database (or a separate schema on the same Postgres Flexible
Server instance — see below), secrets pulled from Key Vault via managed identity.**

- **Min replicas = 1** (not scale-to-zero) — login is on the critical path for every session, and a
  cold-start delay on the identity provider is a worse user experience than on the console itself.
- **Separate database or schema from the application's own tables.** A separate Postgres *database*
  on the same Flexible Server instance (not a second server) is the pragmatic middle ground: it
  keeps Keycloak's data logically isolated from application data (so a bug in one doesn't corrupt
  the other, and Keycloak's own backup/restore story stays self-contained) without paying for and
  operating a second database server for a workload this small.
- Keycloak's admin console should sit behind the same VNet/network restrictions as everything else
  (§7) — there is no reason the Keycloak admin UI needs to be reachable from the open internet for
  a two-person team.

**Why not AKS or a dedicated VM for Keycloak:** Same reasoning as §2 — Keycloak is a single
stateless container image; it doesn't need a cluster, and a VM would mean the team owns OS patching
directly, which ACA avoids entirely.

**Worth flagging even though it's not the current decision:** Microsoft Entra ID (or Entra External
ID for customer-facing scenarios, though that doesn't apply here) is worth reconsidering as a
*future* alternative to self-hosted Keycloak, specifically because:

- All of this system's users are Erria's own internal employees (BDR/ops staff), not external
  customers — this is a workforce-identity scenario, which is Entra ID's strongest fit.
- Erria, being a Microsoft-ecosystem company in practice (typical for a Danish SME of this size),
  likely already has Entra ID / Microsoft 365 tenancy that these employees exist in — federating
  against that instead of standing up a parallel identity store removes a whole system (and its
  container image, its upgrades, its database) from the team's ownership.
- Self-hosting Keycloak means the team owns the Keycloak *image lifecycle* indefinitely (version
  upgrades, CVE patching of the Keycloak distribution itself) even though ACA removes the
  infrastructure-level ops burden. That's a real, ongoing cost that a fully managed identity
  provider removes entirely.

This is **not a recommendation to switch now** — Keycloak is the decided choice and this document
doesn't relitigate it. It's flagged because "run Keycloak on Azure" and "keep running Keycloak
forever" are two different decisions, and the second one is worth revisiting once there's
bandwidth, especially if Erria's own workforce identity already lives in Entra ID.

## 5. Secrets management

**Recommendation: Azure Key Vault, one vault per environment, accessed exclusively via managed
identity — no secrets in application settings, environment variable literals, or source control.**

Secrets to store: the Anthropic (Claude) API key, Keycloak client secrets and admin credentials, the
Postgres connection string/password, and the Keycloak database credentials.

- Each Container App (console, worker, Keycloak) gets a **system-assigned managed identity** with a
  Key Vault access policy/RBAC role scoped to only the secrets it needs (the worker needs the
  Claude API key; the console and Keycloak don't).
- Use **Key Vault references** in Container Apps secret configuration so secrets are pulled at
  startup/refresh rather than baked into images or committed config.
- Container Registry pulls also use managed identity (no ACR admin credentials floating around).

This is standard practice regardless of scale — Key Vault costs pennies a month even for a
low-volume workload, so there's no "simpler for our size" argument for skipping it. Not using Key
Vault would be the wrong kind of shortcut here; it's cheap and removes an entire class of
credential-leak risk.

## 6. CI/CD

**Recommendation: GitHub Actions → Azure Container Registry → Azure Container Apps, two
environments (staging, prod), promoted by branch/tag.**

- Build and push container images to **Azure Container Registry (Basic tier)** on merge to main
  (staging) and on release tag (prod).
- Deploy via the `az containerapp update` CLI action (or the official Container Apps GitHub Action)
  to roll a new revision; ACA's built-in revision model gives an easy rollback (repoint traffic to
  the prior revision) without needing a separate blue/green orchestration layer.
- **Database migrations** run as a one-off **Container Apps Job** (same image, migration
  entrypoint) invoked as a pipeline step *before* the new revision receives traffic — this avoids
  needing a separate migration-runner service.
- Keep it to **two environments**, not a dev/test/staging/prod/DR fleet — a two-person team gets
  no benefit from more environments than they can realistically keep in sync, and the footer copy
  already sampled in the design ("v0.4 · staging") confirms this is the intended shape.
- **Infrastructure as Code**: define all of the above (ACA environment, apps, Postgres, Key Vault,
  networking) in **Bicep** (native, no extra tooling to install, first-class Azure Container Apps
  support) or Terraform if the team already has Terraform skills from elsewhere — either is fine;
  the important thing is that the environment is reproducible from code from day one, which is
  cheap to do now and expensive to retrofit later.

## 7. Networking and security basics

Sized for "a handful of known, named internal users," not for a public-facing or
multi-tenant system:

- **Single VNet per environment**, with ACA using VNet integration so the Container Apps
  environment, Postgres Flexible Server, and Key Vault private endpoints all sit in private address
  space.
- **Postgres: no public endpoint**, reachable only from the ACA environment's subnet.
- **Key Vault: private endpoint** (or, if that adds more complexity than it's worth at this scale,
  Key Vault's own firewall restricted to the ACA subnet plus RBAC-based access — either is
  defensible; private endpoint is the slightly more consistent choice given the VNet is already
  there for Postgres).
- **HTTPS-only ingress** on the console and Keycloak Container Apps, with ACA's automatic managed
  TLS certificates on a custom domain.
- **IP allow-listing** on the console's ingress is worth doing given the user base is a small,
  known set of people (Erria office and/or VPN egress IPs) — this is a cheap extra layer precisely
  *because* the user population is small and fixed, not something available to a public-facing app.
- **Region and data residency**: recommend **West Europe** (or North Europe) as the primary region.
  Erria is a Danish company and this data includes EU business-contact information — keeping
  primary storage in an EU region is the straightforward, low-effort way to align with GDPR data
  residency expectations. The small number of Vietnam-based reviewers will see modestly higher
  latency to a single EU region, but at this request volume (a handful of users, not
  latency-sensitive real-time traffic) that's a non-issue — not a reason to stand up a second
  region.
- **Egress to the Claude API**: the orchestration worker makes outbound HTTPS calls to
  `api.anthropic.com` over the public internet — this is an unavoidable external dependency
  regardless of hosting choice, not something to route around. Default ACA outbound networking (via
  the platform's managed NAT) is sufficient at this call volume; there's no need for a static
  outbound IP or NAT Gateway unless Anthropic's API were to require IP allow-listing on their side
  (worth a quick check, but not assumed here).

**What is deliberately not being recommended here:**

- **No Azure Front Door / WAF.** Front Door plus a WAF policy is a reasonable addition for a
  public-facing app under real attack surface; for an internal tool with IP allow-listing and OIDC
  auth already in front of it, it's extra cost and complexity without a matching threat model. If
  the user base grows beyond office/VPN-reachable IPs (e.g. remote BDRs on arbitrary networks),
  revisit this.
- **No Azure DDoS Protection Standard.** The free, always-on basic DDoS protection included with
  any Azure virtual network is sufficient for an internal tool with a handful of users; the
  paid Standard tier is priced and designed for internet-facing services with real volumetric
  attack exposure.
- **No service mesh / Dapr / event-streaming platform (Event Grid, Kafka, etc.).** The
  orchestration worker's interactions (console → worker → Claude API → database) are simple
  request/response and scheduled-job flows, not a fan-out event system. The upstream
  trigger-detection/ICP-scoring pipeline is explicitly assumed to already exist and hand off scored
  accounts (per the behavior spec's non-goals) — if and when that pipeline needs to be integrated
  as a real system rather than an assumed input, that integration point is where an event backbone
  might become worth evaluating, not before.

## 8. Monitoring and observability

Sized for a two-person team checking in periodically, not a 24/7 SRE function.

- **One Application Insights resource** (auto-instrumented on the Container Apps workloads) for
  request tracing, exception tracking, and dependency tracking — critically, this gives visibility
  into Claude API call latency/failures and database query performance without any custom
  instrumentation work.
- **One Log Analytics workspace** collecting Container Apps console logs, Postgres logs, and Key
  Vault audit logs, with a **daily ingestion cap** set to bound cost (there's no operational need
  for unlimited log retention at this log volume).
- **A small, deliberately short list of alert rules**, routed to an Action Group that emails/Teams-
  notifies the two team members directly (no PagerDuty, no on-call rotation, no error-budget
  policy):
  - Console/API 5xx error rate above a low threshold.
  - Orchestration worker failures calling the Claude API (distinguishing rate-limit/auth errors
    from transient network errors is useful here, since the former needs a human to fix a key or
    quota, not a retry).
  - Postgres CPU/storage utilization approaching capacity (early warning to resize before it's an
    outage).
  - **Azure Cost Management budget alert** — given a two-person team is watching a new,
    unfamiliar recurring cost line (Claude API usage plus Azure infra), a monthly budget threshold
    alert is more valuable here than most infra alerts.
  - **Autonomous-send alerting (issue #62)** — this list originally said nothing about autonomous
    sending because it predates [ADR-0006](../adr/0006-autonomous-send-designed-deferrals-lifted.md);
    every rule below assumed a human was looking at each outbound message. Now that Tier 1 sends
    without one, the same six gaps this section already has a fix for on the one-VM MVP deployment
    (ADR-0007) apply here too, expressed through this design's own primitives instead of a
    managed-identity custom metric:
    - **Scheduled-job silence** — Container Apps Jobs' own execution history (a job that stops
      being invoked shows zero recent executions) is the managed equivalent of the MVP's
      heartbeat-absence metric; alert on it the same way, not on job error output, since the
      failure mode is silence.
    - **Kill-switch flips, in either direction** — an Application Insights custom event emitted
      wherever `autonomousSendingEnabled` changes, with an alert rule on event count > 0 in either
      direction over a short window, notifying both team members either way.
    - **Kill-switch read failure fails closed** — an application-code invariant, not an
      infrastructure concern; carries over unchanged regardless of hosting platform.
    - **Autonomous send volume anomaly** — Azure Monitor's Dynamic Thresholds applied to a custom
      metric or Application Insights metric for autonomous-tier send count, the same mechanism
      already used for Postgres/API alerting above, just with a dynamic rather than static
      threshold, since the design has no fixed ceiling to alert against.
    - **Audit-sample review backlog** — a scheduled query against Application Insights or the
      database (oldest unreviewed `AuditSample` age) feeding an alert rule.
    - **Claude API spend threshold** — separate from the Azure Cost Management budget alert above;
      a different vendor, and per the ticket likely the larger number.
    - **Telemetry tagging** — every trace, log, and metric touching a send should carry a
      `tier: autonomous | human_approved` dimension (or equivalent Application Insights custom
      property) so the alerts above can be scoped to autonomous-tier activity specifically,
      distinct from human-approved activity in the same telemetry stream.
- **Business-level visibility** (tier distribution, escalation volumes, audit-sample pass/fail
  rates called for in the behavior spec's §8/§10) is better served by a simple in-app reporting
  view backed by normal database queries than by infrastructure monitoring tooling — this is an
  application feature, not part of the cloud architecture, but it's worth noting here so it isn't
  accidentally built twice (once as an app feature, once as an Azure Monitor workbook).

**What is deliberately not being recommended here:** a custom Grafana/Prometheus stack, a
service-mesh-level distributed tracing setup, or a formal SRE error-budget/SLO program. Azure
Monitor + Application Insights, used simply, already gives more visibility than a two-person team
needs to actively watch; anything more is tooling overhead without a corresponding team to consume
it.

## 9. Disaster recovery — right-sized, not enterprise-sized

- **RPO ~15 minutes** via Postgres Flexible Server's point-in-time restore (continuous backup within
  the retention window), and **geo-redundant backup storage** so a full regional outage doesn't
  also take out the backups.
- **RTO measured in hours, not seconds.** Because the entire environment is defined in IaC (§6),
  recovery from a regional outage is "redeploy the Bicep/Terraform templates into the paired region,
  restore the database from geo-redundant backup, repoint DNS" — a runbook exercise, not a live
  standby. For a handful of internal reviewers with no 24/7 real-time commercial obligation, an
  RTO of a few hours is a reasonable, honestly-stated trade-off, not a gap to apologize for.
- **What this deliberately isn't:** a warm/hot standby in a second region, live database
  replication, or an automated failover mechanism. Those are the right answer for a system where
  minutes of downtime cost real revenue at scale; they are not proportionate here, and building them
  would consume engineering time this team doesn't have to spare, for resilience the business
  doesn't currently need.

## 10. Monthly cost ballpark (Azure infrastructure only)

> **Superseded — see §13 of the [MVP deployment design](../superpowers/specs/2026-08-04-mvp-deployment-design.md).**
> The table below prices every container at Container Apps' **active** rate. Azure bills a min-replica
> container at a reduced **idle** rate ($0.000004 vs $0.000034 per vCPU-second in West Europe), and
> grants 180,000 vCPU-seconds + 360,000 GiB-seconds free **per subscription** per month. Verified
> totals are roughly **half** the figures here: ~$68–90/month for both environments, not $100–160.
> Also note that private endpoints **on a Container Apps environment** carry a $73/month Dedicated Plan
> Management fee, and that B2s is 4× B1ms rather than a near neighbour.

Rough, single-region, pay-as-you-go estimates in USD (actual pricing varies by exact region/SKU
availability and should be confirmed in the Azure pricing calculator before committing):

| Component | Configuration | Est. monthly cost |
|---|---|---|
| Container Apps — console (min=1) | ~0.5 vCPU / 1 GiB, always-on | $25–35 |
| Container Apps — Keycloak (min=1) | ~0.5 vCPU / 1 GiB, always-on | $20–30 |
| Container Apps — worker + scheduled jobs | scale-to-zero, low invocation volume | $5–15 |
| Azure Database for PostgreSQL Flexible Server | Burstable B1ms, 32 GB storage, backups | $20–35 |
| Azure Key Vault | low operation volume | <$5 |
| Azure Container Registry | Basic tier | ~$5 |
| Log Analytics / Application Insights | capped ingestion | $10–20 |
| Private endpoints / VNet | 1–2 private endpoints, minimal egress | $10–15 |
| **Azure infrastructure subtotal** | | **~$100–160/month** |

**Not included above, but real and worth planning for separately:** the **Anthropic (Claude) API
usage cost** is not an Azure line item, but it is the dependency this whole system exists to call,
and at even modest volume (dozens to a few hundred accounts, a handful of messages per account per
week, plus retries/drafting iterations) it is plausibly **comparable to or larger than the Azure
infrastructure cost itself** — a rough placeholder of $50–300/month depending on message volume and
model choice, refined once real usage data exists. Track it explicitly (a cost/usage dashboard is a
reasonable app-level feature) rather than treating "cloud cost" as only the Azure bill.

**What is deliberately not being priced in:** reserved instances / savings plans. These pay off
once usage patterns are established and stable; committing to a 1- or 3-year reservation before the
team has even a few months of real usage data would lock in a guess. Revisit after 2–3 months of
pay-as-you-go operation.

## 11. Summary of explicit non-recommendations

Collected here for scanability — each is explained in its own section above:

| Not recommending | Why |
|---|---|
| AKS | No dedicated ops/SRE; cluster/node patching is pure overhead at this scale |
| Multi-region active-active | No latency/availability requirement that justifies the cost/complexity |
| 99.99% SLA design | Disproportionate to a handful-of-users internal tool |
| Cosmos DB / NoSQL | Data is genuinely relational; would add complexity, not remove it |
| Azure SQL serverless (over Postgres) | Viable, but cold-start latency isn't worth the marginal savings yet |
| Dedicated VM or AKS for Keycloak | Single stateless container; ACA removes patching burden without a cluster |
| Azure Front Door + WAF | No public-facing threat model; IP allow-list + OIDC already gate access |
| DDoS Protection Standard | Free basic tier already covers an internal, allow-listed app |
| Service mesh / event streaming | Simple request/response flows; no fan-out event system exists yet |
| Full SRE/on-call program, Grafana/Prometheus | Azure Monitor + Application Insights, used simply, is already more than this team needs |
| Live DR standby / automated failover | IaC rebuild + geo-redundant backup gives an honest, adequate RTO/RPO at this scale |
| SOC2/HIPAA compliance program | Neither applies to this data or business context |
| Reserved instances / savings plans (now) | Too early to commit without real usage data |

## 12. When to revisit these decisions

None of the above is permanent. The concrete triggers to re-evaluate:

- **Team grows past two people, or roles split** (e.g. a dedicated ops hire) → AKS, a fuller
  CI/CD promotion pipeline, and a real on-call rotation become proportionate to reconsider.
- **User base grows beyond a fixed, known set of office/VPN IPs** (e.g. remote BDRs joining from
  arbitrary networks) → revisit IP allow-listing and consider Front Door.
- **Erria expands the outreach agent to other business units** (ECS, Cathay Seal, Nordic Marine
  Partner) → revisit multi-tenancy in the data model and whether a single Postgres instance still
  suffices, before revisiting compute scale.
- **Compliance requirement emerges** (e.g. a customer or regulator asks for a formal audit) →
  that's the point to introduce a compliance program, not before one is actually asked for.
- **Claude API usage cost consistently exceeds Azure infra cost by a wide margin** → worth a
  dedicated cost-optimization pass on prompt/token usage, separate from this Azure architecture.
