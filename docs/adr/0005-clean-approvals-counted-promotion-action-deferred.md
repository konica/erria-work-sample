# Clean Approvals are counted; the promotion action itself is deferred

**Status:** accepted (temporary — lifts together with [ADR-0002](0002-tier-1-autonomous-send-deferred.md))

The approve→send flow increments `Account.cleanApprovalsCount` and writes a
`TierHistoryEvent(clean_approval)` on every unedited send with no negative signal since — the
promotion *signal* spec §8 calls "the core promotion signal." It stops short of the promotion
*action*: it never sets `Account.currentTier = 1`.

Reason: promoting an account to Tier 1 while autonomous send is deferred would make the tier badge
describe behavior the system cannot perform, and — because tiering derives
`accountAlreadyEarnedTier1` from `Account.currentTier` — would make ADR-0002's
`NotImplementedFlowError` reachable during normal operation, breaking trigger processing for the
very accounts that behaved best. This is the same principle
[ADR-0004](0004-tier-1-is-earned-never-set-manually.md) applies to the manual path, applied to the
earned path: Tier 1 stays unreachable while the behavior it names is unbuilt, so ADR-0002's throw
remains a genuine never-happens safety net rather than a scheduled outage.

**Consequences:** an account can accumulate clean approvals past
`Setting.tier1PromotionThreshold` and stay at Tier 2. The counter and its history entries are the
durable part — when autonomous send ships, promotion is a small addition that can act on accounts
that already qualify, with no backfill needed. Until then the console should show progress toward
promotion ("2 of 2 clean approvals") without claiming the account has been promoted.
