# Accessibility requirements

WCAG 2.2 AA is the target. This document is the short version an agent needs
while writing markup, plus an honest account of what the automated checks can and
cannot prove.

## Non-negotiables

### Names and roles
- Every interactive element has an accessible name: visible text first, then
  `aria-label`, then `aria-labelledby`. Icon-only buttons need `aria-label`.
- Use the native element for the job: `<button>`, `<a href>`, `<input>`,
  `<select>`. If you must build a custom widget, it needs the full ARIA pattern —
  role, state, keyboard handling — or it will be worse than the native control.
- Decorative images get `alt=""`. Meaningful images get alt text that describes
  their purpose, not their pixels.

### Forms
- Every control has a programmatically associated label: `<label for>` or a
  wrapping `<label>`. Placeholder text is not a label.
- Errors are announced (`aria-describedby`, `role="alert"`) and described in
  text, not only by a red border.
- Group related controls with `<fieldset>`/`<legend>` when the group needs a name.

### Keyboard
- Everything operable by mouse is operable by keyboard, in a predictable order.
- Focus is always visible: `:focus-visible` with a 3px ring, 2px offset.
  **Never** `outline: none` without a replacement.
- No keyboard traps. Dialogs move focus in and restore it on close.
- Skip-link to main content on long navigation.

### Colour and contrast
- Normal text: 4.5:1. Large text (≥24px, or ≥18.66px bold): 3:1.
- Non-text UI that conveys state (focus rings, input borders, chart series):
  3:1 against adjacent colours.
- Never encode information in colour alone — pair with text, icon, or pattern.

### Motion and timing
- Respect `prefers-reduced-motion`; keep parallax, autoplay, and long transitions
  behind it.
- No content that flashes more than three times per second.
- Nothing auto-advances faster than a user can read.

### Touch and zoom
- Interactive targets at least 24×24px (44×44px recommended for primary actions).
- Never `user-scalable=no` or `maximum-scale=1`. Pinch zoom must work.
- Text reflows at 320px width without horizontal scrolling.

### Structure
- One `<h1>` per page; headings descend without skipping levels.
- Landmarks: `<header>`, `<nav>`, `<main>`, `<footer>`, with `aria-label` when
  more than one of a kind exists.
- `<html lang>` is set and correct.
- Tables use `<caption>`, `<th scope>`, and real header cells.

## What the automated checks cover

| Check | Proves | Cannot prove |
| --- | --- | --- |
| `a11yNames` | Controls and images expose a name in the accessibility tree | Whether the name is *useful* |
| `labels` | Controls are programmatically associated with a label | Whether the label is clear |
| `contrast` | Declared colours meet the ratio on measurable surfaces | Text over images/gradients, `opacity` chains, anti-aliased thin text |
| `overflow` | Nothing forces horizontal scrolling at tested widths | Whether the layout is *good* at that width |
| `interactions` | Scripted flows reach the expected DOM state | Keyboard-only paths, screen-reader announcements |
| `links` | Targets resolve | Whether the destination is meaningful |

**A green run is a floor, not a certificate.** Manual review still needs to cover:

- Screen-reader output (NVDA, VoiceOver) for custom widgets.
- Keyboard-only traversal of every flow, including dialogs and menus.
- Zoom to 200% and 400% reflow.
- Contrast of text over images, gradients, and semi-transparent overlays.
- Reading order versus visual order when CSS reorders content.
- Live-region announcements for async updates.

## Recording a known limitation

If an accessibility problem cannot be fixed in this change — a third-party widget,
a design decision that needs sign-off — record it in `DESIGN.md` under
"Accessibility exceptions" with the reason and the follow-up. An undocumented
exception is indistinguishable from an oversight.
