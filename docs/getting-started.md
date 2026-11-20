# Getting started

This is the primary onboarding path: from a fresh checkout to a verified page and
one approved visual baseline. Reference material lives in
[Configuration](configuration.md) and [Verification](verification.md); this page
does not repeat their tables.

## Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 20.11 | Developed and verified on Node 24.21.0 |
| npm | any recent | Used only to install dependencies |
| A Chromium-based browser | any current | Playwright's Chromium, or a local Chrome/Edge via `channel` |

No build step, no transpiler, and no framework. Every tool is plain ESM run
directly by `node`.

## Install

```bash
npm install
npx playwright install chromium
```

If you would rather not download a browser and already have Chrome or Edge
installed, skip the second command and set this in `lunik.config.json`:

```json
{ "browser": { "channel": "chrome" } }
```

`"msedge"` also works. If the browser is missing, verification exits `3` with the
install command in the message; it never reports a pass without a browser.

## Check the plan before running

```bash
node tools/visual-verify.js --plan
```

The plan validates the configuration and prints what a verification *would* do:

- the project root, config file, selected browser and enabled checks;
- every page and viewport, and the number of combinations;
- where reports, screenshots and baselines are written;
- how many baseline images are already present when visual comparison is enabled
  (or that baselines are not used when it is disabled);
- the exact command to run next, including `--config`/`--root` when you used them.

It launches no browser and writes no files, so it is safe to run after every
configuration edit. A bad config exits `2` here, before any capture is lost.

Limit the plan the same way you limit verification:

```bash
node tools/visual-verify.js --plan --page saas-dashboard --viewport mobile
```

## Run the first verification

```bash
npm run verify
```

On a fresh checkout this exits `1` with **54 passed and 6 failed**. All six
failures are the visual check: two pages × three viewports have no approved
baseline. Nothing is broken, and no other check should fail.

```
FAIL  54 passed · 6 failed · 0 warnings · 0 inconclusive · 0 skipped
Report: reports/<run-id>/report.md
Machine-readable: reports/latest.json
```

If you see a failure from a different check, fix that first — it is a real
finding, not first-run setup. The run also prints a short "First run" hint that
points at the report and at `--plan`.

Reports are written per run:

```
reports/<run-id>/report.md          human-readable
reports/<run-id>/report.json        machine-readable
reports/<run-id>/screenshots/<page>/<viewport>.png
reports/<run-id>/diffs/             only when a baseline existed to compare
reports/latest.md                   copy of the newest report
reports/latest.json
```

`reports/` is disposable. `baselines/` is not: it holds approved images.

## Read the report

Open `reports/latest.md` in your editor (or `latest.json` from a script). The
"Needs attention" section gives, for each failure:

- the page, viewport, check and severity;
- what was observed, in plain language;
- a suggested fix, including a copy-pasteable command when a baseline is needed;
- artifact paths — start with the screenshot.

The "Skipped checks" section says why a check did not run (for example, no
interactions or no expected selectors configured). A skipped check is not a pass.

## Approve a baseline

This is a deliberate human action: a baseline is a claim that a rendering is
correct. Only a human can make it, so `tools/visual-verify.js` never writes one.

1. Capture the page and viewport you want to approve:

   ```bash
   node tools/visual-verify.js --page saas-dashboard --viewport desktop
   ```

2. Open the screenshot path from the report:
   `reports/<run-id>/screenshots/saas-dashboard/desktop.png`.

3. Run the approval without `--confirm`. This is a dry run: it writes nothing and
   prints the run id, candidate path, image size and SHA-256.

   ```bash
   node tools/approve-baseline.js --page saas-dashboard --viewport desktop
   ```

   On the first approval it also says `No baseline exists yet`, and there is no
   diff image because there is nothing to compare. Later approvals compare against
   the current baseline and write a diff at
   `reports/<run-id>/approval/<page>/<viewport>-diff.png`.

4. Approve exactly the bytes the dry run printed. `--run`, `--approve-hash` and
   `--confirm` go together; a hash that does not match the candidate is refused
   and nothing is written.

   ```bash
   node tools/approve-baseline.js --page saas-dashboard --viewport desktop \
     --run <run-id the dry run printed> \
     --approve-hash <SHA-256 the dry run printed> \
     --note "initial approved baseline" --confirm
   ```

If you used `--config` or `--root`, the printed dry run and confirm commands
already include those flags, so they can be pasted as-is.

Approval writes `baselines/<page>/<viewport>.png` and records the image's
SHA-256, the run it came from, what it replaced, and an append-only history in
`baselines/manifest.json`. A baseline edited outside this workflow is detected and
reported as inconclusive instead of being trusted.

## Re-run after approval

```bash
node tools/visual-verify.js --page saas-dashboard --viewport desktop
```

That visual check now passes. `npm run verify` still fails the other five visual
checks until each one is reviewed and approved the same way. That is intentional:
approving is per page and viewport, so one hasty click cannot accept the whole
interface.

## Look at the examples

```bash
npm run serve
```

Then open:

- `http://127.0.0.1:4173/examples/saas-dashboard/`
- `http://127.0.0.1:4173/examples/cybersecurity-dashboard/`

Both are static HTML/CSS/JS with local sample data. They make no network requests
and claim no live integration.

## Point it at your own page

Create `lunik.config.json` at your project root (or copy this repository's file
and replace `pages`):

```json
{
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 900 },
    { "name": "mobile", "width": 390, "height": 844 }
  ],
  "pages": [
    {
      "id": "home",
      "path": "/index.html",
      "expect": { "selectors": ["h1", "nav"] }
    }
  ]
}
```

- `path` starts with `/` and is served from the project root by the built-in
  static server: `/index.html` means `<project>/index.html`.
- If your app already runs in dev mode, use `"url": "http://127.0.0.1:5173/"`
  instead of `path`. `url` wins when both are present.
- `id` must be lower-case (it becomes a directory under `reports/` and
  `baselines/`); viewport names are used as file names. Both are validated.
- `expect.selectors` is optional, but it tells the `elements` check what matters
  on the page. `interactions` scripts flows that must keep working.
- `reportsDir` and `baselinesDir` default to `reports` and `baselines`; both are
  relative to the project root.

Then plan, verify and read the report:

```bash
node tools/visual-verify.js --plan
node tools/visual-verify.js
```

Run from a different directory with `--root <project>`, or use a differently
named config with `--config <path>`. See [Configuration](configuration.md) for
every field, threshold and interaction step.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Every required check passed | Warnings may still be present |
| `1` | At least one check failed | Read `reports/latest.md` |
| `2` | Configuration or usage error | Fix the message printed on stderr |
| `3` | Verification could not run | Browser missing, page unreachable, or a check was inconclusive |

Code `3` exists so that "we could not check" can never be mistaken for "we
checked and it is fine" in a script or CI job.

## Run the tests

```bash
npm test            # unit tests, no browser needed (about a minute)
npm run test:browser # integration tests in a real browser (about a minute)
npm run test:all
```

The browser tests deliberately include fixtures that must fail, and assert the
baseline-approval safety model end to end.

## Where to go next

- [Configuration](configuration.md) — pages, viewports, checks, thresholds.
- [Verification](verification.md) — what each check actually proves, and the
  limits of a baseline.
- [Troubleshooting](troubleshooting.md) — browser launch, bad JSON, baseline
  mismatches.
- [Architecture](architecture.md) — module boundaries and decisions.
