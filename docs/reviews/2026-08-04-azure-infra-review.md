# Azure Infrastructure Review — Feasibility, Autonomous-Send Gaps, Outbound Email, Cost

**Review date:** 2026-08-04
**Reviewer:** Azure infrastructure specialist (read-only review)
**Scope reviewed:** [`docs/architecture/2026-08-02-azure-solution-architecture.md`](../architecture/2026-08-02-azure-solution-architecture.md),
[`docs/architecture/2026-08-02-application-architecture.md`](../architecture/2026-08-02-application-architecture.md) §1/§4/§6,
[ADR-0006](../adr/0006-autonomous-send-designed-deferrals-lifted.md),
[`CONTEXT.md`](../../CONTEXT.md),
[`docs/superpowers/specs/2026-08-03-autonomous-send-design.md`](../superpowers/specs/2026-08-03-autonomous-send-design.md)

**Calibration check up front:** I do not dispute any of the Azure doc's §11 exclusions (AKS,
multi-region, Front Door/WAF, DDoS Standard, service mesh/event streaming, Prometheus/Grafana, an
SRE/SLO program, a compliance program). At "dozens to a few hundred accounts, a handful of
reviewers," every one of those is correctly ruled out for the reason given, and I'm not
re-litigating them. This review's job is the opposite failure mode: finding what's missing or
mis-costed, not adding scaffolding back in.

**Marking convention:** claims about exact Azure pricing, quotas, or service limits that I can't be
certain are current are marked **[verify]**. Everything else is either a concrete technical fact
about how the service works (feasibility) or an explicit judgment call (preference), labeled as such.

---

## 1. Feasibility check

### 1.1 Networking: the doc conflates two different "private" mechanisms — real gap

The diagram and §7 both describe Postgres as reached via "private endpoint / VNet integration" as
if those are interchangeable options for the same resource. They are not, and this matters for the
Bicep:

- **Azure Database for PostgreSQL Flexible Server does not support the private-endpoint/Private
  Link model at all for its primary "private access" mode.** Its private-networking mode is **VNet
  integration via a delegated subnet** (delegated to `Microsoft.DBforPostgreSQL/flexibleServers`) —
  a different Azure networking primitive from the private-endpoint model Key Vault and Storage use.
  That delegated subnet **cannot** be the same subnet ACA's environment uses (delegated to
  `Microsoft.App/environments`) — a subnet can only carry one delegation. So "one VNet" in practice
  needs **at least two non-overlapping subnets** (ACA infra subnet + Postgres delegated subnet),
  plus a third if Key Vault gets its own private endpoint per §7's stated option.
- **Postgres VNet integration also requires a linked Private DNS Zone** for the server's private
  FQDN to resolve inside the VNet. This is a required companion resource the doc never mentions.
  Forgetting it is a common, easy-to-hit failure mode: the Flexible Server deployment either fails
  validation or the app can resolve the server name from outside the VNet but not from inside it,
  depending on how the zone link is missed.
- Minimum delegated-subnet size for Flexible Server and minimum ACA infra-subnet size are both real
  constraints the doc is silent on. **[verify exact current numbers]** — my recollection is the ACA
  **workload-profiles environment** requires at least a **/27** infra subnet, while the legacy
  Consumption-only environment type historically required a much larger **/23**. Whichever number is
  correct, the doc should state a subnet plan explicitly rather than "a VNet" — undersizing this is
  the kind of mistake that isn't visible until a resize is needed later and is disruptive to fix
  (subnet resize with existing dependents attached is not always a live operation).

**This is broken/missing, not a preference** — the doc's networking section reads as if reaching
Postgres privately is a one-resource decision; it's actually a subnet-planning decision with at
least three moving parts (two delegated/dedicated subnets minimum, a private DNS zone, and — if the
Key Vault option is taken — a third subnet plus its own private DNS zone for
`privatelink.vaultcore.azure.net`).

### 1.2 Workload profiles vs. Consumption — a framing gap, not a blocker

§2 recommends "Azure Container Apps (ACA), Consumption plan" as if that's a distinct environment
type from "workload profiles." **[verify current state]** — my understanding is that new Container
Apps environments are provisioned as **workload-profiles-enabled environments** by default now, with
a **Consumption** workload profile automatically available inside that environment (it isn't a
separate environment type you choose instead of workload profiles — it's one of the profiles inside
a workload-profiles environment, alongside optional Dedicated profiles you can add later without
recreating the environment). If that's still accurate, the practical implication for the Bicep is:
model the environment as workload-profiles-enabled with a Consumption profile from day one. This
costs nothing extra and keeps the door open to adding a Dedicated profile later (e.g. if the
orchestration worker's Claude-call latency ever needs more headroom than Consumption gives) without
an environment recreation. This is a small, cheap correction to make now, not a feasibility blocker
either way — everything else in the doc (scale-to-zero worker, min-replica apps, scheduled Jobs)
works identically under either framing.

### 1.3 Scheduled ACA Jobs sharing an image with the app — confirmed feasible

This is correct as designed. `Microsoft.App/jobs` is a separate resource type from
`Microsoft.App/containerApps`, but both attach to the same Container Apps Environment and can
reference the identical image/tag in ACR, differing only in trigger type (Schedule/cron for these
two jobs), command/args (the `--job=<name>` entrypoint switch the application doc specifies), and
resource allocation. Jobs also support their own system- or user-assigned managed identity for Key
Vault and ACR pull, same mechanism as the app. No gap here — the app-architecture doc's description
matches how ACA Jobs actually work.

### 1.4 Key Vault reference + managed identity — one real ordering gotcha

The doc says each Container App gets a "system-assigned managed identity" with Key Vault access,
used for Key Vault secret references. This is broadly right but has a **concrete deployment-ordering
problem worth flagging**: a system-assigned identity's principal ID doesn't exist until *after* the
Container App resource is created, but a Key Vault RBAC role assignment (and, in some Container Apps
API versions, the Key-Vault-reference secret configuration itself) needs that principal ID as an
input. Done naively in Bicep, this becomes a circular dependency (app needs the KV secret ref at
creation; KV role assignment needs the app's identity, which doesn't exist until the app is created).

The standard fix — and what I'd recommend for the Bicep — is to **create user-assigned managed
identities as their own top-level resources** (one per workload that needs Key Vault: console,
worker; Keycloak's identity goes away if §4's recommendation below is taken), assign them Key Vault
RBAC roles first, then attach each identity to its Container App at creation. This avoids the
ordering problem entirely and is a small, mechanical change from what's written (system-assigned to
user-assigned) — worth calling out explicitly in the module shape (§6 below) rather than leaving
implementers to discover the circular dependency themselves.

### 1.5 Min-replica billing — clarifying the mechanism, not a correction

Worth being explicit since the task calls this out: **min replicas = 1 does not mean a flat monthly
fee** — it means the platform keeps a replica allocated continuously and bills for every second it
exists, whether or not it's actively handling a request. ACA Consumption plan has separate **Active**
and **Idle** per-second billing rates (Idle is materially cheaper than Active, but never zero)
**[verify exact current rates]**. For a min=1 console or Keycloak replica sitting mostly unused
outside business hours, most of its billed time is at the idle rate, not the active rate — which is
consistent with (not a red flag against) the doc's own $20–35/mo estimates per min=1 app.

One thing the doc's cost table doesn't account for: ACA Consumption includes a **monthly free
grant** of vCPU-seconds/GiB-seconds/requests shared across the whole subscription
**[verify exact current amounts — I recall roughly 180,000 vCPU-seconds / 360,000 GiB-seconds /
2,000,000 requests]**. A single min=1 app running 24/7 at even 0.5 vCPU consumes roughly 1.3M
vCPU-seconds/month on its own — far past that free grant — so the grant doesn't meaningfully offset
the min=1 lines. It very likely **does** cover most or all of the scale-to-zero worker + scheduled
Jobs line at this invocation volume, meaning the §10 estimate of $5–15/mo for that line is probably
conservative (real cost plausibly closer to $0–5). Not a correction to the doc, just a note that
there's likely no further savings to chase there — the money is in the two min=1 apps, not the
scale-to-zero one.

### 1.6 Worker ingress — a missing but important detail

The application-architecture doc describes the Console API making synchronous internal calls to the
worker (`POST /internal/process-trigger/:id`, dispatch invocation) and the worker exposing "a small
internal HTTP server." The Azure doc's §7 networking section never states that this ingress should
be configured as **ACA internal ingress** (reachable only from within the Container Apps
Environment, not the public internet) rather than external ingress with some other access
restriction bolted on. This is a real, specific gap: internal-only ingress is a first-class ACA
setting (`ingress.external = false`), it's the correct mechanism here, and the doc should say so
explicitly rather than leaving "how is the worker's HTTP surface protected" implicit. Get this wrong
and the worker's internal API — which accepts trigger-processing and dispatch calls with no
end-user auth in front of it — is reachable from the internet.

### 1.7 ACR Basic tier — a minor, worth-naming inconsistency, not a bug

Everything else in §7 is private-endpoint/VNet-first. Azure Container Registry **Basic tier does
not support Private Link/private endpoints** (that requires Premium, a real cost step up —
**[verify current Premium price, historically roughly 8x Basic]**). So ACR necessarily stays a
publicly-reachable endpoint even in an otherwise all-private design, authenticated by managed
identity over HTTPS. This is normal, standard practice and not a security hole worth paying for —
I'm not recommending Premium — but the doc should say this explicitly (image pulls are the one
component that isn't network-isolated, and that's a deliberate, fine trade-off) rather than leaving
a reader to notice the inconsistency themselves.

---

## 2. Gaps created by autonomous send

ADR-0006 and the autonomous-send design change the risk profile the Azure doc's §7/§8 were written
against: every alert in the current §8 assumes a human was going to see the message before it went
out, and now an entire tier of messages skips that. The application-level design (gates, kill
switch, stuck-send reconciliation, audit sampling) is well thought through — but none of it has a
corresponding **infrastructure-level observability or alerting rule** in the Azure doc.

### 2.1 Missing alert: scheduled job silently stops running

Both the follow-up cadence job and the stuck-send reconciliation sweep are cron-triggered ACA Jobs
with nobody watching them by design. Before autonomous send, a stalled job just meant slower
approvals — a human would eventually notice an empty-looking queue. **Now, a stalled reconciliation
sweep means an autonomously-approved-but-dispatch-failed message sits silently "approved," never
sent, forever** — exactly the "silent failure in an autonomous path is invisible" risk the task
calls out. Recommend an explicit alert on ACA Job execution failure/absence (Azure Monitor can alert
on Container Apps Job run status), e.g. "no successful reconciliation-sweep run in the last N
hours," not just "the worker returned a 5xx."

### 2.2 Missing alert: message flagged after failed reconciled retry

The design spec (§8, error handling table) states that a message failing its reconciled retry too
"is flagged for human attention." The Azure doc's current §8 alert list has nothing that watches for
this specific state. This is the last line of defense for a dispatch failure on an autonomous send —
it needs its own alert (a Log Analytics query against the app's structured logs for this flag, or a
custom metric the worker emits), not just being folded into the generic "worker failures calling the
Claude API" rule, which is about a different failure mode entirely (LLM call failure, not
send/dispatch failure).

### 2.3 Missing alert: kill switch state changes

The autonomous-send design (§6) deliberately makes the kill switch cheap to flip off and asymmetric
about resuming, specifically because "the other person may be asleep." That's an application-level
UX decision, but there is no corresponding infra-level notification when the switch changes state.
Recommend a log-based alert (structured log line on toggle, routed to the same Action Group as
everything else in §8) firing on **both** transitions — pause (so the other team member finds out
immediately rather than only when they next open the console) and, especially, **resume** (the
riskier direction, per the design's own reasoning).

### 2.4 Missing alert: anomalous autonomous-send volume

The design explicitly and correctly rejects a hard volume cap ("no volume caps," §1). An **alert-only
tripwire is a different thing than a cap** and doesn't conflict with that decision — it doesn't block
anything, it just tells a human "more autonomous sends happened in the last hour than is normal,"
which is exactly the kind of signal that catches a classifier regression or a follow-up-cadence bug
before it becomes a dozen duplicate emails to the same accounts. This is cheap (one Log Analytics
query + alert rule against `LlmCall`/`Message` telemetry) and currently entirely absent from §8.

### 2.5 Missing alert: audit-sample review backlog

Audit sampling is now the *only* retrospective quality control on autonomous sends (first send always
sampled, then the configured rate). A growing backlog of `unreviewed` `AuditSample` rows silently
defeats the entire mechanism — nobody looking is functionally the same as nobody sampling. §8 has
nothing tracking this. Recommend an alert on "unreviewed audit-sample count exceeds N" or "oldest
unreviewed sample older than N days."

### 2.6 Missing: telemetry doesn't distinguish autonomous from human-approved sends

§8's existing alerts ("Console/API 5xx," "worker failures calling Claude API") are all tier-agnostic.
Application Insights auto-instrumentation sees HTTP/dependency calls, not the business distinction of
"was this an autonomous send." Recommend the Message Dispatch and Drafting modules emit an explicit
custom dimension (`isAutonomous`, `tierContext`) on their telemetry, so that all of the alerts above
can filter specifically to autonomous-tier activity rather than being blended into overall (mostly
human-reviewed, lower-risk) traffic. Without this, an alert threshold tuned for the whole system's
volume will under-react to a problem concentrated entirely in the unattended path.

### 2.7 Missing: Claude spend isn't covered by the existing budget alert, and volume is no longer human-throttled

§8 already has an "Azure Cost Management budget alert," and §10 already notes Claude API cost is
**not** an Azure line item and isn't covered by that budget. Before autonomous send, every message
had a human clicking "approve," which incidentally throttled volume. Autonomous send removes that
natural brake — a bug in the cadence job's fact-detection (e.g. `newFactsSince` misbehaving) could
drive materially more Claude calls than intended, and nothing in Azure Cost Management would notice.
Recommend a **separate** cost/usage alert on Claude spend, independent of the Azure budget alert —
this can't be an Azure Monitor rule against Anthropic's API directly, so it needs to be an
app-level check (daily/hourly token or call-count threshold against `LlmCall`, alerting through the
same Action Group) rather than assumed-covered by the existing Azure budget line.

### 2.8 Networking/security gap: no stated fail-safe direction for the kill-switch read

The design spec states dispatch "re-checks the switch immediately before sending." The Azure doc
never states what happens to that check if the underlying read fails (e.g. a transient Postgres
blip at exactly the wrong moment). This is a genuinely new requirement created by autonomous send:
previously nothing failed *open* into an unattended send, because a human was always the actual
gate. Now, if the kill-switch read errors, does dispatch fail-closed (treat any read failure as "hold,
don't send") or fail-open (send anyway on the assumption the switch was probably still off)?
The doc should state explicitly that this must fail-closed — an error reading the kill switch is not
the same thing as confirming it's off, and conflating the two turns a database hiccup into an
autonomous send nobody authorized.

### 2.9 Networking/security gap: no provider-side velocity guard called out

None of §7's networking hardening addresses the outbound email channel at all, because that channel
didn't exist as a concern when the doc was written. Whichever channel is chosen (§3 below), it's
worth §7 explicitly noting that provider-side sending-velocity limits (most mail-sending platforms
enforce some tenant/account-level rate limit by default) act as an independent, infrastructure-level
backstop against a runaway autonomous-send bug, separate from and in addition to the app's own gates.
This is a "worth stating," not a "must build" — most providers already do this by default — but it's
currently unaddressed anywhere in the doc.

---

## 3. Outbound email infrastructure — the largest gap

The Azure doc doesn't mention outbound email at all; the application doc explicitly leaves Message
Dispatch as a placeholder. With autonomous send now designed, this is no longer deferrable — an
unattended path is about to start sending real email to real prospects with nobody reading it first.

### 3.1 Option A — Microsoft Graph `sendMail` via an Entra app registration

- **Mechanism:** an Entra ID app registration with the `Mail.Send` application permission, calling
  Graph's `sendMail` API with client-credentials auth (fits the managed-identity/Key-Vault pattern
  already established in §5 of the Azure doc — the app's client secret or certificate lives in Key
  Vault the same way the Anthropic key does).
- **Security note, stated plainly:** the `Mail.Send` **application** permission, granted tenant-wide,
  lets the app send as **any** mailbox in the tenant unless scoped down. The correct configuration is
  an Exchange Online **Application Access Policy** restricting that app registration to one specific
  mailbox. This is a one-time Exchange admin configuration step, not an Azure resource, and it's easy
  to skip — worth naming explicitly as a required step, not an optional hardening measure.
- **Cost:** no new Azure line item, assuming Erria already has Microsoft 365/Exchange Online (the
  Azure doc's own §4 already assumes this is "likely" for a Microsoft-ecosystem Danish SME, but that
  assumption is unconfirmed — see recommendation below). Needs a mailbox to send "as" — a shared
  mailbox on the tenant, which is typically included at no extra license cost up to a size limit on
  most M365 plans **[verify current licensing terms]**.
- **Deliverability — the strongest argument for this option:** sending through Microsoft 365's own
  outbound infrastructure, from a mailbox in an already-established, presumably already-warm
  corporate tenant, means SPF/DKIM for the sending domain are very likely **already configured**
  (Microsoft 365 signs outbound mail for verified domains by default) — this is real infrastructure
  reuse, not new reputation being built from zero.
- **Real operational risk this option specifically has:** automated, higher-volume sending through a
  regular tenant mailbox can trip the **tenant's own outbound spam/abuse detection** — cold B2B
  outreach at any real cadence looks structurally similar to what anti-abuse systems are built to
  catch, even when it's fully legitimate and even when it's "your own" infrastructure. This is worth
  taking seriously precisely because it's not a hypothetical third-party's spam filter, it's your own
  tenant's.
- **Bounce/complaint handling gap:** Graph `sendMail` gives you **no native bounce or complaint
  webhook**. Bounces arrive as NDR emails back into the sending mailbox's inbox; there is no
  structured event you can subscribe to. At this volume, a periodic job (naturally, one more
  scheduled ACA Job, or folded into an existing one) reading the mailbox via Graph and
  pattern-matching NDRs is workable, but it's something the team builds, not something the platform
  gives you.
- **Send-rate limits:** Exchange Online enforces tenant/mailbox-level recipient limits (historically
  on the order of thousands of recipients/day per mailbox **[verify current number]**) — irrelevant
  at "dozens to a few hundred accounts, a handful of messages/week," noted only for completeness.

### 3.2 Option B — Azure Communication Services (ACS) Email

- **Mechanism:** an Email Communication Service resource, either an Azure-managed subdomain
  (`*.azurecomm.net` — fast to start, but recipients see an unfamiliar sending domain, which is a
  real trust/deliverability cost for cold **B2B** outreach specifically) or a verified custom domain
  (Erria's own domain or, better, a dedicated subdomain — see §3.4).
- **Cost:** pay-per-email, no fixed monthly minimum **[verify current per-email/per-recipient
  rate — I recall this being priced in the sub-$0.001/email range, but I'm not confident that's
  current]**. At a few thousand emails/month for this scale, this is very likely a low single-digit
  dollar amount regardless of the exact rate.
- **Real operational advantage over Option A:** ACS integrates with **Azure Event Grid** for
  delivery-status and engagement events (Delivered, Bounced, Suppressed, etc.) — a genuine,
  structured, Azure-native bounce/complaint signal, which Option A simply doesn't have. This matters
  for this system specifically because a bounced send probably shouldn't count toward a Clean
  Approval or feed the promotion counter — right now there's no data source for that distinction at
  all, and ACS is the only option of the three that gives you one natively.
- **Real cost this option carries that Option A doesn't:** a brand-new sending domain (or even a
  brand-new subdomain of an old domain) still has to build reputation from zero on ACS's shared
  sending infrastructure — there's no shortcut, and this is exactly where cold-B2B deliverability
  characteristics (§3.4) bite hardest.
- Fits the same managed-identity/Key-Vault wiring pattern as everything else in the Azure doc.

### 3.3 Option C — Third-party relay/ESP (SendGrid, Postmark, Mailgun, etc.)

- **Cost:** typically has a free tier covering several thousand emails/month, comfortably above this
  system's volume, with low-tens-of-dollars paid tiers above that **[verify — pricing on these
  changes frequently and I have no current data to stand behind]**.
- **Operational strength:** the most mature bounce/complaint/deliverability tooling of the three
  options — native webhooks, dedicated-IP and warm-up guidance, reputation dashboards. This is
  genuinely the best-built option for managing sender reputation as a first-class concern.
- **Real cost this option has that the other two don't:** it's a **new third-party data processor**
  handling B2B contact data, under Danish GDPR — that means an actual new Data Processing Agreement
  to execute and track, a new vendor to manage credentials/billing for, and a dependency entirely
  outside the Microsoft ecosystem the rest of this system (and the team) already lives in. Options A
  and B stay inside Erria's existing Microsoft data-processing terms (assuming M365 tenancy exists);
  this one doesn't.
- Same DNS work required (SPF/DKIM/DMARC pointing at the provider) as ACS.

### 3.4 Cross-cutting: SPF/DKIM/DMARC and cold-B2B deliverability

Regardless of which option is chosen:

- **SPF has a hard constraint worth naming explicitly:** a domain can only have **one** SPF TXT
  record; every authorized sender must be listed in it. If Option A is chosen and the sending domain
  already has an SPF record for regular company mail, adding a new sending path means **editing** the
  existing record, not adding a second one (a second SPF record is invalid and gets ignored, silently
  degrading rather than erroring). This is an easy, quiet way to break deliverability without any
  visible failure.
- **DKIM** needs its own CNAME/TXT records added per provider (Graph/M365 typically already has this
  if the tenant is established; ACS and third-party ESPs issue their own DKIM records to add).
- **DMARC** should exist (start at `p=none` for visibility, tighten later) regardless of channel.
- **Recommend a dedicated subdomain for this traffic** (e.g. `outreach.erria.com`), not the apex
  domain, whichever channel is picked. This isolates whatever reputation risk cold outreach carries
  from Erria's regular business email on the same domain — a subdomain's reputation is independent of
  the parent domain's, so a deliverability problem in the outreach system doesn't put ordinary
  company email (invoices, correspondence) at risk, and vice versa.
- **State explicitly, because it's easy to assume otherwise:** cold B2B outbound email has
  meaningfully worse inbox-placement characteristics than transactional email **even with perfect
  SPF/DKIM/DMARC**, because mailbox providers' spam classifiers weight unsolicited-first-contact
  content and sales language regardless of sender authentication correctness. The mitigation for this
  is not infrastructure — it's a slow volume ramp-up on any new sending domain/subdomain, and close
  monitoring of bounce/complaint rates in the first weeks. This is exactly the kind of risk the
  design's own audit-sampling mechanism (tone drift) is positioned to help catch, but it's a
  content/behavioral concern, not something a channel choice fixes.

### 3.5 Recommendation

**Microsoft Graph `sendMail` via a scoped Entra app registration (Option A)**, sending from a
dedicated shared mailbox on a subdomain if the tenant supports it, with an Exchange Online
Application Access Policy restricting `Mail.Send` to that one mailbox — **contingent on confirming
Erria actually has an M365/Exchange Online tenant** (the Azure doc only assumes this as "likely" in
§4; this review doesn't have that confirmed). Reasoning: zero new Azure cost, zero new vendor/DPA,
inherits already-existing (presumably already-warm) SPF/DKIM rather than building reputation from
zero, and keeps the whole system inside the Microsoft ecosystem the team is already in (same
reasoning the Azure doc itself gives for reconsidering Keycloak → Entra ID in §4). The accepted
trade-off is manual/semi-automated bounce handling (a periodic Graph-based NDR scan, not a native
webhook) — a reasonable v1 gap at this volume, not worth adopting ACS purely to get Event Grid
bounce events this scale doesn't yet need.

**If Erria does not have an M365 tenant**, ACS Email becomes the stronger recommendation instead —
still the cheapest new-infrastructure option, Azure-native (fits the existing managed-identity/Key
Vault pattern), and gives real bounce/complaint events Option A can't, at the cost of building
sending-domain reputation from scratch.

Either way, defer Option C (third-party ESP) unless/until bounce/complaint tooling genuinely becomes
a burden at higher volume — its superior tooling isn't worth a new GDPR sub-processor relationship at
this scale.

---

## 4. Cost optimization against the §10 table

| §10 line | Current estimate | Lever | Est. saving | What it costs |
|---|---|---|---|---|
| Keycloak (min=1) | $20–35/mo | **Drop Keycloak, use Entra ID app registration + OIDC instead** (§4 of the Azure doc already names this as a future option) | Full $20–35/mo, plus removes a Postgres schema/database and an indefinite Keycloak-image patch/CVE burden | Requires actually reconsidering a "decided" choice now rather than later — see below |
| Key Vault private endpoint | (rolled into "$10–15 private endpoints/VNet" line) | Take the doc's own already-offered alternative: Key Vault firewall + VNet service endpoint instead of a private endpoint | Roughly one private endpoint's worth, **[verify current private-endpoint hourly rate — historically on the order of $7–8/mo each plus data processing]** | Marginally less consistent with the rest of the "everything private" design, but the doc itself already calls this "defensible" — just commit to it |
| Console (min=1) | $25–35/mo | Time-windowed scale-to-zero via a **KEDA Cron scale rule** (ACA Consumption supports custom KEDA scalers) — min=0 outside Danish/Vietnamese business hours, min=1 during | Roughly half the line if adopted, since ~16–18 of 24 hours/day currently billed at idle would go to zero | **Directly contradicts the doc's own stated goal** ("reviewers never hit a cold start") — first request each morning/after-hours pays a cold start. Present as optional, not a clear win |
| Postgres geo-redundant backup | (rolled into the $20–35 Postgres line) | Downgrade to locally-redundant backup, since the doc's own §9 DR story (redeploy Bicep, restore from backup) doesn't currently include a tested cross-region restore runbook that geo-redundancy is actually protecting | Likely small — geo-redundant backup storage is usually a modest multiple of an already-small backup-storage cost at this DB size **[verify]** | Loses protection against a full regional outage specifically — honest trade-off, not free |
| Log Analytics / App Insights | $10–20/mo | Set an explicit, low daily ingestion cap number in the Bicep (the doc says "capped" but never states a number) | Not a new lever, just closing a precision gap — savings depend on what number gets picked | None — this traffic volume doesn't need much |
| Worker + scheduled Jobs | $5–15/mo | No cut recommended — likely already mostly covered by ACA's monthly free grant at this volume (§1.5 above); the $5–15 estimate is plausibly conservative already | $0 (informational only) | — |

**Total defensible, low-risk cut: roughly $30–45/mo** (Keycloak removal + Key Vault private-endpoint
swap), against a $100–160/mo total — a meaningful 20–30% reduction with no loss of anything the team
actually needs. The console scale-to-zero option is real money too but trades directly against a
design goal the doc stated deliberately, so I'm not folding it into the "defensible" total above.

### Is Keycloak (min=1, $20–30/mo) the best use of that money? No.

This is worth stating as a direct answer, not just a line item. That's roughly **15–25% of the
entire Azure bill** spent keeping one identity-provider container warm, for a system whose users are
exclusively Erria's own employees — a textbook workforce-identity scenario. The Azure doc's own §4
already makes the case for Entra ID as a future alternative and gives the right reasons (all users
are internal employees; Erria likely already has an Entra ID/M365 tenant these employees exist in;
self-hosting means owning Keycloak's version/CVE lifecycle indefinitely, a cost ACA's infra
management doesn't remove). Given that this review is happening anyway, I'd go further than the
Azure doc did and recommend **making this call now, for v1, not deferring it**: standing up Keycloak
on ACA and then migrating off it later is strictly more total work than not standing it up in the
first place, and every reason the Azure doc gives for revisiting later already applies today — none
of them are contingent on the team growing or on some future trigger. This is a preference/judgment
call, not a feasibility problem (self-hosted Keycloak on ACA does work) — but it's a specific,
reasoned disagreement with "this is the decided choice, not relitigated here," made because the
review was explicitly asked whether this is the best use of the money, and the honest answer is no.
Dropping Keycloak also removes its own database schema and simplifies the ACA environment from four
workloads to three (or two, if the worker+jobs count as one conceptually) — a second-order
operational simplification covered again in §5.

---

## 5. Operational simplifications a two-person team could drop or defer

- **Keycloak, per §4 above** — the single biggest simplification available: one fewer container
  image to patch, one fewer database schema, one fewer custom-domain/TLS-cert/redirect-URI set to
  keep in sync, in addition to the cost saving.
- **IP allow-listing on the console's ingress (§7).** The doc frames this as cheap because the user
  population is small and fixed — but the same doc separately mentions Vietnam-based reviewers, and
  reviewers connecting from residential or mobile connections generally don't have static IPs. If
  that's the actual situation, the allow-list either needs constant upkeep (real ongoing toil for a
  two-person team) or silently locks people out. Recommend deferring this and relying on OIDC + browser
  session as the actual access control, unless Erria can confirm all reviewers sit behind a fixed
  VPN egress IP — worth a direct question rather than an assumption either way.
- **Bicep-or-Terraform optionality (§6 of the Azure doc).** Carrying two IaC-tool options into an
  actual implementation is a live decision left unmade. Terraform additionally requires its own
  remote-state backend (typically a storage account with locking) to secure and back up — one more
  thing to operate. Recommend committing to Bicep now (native, first-class ACA support, no extra
  state-backend to run) and dropping the Terraform mention.
- **Geo-redundant Postgres backup, per §4's cost table** — also an operational simplification: fewer
  DR modes to reason about and (if ever) test, at the honest cost of not surviving a full regional
  outage.
- **The private-endpoint-vs-firewall ambiguity for Key Vault (§7)** — same point as above: pick one
  now rather than leaving "either is defensible" as an open decision for implementation time.

---

## 6. Bicep/IaC module shape

Not writing the Bicep itself, per the brief — the decomposition I'd actually use:

- `main.bicep` — resource-group-scoped orchestrator; environment-specific values via
  `main.staging.bicepparam` / `main.prod.bicepparam` (two environments, per the Azure doc's §6).
- `modules/network.bicep` — VNet; ACA infra subnet (workload-profiles-sized); Postgres delegated
  subnet; optional private-endpoint subnet (only if Key Vault keeps a private endpoint — see §4/§5);
  the Postgres private DNS zone and its VNet link (§1.1's gap, made explicit here).
- `modules/identity.bicep` — one **user-assigned** managed identity per workload needing Key Vault
  access (console, worker), created ahead of the Container Apps that use them specifically to avoid
  the ordering problem in §1.4.
- `modules/keyvault.bicep` — the vault, RBAC role assignments against the identities from
  `identity.bicep`, and (decision from §4/§5) either its private endpoint or its VNet
  service-endpoint firewall rule.
- `modules/postgres.bicep` — Flexible Server, database(s) (app schema + Keycloak schema, or just the
  app schema if Keycloak is dropped per §4), backup configuration (locally- vs. geo-redundant per the
  §4/§5 decision), VNet integration against the delegated subnet.
- `modules/acr.bicep` — registry (Basic tier) + pull-role assignments for the identities.
- `modules/containerapps-env.bicep` — the shared, workload-profiles-enabled Container Apps
  Environment (Consumption profile), Log Analytics workspace (with an explicit daily cap value),
  Application Insights.
- `modules/containerapp.bicep` — one parametrized module invoked per app (console, worker, and
  Keycloak only if retained) — parameters cover min/max replicas, external vs. internal ingress
  (worker = internal per §1.6), identity binding, secrets (Key Vault references), and the KEDA Cron
  scale rule if the business-hours scaling option from §4 is adopted for the console.
- `modules/containerapp-job.bicep` — one parametrized module invoked per scheduled job (follow-up
  cadence, stuck-send reconciliation, audit-sample maintenance), same image reference as
  `containerapp.bicep`'s worker instance, differing only in cron schedule and `--job=` argument.
- `modules/monitoring.bicep` — the Action Group plus every alert rule, including the seven new ones
  from §2 (job-silence, flagged-after-retry, kill-switch toggled, autonomous-send-volume anomaly,
  audit-sample backlog, Claude-spend threshold, and the existing baseline set from the Azure doc's
  original §8).
- `modules/budget.bicep` — the Azure Cost Management budget/alert (Azure spend only — the separate
  Claude-spend check lives in the app, not here, per §2.7).

This keeps the same "one module per resource concern" shape the Azure doc's own CI/CD section
implies, just with the identity-ordering fix (§1.4), the Postgres DNS/subnet gap (§1.1) made
explicit as first-class resources, and the new alert rules (§2) as their own additions to
`monitoring.bicep` rather than folded silently into the existing three.

---

## Summary of what needs a decision, not just a read

1. **Confirm whether Erria has an existing M365/Exchange Online tenant** — this determines whether
   §3's recommendation (Graph `sendMail`) or its fallback (ACS Email) is the right call, and it's
   currently an unconfirmed assumption in both the Azure doc (§4) and this review.
2. **Decide Keycloak vs. Entra ID for v1, now** — the biggest single cost/ops lever in this review,
   and one the Azure doc already argues for but defers.
3. **Confirm whether reviewers have static, allow-listable IPs** — determines whether §7's IP
   allow-listing recommendation is actually cheap (as the doc assumes) or ongoing toil (as the
   Vietnam-reviewer detail elsewhere in the same doc suggests it might be).
4. **Pick one Key Vault networking mechanism and one IaC tool** — both currently left as "either is
   fine," which is itself the thing to fix for a two-person team.
