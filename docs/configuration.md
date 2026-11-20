# Configuration

Everything is driven by `lunik.config.json` at the project root, merged over the
defaults in `tools/lib/config.js`. Unknown keys are ignored; invalid values fail
with exit code 2 and a specific message.

```bash
node tools/visual-verify.js --config path/to/other.config.json
```

## Top-level fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `viewports` | array | 1440×900, 834×1112, 390×844 | Named viewport sizes to verify |
| `pages` | array | `[]` | Pages to verify (required, non-empty) |
| `browser.channel` | string \| null | `null` | `null` = Playwright Chromium; `"chrome"`/`"msedge"` = installed browser |
| `browser.headless` | boolean | `true` | Run headless |
| `browser.colorScheme` | string | `"light"` | Emulated `prefers-color-scheme`, so screenshots do not depend on the host theme |
| `reportsDir` | string | `"reports"` | Where runs are written (relative to the project root) |
| `baselinesDir` | string | `"baselines"` | Where approved baselines live |
| `checks` | object | see below | Per-check enable/disable, severity, thresholds |

## Viewports

```json
{ "viewports": [
  { "name": "desktop", "width": 1440, "height": 900 },
  { "name": "mobile",  "width": 390,  "height": 844 }
] }
```

Names must be unique and must match `/^[a-z0-9][a-z0-9._-]*$/`. A name becomes a
baseline file (`<name>.png`) and an archive prefix, so anything that looks like a
path — `../x`, `..\x`, `C:\x`, `sub/dir` — is rejected during validation, and
again when the path is built. The same rule applies to page ids. Viewports are
emulated with `deviceScaleFactor: 1`, `locale: en-US`, and `timezoneId: UTC` so
rendering does not vary by machine.

## Pages

A page is either served from the project root (`path`) or already running
elsewhere (`url`).

```json
{
  "id": "saas-dashboard",
  "path": "/examples/saas-dashboard/index.html",
  "design": "examples/saas-dashboard/DESIGN.md",
  "expect": {
    "selectors": [
      "h1",
      { "selector": "[data-accounts-table]", "text": "Accounts" }
    ]
  },
  "interactions": [
    {
      "name": "churned filter shows the empty state",
      "steps": [
        { "click": "[data-filter='churned']" },
        { "expectVisible": "[data-empty-state]" }
      ]
    }
  ]
}
```

- `id` must match `^[a-z0-9][a-z0-9._-]*$`. It becomes a directory name under
  `baselines/`, so this is a safety constraint, not a style preference.
- `path` must start with `/` and is served by the built-in static server, which
  refuses to serve anything outside the project root.
- `url` takes precedence over `path` when both exist. Useful for an app you are
  already running in dev mode.
- `design` is documentation only; the verifier does not parse it.

### Interaction steps

| Step | Shape | Asserts |
| --- | --- | --- |
| `click` | `{ "click": "selector" }` | Clicks the first match |
| `fill` | `{ "fill": "selector", "value": "text" }` | Types a value |
| `select` | `{ "select": "selector", "value": "opt" }` | Selects an option |
| `press` | `{ "press": "selector", "key": "Enter" }` | Presses a key |
| `hover` | `{ "hover": "selector" }` | Hovers |
| `focus` | `{ "focus": "selector" }` | Focuses |
| `expectVisible` | `{ "expectVisible": "selector" }` | Element becomes visible |
| `expectHidden` | `{ "expectHidden": "selector" }` | Element is not visible |
| `expectText` | `{ "expectText": "selector", "contains": "x" }` | Text contains a substring |
| `expectCount` | `{ "expectCount": "selector", "equals": 2 }` | Match count (or `atLeast`) |
| `expectFocus` | `{ "expectFocus": "selector" }` | `document.activeElement` matches |

Each interaction starts from a fresh page load, so flows cannot leak state into
one another. A step has a 2.5 s timeout.

## Checks

```json
{ "checks": {
  "console":      { "enabled": true,  "severity": "error" },
  "contrast":     { "enabled": true,  "severity": "warning",
                    "minRatioNormal": 4.5, "minRatioLarge": 3 },
  "overflow":     { "enabled": true,  "severity": "error", "tolerance": 1 },
  "network":      { "enabled": true,  "severity": "error",
                    "ignore": ["/favicon.ico"],
                    "observationWindowMs": 1000,
                    "pendingTimeoutMs": 2000 },
  "visual":       { "enabled": true,  "severity": "error",
                    "maxDiffRatio": 0.001, "pixelThreshold": 0.1 }
} }
```

`severity` is `"error"` or `"warning"`.

- `"error"` — a violation becomes `fail` and the run exits 1.
- `"warning"` — a violation becomes `warning`; the run still exits 0 unless
  `--strict` is passed.

Choosing `warning` for contrast is deliberate: automated contrast cannot measure
text over images or gradients, so treating it as a hard gate would produce false
confidence in both directions. Do not lower a severity to get a green run — fix
the defect or document why the check cannot see it.

### Network observation

| Key | Type | Default | Allowed | Meaning |
| --- | --- | --- | --- | --- |
| `ignore` | string[] | `["/favicon.ico"]` | non-empty strings | URL substrings to exclude from the network verdict |
| `observationWindowMs` | integer | `1000` | `0`–`10000` | How long after the last interaction step new requests still count as in scope |
| `pendingTimeoutMs` | integer | `2000` | `0`–`30000` | How long a request that started inside that window may stay unanswered |

Both values are milliseconds, must be whole numbers, and are validated when the
config loads: a negative value or a value above its maximum exits `2` with a
message naming the key. They are clamped by nothing — invalid means rejected,
which is why a configuration cannot make verification hang.

`ignore` keeps its original syntax (substring match, case-sensitive) and now
applies to **failed, cancelled and pending** requests alike. It does not hide
other URLs: a 404 that does not match an ignore pattern is still a failure even
when another request on the same page is ignored. Ignored requests are counted
and disclosed in the report (`evidence.counts.ignored`) rather than omitted
silently.

`observationWindowMs` and `pendingTimeoutMs` are two different budgets and must
not be confused:

- the **observation window** decides *what is observed* — a request initiated
  after it closes is out of scope and is not counted either way;
- the **pending timeout** decides *how long an observed request may take* before
  its outcome is reported as unknown.

The worst case for one page/viewport is `observationWindowMs +
pendingTimeoutMs` (3 s with the defaults), and it is only paid when the page has
configured interactions. See
[verification.md](verification.md#network) for the semantics and the limitation.

### Visual thresholds

- `maxDiffRatio` — fraction of differing pixels tolerated (0.001 = 0.1%).
- `pixelThreshold` — pixelmatch colour tolerance, 0–1. Higher tolerates more
  per-pixel colour drift; it does not tolerate missing elements.

## CLI flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--config <path>` | both tools | Alternate config file |
| `--root <path>` | both tools | Project root (default: current directory) |
| `--page <id>` | verify | Limit to a page (repeatable) |
| `--viewport <name>` | verify | Limit to a viewport (repeatable) |
| `--strict` | verify | Treat warnings as failures |
| `--quiet` | verify | Only print the final summary |
| `--plan` | verify | Print the effective pages, viewports, checks and output locations, then the next command. Launches no browser and writes nothing |
| `--confirm` | approve | Actually write the baseline. Refused without `--run` and `--approve-hash` |
| `--approve-hash <sha256>` | approve | The candidate hash the dry run printed. A value that does not match the candidate this invocation read is refused and nothing is written |
| `--note <text>` | approve | Recorded in the manifest |
| `--by <name>` | approve | Recorded in the manifest |
| `--run <runId>` | approve | Which run's screenshot to approve; required with `--confirm`. Must be a generated run id (`2026-11-15T15-16-10-725Z`) — paths, separators and anything else are refused before the path is built |

Option names are validated: an unknown option (for example a mistyped
`--stirct`) and an option that takes a value but was given none both exit `2`
with a message naming the option. Nothing is verified or written in either case.
This matters because silently ignoring `--strict` would report a run as passing
when the operator expected warnings to be fatal. `--quiet` prints only the final
summary line; per-check details stay in the report.
