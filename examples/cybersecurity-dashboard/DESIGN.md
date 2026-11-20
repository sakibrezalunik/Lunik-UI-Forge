# Sentinel — design system

Last reviewed: 2026-11-19 · Owner: Lunik UI Forge maintainers

## Direction

A dark operations console for analysts who watch a queue for hours. A near-black
navigation rail frames a slightly lifted working surface. Density is high but
deliberate: small type, tabular numerals, monospace for hosts and timestamps, and
one accent reserved for interactive affordances. Severity is the only place
saturated colour appears, and it never appears without a text badge. The posture
banner is an evidence panel, not a hero: severity, the current claim, and three
countable facts an analyst can check at a glance.

Primary users: security analysts triaging alerts during a shift, on a large
monitor, occasionally on a laptop.
Primary job of this UI: decide which alert to work next and confirm the estate is
still reporting.
Most important element on the main screen: the current posture banner, followed
immediately by the alert queue.

## Colour

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#0a0f16` | app background |
| `--color-surface` | `#111823` | cards |
| `--color-surface-muted` | `#172130` | nav hover, meter tracks, chip counts |
| `--color-border` | `#263141` | dividers, card borders |
| `--color-border-strong` | `#4d5a6d` | input and button borders |
| `--color-text` | `#e9eef6` | body text |
| `--color-text-muted` | `#a9b5c7` | secondary text, timestamps |
| `--color-accent` | `#8ab0ff` | primary actions, active nav, meters, cue |
| `--color-focus` | `#ffd166` | focus ring (high contrast on dark) |
| `--sidebar-bg` | `#080d14` | navigation rail |
| `--sidebar-bg-raised` | `#111b29` | active nav item |
| `--sidebar-text` | `#eef3fa` | brand and active nav text |
| `--sidebar-muted` | `#a8b5c7` | nav links and disclosure |
| `--sidebar-subtle` | `#8494a9` | brand meta, nav label |
| `--sev-critical` | `#ffb9b9` on `#3d1f28` | critical badges |
| `--sev-high` | `#ffd79a` on `#3a2c12` | high badges, posture border, investigating |
| `--sev-medium` | `#a8d4ff` on `#14304a` | medium badges, quarantined |
| `--sev-low` | `#cfd8e6` on `#232c3a` | low badges |

Rules:
- Severity is a labelled badge. No row is identified by colour alone, and the
  posture banner carries the severity in words ("Elevated — …").
- State is a pill with a dot and a word: Open, Investigating, Quarantined,
  Acknowledged. The dot is decorative; the text is the signal.
- Muted text is `#a9b5c7`: 8.43:1 on the card surface. Do not lighten it "for
  subtlety".
- Measured ratios for the shipped pairs: body text on background 16.10:1;
  critical badge 9.05:1; high badge 9.97:1; medium badge 8.72:1; low badge
  9.79:1; accent text on the accent fill 7.52:1.
- The accent is for interaction only. Severity colours are for status only. They
  are not interchangeable.

## Typography

- Family: `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial`
- Monospace: `ui-monospace, SFMono-Regular, Menlo, Consolas` for hostnames,
  timestamps, and alert ids
- Body: 15px / 1.5 in the app shell; 16px is used only in prose blocks
- Table body: 14px; table headers: 11px uppercase with 0.07em tracking
- Page title: 27px / 1.25, weight 700
- Section headings: 16px / 1.25, weight 700
- Metric values: 28px, weight 700, tabular numerals
- Posture facts: 11px uppercase labels, 17px values
- All numerals in tables, metrics, and timestamps use `tabular-nums`

## Spacing and layout

- Base unit 4px. Steps used: 4, 8, 12, 16, 24, 32.
- Content max-width 92rem; the console is allowed to be wider than a marketing page.
- Shell: 15rem sticky navigation rail + fluid content. The rail stays in view on
  desktop; below 1024px it becomes a horizontal nav strip.
- Posture banner: evidence copy on the left, three facts on the right
  (quarantined hosts, review queue, detection baseline). Facts are separated by
  hairlines, not cards. Below 768px they become label/value rows so no label can
  collide or clip.
- Metric row: fixed 4 / 2 / 1 columns — 4 up at ≥1220px, 2 up at 768–1219px,
  1 up below 768px. `auto-fit` fitted three columns at 768–1100px and orphaned
  the fourth card; fixed counts cannot. The transition matches the SaaS
  dashboard exactly, so the two examples never disagree about when four-up is
  honest.
- Alert queue: `min-width: 54rem` table inside `.table-wrap { overflow-x: auto }`,
  so the page never scrolls sideways even at 320px. 54rem clears the 860px the
  table needs to keep every alert title, meta line, host identifier, and
  timestamp on one line, so the wrapper scrolls at tablet width instead of
  crushing the asset column. Host identifiers and timestamps are monospace and
  `white-space: nowrap`, so `edge-gateway-01` can never break mid-word.
- The scrollable queue carries its own affordance, and it is a label rather than
  a shadow: `More columns, including Acknowledge →`, right-aligned directly
  above the table. Chromium in this project's Playwright build paints no scrollbar for an
  overlay-scrollbar scrollport, and a dark edge gradient cannot reach the 3:1
  non-text floor on this surface. The label measures 7.09:1 and its visibility
  follows the real scroll state (`syncScrollHint()` in `app.js`): shown while
  content is hidden to the right, hidden at the rightmost position, hidden when
  the table fits, and shown for any overflow from 1px up.
- A 2.5rem surface fade sits at the right edge of the scroll box, shown while
  content remains to the right and hidden at the rightmost position. It is not
  the affordance — the labelled cue is — but it stops a partially clipped
  control from reading as a broken button: the fragment fades into the card
  surface while the table continues underneath. It is `aria-hidden` and
  `pointer-events: none`, so it adds neither announcement nor click target.
- The cue is a sibling of the scroll box, so it can neither scroll nor cover the
  table, and nothing shifts when it appears. `pointer-events: none` means it
  cannot take a click, and the scroll box keeps its `tabindex="0"` region with a
  name that states the same fact for assistive technology.
- Split panels (timeline + asset health) are 1.4fr / 1fr above 1200px and stack
  below it.
- Every grid/flex child holding text or a table sets `min-width: 0`.

## Components

| Component | States implemented | Notes |
| --- | --- | --- |
| Posture banner | static | Severity word + dot + explanation + three facts |
| Metric card | default | Label, value, meta line; deltas carry a sign and a word |
| Severity badge | critical, high, medium, low | Uppercase text, never colour-only |
| Chip filter | default, hover, active (`aria-pressed`) | Counts are computed from the queue and shown in a count pill |
| Table | default, empty, overflow | `caption`, `scope`, monospace for ids/hosts |
| State pill | open, investigating, quarantined, acknowledged | Dot + word; acknowledged row gets a faint green wash |
| Acknowledge button | default, hover, disabled (after acknowledging) | Focus moves to the next alert action, or the table region |
| Meter | normal, warning (<80%) | Visible target marker at 80%; `role="progressbar"` with a text value |
| Timeline | default | Dot rail with a connector line; timestamps stay monospace |
| Refresh | default, hover | Local re-render; updates the "Updated …" line and announces that nothing was fetched |
| State block | empty / no match | Icon, explanation, and a real Reset action; one row on desktop, stacked below 768px |

## Accessibility requirements

- WCAG 2.2 AA. Focus ring is `#ffd166` at 3px, which is legible against both
  surfaces; every interactive element shows it.
- Skip link to `#main` is the first focusable element.
- The acknowledge action keeps keyboard focus on the next actionable control
  after the row re-renders, so a keyboard user does not lose their place. When
  it was the last action, focus lands on the named scroll region.
- Meters expose `role="progressbar"`, min/max/now, and a descriptive
  `aria-label`; the numeric value is also visible as text.
- Filters announce the new result count through a polite live region.
- Severity, asset, and timestamps are real table cells with `scope="col"` headers.
- No information is conveyed by the severity colour or state dot alone.
- `/` focuses the search field when focus is not already in a control.
- Counts in filter chips are text, not badges that replace the label.

## Responsive rules

- Mobile (<768px): single column; nav wraps horizontally; cards lose a step of
  padding; banner facts become label/value rows; timeline stacks its timestamp
  above the body with the dot rail retained.
- Tablet (768–1023px): single column with horizontal nav; two-up metrics; the
  table scrolls and the cue stays visible.
- Desktop (≥1024px): sticky sidebar; split panels side by side above 1200px.
- The sample-data note sits in normal flow under the nav — at the bottom of the
  sticky rail above 1024px, and under the nav strip below it — so it is readable
  in the first viewport at every width. It is never hidden.
- No horizontal page scroll at any width ≥320px. Verified at 320 / 390 / 767 /
  768 / 834 / 1024 / 1200 / 1440.

## Motion

- No animation in this example; state changes are immediate.
- A `prefers-reduced-motion` block neutralises anything added later.
- All timestamps are static text except the local "Updated just now" refresh
  confirmation, so screenshots cannot drift.

## Anti-patterns (do not add)

- Severity conveyed by row background colour only.
- Green/red deltas without a sign or word to explain direction.
- Auto-refreshing tables that move rows under the analyst's pointer.
- Charts that require hover to read a value.
- Tables that force page-level horizontal scrolling.
- A second accent colour competing with the interactive accent.
- A "live" indicator that claims telemetry the sample does not have.

## Accessibility exceptions

None known. Live-region announcements cover result counts and local refresh
state only; new alerts arriving asynchronously in a real deployment would need
`aria-live="assertive"` for critical severity, which this static sample does not
implement.
