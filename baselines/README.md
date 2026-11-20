# Baselines

This directory holds **approved** screenshots used for visual regression checks.

It is intentionally empty on a fresh checkout. That is not an oversight:

- A baseline is a promise that "this exact rendering is correct". Only a human
  can make that promise.
- `tools/visual-verify.js` **never writes here**. It only reads.
- The first verification run therefore reports every visual check as a failure
  with the message *"No approved baseline"*. That is the intended behaviour.

## What a baseline does and does not cover

Each baseline is **one screenshot of the first viewport**, captured under fixed
conditions:

| Property | Contract |
| --- | --- |
| Desktop viewport | 1440 × 900 |
| Tablet viewport | 834 × 1112 |
| Mobile viewport | 390 × 844 |
| Capture mode | First viewport only |
| Interaction state | Pre-interaction |
| Motion | Frozen / reduced motion |
| Browser | Chromium |
| Full-page, below-the-fold, interactive, keyboard-focus and scroll-dependent states | **Excluded** |

A baseline represents only that first-viewport appearance at that viewport and
those conditions. It does not represent the whole page, any other width, any
interactive state, any focus state, or anything below the fold. A green visual
check therefore does **not** prove the interface is correct — it proves one
screenshot still matches an image a human approved.

Covering full-page, interaction-state or keyboard-focus rendering is a future
capability decision. The current tool has no such mode, and a baseline must not
be described as covering those cases. The authoritative version of this contract
is the "Visual baseline contract" section of [`docs/verification.md`](../docs/verification.md).

**Approval rules.** Baselines are reviewed by a human before approval, never
approved automatically. A missing or unapproved baseline is reported as a
failure and must not be treated as a pass or quietly ignored. Approval is a
separate, explicit action — `tools/visual-verify.js` only ever reads this
directory, and only `tools/approve-baseline.js` writes to it — with an explicit
`--confirm`, an explicit `--run` and the exact `--approve-hash` it printed.

## Layout

```
baselines/
├── manifest.json                     ← approval record written by the tool
├── <page-id>/
│   ├── <viewport>.png                ← approved baseline
│   └── archive/
│       └── <viewport>-<timestamp>.png ← previous baselines, kept on replacement
```

## Approving a baseline

1. Run the verification so screenshots exist:

   ```bash
   node tools/visual-verify.js --page saas-dashboard --viewport desktop
   ```

2. Look at the captured screenshot in `reports/<run-id>/screenshots/`.

3. Run the dry run. It writes nothing; it prints the run id, the candidate path,
   the candidate's SHA-256, the hash of the baseline it would replace, and (when
   a comparison is possible) writes a diff image into
   `reports/<run-id>/approval/` and prints its path:

   ```bash
   node tools/approve-baseline.js --page saas-dashboard --viewport desktop
   ```

4. Approve those exact bytes. `--run`, `--approve-hash` and `--confirm` go
   together; a hash that does not match the candidate is refused and nothing is
   written:

   ```bash
   node tools/approve-baseline.js --page saas-dashboard --viewport desktop \
     --run 2026-11-15T15-16-10-725Z \
     --approve-hash <the SHA-256 the dry run printed> \
     --note "reviewed the new metric row" --confirm
   ```

   One invocation approves one page at one viewport. There is no bulk mode.

5. Re-run verification to confirm the check now passes:

   ```bash
   node tools/visual-verify.js
   ```

## What the manifest records

Each entry stores the page id, viewport name, file path, SHA-256 of the file,
pixel dimensions, approval timestamp, optional approver and note, and the browser
version that produced it.

It also stores the audit trail (manifest `version: 2`):

| Field | Answers |
| --- | --- |
| `runId` | which verification run was approved |
| `candidate` | that run's screenshot path, SHA-256 and dimensions |
| `config` | the config file, viewport size and pixel threshold in force |
| `previous` | the image this replaced: its file, run, SHA-256, dimensions, when it was approved and by whom, plus the `archive` path and the archived file's `archiveSha256` |
| `history` | an append-only list of earlier approvals, oldest first, each with the approval that replaced it |

A `version: 1` manifest (no audit trail) is still read; its entries are upgraded
in place the next time one of them is approved, and the old record is moved into
`history` rather than dropped. A manifest with a version this tool does not know
is refused rather than guessed at.

The hash is not decoration. If a baseline file is edited by hand, verification
notices the mismatch and reports the check as **inconclusive** rather than
silently comparing against an unapproved image. Archived images are verified
against the hash recorded for them at archive time.

## Committing baselines

Committing baselines is a deliberate choice, not a default. If you do commit
them:

- Generate them on one machine/OS/browser and verify in the same class of
  environment. Font rasterisation differs across platforms, so a baseline
  produced on Windows and checked on Linux will report false regressions.
- Expect to re-approve after a browser upgrade. The check says so explicitly
  when the recorded browser version differs from the running one.
- Never commit a baseline you have not looked at.
