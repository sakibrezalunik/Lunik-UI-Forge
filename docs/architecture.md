# Architecture

## Shape

```
lunik.config.json          pages, viewports, check settings
skills/                    agent-facing workflow + machine-readable manifest
knowledge/                 design intelligence (prose + tokens)
tools/                     executable audits
  visual-verify.js         verification entry point
  approve-baseline.js      the only writer of baselines/
  serve.js                 static server for manual inspection
  lib/                     config, server, browser, runner, checks, report, diff, baseline
tests/                     unit + browser tests, fixtures (pass and fail)
examples/                  two runnable dashboards
baselines/                 approved screenshots + manifest (human-approved only)
docs/                      this documentation
reports/                   generated output (gitignored)
```

The separation is intentional: **agent instructions** (`skills/`), **design
knowledge** (`knowledge/`), **rules that can be executed** (`tools/`), and
**proof** (`tests/`) are different kinds of artefact and age differently. Mixing
them is how a toolkit becomes a pile of prompts.

## Data flow

```
lunik.config.json
      │
      ├─→ config.js  (merge defaults, validate → ConfigError / exit 2)
      │
      ▼
   runner.js
      │  starts static server (only if a page uses a local path)
      │  launches browser (EnvironmentError / exit 3)
      │
      ├─→ for each page × viewport: fresh context + page
      │      ├─ collectors (console, pageerror, requestfailed, response)
      │      ├─ initial screenshot → reports/<run>/screenshots/…
      │      ├─ checks/*  → { ok, message, evidence, remediation } | { skip } | { inconclusive }
      │      └─ visual check → compare the initial screenshot against baselines/ (read-only)
      │
      ▼
   report.js  → report.json + report.md + latest.*
      │
      ▼
   severity.js → exit code (0 / 1 / 2 / 3)
```

`runner.js` never writes to `baselines/`. `approve-baseline.js` is the only
module that does, and only with `--confirm`.

## Decisions and trade-offs

### Plain ESM JavaScript, no build step

Tools run as `node tools/visual-verify.js`. No transpile step means no `dist/`
drift between what is reviewed and what runs, and an agent can read exactly the
file that executed. Trade-off: no compile-time types. Mitigated with JSDoc,
`node --check`, and a test suite that asserts behaviour rather than shapes.

### Playwright, not a custom CDP harness

Playwright gives cross-browser launching, stable locators, and screenshot
control for free. Its `expect(...).toHaveScreenshot()` was deliberately **not**
used: `--update-snapshots` rewrites baselines in place, which is exactly the
automatic approval this project forbids. Instead the diff is owned here
(`lib/diff.js`, `pngjs` + `pixelmatch`) so approval can be a separate command.

### Checks run inside the page

Accessible names come from the Chromium accessibility tree; contrast, labels,
and overflow are computed from the live DOM and computed styles. No `jsdom` or
`cheerio` — those would audit the markup, not the rendering, and would disagree
with what a user sees.

### Fixed determinism inputs

Locale, timezone, colour scheme, device scale factor, and reduced-motion are all
pinned per context. Without this, screenshots differ between machines for reasons
that have nothing to do with the UI.

### Four exit codes

`0` pass · `1` failure · `2` usage/config · `3` could not run. The fourth code is
the important one: it makes "the browser never launched" impossible to report as
a pass in CI.

### Status vocabulary

`pass`, `fail`, `warning`, `inconclusive`, `skipped`. `inconclusive` exists so a
check that ran but could not produce a trustworthy answer never collapses into
either success or failure.

### Two dependencies plus Playwright

`pngjs` (decode/encode PNG), `pixelmatch` (pixel diff), `playwright` (browser).
Everything else uses the standard library: `node:test` for tests, `node:http`
for the static server, `fetch` for link checks.

## Extension points

- **A new check** — add `tools/lib/checks/<name>.js` exporting `id`, `title`, and
  `run(ctx)`; register it in `CHECKS` in `runner.js`; add its default in
  `defaultConfig()`; add a failing fixture if it can fail.
- **A new agent platform** — implement the four adapter responsibilities listed
  in `docs/integrations.md` and reuse `skills/lunik-ui.js` as the contract.
- **A different browser** — set `browser.channel` or `LUNIK_BROWSER_CHANNEL`.
- **A different report consumer** — `report.json` is versioned
  (`schemaVersion: 1`) and stable; parse it instead of the markdown.

## Deliberately not included

- No LLM calls, no API keys, no telemetry, no network calls beyond same-origin
  link checks.
- No database, no server framework, no component library.
- No automatic baseline updates, no auto-fix mode, no autonomous redesign loop.
- No claim of support for agent platforms that have not been wired up.
