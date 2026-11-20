# Layout patterns

Reusable structures that survive narrow viewports. Prefer these over inventing a
shell per page.

## Application shell

```
┌──────────────────────────────────────────────┐
│ topbar: brand · context · search · account   │
├───────────┬──────────────────────────────────┤
│ sidebar   │ main content (single h1, then    │
│ nav       │ sections stacked or in a grid)   │
└───────────┴──────────────────────────────────┘
```

**Desktop (≥1024px):** sidebar fixed 240–280px, content fluid, `max-width` on the
content column so lines do not run to 2000px.

**Tablet (768–1023px):** either collapse the sidebar to icons with tooltips, or
move navigation into a disclosure at the top. Do not keep a 260px sidebar on an
834px screen; content suffers first.

**Mobile (<768px):** single column. Navigation becomes a horizontal scroll strip
or a `<details>` disclosure. Topbar keeps brand and the one primary action.

**The rule that prevents most overflow bugs:** never give the shell a
`min-width` in pixels. Use `minmax(0, 1fr)` on grid children and `min-width: 0`
on flex children that contain long text or tables. Flex and grid children default
to `min-width: auto`, which refuses to shrink below their content.

## Dense data table

```css
.table-wrap { overflow-x: auto; }        /* scrolls itself, not the page */
.table-wrap table { min-width: 40rem; }  /* below this, columns crush */
td, th { font-variant-numeric: tabular-nums; }
```

Always wrap wide tables. A table that overflows the page breaks the entire layout;
a table that scrolls inside its card keeps the shell intact.

For very narrow screens, prefer stacked "cards" over a scrolling table when rows
carry more than four fields.

**The trap that survives every other fix:** an absolutely positioned element
inside a scrolling table escapes the scroll container's clip. A
`<span class="visually-hidden">` in a header cell, a tooltip, or a `position:
absolute` badge anchors to the nearest positioned ancestor — and if there is
none, to the viewport. A cell sitting 700px into a 46rem table then makes the
whole page scroll sideways, even though the table itself scrolls correctly.

```css
.table-wrap {
  position: relative;   /* contain abs-positioned descendants */
  overflow-x: auto;
}
```

## Metric / KPI row

- 4 across on desktop, 2 across on tablet, 1–2 on mobile.
- `grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr))` handles all three
  without media queries.
- Each card: label (small, muted), value (large, tabular), delta (with an arrow
  **and** a word — "12% up", not a bare green number).
- Keep all metric cards the same height; ragged rows look broken.

## Two-column detail layout

`grid-template-columns: minmax(0, 2fr) minmax(0, 1fr)` for primary content plus a
secondary panel. Collapse to one column below 1024px, with the secondary panel
moving **after** the primary content — not hidden.

## Timeline / event feed

- Ordered list (`<ol>`), one `<li>` per event.
- Timestamp in a fixed-width, tabular-numeral column so events align.
- Severity as a labelled badge, not a coloured left border alone (colour must not
  be the only signal; a border is also invisible to screen readers).
- Newest first, with an explicit "newest first" label if the ordering matters.

## Forms

- One column. Two-column forms cause missed fields on mobile and awkward tab order.
- Labels above inputs; helper text below in muted colour that still passes 4.5:1.
- Group with `<fieldset>` when a legend clarifies ("Notification settings").
- Primary action left-aligned under the form, or right-aligned in a footer bar —
  pick one and keep it across the product.

## Empty, loading, and error regions

Reserve the final height so nothing jumps:

```css
.state-block { min-height: 12rem; display: grid; place-items: center; }
```

A skeleton that is 3 lines tall followed by 20 rows of data is a layout shift the
user experiences as a bug.

## Breakpoint policy

Test at **320, 390, 768, 834, 1024, 1440**. The configuration in
`lunik.config.json` covers 390/834/1440 by default; add 320 if the product
supports small phones.

Use these as *verification* widths, not as a licence to write one media query per
width. Prefer intrinsic layout (`auto-fit`, `minmax`, `clamp`) and add a media
query only where the design genuinely changes.

## Spacing rhythm

Pick a base unit (4px) and use only multiples. Vertical rhythm inside a card:
`16px` padding, `12px` between label and value, `24px` between sections. Inconsistent
spacing reads as "unfinished" even when every individual element is fine.
