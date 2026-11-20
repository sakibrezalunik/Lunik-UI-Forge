# Northwind — design system

Last reviewed: 2026-11-19 · Owner: Lunik UI Forge maintainers

## Direction

A calm editorial workspace for a growth team that checks revenue daily. A deep
ink navigation rail anchors a bright, generous reporting surface. Density is
comfortable rather than dense: one metric row, one chart, one accounts table,
one activity feed. Colour is rationed — cobalt appears only on interactive
affordances (primary filter, active nav, chart line, sort affordance) and status
colour only inside labelled badges or deltas.

Primary users: account managers and founders reviewing revenue and account health
once or twice a day, usually on a laptop.
Primary job of this UI: answer "is revenue healthy, and which accounts need
attention?" in under ten seconds.
Most important element on the main screen: the revenue metric row, followed by
the revenue trend and the account table.

## Colour

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#f4f5f7` | app background |
| `--color-surface` | `#ffffff` | cards |
| `--color-surface-sunken` | `#f8f9fb` | panel heads, row hover |
| `--color-surface-muted` | `#eef1f5` | chips, empty-state icon plate |
| `--color-border` | `#e1e5eb` | dividers, card borders |
| `--color-border-strong` | `#98a2b3` | input and secondary button borders |
| `--color-text` | `#111827` | body text |
| `--color-text-muted` | `#5b6475` | secondary text, captions |
| `--color-text-subtle` | `#667085` | chart axes, placeholder (5.3:1 on white) |
| `--color-accent` | `#1d4ed8` | primary actions, active filter, chart line |
| `--color-success` | `#15803d` | positive deltas on white |
| `--color-success-strong` | `#116b30` | "Active" badge text on its subtle fill |
| `--color-danger` | `#b91c1c` | churned accounts |
| `--color-focus` | `#b45309` | focus ring on light surfaces |
| `--color-focus-dark` | `#fbbf24` | focus ring on the ink rail |
| `--sidebar-bg` | `#0f1b2d` | navigation rail |
| `--sidebar-bg-raised` | `#17263b` | active nav item |
| `--sidebar-text` | `#eef3fa` | brand and active nav text |
| `--sidebar-muted` | `#b3bfd0` | nav links and disclosure |
| `--sidebar-subtle` | `#8fa0b7` | brand meta, nav label |

Rules:
- Cobalt is reserved for interactive affordances. It is never a decorative fill.
- The ink rail carries the only large dark surface; the reporting area stays light.
- Status colour always appears with a text label inside a badge or a sentence.
- Muted text is `#5b6475`, not a lighter grey, so it clears 4.5:1 on both
  `#ffffff` (5.9:1) and `#f4f5f7` (5.5:1).
- Chart axes use `#667085` (5.3:1 on white). A lighter grey measured 4.15:1 and
  was rejected by the contrast check.
- Badge text uses the `-strong` variants. Base success and warning colours
  measured 4.49:1 and 4.47:1 on their subtle fills — below AA for 12px text.
  Shipped values measure 5.93:1 and 5.74:1.

## Typography

- Family: `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial`
- Body: 16px / 1.5
- Table body: 14px; table headers: 12px uppercase with 0.04em tracking
- Page title: 30px / 1.2, weight 700, −0.015em tracking
- Section headings: 17px / 1.2, weight 700
- Metric values: 32px, weight 700, tabular numerals
- Chart axes: 10–11px, tabular numerals; axis text is HTML, not SVG, so it never
  stretches with the chart path
- Numerals: `font-variant-numeric: tabular-nums` on metrics, tables, timestamps,
  chart axes, and the chart summary

## Spacing and layout

- Base unit 4px. Steps used: 4, 8, 12, 16, 24, 32, 48.
- Content max-width 88rem inside the shell.
- Shell: 15.5rem sticky navigation rail + fluid content. The rail keeps its own
  scroll and stays in view while the long accounts page scrolls. Below 1024px it
  becomes a horizontal strip above the content.
- Main sections are a 24px vertical stack (16px below 768px).
- Metric row: fixed 4 / 2 / 1 columns — 4 up at ≥1220px, 2 up at 768–1219px,
  1 up below 768px. The counts are explicit because `auto-fit` with a 13rem
  track fitted three columns at 1024–1199px and again at tablet width, leaving
  the fourth card alone on its own row.
- The four-up transition is at 1220px because that is where the cards genuinely
  fit their own text. Measured: at a 1200px viewport each card is 210px wide, so
  after borders and padding its content box was 160px, while "Monthly recurring
  revenue" needed 160.9px on one line. At 1200–1203px that label wrapped and
  pushed its value 20px below the other three. This build gives each card more
  padding room, but the transition stays at 1220px so font drift cannot
  reintroduce the wrap. There is deliberately no three-column stage.
- Wide tables scroll inside `.table-wrap`, never the page. `.table` has
  `min-width: 36rem` so columns never crush below that width. Below 640px a
  static `Scroll horizontally…` hint states that the table scrolls.
- Every grid/flex child that holds text or a table gets `min-width: 0` to defeat
  the default `min-width: auto` that causes most overflow bugs.
- The chart uses an HTML y-axis, a responsive SVG plot (`preserveAspectRatio:
  none`), and an HTML month row. Grid labels therefore stay crisp while the line
  stretches. The chart is 190px tall on desktop and 168px on mobile so the
  accounts card still enters the first viewport at 900px.

## Components

| Component | States implemented | Notes |
| --- | --- | --- |
| Button | default, hover, active, focus-visible, disabled (native) | primary / secondary / icon only; icons are decorative |
| Notification button | closed, open (`aria-expanded`), unread, all read | opens a non-modal panel |
| Notification panel | open, all read | focus moves to "Mark all read"; Escape and outside click close, focus returns to the trigger |
| Chip filter | default, hover, active (`aria-pressed`) | active state is also textual state in the count line |
| Sortable header | none, ascending, descending (`aria-sort`) | Account / Seats / MRR; default MRR high-to-low |
| Badge | active, paused, churned | always contains its label |
| Plan tag | default | neutral outlined tag, not an action |
| Metric card | default | sparkline is decorative and `aria-hidden`; the delta carries a sign and a word |
| Card | default, empty | `.state-block` is a compact row on desktop (icon, copy, action) and stacks below 768px |
| Table | default, empty, overflow | `<caption>`, `scope="col"`, tabular numerals |
| Input | default, focus-visible | visible label above; `/` focuses it |
| Timeline | default | dot rail, `<ol>`, `<time datetime>` |
| Empty state | filtered / no-match | icon, explanation, and a real Reset action; the action stays in the first viewport at 900px |

## Accessibility requirements

- WCAG 2.2 AA. 4.5:1 body text, 3:1 large text and control boundaries.
- `:focus-visible` ring: 3px `#b45309` on light surfaces, `#fbbf24` on the rail,
  with 2px offset, on every control.
- Skip link to `#main` is the first focusable element.
- Icon-only notification button carries `aria-label` that changes between
  "Open notifications" and "Close notifications".
- The notification panel is labelled, is not a focus trap, closes on Escape,
  returns focus to its trigger, and closes when focus or a pointer leaves it.
- Sort controls are real buttons inside `<th>`; the current direction is exposed
  with `aria-sort`, not colour alone.
- Filter result count and total MRR update through normal text; the count is also
  announced through a polite live region.
- Wide table keeps real `<th scope="col">` headers so screen readers can navigate
  it as a table even when it scrolls horizontally.
- Decorative chart is exposed as a single `role="img"` with a descriptive label;
  its values are also stated in text above and below the chart.
- The mobile table hint is `aria-hidden`: it repeats a visual fact and the table's
  caption already names every column.

## Responsive rules

- Mobile (<768px): single column; nav becomes a horizontal strip; the top bar's
  search, Export, and notifications stay on one row down to 320px; cards lose a
  step of padding; timeline stacks its timestamp above the body.
- Tablet (768–1023px): single column with the horizontal nav and a two-up metric
  row.
- Desktop (≥1024px): sticky sidebar; four-up metrics only above 1220px.
- The sample-data note sits in normal flow under the nav on narrow widths and at
  the bottom of the sticky rail on desktop, so it is readable in the first
  viewport at every width. It is never hidden.
- No horizontal page scroll at any width ≥320px. Verified at 320 / 390 / 767 /
  834 / 1024 / 1200 / 1440.

## Motion

- No animations in this example. Hover and active states change colour or move
  1px; nothing animates over time.
- A `prefers-reduced-motion` block neutralises any transition that is added later.
- The chart is static SVG, so it cannot drift between screenshot runs.

## Anti-patterns (do not add)

- A second accent colour, or accent used as a decorative background.
- Icon-only buttons without `aria-label`.
- Colour-coded rows without a text badge.
- Charts that require hovering to read a value.
- Tables that push the page into horizontal scroll.
- Metric grids that can orphan a card: `auto-fit` with a fixed minimum track.
- Placeholder text used instead of a visible label.
- A sort control that changes the arrow but not the row order.

## Accessibility exceptions

None known. The chart is not keyboard-navigable point-by-point because its values
are stated in the summary text and caption; if interactive chart tooltips are
added, that exception must be revisited.
