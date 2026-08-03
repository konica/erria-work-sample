# Design System — Erria Outreach Agent Console

This document consolidates everything under `design-system/` into one human-readable reference:
what was actually auto-extracted from erria.dk, what was manually curated to fill real gaps in
that extraction, and what's a deliberate designer decision for this project's app (not derived
from Erria's site at all). Use this alongside [`../ideation/open-design-brief.md`](../ideation/open-design-brief.md)
when generating the UI in Open Design.

## Provenance

- **Source**: `https://www.erria.dk/`, extracted 2026-08-01 via `extract-design-system` (CLI
  backed by the `dembrandt` crawler).
- **Tool limitation found**: the automated color/radius/shadow normalization step returned empty
  arrays in `tokens.json`/`tokens.css`, even though the raw crawl (`.extract-design-system/raw.json`)
  clearly captured real values — its frequency-count threshold missed colors that are semantically
  important (e.g. the primary button/link color) but don't repeat often enough across one page.
  Everything marked **curated** below was manually reviewed from `raw.json` to fill that gap.
- **Everything marked "designer decision"** is not derived from erria.dk at all — erria.dk has no
  dark theme (confirmed by re-running extraction with the `--dark-mode` flag: identical, light-only
  result) — those values were authored for this project by extrapolating from the real brand colors.
- Treat all of this as a **starter reference for initialization, not pixel-perfect brand truth** —
  it's based on a single-page crawl of a WordPress/Elementor site, not Erria's design guidelines.

## Colors

### Light theme (auto-extracted signal + curated)

| Token | Value | Source |
|---|---|---|
| `--color-background` | `#ffffff` | extracted (352 instances) |
| `--color-surface` | `#f5f4f7` | extracted (page/card background) |
| `--color-border` | `#ebf0f7` | extracted (70 instances) |
| `--color-text-primary` | `#0f172a` | extracted (130 instances, heavy button/text use) |
| `--color-text-secondary` | `#5a5a5a` / `#333333` | extracted (`#333333` is the single most frequent color on the page — 1060 instances, almost certainly body text) |
| `--color-brand-primary` | `#1e73be` | extracted — default button background and default link color; matches the theme's own `--e-global-color-primary` |

### Dark theme (designer decision — no erria.dk precedent)

| Token | Value | Note |
|---|---|---|
| `--color-background` | `#0f172a` | Reuses Erria's own extracted dark navy as the dark-mode base — a legitimate brand tone, not an arbitrary gray |
| `--color-surface` | `#1a2438` | Derived: one step lighter than background for card/panel contrast |
| `--color-border` | `#2a3650` | Derived |
| `--color-text-primary` | `#f5f4f7` | Derived |
| `--color-text-secondary` | `#9aa3b2` | Derived |
| `--color-brand-primary` (on dark) | `#4a9bd8` | Lightened from `#1e73be` for contrast against the dark background — verify actual contrast ratio when the UI is generated |

### Excluded / uncertain

- **`#00aced` — excluded as noise.** 107 instances, but this is the literal classic Twitter-brand
  blue. Almost certainly picked up from a social-media icon, not part of Erria's own palette.
- **`#cc3366` — uncertain.** Appears as an alternate link color (36 instances). Could be an
  intentional accent or just a theme default — use with caution, don't treat as confirmed brand.

## Typography

- Heading font: Helvetica. Body font: Helvetica.
- **Reads as a generic WordPress/Elementor theme default**, not a deliberate custom brand
  typeface — don't over-invest in reproducing it as if it were a considered brand choice.

## Spacing

Extracted scale (px): `2, 5, 5.5, 7, 8, 10, 13, 14.4, 15, 20, 22.95, 25, 30, 94, 100`.
Roughly a 5px-based system in the small range, with a couple of large one-off values (94/100px)
likely from section padding rather than a deliberate part of the scale.

## Border radius (curated)

Auto-normalization returned empty; manually reviewed from `raw.json`: `2px, 3px, 5px, 6px, 12px`.
Most interactive elements (buttons, inputs) cluster around 5–6px — a conservative, non-pill radius
consistent with a corporate B2B site.

## Shadows (curated)

Only one low-confidence sample on the crawled page (count: 2): a standard "elevated card" shadow
— `0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23)`. Not a strong signal; use as a
reasonable default elevation, not a confirmed brand pattern.

## Logo & brand assets

Located in `design-system/assets/`:

- `erria-logo.png` (2847×947, transparent background) — the primary logo mark.
- `erria-favicon-192.png` (192×192) — small icon/favicon variant.

**Important caveat**: the logo file is a "transparent-white" mark (per its own filename) — the
mark itself is white/light-colored line art. It reads fine directly on the dark theme's navy
background, but **will wash out or vanish on light-theme white/off-white backgrounds**. No
colored/dark logo variant was available to extract. In light mode, place the logo inside a small
dark-navy chip/bar in the header rather than directly on the light page background.

## Light / dark theme summary

See the full rationale in [`open-design-brief.md`](../ideation/open-design-brief.md#light--dark-theme).
Short version: support both (internal, data-dense tool, plausible off-hours use by a small team);
there's no Erria precedent to follow since their own site is light-only; tier/escalation status
colors must stay legible and not color-only across both themes.

## How to use these tokens

Import `design-system/tokens.css` into the app entrypoint. `:root` carries the light theme (the
default); apply `data-theme="dark"` on a root element (e.g. `<html data-theme="dark">`) to switch.
`design-system/tokens.json` mirrors the same values in a structured, W3C-token-adjacent shape for
programmatic use.

## Related documents

- [`ideation/scenario-research.md`](../ideation/scenario-research.md) — verified facts behind the
  Mermaid Maritime Vietnam scenario.
- [`docs/superpowers/specs/2026-08-01-outreach-agent-design.md`](../docs/superpowers/specs/2026-08-01-outreach-agent-design.md) —
  the outreach agent's tiering/escalation/tone design (the actual work-sample deliverable).
- [`ideation/open-design-brief.md`](../ideation/open-design-brief.md) — the copy-paste brief for
  generating the console UI in Open Design.

## Known limitations / open items

- No dark-colored logo variant exists in what was extracted — if the light-mode header treatment
  (dark chip/bar) doesn't look right once generated, a proper light-mode logo asset should be
  sourced from Erria directly rather than improvised.
- `#cc3366` accent usage is unconfirmed — avoid leaning on it for anything status-critical (e.g.
  don't repurpose it as an error/danger color without checking it isn't actually a themed link
  color with no semantic meaning).
- All of this reflects a single-page crawl of