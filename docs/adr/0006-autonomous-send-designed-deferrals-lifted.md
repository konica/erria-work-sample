# Tier 1 autonomous send is designed; the ADR-0002 and ADR-0005 deferrals are lifted

**Status:** accepted
**Supersedes:** [ADR-0002](0002-tier-1-autonomous-send-deferred.md), [ADR-0005](0005-clean-approvals-counted-promotion-action-deferred.md)

Tier 1 autonomous sending now has a design:
[`docs/superpowers/specs/2026-08-03-autonomous-send-design.md`](../superpowers/specs/2026-08-03-autonomous-send-design.md).
Both earlier deferrals existed only because that behavior was unspecified, so both are lifted:
`recommendTierForTrigger` returning tier 1 stops being an error condition, and reaching the
Clean Approval threshold with an independently qualifying score performs the promotion instead of
stopping short of it.

The two ADRs those deferrals leaned on are **upheld, not weakened**.
[ADR-0003](0003-hard-trigger-rule-5-message-level-cap.md)'s message-level cap turns out to be the
general mechanism rather than a rule-5 special case: the design uses it for all four
hold-for-approval gates (kill switch, active escalation, rule 5, mid confidence), each holding one
message at Tier 2 without disturbing the account's earned tier.
[ADR-0004](0004-tier-1-is-earned-never-set-manually.md) becomes load-bearing rather than merely
protective — earning is now the only route to Tier 1, so the promotion path is the whole story of
how an account gets there.

**Consequences.** Three things that were blocked all unblock together: the promotion action, the
`NotImplementedFlowError` path (which becomes genuinely unreachable rather than deferred-and-
reachable), and Plan 4's Send Audit screen, whose `AuditSample` rows finally have a producer.

Two decisions in the design are worth surfacing here because they are the kind a future reader would
otherwise wonder about. The kill switch **defaults to off**, so autonomous sending is switched on
once, deliberately, by a human — the posture the rollout overlay takes toward individual accounts,
applied to the capability itself. And an autonomous message is persisted as `approved` with
`decidedBy = 'system (autonomous)'` before dispatch, which lets the existing stuck-send
reconciliation sweep cover autonomous failures unchanged and keeps "who decided to send this?"
answerable rather than null.
