# Design principles

How to choose and defend a visual direction. Read this before writing CSS; it is
the part that separates a designed interface from a plausible-looking one.

## 1. Start from the job, not the look

Answer these four questions in writing before choosing colours:

1. **Who is looking at this, and how often?** An operator watching a security
   queue for eight hours needs density and quiet. A new customer on a pricing page
   needs one clear action.
2. **What is the single most important number or action on this screen?** If you
   cannot name it, the layout has no hierarchy and no direction will fix that.
3. **What does the user already know?** Existing internal tools, industry
   conventions, and the project's current components are constraints, not
   obstacles.
4. **What must never be misread?** Destructive actions, status severity, money,
   and anything that changes on its own.

Write the answers into `DESIGN.md`. They are what you will be held to when the
interface is audited.

## 2. Choose a direction and name it

A direction is a short, falsifiable statement, not an adjective:

- ✅ "Dense light-theme operations console: compact 14px tables, tabular numerals,
  one accent colour reserved for the primary action, severity carried by
  labelled badges."
- ❌ "Modern, clean, professional dashboard."

Good directions constrain three things at once: **density**, **contrast strategy**,
and **where colour is allowed to appear**. If a direction does not constrain
anything, it is decoration.

### Three workable starting points

| Direction | Density | Surface | Colour use | Fits |
| --- | --- | --- | --- | --- |
| Calm workspace | Comfortable | Light, near-white | One accent for actions only | SaaS tooling used daily |
| Operations console | High | Light or dark, high data contrast | Severity scale, used sparingly and always with a label | Monitoring, security, admin |
| Editorial/documentation | Low | Paper-like, generous margins | Almost none; type does the work | Docs, marketing, help centres |

Pick one and stay in it. Mixing an editorial hero with an operations table in the
same product is the most common cause of "it feels inconsistent".

## 3. Hierarchy is spacing, weight, and position — in that order

Before reaching for colour or a bigger font:

1. **Space** separates groups. Related items sit 8–12px apart, groups 24–32px.
2. **Weight** distinguishes labels from values within a group.
3. **Position** puts the primary action top-left of the content it affects, or
   right-aligned in a toolbar — consistently.

Only then consider size. A page where everything is bold has no hierarchy.

**Practical test:** squint at the page. The first thing your eye lands on must be
the most important thing on the page. If it is the sidebar or a decorative
gradient, the hierarchy is wrong.

## 4. Typography rules that prevent most readability complaints

- Body text 16px; dense tables may go to 14px; nothing below 12px except
  non-essential metadata.
- Line length 60–80 characters. Cap prose containers around `65ch`.
- Line height 1.5 for body, 1.2 for headings, 1.4 for dense table cells.
- Numbers in tables and metrics use `font-variant-numeric: tabular-nums` so
  columns align and values do not jitter when they update.
- Maximum two weights per screen. Three is a smell.
- Never use letter-spacing to fix narrow fonts; pick a font stack that renders.

## 5. Colour is a system, not a mood

- Define **semantic** tokens (`--color-text`, `--color-border`, `--color-danger`)
  and use only those in components. Primitive palettes exist to feed semantics.
- Reserve the accent for interactive affordances. If the accent is on a
  non-interactive decoration, clicking behaviour becomes unpredictable.
- Every semantic colour needs a text label or icon alongside it. Roughly 8% of men
  have a colour-vision deficiency; "red row" alone communicates nothing.
- Check contrast against the actual surface the text sits on, not against white.
  A muted grey that passes on `#fff` often fails on `#f6f7f9`.

## 6. Restraint is a feature

Add an element only if it does one of these: helps the user decide, helps the user
act, or prevents an error. Everything else is noise — gradients behind headings,
icon-per-row, three competing button styles, decorative charts with no data.

When something is added, something should usually be removed. Interfaces get slow
and ugly by accumulation, not by any single bad decision.

## 7. States are part of the design

Every data-driven view needs five states designed, not discovered in production:

1. **Loading** — skeletons the size of the real content, not a spinner that
   collapses the layout.
2. **Empty** — say what would be here and how to create it.
3. **Partial** — some data failed; show what worked, mark what did not.
4. **Error** — what happened, what to do, and whether data is stale.
5. **Overflow** — long names, hundreds of rows, numbers with many digits.

Designing only the happy path with three rows is the most reliable way to ship
overflow bugs. The verifier checks the narrow viewport precisely because this is
where those bugs surface.

## 8. Interaction conventions you should not reinvent

- Buttons do things; links go places. A `<div>` with a click handler is neither.
- Focus is visible on every interactive element, including within dialogs.
- Destructive actions are confirmed, styled distinctly, and never the default
  focus target.
- Filters show their current state in text, not only by a changed colour.
- Anything that updates automatically must be pausable or must not move content
  under the pointer.

## 9. Anti-patterns this project writes automated checks for

| Anti-pattern | Why it matters | Caught by |
| --- | --- | --- |
| Fixed-width panels wider than the viewport | Breaks mobile entirely | `overflow` |
| Icon-only buttons without a label | Unusable with a screen reader | `a11yNames` |
| Placeholder text used as a label | Disappears on input, not announced | `labels` |
| Grey-on-grey helper text | Unreadable in daylight | `contrast` |
| `href="#"` on "buttons" | Does nothing, breaks keyboard flow | `links` |
| A dashboard shell with no data | Hides loading/empty states | `elements` |

Not everything is checkable. Taste, hierarchy, and appropriateness are yours to
argue for in `DESIGN.md` and to show in a screenshot.
