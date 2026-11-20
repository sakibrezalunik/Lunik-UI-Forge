# UI heuristics

Use these when reviewing a rendered interface — your own or an existing one. Each
heuristic is phrased as a question you can answer from a screenshot or a click
path, so it produces a fix rather than an opinion.

## 1. Is the purpose of the screen obvious in three seconds?

Name the screen's job out loud. If you need the navigation to explain it, the
heading or the primary action is wrong.

## 2. Is the most important thing the most prominent thing?

Squint test. The first landing point of the eye must be the primary metric or
action. Sidebars, logos, and decorative gradients frequently win this by accident.

## 3. Does every element earn its place?

For each visual element, state what decision or action it supports. "It fills the
space" is a reason to delete it.

## 4. Are the states designed?

Check loading, empty, partial, error, and long-content. If any of them is
improvised, it is not designed. Simulate by throttling the network and by
filtering to zero results.

## 5. Can you tell what is interactive without hovering?

Interactive elements must be distinguishable at rest. If the only affordance is a
hover colour change, keyboard and touch users get no signal.

## 6. Is feedback immediate and proportionate?

- Buttons respond on press, not on completion.
- Actions that fail say so near the thing that failed.
- Success does not need a modal. Failure does need a specific message.

## 7. Is the same thing called the same thing everywhere?

One concept, one word. If the nav says "Alerts", the heading says "Alert
overview", and the button says "Open cases", the user now has three concepts.

## 8. Are numbers readable and honest?

- Tabular numerals for columns and live values.
- Units next to the number, not in a legend at the bottom.
- No precision theatre: `99.2%` next to `41` incidents is false precision.
- Sample data is labelled as sample data.

## 9. Does the layout hold at 390px and at 1440px?

Check for: sideways scroll, clipped labels, overlapping badges, tables that crush,
and actions that fall below the fold on mobile. Wide layouts fail by being empty;
narrow layouts fail by being crowded.

## 10. Is destructive action safe?

Confirmation for irreversible operations, distinct styling that is not the same
colour as the primary action, and no destructive default focus.

## 11. Does motion explain something?

Animation should show where a panel came from, or draw attention to a change that
already happened. If the motion only decorates, it costs frames and distracts.

## 12. Would a screen-reader user be able to complete the main task?

Tab through the primary flow. Every stop must announce what it is and what it
does. If you cannot tell from the announcement alone, neither can they.

## 13. Is the empty database still a usable product?

The zero-data state is the first thing every new user sees. If it says
"No data available" and offers nothing, the product starts broken.

## Severity guidance for findings

| Level | Meaning | Examples |
| --- | --- | --- |
| Blocker | Task cannot be completed or content cannot be perceived | Unlabelled form control, contrast below 3:1, dialog without focus management |
| Major | Task is possible but damaged | Horizontal overflow on mobile, missing empty state, destructive action unconfirmed |
| Minor | Polish that affects trust | Inconsistent spacing, mixed button styles, misaligned numerals |
| Note | Observation, no action needed yet | "The third chart duplicates the second; consider removing one" |

Report findings at the level you would defend in review. Inflating minor issues
to blockers trains people to ignore the report.
