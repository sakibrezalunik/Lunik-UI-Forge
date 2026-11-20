# Verification

What each check actually inspects, what it can prove, and what it cannot. Read
the limitations column before trusting a green run.

## How a run works

For every page × viewport:

1. A fresh browser context is created at that viewport size, with
   `deviceScaleFactor: 1`, `locale: en-US`, `timezoneId: UTC`, the configured
   colour scheme, and `reducedMotion: reduce`.
2. The page loads over real HTTP from the built-in static server.
3. Motion is frozen with an injected stylesheet so nothing animates mid-audit.
4. One initial screenshot is captured **before** any check or interaction can
   mutate the page.
5. Checks run in the report order `console`, `network`, `overflow`, accessible
   names (`a11yNames`), `labels`, `contrast`, `links`, `elements`, `visual`,
   `interactions`. The visual check compares the already-captured screenshot
   against the approved baseline. The first two checks are pure functions over
   collected browser events, so their verdicts are finalised **after**
   interactions run: an error or failed request raised by a scripted flow is
   reported instead of being missed. Only the timing changes — the order in the
   report stays the same and each check is reported once.
6. Interactions run last, each from a fresh load.
7. The post-interaction observation window closes, and only then are `console`
   and `network` finalised — see [network](#network) for the exact policy and
   its limits.

A navigation failure aborts the whole page/viewport and produces a single
`navigation` result with status `inconclusive`.

## The checks

| Check | What it inspects | Default severity |
| --- | --- | --- |
| `console` | `console.error` calls and uncaught exceptions | error |
| `network` | Failed requests and responses with status ≥ 400 | error |
| `overflow` | Document width versus viewport width, plus the offending elements | error |
| `a11yNames` | The Chromium accessibility tree: controls and images with no name | error |
| `labels` | Form controls without an associated label; `label[for]` with no target | error |
| `contrast` | Declared text colour against the resolved background | warning |
| `links` | Broken same-origin links, unresolved `#fragment`s, placeholder links | error |
| `elements` | Configured selectors are present, visible, and contain expected text | error |
| `interactions` | Scripted flows reach the expected DOM state | error |
| `visual` | Pixel diff against the approved baseline | error |

### console

Captures `console.error` and uncaught exceptions across the whole run: page load
**and** the configured interactions. `console.warn` and `log` are ignored on
purpose — they are too noisy to gate a build.

### network

Reports requests that failed outright and responses with a 4xx/5xx status, for
the whole run including requests made by interactions. `checks.network.ignore`
holds URL substrings to skip (favicon probes by default); it applies to failed,
cancelled and pending requests alike.

**What counts as a completed response.** A request stops waiting for an answer
as soon as its **response** arrives — the status is what the check judges. It is
not required that the page read the body: Chromium never emits
`requestfinished` for a fetch whose body is left unconsumed, so requiring that
event would leave a perfectly healthy request pending forever. The evidence
reports how many responses arrived without a finish event
(`counts.responsesWithoutFinishEvent`). A request that failed *before* any
response is a different state and is never described as a successful response.

**The observation policy.** Console and network are evaluated after interactions
run, but a request started by the last step may still be in flight — and an
interaction that debounces, awaits an animation frame, or queues a task starts
its request *after* the step returns. Evaluating immediately would report “all
requests succeeded” for a request that is about to 404.

So, when interactions are configured, the runner observes the network under two
separate budgets (`checks.network.observationWindowMs`, default 1000 ms, and
`checks.network.pendingTimeoutMs`, default 2000 ms):

1. **Observation window** — a fixed wait after the last interaction step. Every
   request initiated inside it is in scope, including ones dispatched by a
   timer, a debounce or an animation frame.
2. **Pending timeout** — a second budget for requests that started inside the
   window to receive a response. The drain stops as soon as nothing in-scope is
   waiting.

The window is never extended because requests keep arriving: the cost of a run
is bounded and predictable (`observationWindowMs + pendingTimeoutMs` worst case
per page/viewport, only when interactions are configured).

**The limitation, stated plainly.** Bounded observation is not monitoring.
A request initiated after the observation window closes is *outside the
observation scope*: it is not waited for, and it is not evidence that nothing
happened. Requests that do start after the window are counted in
`counts.outsideObservationWindow` and named in the message, but a request that
starts after the check has finished (or after the page closes) is not seen at
all. A green network result means “no failure among the requests that were
observed”, never “this page makes no failing requests”.

The verdict model keeps every state apart:

| Observation | Result |
| --- | --- |
| 4xx/5xx response, or a transport failure other than cancellation | `fail` |
| Response received (status inspected, body consumed or not) | counted as completed |
| Request cancelled before any response (`net::ERR_ABORTED`) | `pass`, with the count in the message and the URLs plus reason in evidence — “not evaluated”, never a silent success |
| Request invalidated by a document navigation | reported as cancelled with `reason: "navigation"`, never as a success |
| Request still pending when both budgets are spent | `inconclusive` (exit 3) — running out of time is not a pass |
| Request matching `checks.network.ignore` | excluded from the wait and the verdict, counted under `counts.ignored` |
| Request initiated after the window | outside the observation scope, disclosed and not counted |

Identical findings (same kind, URL and detail) are reported once, and each
request contributes at most one finding even when redirect hops or repeated
lifecycle events arrive.

**Cancellation and navigation.** Requests are tracked against the document that
issued them. When a frame swaps documents — a harness reload between
interactions, `location.reload()`, a link to another page — unanswered requests
from the previous document are resolved as cancelled with the reason
`navigation`. Chromium emits neither `requestfinished` nor `requestfailed` for
them, so without this they would sit in the pending set until the hard timeout.
A same-document navigation (`history.pushState`, a `#hash` change) does *not*
count as a new document, and a genuine transport failure reported for a request
already marked cancelled replaces the cancellation — observed evidence wins over
a speculative one.

**Long-lived connections.** A connection that never answers (an event stream, a
long poll, a websocket-style keepalive) has no verdict, so a non-ignored one
reaches the hard timeout and makes the check `inconclusive` (exit 3). If it is
expected to stay open, add it to `checks.network.ignore`; an ignored request
then neither blocks the wait nor forces exit 3, and does not hide failures from
other URLs.

### overflow

Compares `documentElement.scrollWidth` against `innerWidth`. When it overflows,
it lists the elements whose right (or left) edge passes the viewport, sorted by
how far they extend, with a CSS-ish selector path.

The failing fixture proves this catches the intended case. Real-world causes
worth knowing:

- A fixed-width panel or an image larger than the viewport.
- A grid or flex child without `min-width: 0`, which refuses to shrink below
  its content.
- **An absolutely positioned element inside a scrolling table.** If the scroll
  container is not `position: relative`, a `visually-hidden` label inside a cell
  anchors to the viewport and widens the page. This exact bug was found in this
  repository's own cybersecurity example during development.

### a11yNames

Reads the real accessibility tree over the DevTools protocol and reports
interactive roles (button, link, textbox, checkbox, tab, …) and images whose
computed name is empty. Each finding includes a snippet of the offending
`outerHTML`.

If the tree cannot be read, the result is `inconclusive`, never a pass.

### labels

Checks every `input`, `select`, and `textarea` (excluding hidden/submit/button/
reset/image) for an accessible association: `aria-label`, resolving
`aria-labelledby`, `title`, a wrapping `<label>`, or `label[for]`. Also reports
`label[for]` values that point at no element.

### contrast

Computes WCAG 2.2 AA ratios from declared colours: 4.5:1 for normal text, 3:1
for large text (≥24px, or ≥18.66px bold). The background is resolved by walking
ancestors and compositing any semi-transparent layers over white.

**Cannot measure:**

- Text over background images or gradients (counted as `unverifiable`).
- `opacity` applied to an ancestor.
- Whether a passing ratio is actually comfortable to read.

Because of these gaps the default severity is `warning`, and every result states
how many elements could not be measured.

### links

Resolves in-page `#fragment` links against the DOM, fetches same-origin and
relative links over HTTP, and flags `href="#"` or empty links as placeholders.
External hosts are counted but not fetched: a remote outage is not a defect in
this project, and verification should not depend on the public internet.

### elements

Checks the `expect.selectors` from the page config: present, visible, and — when
`text` is given — containing the expected substring. This catches "the app did
not boot", which a screenshot can miss when an empty page looks plausible.

### interactions

Replays the configured step sequences. Each interaction reloads first so state
cannot leak between flows. Failures name the step index and the expectation that
was not met.

### visual

Compares the screenshot against `baselines/<page>/<viewport>.png`.

- No baseline → **fail**, with the exact approval command in the remediation.
- Baseline present but not in the manifest, or with a mismatched SHA-256 →
  **inconclusive**. Someone edited it outside the approval workflow.
- Manifest entry without a valid SHA-256 fingerprint → the run is refused as a
  configuration error (exit 2) before any page is opened. Integrity fails closed:
  an entry that could omit its hash could vouch for an image the tool never saw.
- Baseline recorded on a different browser version → **inconclusive**. Rendering
  differs between builds, so the comparison is not trustworthy.
- Size change → fail. Layout or scrollbar behaviour changed.
- Pixel difference above `maxDiffRatio` → fail, with a diff image.

## Visual baseline contract

A baseline is a screenshot someone looked at and approved. It is worth being
precise about how little that promises, because "the visual check is green" is
easily read as "the interface is correct", and it does not mean that.

### What is captured

Every visual check compares exactly one image per page and viewport, produced
under these conditions:

| Property | Contract |
| --- | --- |
| Desktop viewport | 1440 × 900 |
| Tablet viewport | 834 × 1112 |
| Mobile viewport | 390 × 844 |
| Capture mode | First viewport only |
| Interaction state | Pre-interaction (captured before any scripted flow runs) |
| Motion | Frozen — `reducedMotion: reduce` plus an injected no-animation sheet |
| Browser | Chromium (the version is recorded in the manifest entry) |
| Full-page captures | Excluded |
| Below-the-fold content | Excluded |
| Interactive states | Excluded |
| Keyboard-focus screenshots | Excluded |
| Scroll-dependent states | Excluded |

### What a baseline therefore represents

A baseline represents **only the configured first-viewport appearance at the
specified viewport, browser and capture conditions**. It does not represent the
complete page, the layout at any other width, any interactive state reached by a
scripted or human flow, any keyboard-focus state, or anything below the fold at
the captured viewport.

Consequences worth stating plainly:

- **A passing visual check is not proof of UI correctness.** It proves that one
  screenshot at one size still matches an image a human approved. The other
  checks in this tool (`overflow`, `contrast`, `labels`, `a11yNames`, `links`,
  `elements`, `interactions`, `console`, `network`) cover different failures, and
  the responsive behaviour of a page is covered by the browser test suite
  (`tests/browser/responsive-layout.test.js`), not by baselines.
- **Content below the fold is not covered.** On the example dashboards the mobile
  alert queue, the SaaS accounts table and both footers sit outside a first
  viewport capture entirely. A regression there can be invisible to a baseline.
- **Hover, focus, disabled, empty and post-interaction states are not covered.**
  The empty-state blocks, active filter chips and acknowledged alert rows never
  appear in a baseline image.
- **Scrolling changes what is on screen and is not captured.** A horizontally
  scrollable table is photographed at its scroll position of 0 only.

Extending visual coverage to full-page captures or interaction and
keyboard-focus states is a **future capability decision**, not something the
current implementation does. Until such a mode exists and is documented here,
no baseline may be described as covering them.

### Approval is a separate, human action

- `tools/visual-verify.js` **never** writes to `baselines/`. It only reads.
- A missing or unapproved baseline is reported as a **failure**, never silently
  accepted, skipped, or downgraded to a warning.
- Approving is the one command that writes there (`tools/approve-baseline.js`),
  and it is deliberately two steps. Run it **without** `--confirm` first: the dry
  run prints the run id, the candidate path, its SHA-256, the hash of the
  baseline it would replace, and — when a comparison is possible — writes a diff
  image into `reports/<run-id>/approval/` and prints that path.
- The approval has to name the candidate it approves: `--run <run-id>`,
  `--approve-hash <sha256>` and `--confirm` together. A hash that does not match
  the candidate this invocation read is refused and nothing is written, so a
  command line copied from an earlier run cannot approve a newer capture by
  accident. One invocation approves one page at one viewport; there is no bulk
  mode.
- A human must look at the captured screenshot before approving. The tool can
  tell you the pixels match; it cannot tell you the pixels are right. Tying the
  approval to a hash makes the *wrong* image harder to approve by accident — it
  does not prove anyone looked at the right one.
- **Demonstration baselines are deliberately not shipped.** A baseline is tied
  to the browser build that produced it: the manifest records that version and a
  different build is reported as inconclusive. A bundled demo image would either
  mislead on another build or teach users to approve mismatches. The safest
  demonstration is the honest fresh-checkout state: capture, inspect, approve one
  page, and re-verify it.

### How an approval keeps its two files consistent

An approval replaces two separate files — `baselines/<page>/<viewport>.png` and
`baselines/manifest.json`. No filesystem makes two replacements atomic together,
so the tool does not pretend it does. It serializes the work and makes it
recoverable instead:

1. **A lock**, `baselines/.approval.lock`, created with an exclusive create. It
   is taken *before* the manifest or baseline is read for the final decision, and
   held until the approval has committed or finished rolling back. A second
   approval waits up to 15 seconds (override with `LUNIK_APPROVAL_LOCK_TIMEOUT_MS`)
   and then exits 3 naming the owning PID and host. A lock is reclaimed
   automatically only when it is provably abandoned: same host, and the recorded
   PID no longer exists. A lock from another machine is never reclaimed, because
   its PID cannot be checked here. Nothing deletes a lock that might still be in
   use.
2. **A journal**, `baselines/.approval-journal.json`, written before the first
   replacement. It records the candidate hash, the staged file, the previous
   baseline and archive hashes, the manifest's exact previous text and its own
   stage.
3. **Staged bytes.** The candidate is copied into `baselines/<page>/` and the
   *staged copy* is hashed; those verified bytes are what get renamed over the
   baseline, so a source file that changes mid-approval cannot slip through.
4. **Per-file atomic replacement.** Each file is written to a uniquely named
   temporary file in its own directory, flushed, and renamed over the
   destination — on POSIX `rename(2)`, on Windows `MoveFileEx` with
   replace-existing. Each replacement is atomic; the *pair* is not, which is why
   the journal exists.
5. **Verified rollback.** A failure after the baseline is replaced restores the
   previous image from its archive and the manifest from its recorded text, then
   re-hashes both. If that cannot be done, the error names the exact paths,
   expected and observed hashes, keeps the journal, and says that manual
   recovery is required — it never reports a state it cannot verify.
6. **Startup recovery.** Every approval first resolves an unfinished journal:
   roll back if the two files disagree, keep the approval if both already
   describe it, refuse and explain if the journal is unreadable. Recovery is
   idempotent, so a second attempt cannot damage a recovered approval.

One consequence worth knowing: if an approval fails and the rollback also fails,
`baselines/` holds a baseline whose bytes are newer than its manifest record.
Verification reports that state as **inconclusive**, never a pass. Do not approve
anything else until the reported hash mismatch is resolved.

### Durability boundary

The guarantees above are about *process* failure on a live filesystem, not about
power loss:

- **Atomic per-file replacement.** Writing to a uniquely named temporary file in
  the destination directory, flushing it, and renaming it over the destination
  means a reader sees the old file or the new file, never a partially written
  one — under the documented filesystem assumptions (`rename(2)` on POSIX,
  `MoveFileEx` with replace-existing on Windows).
- **Process termination.** The journal is written before the first replacement
  and kept until the transaction commits, so a process killed between the two
  replacements leaves enough state for the next run to roll back or finish.
- **Power loss or an operating-system crash is not covered.** The containing
  directory is not synced after the rename on this platform, so the rename — and
  possibly the journal write that precedes it — may not have reached stable
  storage when power is lost. Flushing the temporary file guarantees its
  contents, not the persistence of the rename or of the directory entry. An
  approval is therefore not power-loss-proof, and the transaction must not be
  relied on to survive a machine crash at an arbitrary instant.

## Reports

```
reports/<run-id>/
├── report.json                 machine-readable, schemaVersion 1
├── report.md                   human-readable summary
├── screenshots/<page>/<viewport>.png
└── diffs/<page>/<viewport>.png     only when a comparison produced a diff
```

`reports/latest.json` and `reports/latest.md` are copies of the most recent run.
`reports/` is gitignored.

Each result carries: `pageId`, `pageUrl`, `viewport`, `viewportSize`, `check`,
`title`, `severity`, `status` (`pass` | `fail` | `warning` | `inconclusive` |
`skipped`), `message`, `evidence`, `remediation`, `artifacts`, `durationMs`.

## Determinism

Screenshots are stabilised by: fixed locale and timezone, forced colour scheme,
reduced-motion emulation, animations disabled at capture, caret hidden, a
`deviceScaleFactor` of 1, and `Cache-Control: no-store` on served files.

They are **not** portable across machines. Font rasterisation, hinting, and GPU
compositing differ between operating systems and browser builds. Generate and
verify baselines in the same class of environment, and expect to re-approve after
a browser upgrade.
