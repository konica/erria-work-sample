import { test } from '../fixtures/test.js';

// docs/qa/uat-test-cases.md — Escalation (EscalationPanel)
//
// Both cases are marked BLOCKED — gap 1 in the UAT doc: the Account Queue only lists accounts
// with a pending_review Message (only Song Hong Shipping qualifies), and the sidebar's
// "Escalations" nav item has no click handler (apps/console-web/src/shell/Sidebar.tsx). There is
// no URL routing either (apps/console-web/src/shell/screens.ts), so no path — browser-driven or
// automated — reaches Truong Phat Marine's Account Detail today. Skipped rather than left to fail
// for a reason unrelated to the escalation flow itself; un-skip once a navigation path exists.

test.skip('TC-ESC-1 — Viewing an active Hard-Trigger escalation', () => {
  // BLOCKED — gap 1: no console navigation path reaches Truong Phat Marine.
});

test.skip('TC-ESC-2 — Resolving an escalation requires an outcome', () => {
  // BLOCKED — gap 1 (same reason as TC-ESC-1).
});
