# The MVP deploys to a single VM with docker-compose, not to managed Azure PaaS

**Status:** accepted
**Scope:** the MVP / stakeholder-review phase only. Does not supersede
[`docs/architecture/2026-08-02-azure-solution-architecture.md`](../architecture/2026-08-02-azure-solution-architecture.md),
which stands as the target state for when this outgrows one box.

The Erria Outreach Agent MVP runs as a single `Standard_B2s` virtual machine in West Europe running
docker-compose: Caddy, Console API, Orchestration Worker, Keycloak, and PostgreSQL. Every service is
self-hosted. The deployment exposes a public HTTPS URL so Erria stakeholders can use the app and give
feedback.

## Why not the managed PaaS design

The Azure solution architecture doc recommends Azure Container Apps plus PostgreSQL Flexible Server,
and that recommendation is sound — it is cheaper than Kubernetes, gives point-in-time restore for
free, and separates staging from prod. It is deferred rather than rejected for one reason: at the MVP
stage the priority is a cheap, self-contained deployment that stakeholders can look at, and a single
VM is about half the cost (~$44/month against ~$68–90) with no managed dependency to configure.

**AKS was considered and rejected on verified cost.** Self-hosting the same stack on AKS prices at
roughly **$107/month for one environment** — free-tier control plane, but 2 × `Standard_B2s` nodes
($70.08), a Postgres PVC ($9.60), a Standard Load Balancer for ingress (~$18), and a static IP
($4.38). That is more than the managed design costs for *two* environments, and more than double this
ADR's option, while adding cluster upgrades, ingress and cert-manager ownership to a two-person team
with no ops staff. Two nodes is also the floor rather than a comfortable target: AKS reserves ~1.1 GiB
per node for kubelet and system pods, and Keycloak on the JVM wants 1–1.5 GiB of what remains.

Notably, **managed PostgreSQL was never the expensive part.** Flexible Server B1ms is $14.53/month —
less than the load balancer AKS needs, and less than the node capacity plus disk that an in-cluster
Postgres consumes. The instinct that a managed database is the premium option does not survive
pricing it.

## What self-hosting costs, stated plainly

**No point-in-time restore.** The managed design got continuous backup and a ~15-minute RPO as a
property of the service. Here the backup story is a nightly `pg_dump` to Azure Blob and a restore
someone has actually performed. For the fictional seed data of the review phase this does not matter.
It starts mattering the moment real buyer correspondence accumulates, which is why the milestone that
enables real email sending is gated separately (see the deployment plan).

**One box is one failure domain**, and honest RTO is "rebuild from the compose file, restore the
dump." **Staging and prod are not separated** — the review deployment is the only environment.
**B-series VMs are burstable on CPU credits** (B2s baseline is 40% of 2 vCPUs), so sustained CPU —
Keycloak's JVM start, Prisma migrations — spends credits and can throttle.

## Consequences

**Keycloak stays, and no earlier decision is reversed.** Switching to Microsoft Entra ID was on the
table on cost and lifecycle-ownership grounds, and would have contradicted the landing/login brief.
Self-hosting settles it the other way: Entra ID is a managed external dependency, which is what this
platform choice is avoiding. Keycloak in compose is the coherent option, so the brief's decision
stands as written. Keycloak remains the largest memory consumer on the box and the reason its heap is
capped.

**Container Apps Jobs become cron.** The two scheduled behaviours (follow-up cadence, audit-sample
maintenance) run as `docker compose run --rm worker --job=<name>` from the host crontab — the same
image and the same entrypoint the ACA Jobs design specified, so no application code changes.

**IP allow-listing is out.** The Azure doc's §7 proposed it because the user population was small and
known; a public stakeholder URL means reviewers on arbitrary networks in Denmark and Vietnam. Keycloak
becomes the only gate, which raises what that gate has to be worth: no default admin credentials, the
admin console blocked at the reverse proxy rather than merely unlinked, login rate-limiting, and MFA
on any account that can approve a send.

**Message Dispatch gains two modes, and this is load-bearing.** A publicly reachable console that can
send real email is a console where a stakeholder clicking *Approve & send* emails a real shipowner.
Dispatch therefore runs in `sandbox` mode by default — persist, mark sent, render, call nothing
external — with `graph` mode enabled deliberately and never by default. This is cheap to do only
because [ADR-0001](0001-modular-monolith-not-microservices.md)'s module boundaries already isolate
Message Dispatch as a thin adapter with no business logic; the seam was in the right place before
there was a reason to use it.

## When to revisit

Any one of these is enough: real buyer correspondence exists and point-in-time restore starts being
worth its price; the review phase ends and staging needs to be separate from production; the single
failure domain becomes unacceptable; or the box runs out of memory. The destination in each case is
the existing Azure solution architecture doc, not a new investigation.
