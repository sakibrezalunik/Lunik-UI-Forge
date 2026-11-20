---
name: lunik-ui
description: Design, implement, and verify a user interface with browser-based evidence. Use when a task involves building or changing UI, choosing a visual direction, establishing a design system, auditing an interface for accessibility or responsive defects, or fixing what an audit found. Produces screenshots, machine-readable reports, and a bounded fix loop instead of unverified claims.
---

# Lunik UI

A workflow for changing a user interface and proving the result. It exists
because an interface that merely looks plausible in a screenshot can still be
unusable at 390px, unreadable for low-vision users, and broken for keyboard
users.

## When to use this

- Building a new screen, page, or component.
- Changing the visual direction or design system of an existing app.
- Auditing an interface for responsive, accessibility, or regressions.
- Fixing defects a previous audit reported.

Do not use it to generate decorative mockups or to restyle a codebase nobody
asked you to restyle.

## The loop

Work through these steps in order. Do not skip step 1, and do not skip step 7.

### 1. Inspect before you change anything

- Read the project's `DESIGN.md`. If one exists, it is the authority — follow it
  or propose an explicit update. Never silently diverge from it.
- Find the existing tokens, components, and layout patterns. Reuse them.
- Read `package.json` to learn the stack. Do not introduce a framework, a CSS
  library, or a component kit to solve a layout problem.
- Note the viewports that matter. The default config verifies 390, 834, 1440.

### 2. Clarify only what is material

Ask the user only when a missing answer would change the design: who the screen
is for, which action is primary, whether a data source is real or sample. Do not
ask questions whose answers are already in the repository.

### 3. Establish or respect the design system

If `DESIGN.md` exists, extend it. If it does not, copy
`knowledge/DESIGN-TEMPLATE.md` and fill it in *before* writing CSS. A direction
must constrain density, contrast strategy, and where colour may appear — see
`knowledge/design-principles.md`.

### 4. Plan the change in a sentence or two

Name the hierarchy: what the user sees first, second, third. If you cannot state
it, the layout is not designed yet.

### 5. Implement

- Semantic HTML first. A `<button>` for actions, an `<a href>` for navigation.
- Use the design tokens. Do not invent one-off colours.
- Design the five states: loading, empty, partial, error, long-content.
- Wrap wide tables in a scroll container with `position: relative`.
- Never remove focus outlines. Never disable user zoom.

### 6. Verify — and read the output

```bash
node tools/visual-verify.js
```

Then open `reports/latest.md` and, for anything that failed, the screenshot in
`reports/<run-id>/screenshots/`. The report states the page, viewport, check,
severity, evidence, and a suggested fix. Read the evidence; do not guess at the
cause.

Useful flags: `--page <id>`, `--viewport <name>`, `--strict`, `--quiet`.

### 7. Fix and re-run

Fix the cause, not the symptom. Deleting a test, loosening a threshold, or
lowering a severity to get green is not a fix — if you believe a check is wrong,
say so and explain why.

Re-run only the affected page/viewport while iterating, then the whole suite
once before reporting.

### 8. Report honestly

State: what changed, what the verification actually reported (paste the summary
line), which checks are warnings, and what remains unverified. Name limitations
explicitly — for example "contrast over the hero image could not be measured".

## Hard rules

1. **Never write to `baselines/`.** Visual baselines are approved by a human with
   `tools/approve-baseline.js … --confirm`. An agent must not run it on its own
   initiative, and must never create placeholder images to make a check pass.
2. **Never report a pass you did not observe.** If the browser failed to launch,
   the result is "could not run", not "passed".
3. **A warning is not a pass.** Report warnings as warnings.
4. **Bound the loop.** At most three fix/verify cycles for one task. If it is
   still failing after three, stop and report what you tried. Endless automatic
   redesign is a failure mode, not diligence.
5. **One change at a time when debugging.** If you change three things and it
   goes green, you have learned nothing.
6. **Do not restyle unrelated screens.** Stay inside the task.

## Stopping conditions

Stop and report when any of these is true:

- All required checks pass and the remaining warnings are understood.
- Three fix cycles are done and something still fails.
- The only remaining failure needs a human decision (an intentional visual
  change, a design-tradeoff, a product requirement you cannot infer).
- The environment cannot run the verification (no browser). Report that plainly.

## Output shape

End with a short summary: pages changed, checks run, real results, open
questions. Include the exact command the user should run to see the evidence
themselves.

## Reference material

| File | Use |
| --- | --- |
| `knowledge/design-principles.md` | choosing and defending a direction |
| `knowledge/design-tokens.json` | token names and measured contrast values |
| `knowledge/accessibility.md` | WCAG AA requirements and what automation cannot prove |
| `knowledge/layout-patterns.md` | shells, dense tables, responsive rules |
| `knowledge/ui-heuristics.md` | review checklist for judging a screen |
| `knowledge/DESIGN-TEMPLATE.md` | the per-project design document |
| `docs/verification.md` | what each check does and its limits |
