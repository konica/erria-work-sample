# Hard-Trigger Rule 5's Tier-2 cap is message-level only, not an account demotion

**Status:** accepted

Spec §4 rule 5 caps any message citing a vessel's compliance/recertification deadline at Tier 2,
"even from an otherwise-earned Tier 1 account" — but the application architecture doc's Flow 1
narration was ambiguous about whether this also demotes `Account.currentTier`, or only caps that
one message's `tierContext`. Resolved as message-level only: `Account.currentTier` stays at 1, and
the cap is recorded as a `TierHistoryEvent(current_draft)` rather than a change to the account's
standing tier. Reasoning: spec §3's demotion clause is explicitly triggered by negative signals
(Hard-Trigger Rule 3, a distinct rule) — rule 5 is a content-based cap on messaging, not a signal
that something went wrong with the relationship, so treating it as a permanent demotion would
conflate two concepts the spec itself keeps separate.

**Consequences:** `Message.tierContext` and `Account.currentTier` can legitimately diverge for a
single message; any code reading "the account's tier" for a specific historical message must read
`Message.tierContext`, not `Account.currentTier`.
