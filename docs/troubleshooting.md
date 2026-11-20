# Troubleshooting

Every message below is one the tools can actually produce. Start with the exit
code: `2` means you must change the configuration, `3` means the environment
prevented verification.

## "Could not launch a browser"

```
Environment error: Could not launch a browser: ...
  - Bundled Chromium is missing. Run: npx playwright install chromium
```

The bundled browser is not installed. Either install it:

```bash
npx playwright install chromium
```

or use a browser you already have:

```json
{ "browser": { "channel": "chrome" } }
```

`"msedge"` also works. For a one-off override without editing the config:

```bash
LUNIK_BROWSER_CHANNEL=chrome node tools/visual-verify.js
```

Exit code is `3` — verification did not happen. The process must exit on its
own; if a browser-launch failure leaves it running, the static server was not
released and that is a regression, not an environment quirk.

## "No configuration found at …"

You are running from a directory without `lunik.config.json`, or `--config`
points somewhere that does not exist. Run from the project root, or:

```bash
node tools/visual-verify.js --root /path/to/project
```

Exit code `2`.

## "Invalid JSON in configuration file"

```
Configuration error: Invalid JSON in configuration file: …\lunik.config.json
  - Failed to read JSON at …: Unexpected token '/', "/ a comment"… is not valid JSON
```

The file exists but does not parse — usually a comment (`//`, `/* */`), a trailing
comma, or a `.md`/`.txt` file passed to `--config`. The message names the file and
the parser's complaint. Exit code `2`, with no stack trace: this is a config
mistake, not an environment failure.

If the path cannot be read at all (a directory, permissions), the run exits `3`
with an `Environment error` instead — that is not something editing JSON fixes.

## "Unknown page id" / "Unknown viewport name"

The `--page` or `--viewport` value is not in the config. The error lists the ids
that are configured. Exit code `2`.

## "No approved baseline for …"

Expected on a fresh checkout. The visual check needs a baseline a human has
approved; the tool will not create one for you, and `--plan` writes nothing.

See [Approve a baseline](getting-started.md#approve-a-baseline) for the full
capture → inspect → dry run → confirm walkthrough. On the first approval there is
no diff image, because there is no existing baseline to compare against.

## "The baseline manifest at … does not satisfy its schema"

Every entry in `baselines/manifest.json` must carry a 64-character lowercase
SHA-256 fingerprint. An entry with a missing, empty, malformed or wrong-length
hash is refused **before any page is opened** (exit `2`), because a baseline
without a fingerprint cannot be distinguished from one swapped outside the
approval workflow.

The error lists the offending keys. Either repair the manifest by hand or delete
the broken entries and re-approve those baselines deliberately — dry run first,
inspect the candidate, then confirm the hash it prints. See
[Approve a baseline](getting-started.md#approve-a-baseline).

A manifest that is not valid JSON is reported the same way, as a configuration
error rather than an environment failure.

## "`--run …` is not a verification run id"

`--run` takes the run id printed by the verification report — the directory name
under `reports/`, shaped like `2026-11-15T15-16-10-725Z`. Values containing
separators, `..`, a drive letter, or a leading slash are rejected before the
screenshot path is built, so they never reach the filesystem.

A dry run may omit `--run`: it then uses the newest run that captured that
page/viewport and prints which one it picked. An approval may not — `--confirm`
refuses to run without an explicit `--run`, so the run a human reviewed is the
run that gets approved.

## "The baseline file does not match the hash recorded at approval time"

The baseline PNG was modified after approval — edited by hand, replaced by a
script, or restored from an inconsistent backup. The comparison cannot be
trusted, so the result is `inconclusive` (exit `3`).

Re-approve it explicitly if the current image is correct; see
[Approve a baseline](getting-started.md#approve-a-baseline). The dry run compares
against the image currently on disk, so inspect that diff before confirming.

## "Baseline was approved on <version> but this run used <version>"

The browser changed. Font rasterisation and layout rounding differ between
builds, so a pixel comparison across versions produces false regressions. Either
pin the browser version, or re-approve the baselines on the new one.

## The visual check reports a diff that looks invisible

Check `maxDiffRatio` in the config (default 0.1%, i.e. 0.001) and open the diff
image in `reports/<run-id>/diffs/`. Common benign causes:

- Anti-aliasing differences after a font stack change.
- A scrollbar appearing because content height crossed a threshold.
- A date or timestamp rendered in the page.
- Subpixel rendering differences between two machines.

If it is benign, approving a new baseline is the correct action — but look at the
image first.

## "Page responded with HTTP 404"

The `path` in the config does not exist under the project root. Paths are
served from the root, so `/examples/x/index.html` means
`<project>/examples/x/index.html`. Exit code `3`.

## "N network request(s) had not received a response within the X ms observation window plus the Y ms pending-request timeout"

The network check reached its hard bound with requests still unanswered, so
their outcome is unknown. This is `inconclusive` (exit `3`) on purpose: running
out of time is never reported as a pass.

Decide which of these it is:

- **The request is legitimately slow.** Raise `checks.network.pendingTimeoutMs`
  (max `30000`). This only affects requests that started inside the observation
  window.
- **The page keeps a connection open on purpose** (an event stream, a long poll,
  a websocket-style keepalive). Add a substring of its URL to
  `checks.network.ignore`. An ignored request is excluded from the wait, so it
  neither blocks verification nor forces exit `3`, and it is still counted in
  the report under `counts.ignored.pending`.
- **The request genuinely never finishes.** That is a defect in the page, not a
  timeout to tune.

Note that the two numbers are different budgets: raising
`observationWindowMs` widens *what is observed*, raising `pendingTimeoutMs`
widens *how long an observed request may take*.

## A request is reported as cancelled with reason `navigation`

Not a failure. The document changed while the request was in flight — a
`page.reload()` between interaction flows, a `location.reload()` in the page, a
link to another page — so the response never arrived and the request could not
be evaluated. The report says so explicitly (`evidence.cancelled`) instead of
claiming a success. If the request mattered, assert its result *before*
navigating away, or keep the interaction on one document.

## "N request(s) started after the observation window and were not evaluated"

A request was initiated after `checks.network.observationWindowMs` closed. It is
outside the observation scope: it was not waited for and it is not evidence that
the page has no network problems. If the request matters, do one of:

- start it earlier in the interaction (the step that triggers it should run
  before the flow ends);
- raise `checks.network.observationWindowMs` (max `10000`) so it falls inside
  the window.

Bounded observation is not complete monitoring: a request initiated after the
window — or after the page closes — may not be seen at all.

## "checks.network.observationWindowMs must be an integer between 0 and 10000"

Both `observationWindowMs` (`0`–`10000`) and `pendingTimeoutMs` (`0`–`30000`)
are whole milliseconds. A negative, fractional or oversized value exits `2`
rather than being clamped, because a config that could make verification hang
must not be accepted. The same applies to `checks.network.ignore`, which must be
an array of non-empty strings.

## A page loads but every element check fails

Usually the app renders client-side and the checks ran before hydration
finished. The runner waits for `load` and for `document.fonts.ready`, not for
your framework's readiness signal. Add a deterministic marker element and wait
for it — for example, have the app set `data-ready="true"` on `<body>` and
include `[data-ready='true']` in `expect.selectors`.

## "Horizontal overflow" points at a table

If the table is inside a scroll container and still widens the page, the cause
is almost always an absolutely positioned descendant (a `visually-hidden` label,
a tooltip, a badge) escaping the clip because the container is not positioned:

```css
.table-wrap { position: relative; overflow-x: auto; }
```

## Tests fail with "ENOENT … tests/.tmp-test/config-*.json"

Two test files sharing a scratch directory and deleting each other's fixtures.
This was a real bug in this repository and is fixed; if you add a test file,
clean up only your own files under `tests/.tmp-test/`.

## `node --test tests/unit` says "Cannot find module"

Node 24 treats positional `--test` arguments as file paths or globs, not
directories. Use a glob, as the npm scripts do:

```bash
node --test "tests/unit/**/*.test.js"
```

## Port already in use when running `npm run serve`

```bash
node tools/serve.js --port 4174
```

## Everything passes but the page looks wrong

The checks measure overflow, names, contrast ratios, links, expected elements,
and pixel differences. They do not measure taste, hierarchy, or whether the
layout communicates the right thing. That is what `knowledge/ui-heuristics.md`
and the screenshots are for. A green run is a floor, not a certificate.
