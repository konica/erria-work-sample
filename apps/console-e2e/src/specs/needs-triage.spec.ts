import { test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Needs Triage
//
// FAILS AS BUILT — gaps 1 and 2. Gap 1: no console navigation path reaches Vina Offshore Supply
// (see escalation.spec.ts). Gap 2: even once reachable, AccountDetailPage's Work tab only
// branches on "active escalation" vs. "pending message" (apps/console-web/src/AccountDetailPage.tsx)
// — a needs_triage Trigger with no Message falls into the same generic "Nothing awaiting review on
// this account" empty state as an account with nothing going on at all, and AccountDetail's API
// type carries no trigger-status field to distinguish them. This is the product bug the domain
// glossary itself warns Needs Triage is easy to get silently wrong on (CONTEXT.md). Skipped rather
// than asserting a screen state that doesn't exist yet; un-skip once both gaps are fixed.

test.skip('TC-TRIAGE-1 — The abstain path renders distinctly from an Escalation', () => {
  // FAILS AS BUILT — gaps 1 and 2: unreachable, and no distinct Needs Triage render state exists.
});
