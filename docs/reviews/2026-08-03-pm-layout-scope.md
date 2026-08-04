# Layout Scope Remediation — 2026-08-03

**Recommendation Summary**
- **New tickets: 2**
- **Single most important sequencing decision: Design-system CSS and app-shell component must both complete before any Plan 2–5 screen work; they are joint blocking prerequisites.**

---

## 1. Sequencing Against Existing Backlog

The app-shell and design-system work is a prerequisite for every UI ticket in Plans 2–5, and also affects Plan 1's Queue screen (Task 12). Currently, neither is ticketed anywhere.

**Recommendation: Extract as two separate blocking-prerequisite tickets**

- **Ticket A (Design System CSS Foundation)** — Porting the 618-line `<style>` block from the mockup into structured CSS (design tokens, layout primitives, components). Outputs a stylesheet that all screen work will import.
- **Ticket B (App Shell Component)** — Building the React shell component (sidebar nav with logo/labels/items/user, header with breadcrumb/search/theme-toggle, layout grid). Includes theme-toggle interactivity and dark-theme switching.

**Dependency graph:**
```
A (CSS Foundation) → B (App Shell) → Plan 1 Task 12 (Queue UI) and all Plans 2–5 screen tasks
```

**Cost of not extracting:** If shell and CSS are folded into Plan 1 Task 12, that task becomes a megaticket (backend QA + entire app infrastructure + Queue layout). It would be hard to verify in isolation, hard to split across the team, and it would block Plans 2–5 without being visible as a dependency.

**Cost of extracting:** Two smaller, focused tickets that are independently demoable and maintain clear dependency chains.

---

## 2. Slicing — Ticket Boundaries

**Candidate seams (evaluate, accept, reject, replace):**

| Seam | Decision | Rationale |
|------|----------|-----------|
| Design-system/CSS foundation | ✓ **Accept as Ticket A** | Mechanical porting task; can be verified by static file review; all screens depend on it. |
| App shell + nav | ✓ **Accept as Ticket B** | Structural React component; includes layout grid, sidebar, header. Single component, single responsibility. |
| Theme toggle | ✓ **Merge into Ticket B** | Trivial implementation (toggle attribute on root, CSS handles rest); belongs with the shell component that renders it. |
| Per-screen layout conformance | ✗ **Reject as separate tickets** | Each screen's layout is mostly CSS class application + minor template; too small to separate. Fold into each Plan's existing task. |

**Why merge theme-toggle into B, not separate?** Decoupling would create artificial ordering (shell must exist before toggle can be wired). Combining keeps related concerns together for a small team and reduces ticket overhead.

**Why not extract per-screen layouts?** Each of Plans 2–5 already has backend-flow tasks (Plan 2: approve/send logic, Plan 3: escalation classification, Plan 4: settings/audit queries). Adding "UI layout matches mockup" as an acceptance criterion to those tasks keeps the effort adjacent to the backend work and avoids proliferating small tickets.

**Result: 2 new tickets + amend existing/planned screen tasks**

---

## 3. MVP vs Deferrable

**Must have to not look broken (MVP):**
- All 618 lines of CSS: tokens (colors, shadows, radius, fonts), layout grid (flexbox, grid), typography, component classes (buttons, badges, tables, forms, panels), light and dark theme color sets.
- App shell: sidebar with brand/nav/user, header with breadcrumb/search/theme-toggle, main-content grid (100vh split).
- Light theme: fully functional by default.
- Dark theme: CSS rules included; toggle button wired (clicking `theme-toggle` flips `[data-theme]` attribute on root).
- Per-screen layouts: Queue table, Review split-view, Escalation banner, Settings form, Audit timeline — each matches mockup exactly (HTML/CSS; no interactivity required yet).

**Nice-to-have but deferrable:**
- Hover state transitions and animations (the mockup includes `.transition` declarations; could ship without the 120ms delays for MVP).
- Mobile/tablet responsiveness (the mockup includes media queries; MVP targets desktop-sized viewports).
- Intricate interactive overlays (if any modal/sheet interactions aren't critical for the first demo, simplify to static panels for MVP).

**Cost of deferring:**
- Animations: ~2 hours of CSS tweaks to add back once other screens are done. Feels snappier when re-added.
- Mobile responsiveness: app is unusable on mobile until fixed; medium cost. If demoing only on desktop, can wait.
- Overlays: depends on design; if critical to a workflow, cost is high. If they're nice-to-haves, cost is low.

**Recommendation: Include light + dark theme, all CSS, shell, per-screen layouts in MVP. Defer animations and mobile responsiveness for post-launch polish.**

---

## 4. Existing Ticket Amendments

**Ticket #7: "Console UI shows the queue"**
- **Current status:** Closed or in progress.
- **Current scope:** Likely just the Queue table display.
- **Problem:** Acceptance criteria do not account for the app shell (sidebar, header, breadcrumb) that must surround the Queue, nor the design-system CSS foundation that must be imported. The ticket will fail verification if the shell doesn't exist.
- **Amendment:**
  ```
  Acceptance Criteria:
  - [ ] App shell (sidebar, header, breadcrumb, topbar) renders and matches mockup v07 exactly
  - [ ] Design-system CSS is imported; all colors, spacing, typography follow tokens
  - [ ] Queue table layout matches mockup v07 exactly; all columns present and styled
  - [ ] Light theme is fully functional; text, borders, backgrounds match token values
  - [ ] Dark theme CSS is applied when [data-theme="dark"] is set; toggle button exists
  - [ ] Tier badges, status indicators, ICP bars all render with correct colors (never color-alone)
  
  **Dependencies:** Blocked by Ticket A (CSS Foundation) and Ticket B (App Shell).
  ```

**Plans 2–5: Screen implementation tasks (not yet created)**
- Each plan's queue/review/escalation/audit/settings tasks should include:
  ```
  Acceptance Criteria:
  - [ ] UI layout matches mockup v07 exactly (columns, spacing, component placement)
  - [ ] All design-system CSS classes applied (colors, badges, status indicators)
  - [ ] Interactive elements (buttons, forms, state changes) functional
  
  **Dependencies:** Blocked by Ticket A (CSS Foundation) and Ticket B (App Shell).
  ```

---

## 5. Recommended Ticket Wording

**Ticket A: Design System CSS Foundation**
- Goal: Port the 618-line CSS from `mockup/outreach-console.html` into a production stylesheet.
- Output: `src/styles/design-system.css` (or similar), importable from React components.
- Scope: Design tokens (custom properties for light and dark theme), layout primitives (grid/flexbox classes), component-class definitions (buttons, badges, tables, panels, etc.), media queries.
- Acceptance: All CSS from mockup is present; light and dark theme color sets are applied correctly; no colors used without accompanying label/icon; responsive breakpoints match mockup.

**Ticket B: App Shell Component + Theme Toggle**
- Goal: Build the React shell component (App, Sidebar, Header) that all screens render inside.
- Output: `src/components/AppShell.tsx` with nav state, breadcrumb management, theme-toggle wired.
- Scope: Sidebar (Erria logo, nav labels, nav items with icons/counts/active state, user footer), Header (breadcrumb/title, search, theme toggle), main-content grid, layout grid for 100vh split.
- Acceptance: Shell renders; nav items respond to `active` state; theme toggle flips `[data-theme]` on root; all elements match mockup v07; light and dark themes both render correctly.

---

## 6. Summary

| Item | Recommendation |
|------|-----------------|
| New tickets needed | 2 (CSS Foundation + App Shell) |
| Blocking prerequisite? | Yes; both must complete before Plans 2–5 screen work |
| Existing amendments | Ticket #7 acceptance criteria; all Plans 2–5 screen tasks add layout-conformance criteria and dependencies |
| MVP vs polish | Include: all CSS, shell, light+dark theme, per-screen layouts. Defer: animations, mobile responsiveness. |
| Single most important sequencing decision | Design-system CSS and app-shell component must both complete before any Plan 2–5 screen work; they are joint blocking prerequisites. |
