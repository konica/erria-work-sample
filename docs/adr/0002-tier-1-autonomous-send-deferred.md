# Tier 1 autonomous sending is an explicit, deferred gap

**Status:** superseded by [ADR-0006](0006-autonomous-send-designed-deferrals-lifted.md) — autonomous
send is now designed, so the deferral this ADR records is lifted. Kept for the reasoning, which
still explains why the gap was left open deliberately rather than guessed at.

The behavior spec's tiering table (§3) defines Tier 1 as "agent sends autonomously," but none of
the four flows in the application architecture doc's §5 ever specify that path end to end — every
documented flow produces a Tier 2 draft awaiting human approval. Rather than infer an
autonomous-send implementation from the tier definition alone, the domain layer's tiering
evaluation (`recommendTierForTrigger`) is allowed to compute a Tier 1 recommendation, but the
persistence layer (`recordIncomingTrigger`) rejects it with a `NotImplementedFlowError` instead of
guessing at unbuilt behavior.

**Considered options:** silently cap every Tier 1 recommendation to Tier 2 (rejected — it would
quietly disable earned trust for accounts that qualify, with no visibility that it's happening);
implement a naive "draft and auto-send" path now (rejected — sending without a human in the loop
deserves its own design pass, not an afterthought bolted onto the trigger-arrival flow).

**Consequences:** Any Account that scores for genuine Tier 1 autonomous treatment will error loudly
(visible in `LlmCall`/error logs) rather than silently mis-behave, until a future plan designs the
autonomous-send flow properly.
