# Contributing

## Ground rules

1. **No new dependency without a written reason.** The runtime set is `playwright`,
   `pngjs`, and `pixelmatch`. Anything else needs to justify itself in the pull
   request and be recorded in `THIRD-PARTY-NOTICES.md`.
2. **Never weaken a check to make a run green.** No lowered severities, no
   loosened thresholds, no deleted assertions, no invented baselines.
3. **A new check ships with a failing fixture.** If it cannot be made to fail on
   purpose, it is not proven to do anything.
4. **Report only observed results.** If you could not run something, say so.

## Setup

```bash
npm install
npx playwright install chromium
npm run test:all
```

## Adding a check

1. Create `tools/lib/checks/<name>.js`:

```js
export const id = 'myCheck';
export const title = 'What it looks at';

export async function run(ctx) {
  // ctx: { page, pageDef, pageId, viewport, pageUrl, collectors,
  //        checkConfig, config, artifacts, baselinePath, manifest,
  //        baselinesRoot, browserVersion }
  return {
    ok: false,
    message: 'What was observed, concretely.',
    evidence: { /* structured detail that ends up in the report */ },
    remediation: 'What to change.',
  };
}
```

Return shapes:

| Return | Result |
| --- | --- |
| `{ ok: true, message }` | pass |
| `{ ok: false, message, evidence, remediation }` | fail or warning, depending on severity |
| `{ skip: 'reason' }` | skipped (check did not apply) |
| `{ inconclusive: 'reason' }` | inconclusive — never a pass |

2. Register it in the `CHECKS` array in `tools/lib/runner.js`, in the right
   place: checks run in report order, `interactions` last. The initial screenshot
   is already captured before the check loop starts.
3. Add its default to `defaultConfig()` in `tools/lib/config.js`.
4. Add it to the check table in `docs/verification.md` **with its limitations**.
5. Extend `tests/fixtures/fail/index.html` so the check has something to catch,
   and assert it in `tests/browser/verify.test.js`.

## Style

- Plain ESM, no build step, no transpiler-specific syntax.
- Named exports; no default exports except the skill manifest.
- Comments explain *why*, not *what*. Keep them short.
- Every user-facing message should state the observation, not the verdict alone:
  "Page is 240px wider than the 1440px viewport (3 elements …)" beats "overflow".
- Paths in reports are posix and relative to the project root.
- No machine-specific paths, usernames, or tokens in committed files.

## Tests

```bash
node --test "tests/unit/**/*.test.js"      # fast, no browser
node --test "tests/browser/**/*.test.js"   # real browser, about a minute
```

Browser tests spawn the actual CLIs, so they cover exit codes and report output
that unit tests cannot. If you add a browser test file, clean up only your own
artefacts under `tests/.tmp-test/` — files run in parallel.

## Documentation

- If you change behaviour, change the doc in the same commit.
- `README.md` states only verified facts. Do not add a feature list entry for
  something that is not implemented.
- Keep the "known limitations" sections honest; they are the most useful part of
  the docs.

## Git

This project is developed locally first. Do not create remotes, push, publish, or
tag a release without the maintainer's explicit approval. Commits should be
small, with a message that explains why the change was made.
