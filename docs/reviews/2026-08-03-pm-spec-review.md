# Design Specification Review — 2026-08-01 Outreach Agent Design
**Review date:** 2026-08-03  
**Reviewer:** Product Manager (spec drift analysis)  
**Status:** Draft findings — all quotes verified for grep-able accuracy

---

## Overview

This document logs drift between the published spec (`2026-08-01-outreach-agent-design.md`), the latest mockup v07, and the design briefs that commissioned changes. Findings are prioritized by type and severity. All findings include exact verbatim quotes from source files for independent verification.

---

## Findings by Priority

### Priority 1: Self-contradictions in the spec

#### Finding 1.1: Section 11 claims eligibility filtering is configurable, but Section 12 does not list it
**Confidence:** High — clear contradiction

**Spec quote from §11 (lines 256–257):**
> "The sample rate, and which Tier 1 sends are eligible for sampling (e.g. excluding the highest-tenure accounts once they have a long clean history), are admin-configurable — see §12."

**Spec quote from §12, "Freely adjustable" section (lines 264–265):**
> "- Tier 1 promotion threshold — clean approvals required before Tier 1 (integer, 1–4, default 2)
> - Tier 1 audit-sample rate (percentage, default 10%)"

**Problem:** Section 11 claims eligibility filtering (e.g., "excluding high-tenure accounts") is admin-configurable and directs the reader to §12 for details. Section 12 lists only two "Freely adjustable" settings: promotion threshold and sample rate. There is no mention of eligibility filtering in Section 12's Freely Adjustable, Adjustable with Confirmation, or Locked categories. Either §11 should not claim this is configurable, or §12 should list it.

**The mockup's approach:** The v07 mockup implements only the Tier 1 audit-sample rate setting (default 10%), not eligibility filtering. This is consistent with §12, but violates §11's claim.

**Proposed revision for spec:**

Option A (align §11 to §12's current design — preferred for v1 scope):
Replace line 256–257:
```
- The sample rate, and which Tier 1 sends are eligible for sampling (e.g. excluding the
  highest-tenure accounts once they have a long clean history), are admin-configurable — see §12.
```
with:
```
- The sample rate is admin-configurable per §12. Eligibility filtering (e.g., excluding
  highest-tenure accounts) is deferred and not v1.
```

Option B (expand §12 if eligibility filtering is actually intended):
Add to §12's "Freely adjustable" section:
```
- Tier 1 audit-sample eligibility — which account types are included in sampling (e.g., minimum tenure required).
```
and provide mock UI/default behavior. (Not recommended unless design/brief supports it; no brief mentions this.)

---

### Priority 2: Spec describes behavior the v07 mockup does not have

None identified. The mockup implementation is fully aligned with the spec's explicitly scoped behaviors.

---

### Priority 3: Briefs commissioned real changes that the spec never absorbed

None identified. The spec (particularly §10–12) was updated to incorporate all changes from the design briefs (v4 Settings/Send Audit, v5 fixes, manual tier override, v08 corrections). The spec is current.

---

### Priority 4: Structural or numbering defects

#### Finding 4.1: Numbered section "8. Evaluation approach" calls out sampling as "Pre-send," but content describes retrospective (post-send) sampling
**Confidence:** Medium — terminology inconsistency, not functional error

**Spec quote from §8 heading & content (lines 181–184):**
> "## 8. Evaluation approach
> 
> - **Pre-send review sampling**: even at Tier 1, a fixed percentage of autonomous sends are
>   logged for retrospective human spot-check (not blocking, but tracked) to catch tone drift early."

**Design brief quote from v4-settings-audit.md (Purpose section):**
> "Purpose: a fixed sample of Tier 1 autonomous sends (already sent — this is retrospective, not a gate)"

**Problem:** The section heading "Pre-send review sampling" suggests sampling happens before sends are made (i.e., a gate). The content immediately contradicts this by stating the sampling is "retrospective" (after-send) and "not blocking." The brief v4 confirms the intent: "already sent — this is retrospective."

**Proposed revision:**

Replace "Pre-send review sampling" heading/bullet (line 183):
```
- **Retrospective send review sampling**: even at Tier 1, a fixed percentage of autonomous sends are
  logged for retrospective human spot-check (not blocking, but tracked) to catch tone drift early.
```

Or, to preserve "Pre-send" while clarifying (less preferred):
```
- **Pre-send audit logging (retrospective review)**: at send time, a fixed percentage of Tier 1
  autonomous sends are logged for retrospective human spot-check...
```

---

### Priority 5: Wording that undercuts the spec's own stated principles

#### Finding 5.1: Spec uses "settings change log" and "access control" interchangeably when they are separate concepts
**Confidence:** Low-to-medium — may not constitute a defect, but wording is ambiguous

**Spec quote from §12, "Deferred, not v1" (lines 281–287):**
> "**A settings change log.** v04's mockup included one (who/what/when/old→new), but on review this
> was cut for v1: a change log only means something once there's also a concept of *who* is allowed
> to change settings, and this design deliberately isn't building access control yet either (a
> two-person team sharing one login has no one to distinguish from whom). Logging changes without
> that distinction gives an appearance of accountability the system can't actually back up. Revisit
> both together — not the log alone — if the team grows past two people or introduces role
> separation."

**Context from design brief v5-fixes.md (lines 12–18):**
> "Remove the "Change log" section from the bottom of the Settings screen entirely...
> **Why, so this doesn't look like an oversight if questioned later:** a change log only means
> something once there's also a concept of *who* is allowed to change settings — and this app
> deliberately isn't building access control yet either. A two-person team sharing one login has no
> one to distinguish "M. Tran changed X" from. Logging changes without that distinction gives an
> appearance of accountability the system doesn't actually back up. Both the log and access control
> are deferred together, not the log alone — this is a scope decision, not a gap."

**Analysis:** The spec's reasoning is sound, but the phrasing "a change log only means something once there's also a concept of *who*" conflates two separable concerns:
1. **Logging capability** (what changed, when) — does not require knowing *who* made the change.
2. **Attribution** (who made the change) — requires access control / user identity distinction.

A change log recording *what* and *when* is still meaningful for a one-person team or a team sharing one login (e.g., for auditing "when did the sentiment threshold last change?"). The spec is actually cutting the log because of a design principle (no false accountability), not because the log is inherently meaningless without RBAC.

**Proposed revision (minor — improves clarity, not critical):**

Replace lines 281–287:
```
**A settings change log.** v04's mockup included one (who/what/when/old→new), but on review this
was cut for v1: a change log only means something once there's also a concept of *who* is allowed
to change settings, and this design deliberately isn't building access control yet either (a
two-person team sharing one login has no one to distinguish from whom). Logging changes without
that distinction gives an appearance of accountability the system can't actually back up. Revisit
both together — not the log alone — if the team grows past two people or introduces role
separation.
```

with:
```
**A settings change log.** v04's mockup included one (who/what/when/old→new), but on review this
was cut for v1. The reason: a team sharing one login has no way to distinguish *who* made a change
(all changes would be attributed to the same user), creating an appearance of accountability the
system doesn't actually provide. A log alone (what/when) would be meaningful for auditing, but
logging without attribution is deferred to avoid false accountability. Revisit together with access
control if the team grows to introduce role separation.
```

**Impact:** Improves clarity of *why* the log was cut (design principle, not technical limitation), but does not affect functional correctness of the design.

---

## Summary by Priority Category

| Priority | Count | Examples |
|----------|-------|----------|
| 1. Self-contradictions | **1** | §11 vs §12 eligibility filtering claim |
| 2. Spec vs mockup behavioral drift | 0 | — |
| 3. Brief-to-spec absorption gaps | 0 | — |
| 4. Structural/numbering defects | **1** | §8 "Pre-send" vs "retrospective" |
| 5. Hedged wording | **1** | Change log reasoning (low impact) |

**Total findings:** 3  
**Critical findings requiring fix:** 1 (Finding 1.1)  
**Recommended revisions:** 2 (Findings 1.1 and 4.1)  

---

## Single Most Critical Finding

**Finding 1.1: Section 11 promises configurable send-eligibility filtering that Section 12 never lists.**

The spec says eligibility filtering ("excluding high-tenure accounts") is configurable and directs readers to §12 for details, but §12 does not list it under any category (Freely Adjustable, Confirm-Required, Locked, or Deferred). This is a clear internal contradiction. The mockup correctly implements only the sample *rate*, not eligibility *filtering*, making it consistent with §12 but violates §11's claim. The spec should be revised to either (a) defer eligibility filtering explicitly, or (b) add it to §12 if it is intended for v1.

---

## Verification Notes

All quotes have been grep-verified against:
- `/docs/superpowers/specs/2026-08-01-outreach-agent-design.md` (spec)
- `/brainstorm/mockup/Erria-outreach-agent-v07/outreach-console.html` (v07 mockup)
- `/ideation/open-design-brief-v*.md` (design briefs)
- `/docs/adr/000*.md` (architecture decisions, confirmed settled)

No contradictions between the spec and the mockup were found outside of the spec's internal inconsistencies listed above. The mockup is a faithful implementation of the spec's intended behavior.

