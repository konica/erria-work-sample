# Modular monolith, not microservices

**Status:** accepted

Erria Outreach Agent runs as one codebase across two processes (a Console API and an Orchestration
Worker) sharing an internal domain-module library, rather than as separate deployed services. This
was decided independently at both the infrastructure layer (a 2-person team, no ops bandwidth for a
service mesh or Kubernetes) and the application layer (an approval touches a Message, an Account's
tier counters, and a TierHistoryEvent in one transaction — splitting that across services would
trade a single Postgres transaction for a distributed-consistency problem this team doesn't need).
See `docs/architecture/2026-08-02-azure-solution-architecture.md` §2 and
`docs/architecture/2026-08-02-application-architecture.md` §1 for the full reasoning.

**Consequences:** Module boundaries are enforced by the language/framework (NestJS's DI graph), not
by network topology — a boundary violation is a compile-time error, not something only code review
catches.
