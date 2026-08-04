# Frontend layout approach: porting the v07 mockup CSS/shell into React

**Author:** frontend-developer (read-only advisory pass)
**Scope:** how to port `brainstorm/mockup/Erria-outreach-agent-v07/outreach-console.html`'s
`<style>` block and app-shell markup into `apps/console-web`, without redesigning anything.
**Status:** recommendation only — no source files were created or edited to produce this.

This supersedes the CSS/shell parts of `docs/reviews/2026-08-03-pm-layout-scope.md` with concrete
file paths, code sketches, and one blocking finding that review didn't surface (see §0).

---

## 0. A blocking finding first: the two token sets don't match

Plan 1 Task 12 Step 1 says to `cp design-system/tokens.css apps/console-web/src/styles/tokens.css`
and stop there. That alone will not style anything. The mockup's `<style>` block defines its own
`:root` (lines 18–55) and `[data-theme="dark"]` (lines 56–82) with ~35 custom properties named
`--bg`, `--brand`, `--fg`, `--t1-fg`/`--t2-bg`/`--esc-bd`, `--radius-sm`, `--shadow-card`, `--mono`,
`--chip`, etc. `design-system/tokens.css` defines a *different, smaller* set of 6 semantic colors
named `--color-background`, `--color-brand-primary`, etc. — **no overlap in name, and the tier/
status/shadow/radius/font tokens (`--t1-fg`, `--esc-bg`, `--shadow-card`, `--radius-sm`, `--mono`,
`--chip`) don't exist in `design-system/tokens.css` or `tokens.json` at all.** They're only in the
mockup's `<style>` block, hand-authored there (not "extracted" per DESIGN.md's own provenance
notes).

Consequence: every component class the plans reference — `.badge.t2`, `.btn.primary`, `.q-row.esc`
— resolves a `var(--t2-fg)` or `var(--brand)` that is `undefined` if you only import the copied
`design-system/tokens.css`. Colors silently fall through to `currentColor`/transparent. This is
**not** a future problem; it breaks Plan 1 Task 12 and Plan 2 Task 9 as currently written the
moment their components render.

**Fix, folded into Ticket 1 below:** the file at `apps/console-web/src/styles/tokens.css` should be
a new file that reproduces the mockup's full `:root`/`[data-theme="dark"]` block (lines 18–82),
*aliased onto* `design-system/tokens.css`'s primitives where they genuinely overlap, so
`design-system/tokens.css` stays upstream source of truth for what it does define:

```css
/* apps/console-web/src/styles/tokens.css
   Base 6 colors sourced from design-system/tokens.css (re-copy that file on changes — see below).
   Everything else (tier/status colors, radius-sm, shadows, mono font, chip) is authored directly
   in the mockup's <style> block and has no design-system/ counterpart yet — ported verbatim from
   brainstorm/mockup/Erria-outreach-agent-v07/outreach-console.html lines 18–82.
   Ported: 2026-08-04, mockup v07. Re-run scripts checked in §2 against the next mockup version. */
@import "./design-system-tokens.css"; /* the literal copy from Task 12 Step 1, untouched */

:root {
  --bg: var(--color-background);
  --surface: var(--color-surface);
  --border: var(--color-border);
  --fg: var(--color-text-primary);
  --muted: var(--color-text-secondary);
  --brand: var(--color-brand-primary);
  /* ...tokens with no design-system/ counterpart, copied verbatim from the mockup: */
  --panel: #ffffff; --rail: #f7f8fb; --border-strong: #dbe3ef; --faint: #8a93a3;
  --brand-strong: #1a66a8; --brand-tint: #eaf2fa; --on-brand: #ffffff;
  --t1-fg: #475569; --t1-bg: #eef2f7; --t1-bd: #cdd8e6;
  --t2-fg: #b45309; --t2-bg: #fdf3e0; --t2-bd: #f0d4a2;
  --t3-fg: #b91c1c; --t3-bg: #fdeceb; --t3-bd: #f2bcb8;
  --esc-fg: #b91c1c; --esc-bg: #fdeceb; --esc-bd: #f2bcb8;
  --ok-fg: #15803d; --ok-bg: #e9f6ee; --ok-bd: #bfe3cc;
  --warn-fg: #b45309; --warn-bg: #fdf3e0; --warn-bd: #f0d4a2; /* used by .repeat-banner/.confirm-inline; not in the :root block itself but referenced — verify against mockup on next port, flagged below */
  --chip: #0f172a;
  --radius: 8px; --radius-sm: 6px;
  --shadow-card: 0 1px 2px rgba(15,23,42,.05), 0 1px 3px rgba(15,23,42,.04);
  --shadow-pop: 0 12px 28px rgba(15,23,42,.14), 0 4px 8px rgba(15,23,42,.08);
  --shadow-btn: 0 1px 0 rgba(15,23,42,.06), 0 2px 6px rgba(30,115,190,.28);
  --font: "Inter", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}
[data-theme="dark"] {
  --bg: var(--color-background); --surface: var(--color-surface); --border: var(--color-border);
  --fg: var(--color-text-primary); --muted: var(--color-text-secondary); --brand: var(--color-brand-primary);
  /* ...dark-theme values with no design-system/ counterpart, copied verbatim */
}
```

One more real gap this surfaced: I could not find `--warn-bd`/`--warn-bg` defined anywhere in the
mockup's `:root` blocks, yet `.repeat-banner`, `.confirm-inline`, `.set-hint` reference
`var(--warn-bd)`/`var(--warn-bg)` (lines 524, 582). Only `--warn-fg` is defined. This is a gap in
the **mockup itself**, not something introduced by porting — flag it back to the designer/PM rather
than inventing values silently; note it in the ticket rather than guessing a `--warn-bg`.

---

## 1. Where the CSS should live and how it's organized

**A small set of hand-authored global CSS files, split by concern, imported once at the app
entrypoint — not CSS Modules per component, not one 618-line file.**

```
apps/console-web/src/styles/
  design-system-tokens.css   # byte-identical copy of design-system/tokens.css (Task 12 Step 1, unchanged)
  tokens.css                 # the mockup's full :root/[data-theme=dark] superset, aliased onto the above (§0)
  base.css                   # reset, body/typography, svg base sizing, ::selection, button font-family
  layout.css                 # .app/.rail/.main/.topbar/.scroll — the grid shell
  components.css             # badge, btn, chip, icp, why, msg/thread, doss-card, tier-panel, decision,
                              # policy-tag, timeline, toast, pager — reusable across screens
  screens.css                # screen-specific blocks the mockup itself delimits with "SCREEN N" /
                              # "Account Detail" / "v4" comments: q-table/q-row, split-wrap, esc-*,
                              # detail-*, tier-panel-inline, sa-*, set-*, res-row
  index.css                  # `@import` of the five files above, in this order; imported once by main.tsx
```

This is not an invented taxonomy — it's cutting along the section-divider comments the mockup's own
author already wrote (`/* ---------- App layout ---------- */`, `/* ========== SCREEN 1 ========== */`,
etc.), so the split is mechanical, not a redesign decision.

**Why global CSS, not CSS Modules:** Vite supports `.module.css` with zero extra dependency, so
"no new runtime dependency" isn't the blocker — fidelity-to-source is. The mockup already ships a
flat, hand-namespaced convention (`q-`, `esc-`, `tp-`, `sa-`, `tl-`, `doss-`, `rl-` prefixes) with
selectors like `.info-wrap .dossier` and `.sa-row.flagged` that depend on *ancestor-context*
overrides, not just a component's own class. Porting these into CSS Modules means renaming every
`className="q-row esc"` to `styles.qRow + ' ' + styles.esc` (or composition), and the ancestor-
override rules (`.info-wrap .dossier`, `.detail-tab.active .tcount`) would need constant `:global()`
escapes across module boundaries — at that point you're not porting the mockup, you're translating
it, and every future diff against a re-exported mockup (§2) has to be translated again by hand.
Global classes let you copy-paste the mockup's own selector text into the split files above with
the class names unchanged.

**What this trades away, explicitly:**
- No automatic scope isolation — a stray class name collision between two components is possible
  and won't be caught by tooling. Mitigated cheaply: keep the mockup's existing short-prefix
  convention as a one-line house rule in `apps/console-web/src/styles/README.md` (or a comment atop
  `components.css`), and rely on the fact that there are ~40 mockup screens' worth of classes total,
  already collision-free today, and a 2-person team can `grep -rn '\.classname' src/styles` before
  inventing a new one.
- No "this class is dead" build-time detection. Acceptable: Vitest/RTL tests assert on roles/text
  per your constraint, not classes, so a dead or misspelled class fails a *visual* review, not a
  test — this is a real trade, not a free one, and is why §2's diff process matters more than it
  would with CSS Modules (which get closer to compile-time honesty for free).
- No colocation of a component's markup and its styles in one file. Acceptable for this size of
  app; revisit only if the team grows past ~3-4 frontend engineers or the stylesheet count grows
  past what `screens.css` can hold without becoming its own 600-line file again.

---

## 2. Keeping the ported CSS honest against future mockup revisions

No build tooling, no extraction pipeline — a checked-in snapshot plus `diff`.

1. Check in a byte-for-byte copy of the *currently-ported* mockup `<style>` block as
   `apps/console-web/src/styles/_mockup-snapshot.css` (leading underscore: reference-only, never
   `@import`ed, never linted as live CSS). This is the baseline for "what did we already port."
2. Put one line at the top of it: `/* snapshot of Erria-outreach-agent-v07/outreach-console.html
   <style> block, lines 11–628, as of 2026-08-04 */`.
3. When the designer re-exports a new mockup version (`v08/outreach-console.html`, say), the whole
   diff is one command, run by hand, no script required:
   ```bash
   sed -n '/<style>/,/<\/style>/p' brainstorm/mockup/Erria-outreach-agent-v08/outreach-console.html \
     > /tmp/v08.css
   diff apps/console-web/src/styles/_mockup-snapshot.css /tmp/v08.css
   ```
4. The diff output *is* the port list: each hunk names the selector that changed. Copy each
   changed rule into whichever of `layout.css`/`components.css`/`screens.css` currently owns that
   selector (the section-comment dividers make "which file" unambiguous — see §1's mapping).
5. Once ported, overwrite `_mockup-snapshot.css` with `/tmp/v08.css` and bump the version note.
   The next diff is against the new baseline, so drift never compounds.

This is deliberately *not* a lint rule or CI check — for a two-person team, "run one `diff`
command when a new mockup file shows up" is cheaper than maintaining a script that has to parse
CSS well enough to auto-merge, and the failure mode (someone forgets to diff) is caught the next
time someone eyeballs the running app next to the new mockup screenshot, which they'll do anyway
since fidelity is the whole point.

Optional, cheap enough to add later if it earns its keep: a 10-line Node/Vitest script that greps
every `className="..."` string literal out of `apps/console-web/src/**/*.tsx` and asserts each
individual class token appears somewhere in `styles/*.css` — catches typos, not semantic drift.
Not needed for v1.

---

## 3. App-shell decomposition

```
apps/console-web/src/shell/
  AppShell.tsx        # the `.app` grid: <Sidebar/> + the main column wrapper; owns nav-count fetch
  Sidebar.tsx          # `.rail`: brand chip, nav sections, rail-foot (settings + user)
  NavItem.tsx          # one `.nav-item` button: icon, label, optional count badge, active/attention state
  Header.tsx           # `.topbar`: breadcrumb + page title, (decorative) search, <ThemeToggle/>
  ThemeToggle.tsx      # `.theme-toggle` button, consumes useTheme()
  useTheme.ts          # see §4
  screens.ts           # the route table — same shape as the mockup's `NAV` const (icon/label/title/crumb)
```

`AppShell` replaces the mockup's `render()`/`renderNav()` pair. It does not know about individual
screens' data — it owns exactly what the mockup's shell owns: which nav item is active (derived
from the router, see below), the badge counts on Review/Escalations/Send Audit, and the theme.

```tsx
// apps/console-web/src/shell/screens.ts
export const SCREENS = {
  queue:       { icon: 'queue',      label: 'Account Queue', title: 'Account Queue', crumb: 'Accounts the agent is working', path: '/queue' },
  review:      { icon: 'review',     label: 'Review',        title: 'Review Worklist', crumb: 'Drafts awaiting approval across all accounts', path: '/review' },
  escalation:  { icon: 'escalation', label: 'Escalations',   title: 'Escalations', crumb: 'Accounts that need a human response', path: '/escalations' },
  audit:       { icon: 'audit',      label: 'Audit Trail',   title: 'Tier History', crumb: "How each account earned its tier", path: '/audit' },
  sendaudit:   { icon: 'sample',     label: 'Send Audit',    title: 'Send Audit', crumb: 'Retrospective spot-check of Tier 1 autonomous sends', path: '/send-audit' },
  settings:    { icon: 'gear',       label: 'Settings',      title: 'Settings', crumb: 'Tune the system', path: '/settings' },
} as const;
```

```tsx
// apps/console-web/src/shell/Sidebar.tsx (shape only)
export function Sidebar({ active, counts }: { active: keyof typeof SCREENS | 'detail'; counts: NavCounts }) {
  return (
    <aside className="rail">
      <div className="brand">
        <div className="brand-chip"><img src="/erria-logo.png" alt="Erria" /></div>
        <div><div className="brand-name">Erria</div><div className="brand-sub">Outreach Agent</div></div>
      </div>
      <div className="nav-label">Workspace</div>
      <NavItem screen="queue" active={active === 'queue'} />
      <NavItem screen="review" active={active === 'review'} count={counts.review} />
      <NavItem screen="escalation" active={active === 'escalation'} count={counts.escalation} variant="attention" />
      <NavItem screen="audit" active={active === 'audit'} />
      <div className="nav-label">Admin</div>
      <NavItem screen="sendaudit" active={active === 'sendaudit'} count={counts.sendAuditUnreviewed} variant="sample" />
      <div className="rail-foot">
        <NavItem screen="settings" active={active === 'settings'} />
        <div className="rail-user">…</div>
      </div>
    </aside>
  );
}
```

### Routing/state shape

There is currently no router — `App.tsx` toggles `QueuePage`/`AccountDetailPage` with local
`useState`. The mockup already models six screens plus a four-tab detail page as first-class state
(`state.view`, `state.detailId`, `state.detailTab`, `state.detailFrom`). Once Plans 3–4 land
Escalations/Audit/Send Audit/Settings screens, that's 6 top-level screens + 4 detail tabs, and this
is an internal ops tool where "share a link to this escalation" is a real, plausible use case.

**Recommendation: add `react-router-dom`.** This is the one new runtime dependency the constraints
explicitly leave room for ("a router may be justified"). It carries no styling opinions (nothing
here conflicts with "no component library"), and it replaces what would otherwise be a hand-rolled
equivalent of the mockup's `state.view`/`state.detailFrom`/`state.detailTab` — back-button
behavior, deep links, and "go back to wherever I came from" for free instead of reimplemented.

```
/                          -> redirect to /queue
/queue                     -> QueuePage
/review                    -> ReviewWorklistPage       (tier-2 flat list; not yet in any plan — see §6)
/escalations               -> EscalationsWorklistPage  (tier-3 flat list; not yet in any plan — see §6)
/audit                     -> AuditTrailPage           (account picker + timeline; not yet in any plan)
/send-audit                -> SendAuditPage
/settings                  -> SettingsPage
/accounts/:accountId       -> AccountDetailPage, default tab "work"
/accounts/:accountId/:tab  -> AccountDetailPage, tab in {info, work, history, resolution}
```

`Sidebar`'s `active` prop comes from `useLocation()` matched against this table (mirrors the
mockup's `state.view === k` check), not local state — this is exactly what the router buys you
over the mockup's approach. `AccountDetailPage`'s "Back to {queue|review|escalations}" button
(mockup: `state.detailFrom`) becomes `useNavigate(-1)` or an explicit `from` query param if you
want it more robust than browser history order.

Nav counts are cross-cutting (every screen needs the same three badge numbers regardless of which
one is active), so they live in `AppShell`, fetched once on mount and refreshed via a small
callback threaded down (or a light context) whenever a page performs a mutating action
(approve/reject/mark-resolved/link-escalation) — plain `fetch` + `useEffect`, no new dependency,
consistent with the plans' existing `onDecision`-callback pattern:

```tsx
// apps/console-web/src/shell/AppShell.tsx (sketch)
export function AppShell({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<NavCounts>({ review: 0, escalation: 0, sendAuditUnreviewed: 0 });
  const location = useLocation();
  const refreshCounts = useCallback(() => { /* refetch the 3 counts */ }, []);
  useEffect(() => { refreshCounts(); }, [refreshCounts]);

  return (
    <NavCountsContext.Provider value={{ counts, refreshCounts }}>
      <div className="app">
        <Sidebar active={activeScreenFor(location.pathname)} counts={counts} />
        <main className="main">
          <Header />
          <div className="scroll">{children}</div>
        </main>
      </div>
    </NavCountsContext.Provider>
  );
}
```

The mockup's toast host (`<div class="toast-wrap" id="toasts">`) is a **sibling of `.app`**, not
nested inside it — keep that placement in React too (render it alongside `<AppShell>` in
`main.tsx`/`App.tsx`, not inside `AppShell`'s returned tree). It's `position: fixed`, and nesting
it under an ancestor that later gains a `transform`/`filter` (easy to introduce by accident, e.g.
on a modal wrapper) would silently break its viewport-relative positioning.

---

## 4. Theme switching

Mechanism: `data-theme="light"|"dark"` on `<html>`, exactly as the mockup — CSS custom properties
already do all the work once the attribute flips, so React's only job is to own that one attribute
and persist the choice.

```ts
// apps/console-web/src/shell/useTheme.ts
type Theme = 'light' | 'dark';
const STORAGE_KEY = 'erria-theme';

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}
```

**`prefers-color-scheme`: the mockup does not consult it, and I'm not adding it.** The mockup hard-
codes `<html data-theme="light">` and only ever overrides from `localStorage` (lines 1831–1838,
1877) — there's no `@media (prefers-color-scheme: dark)` block anywhere in `design-system/
tokens.css` or the mockup's `<style>` block either. Given the brief's constraint that fidelity is
the goal and this isn't a redesign, the faithful port is: **default light, override only from a
stored preference, no OS-preference fallback.** I'm calling this out explicitly rather than quietly
picking a side, because the task prompt asks how it "interacts with `prefers-color-scheme`" and the
honest answer is "the approved design doesn't wire it up at all" — if that's actually wanted, it's
a two-line addition to the `useState` initializer (`stored ?? (matchMedia('(prefers-color-scheme:
dark)').matches ? 'dark' : 'light')`), but it would be a deviation from v07, not a port of it, so
it needs a yes from whoever owns the mockup, not an assumption baked into the ticket.

`ThemeToggle` is a thin consumer: `svg(dark ? 'sun' : 'moon')` + `dark ? 'Light' : 'Dark'` label,
identical to the mockup's `themeIcon()` (line 1837-1838).

---

## 5. What ports verbatim vs. what must be rewritten

**Ports verbatim (copy the selector text unchanged into the files in §1):**
- The entire token superset (§0) and all flat component classes with no DOM-order dependency:
  `.badge*`, `.btn*`, `.chip*`, `.why`, `.msg*`, `.doss-card`, `.doss-row`, `.tier-panel*`,
  `.decision*`, `.policy-tag*`, `.esc-*`, `.tl-item*`, `.toast*`, `.pager`, `.detail-*`, `.set-*`,
  `.res-row`, `.sa-*`. These select on `className` alone — React just needs to emit the same class
  strings on the same element shapes (`div`/`span` nesting) as the mockup's template-string HTML,
  which is a mechanical JSX translation of `queueRow()`, `renderDossier()`, etc., not a rewrite.
- The two Google Fonts `<link>` tags (Inter) — copy into `apps/console-web/index.html` verbatim, or
  the shell degrades to the fallback stack (`system-ui`, etc.) silently, which is a fidelity miss
  worth avoiding for one `<link>` tag.
- Grid layouts keyed on a fixed child count (`.q-head`/`.q-row` at `grid-template-columns: 2.3fr
  2.6fr 1fr 1.1fr 1.2fr`, `.detail-grid`, `.split-wrap`) — these aren't selector-order dependencies
  (no combinator involved), they're a *contract*: the component must always emit exactly 5 (or 2,
  for detail-grid) direct children in the matching order. Document that contract with a one-line
  comment on the component (`// keep 5 children in this order — matches .q-row's grid-template-
  columns in screens.css`) rather than as CSS to rewrite.

**Won't survive contact with React unchanged — flag these specifically:**

1. **`.icp-bars i:nth-child(-n+3|-n+2|-n+1)`** (lines 205–207) — fills 3/2/1 bars via sibling
   position, not a class per bar. This only keeps working if `IcpMeter` always renders exactly
   three `<i>` unconditionally for every level (`high`/`med`/`low`) and never maps over a variable-
   length array — the natural React instinct to "clean this up" into
   `Array.from({length: barsFor(level)})` breaks it silently. Keep the markup shape dumb on
   purpose; add a unit test asserting exactly 3 `<i>` render regardless of level.
2. **`.tp-field:nth-child(2)`** (line 506, in the manual tier-override panel) — widens the *second*
   `.tp-field` inside `.tp-body` positionally. `ChangeTierPanel` (a real planned component, Plan
   3/4 Task 8) is exactly the kind of component someone will later reorder fields in. **Rewrite
   recommendation:** replace this with an explicit modifier the component applies directly —
   `.tp-field.wide` or `.tp-field--reason` on the specific field — same visual result, removes the
   order dependency. This is the one genuine, safe rewrite in the whole file.
3. **`.nav-label + .nav-item {}`** (line 480) — empty rule, currently a no-op. It does encode an
   assumption (a `.nav-label` and the following `.nav-item`s are flat siblings in `.rail`, not each
   wrapped in their own container) that `Sidebar`'s JSX should preserve if this rule is ever filled
   in later. Harmless today; noted so nobody wraps nav items in per-section `<div>`s and wonders
   why a future adjacent-sibling rule stops matching.
4. **`onclick="fn(...)"` string handlers** — the biggest actual vanilla-JS-vs-React difference, but
   it's not a CSS problem: the hover/active *pseudo-classes* they trigger (`.btn:hover`,
   `.btn:active { transform: translateY(1px) }`) are plain CSS and port unchanged regardless of how
   the click itself is wired (`onClick={approve}` in React, per Plan 2 Task 9's own sketch).
5. **`[data-od-id="..."]` attributes** (94 occurrences) — I checked: none of these appear as a CSS
   selector anywhere in the `<style>` block. They're Open Design's own generation-tool hooks, not
   styling or test hooks. **Drop them entirely** — don't port to React. Your test constraint
   (roles/text, not classes) means you won't need a stable-hook replacement; if one is ever needed,
   RTL's own `data-testid` convention is the fallback, not a revival of `data-od-id`.
6. **Inline `style="..."` fragments in the JS template strings** (a handful, e.g. `style="margin-
   bottom:16px"` on the calm-state `.policy-tag.info`, `style="display:flex;gap:8px;margin-top:10px"`
   around the edit-mode Save/Cancel buttons) — these were never in the `<style>` block to begin
   with, so §2's diff process doesn't cover them regardless. Low-risk, low-cost rewrite: promote
   each into a small named class alongside the rule it's patching (e.g. widen `.policy-tags` gap
   rules) rather than carrying `style={{...}}` into JSX, for consistency with everything else being
   class-driven.
7. **No `#id` selectors exist in the `<style>` block** (`#crumb`, `#pageTitle`, `#themeToggle`,
   `#view`, `#toasts` are all only used as JS `getElementById` targets, never in CSS) — confirmed by
   inspection, so component boundaries are free to use whatever wrapper elements/IDs (or none) they
   want; nothing here constrains the shell decomposition in §3.

---

## 6. Sequencing

```
Ticket 1 ──▶ Ticket 2 ──┐
        └──▶ Ticket 3 ──┼──▶ Ticket 4 (folded into each Plan's existing UI tasks)
                        │
Ticket 5 (independent, anytime) ───────────────┘
```

- **Ticket 1 — Token fix + base/layout CSS + static AppShell.** Port §0's token superset,
  `base.css`, `layout.css`; build `AppShell`/`Sidebar`/`NavItem`/`Header`/`ThemeToggle` with the
  theme wired (§4) but nav counts hardcoded to `0` and no router yet — wrap whatever `App.tsx`
  currently renders (the existing `QueuePage`/`AccountDetailPage` local-state toggle, unchanged) in
  the new shell. **This is the smallest ticket that visibly improves the app**: it turns "unstyled
  serif text in a bare table" into "the mockup's actual chrome — sidebar, logo, breadcrumb, theme
  toggle — around whatever screens already exist," without needing the router, nav-count wiring, or
  any per-screen markup rewrite yet. Every other ticket depends on this one because `components.css`
  and `screens.css` both reference tokens this ticket introduces.
- **Ticket 2 — `components.css` + retrofit existing pages' markup.** Add badges/buttons/chips/msg/
  doss-card/tier-panel/decision/pager/toast rules, and fix `QueuePage`/`AccountDetailPage`'s
  className drift from the plans-as-written (`queue-table` → `q-table` + `q-head`/`q-row`/`acct`/
  `vessel`/`trigger`/`tier-cell`/`rowcta`; the ad hoc `account-detail`/`outreach`/`tier-why`/`draft-
  body`/`edited-note` classes in Plan 2 Task 9's sketch → the mockup's real `detail-grid`/`detail-
  col`/`detail-rail`/`dossier`/`doss-card`/`msg`/`decision` classes). Depends on Ticket 1.
- **Ticket 3 — Router + nav counts + `screens.css`.** Add `react-router-dom`, the route table in
  §3, `useNavCounts`, and the remaining screen-specific CSS block (`detail-tabs`, `esc-*`, `sa-*`,
  `set-*`, `res-row`). Needed once Plans 3–4 start landing Escalations/Audit/Send Audit/Settings as
  real navigable screens rather than the two-screen local-state toggle. Depends on Ticket 1 only;
  can run in parallel with Ticket 2.
- **Ticket 4 — not a standalone ticket.** Fold "layout matches mockup v07" as an acceptance
  criterion into each Plan's existing screen tasks (`EscalationPanel`, `ChangeTierPanel`,
  `SettingsPage`, `SendAuditPage`, `TierHistoryTab`) once Tickets 1–3 exist for them to build on —
  agrees with `2026-08-03-pm-layout-scope.md`'s call to reject per-screen tickets as too small to
  separate.
- **Ticket 5 — independent, low urgency.** Check in `_mockup-snapshot.css` and write the one-
  paragraph "how to re-port the next mockup version" note from §2 into
  `apps/console-web/src/styles/README.md`. No code dependency on anything else; do it whenever.

Note: Plan 1's `Review`/`Escalations`/`Audit` nav items currently have **no worklist page behind
them anywhere in the plans** — only `QueuePage` (flat list) and `AccountDetailPage` exist today; the
mockup's `renderWorklist(tier)` (tier-2/tier-3 flat cross-account lists) has no planned React
counterpart yet. Ticket 3 needs `ReviewWorklistPage`/`EscalationsWorklistPage`/`AuditTrailPage` as
new (thin) components — reusing the same `q-table`/`queueRow`-shaped markup as `QueuePage` — to
have somewhere to route those nav items to; flag this as new scope for whoever writes the actual
tickets, not something to infer silently from an existing task.

---

## Deliverable summary

No source files were created or modified — this document is the only output, per the read-only
constraint. File paths referenced above are recommendations for tickets to create, based on:
- `brainstorm/mockup/Erria-outreach-agent-v07/outreach-console.html` (read in full, style block and
  render functions)
- `design-system/tokens.css`, `design-system/tokens.json`, `design-system/DESIGN.md`
- `docs/superpowers/plans/2026-08-02-outreach-agent-foundation-flow1.md` (Task 12)
- `docs/superpowers/plans/2026-08-03-outreach-agent-flow2-approve-send.md` (Task 9)
- `docs/superpowers/plans/2026-08-03-outreach-agent-flow3-4-escalations.md` (Task 9, for
  `EscalationPanel`/`ChangeTierPanel` naming)
- `docs/superpowers/plans/2026-08-03-outreach-agent-settings-audit.md` (for `SettingsPage`/
  `SendAuditPage`/`TierHistoryTab` naming)
- `docs/reviews/2026-08-03-pm-layout-scope.md` (prior PM-level scope pass, referenced/superseded
  where noted)
