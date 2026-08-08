# console-e2e

Browser-driven automation of the UAT test-case suite in
[`docs/qa/uat-test-cases.md`](../../docs/qa/uat-test-cases.md) (ticket 80, this ticket is 81 — see
that doc's own header for the four-ticket run). One spec file per test-case group in that document,
named to match (`TC-QUEUE-*`, `TC-WORK-*`, …) so a failure here traces straight back to its written
case.

## Running locally

Out of the box this targets a local `docker compose up` stack with no extra setup:

```bash
pnpm compose:up                                          # postgres + keycloak
pnpm --filter @erria/db run seed                          # the four demo accounts (#54)
pnpm build                                                 # @erria/db must be compiled — console-api/worker need it too
pnpm --filter console-api dev &                            # :3000
pnpm --filter worker dev &                                 # :3100
pnpm --filter console-web dev &                             # :5173
pnpm test:e2e
```

The first run installs Playwright's browser binaries automatically; to do it explicitly (or in an
environment without one cached already):

```bash
pnpm --filter console-e2e exec playwright install chromium
```

## Pointing it at a different environment

Nothing environment-specific is hardcoded. Override these environment variables to run the same
suite against another deployment (e.g. the review deployment, ticket 82) instead of local compose:

| Variable | Default (local compose) | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:5173` | The console's origin. |
| `UAT_REVIEWER_USERNAME` / `UAT_REVIEWER_PASSWORD` | `minh.tran` / `erria-dev` | A `reviewer`-role login. |
| `UAT_ADMIN_USERNAME` / `UAT_ADMIN_PASSWORD` | `huy.dinh` / `erria-dev` | An `admin`-role login (needed for the Settings cases). |

The local defaults are the two dev-seeded Keycloak users from `keycloak/realm-export.json` /
`keycloak/dev-entrypoint.sh` — throwaway dev values, not secrets, same as the rest of `.env.example`.
Never commit real credentials for another environment; export them in your shell instead:

```bash
BASE_URL=https://erria-outreach.duckdns.org \
UAT_REVIEWER_USERNAME=uat-qa-reviewer UAT_REVIEWER_PASSWORD='<handed out per docs/qa/uat-round-1-testers.txt>' \
UAT_ADMIN_USERNAME=uat-qa-admin UAT_ADMIN_PASSWORD='<...>' \
pnpm test:e2e
```

## Why some specs are skipped

Three of the four seed accounts have no navigation path to their Account Detail screen in the
console as built today, and Needs Triage has no distinct render state even where it is reachable —
both are documented as known gaps in `docs/qa/uat-test-cases.md`, not bugs in this suite. Automation
hits the same wall a human UAT tester does, so rather than leaving permanently-failing tests in the
suite, the affected specs are `test.skip` with a comment citing the exact gap:

- `escalation.spec.ts` (TC-ESC-1/2) and `resolution.spec.ts` (TC-RES-1) — **BLOCKED, gap 1**: no
  click path reaches Truong Phat Marine / Dai Duong Shipping (`Sidebar.tsx`'s Escalations nav item
  has no handler, and there's no router/deep link).
- `needs-triage.spec.ts` (TC-TRIAGE-1) — **FAILS AS BUILT, gaps 1 and 2**: unreachable for the same
  reason, and even once reached, `AccountDetailPage`'s Work tab has no distinct Needs Triage render
  state to assert on.

Un-skip each once the console gains the corresponding navigation path / render state — the test
bodies already document the intended behavior from the UAT doc so there's a clear starting point.

## Work-tab tests and shared seed data

TC-WORK-1/2/3 (`work-tab.spec.ts`) each act on Song Hong Shipping's one seeded pending-review draft
and are mutually exclusive against it in a manual UAT pass (see the UAT doc's "known gap 4"). This
suite resets that one draft straight back to its seed-time values before each test — see
`src/fixtures/db-reset.ts` — via a direct `@erria/db` connection, rather than requiring a full
`pnpm compose:reset` between cases. The same reset also runs once in `src/global-setup.ts` so a
repeat `pnpm test:e2e` run (without a manual reseed) starts from the same baseline as a fresh one.

Because of this shared, mutated state, the suite runs with a single worker
(`fullyParallel: false`, `workers: 1` in `playwright.config.ts`) — the Queue tests assert on exactly
one row, which wouldn't hold if a Work-tab test ran concurrently against the same account.

## CI

Not wired into CI by this ticket — out of scope per ticket 81's acceptance criteria. `pnpm test:e2e`
is a standalone script at the repo root, ready to add to a workflow later.
