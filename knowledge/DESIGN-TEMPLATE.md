# DESIGN.md template

Copy this into a project as `DESIGN.md` and fill it in. Keep it short enough that
someone actually reads it: one screen of decisions beats ten pages of intentions.

Two rules:

1. **Do not overwrite an existing `DESIGN.md`.** Read it first. If a change
   contradicts it, either propose an update or follow it — never silently diverge.
2. **Write decisions, not adjectives.** "16px body, 14px tables, 48px section
   rhythm" is usable. "Clean and modern" is not.

---

```markdown
# <Project> — design system

Last reviewed: <date> · Owner: <name or agent>

## Direction

<One paragraph: what kind of interface this is, the density it targets, the
contrast strategy, and where colour is allowed to appear.>

Primary users: <who, how often, in what context>
Primary job of this UI: <the one thing it must make easy>
Most important element on the main screen: <name it>

## Colour

Semantic tokens (see `knowledge/design-tokens.json` for a starting set):

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#f6f7f9` | app background |
| `--color-surface` | `#ffffff` | cards, panels |
| `--color-text` | `#111318` | body text |
| `--color-text-muted` | `#5b6172` | secondary text (≥4.5:1 on surface) |
| `--color-border` | `#d7dbe2` | dividers, input borders |
| `--color-accent` | `#1d4ed8` | primary actions only |
| `--color-danger` | `#b91c1c` | destructive actions, failures |
| `--color-warning` | `#a16207` | degraded states |
| `--color-success` | `#15803d` | confirmed, healthy |

Rules:
- Accent colour is reserved for interactive affordances.
- Status colour is always paired with a text label.
- <any project-specific additions>

## Typography

- Family: <stack>
- Body: <size>/<line-height>
- Dense contexts (tables, badges): <size>
- Headings: <sizes and weights>
- Numerals: tabular in tables and metrics

## Spacing and layout

- Base unit: 4px; steps in use: 4, 8, 12, 16, 24, 32, 48
- Content max-width: <value>
- Shell: <sidebar / topbar / single column>
- Breakpoints: 390 (mobile), 834 (tablet), 1440 (desktop)
- Wide tables scroll inside their card, never the page

## Components

| Component | Required states | Notes |
| --- | --- | --- |
| Button | default, hover, focus-visible, active, disabled | primary/secondary/ghost only |
| Card | default, loading, empty, error | fixed min-height in data states |
| Table | default, empty, sorted, overflow | `<caption>` + `scope` required |
| Badge | neutral, success, warning, danger | always has text |
| Input | default, focus, invalid, disabled | label above, helper below |

## Accessibility requirements

- WCAG 2.2 AA. Contrast 4.5:1 body, 3:1 large text and UI boundaries.
- Visible focus ring on every interactive element.
- No information conveyed by colour alone.
- Target size ≥24×24px.
- Focus is managed in dialogs and disclosures.

## Responsive rules

- Mobile (<768px): single column, nav collapses, tables scroll in place.
- Tablet (768–1023px): <what changes>
- Desktop (≥1024px): <what changes>
- No horizontal page scroll at any width ≥320px.

## Motion

- Durations: 120ms micro, 180ms standard, 280ms panel.
- All motion wrapped in `prefers-reduced-motion: reduce`.
- <what may animate>

## Anti-patterns (do not add)

- <e.g. more than one accent colour>
- <e.g. icon-only buttons without aria-label>
- <e.g. tables that force page-level horizontal scroll>
- <e.g. gradient backgrounds behind body text>
- <e.g. unmounted third-party icon fonts>

## Accessibility exceptions

<Any known, accepted limitation with the reason and follow-up date. Empty is a
good sign.>
```
