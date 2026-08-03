# Tier 1 is earned, never set manually

**Status:** accepted (temporary — revisit when autonomous send is designed)

The manual tier override control (v07 mockup) originally offered Tier 1, 2, and 3. It now offers
only **Tier 2 and Tier 3**: a human may manually demote an account, or restore it to Tier 2, but
may never manually grant Tier 1. Tier 1 is reached only by earning it — the clean-approval
promotion path in spec §3 — because Tier 1 means "the agent sends autonomously," and that is a
level of trust the rollout overlay deliberately makes an account demonstrate rather than something
an operator can hand out.

There is also a concrete implementation reason: [ADR-0002](0002-tier-1-autonomous-send-deferred.md)
defers autonomous send and makes a Tier 1 recommendation fail loudly. Since tiering reads
`accountAlreadyEarnedTier1` from `Account.currentTier`, a manually-set Tier 1 account would throw
`NotImplementedFlowError` on its next qualifying trigger — a human action would silently break
trigger processing for that account.

**Considered options:** offer Tier 1 but treat it as display-only (rejected — the tier badge would
stop describing actual behavior, and the whole point of the tier is that it states what the agent
is allowed to do); design autonomous send now to close the gap at its source (rejected for now —
deliberately deferred, see ADR-0002).

**Consequences:** the demotion direction stays fully manual and the promotion direction stays fully
earned, which is a cleaner rule than the original control expressed. Revisit this ADR together with
ADR-0002 — if autonomous send is ever built, whether Tier 1 becomes manually settable is a separate
question from whether it works.
