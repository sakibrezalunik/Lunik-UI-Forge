/**
 * M-4 regression — console and network failures raised by a configured
 * interaction must appear in the final report.
 *
 * The fixture loads cleanly, so a verifier that evaluates those checks at load
 * time reports a false pass. Both checks are expected to fail here, exactly once.
 *
 * Determinism: the failing flow is the *last* one. A flow that reloads the page
 * (every flow after the first does) can cancel or delay a request started by the
 * previous flow, so putting the 404 before a reload made this test pass or fail
 * depending on machine load. With the 404 last, nothing can navigate away before
 * the runner observes it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test', 'interaction-errors');
const REPORTS = 'tests/.tmp-test/interaction-errors/reports';

const CONFIG_WITH_INTERACTIONS = path.join(TMP, 'with-interactions.json');
const CONFIG_WITHOUT_INTERACTIONS = path.join(TMP, 'without-interactions.json');
const CONFIG_TWO_PAGES = path.join(TMP, 'two-pages.json');
const CONFIG_DELAYED = path.join(TMP, 'delayed.json');

const PAGE = {
  id: 'fixture-interaction-errors',
  path: '/tests/fixtures/fail-interaction/index.html',
  expect: { selectors: ['h1', '[data-action="explode"]', '[data-action="toggle"]'] },
};

/** Same document, no interactions: it must stay clean even in the same run. */
const CLEAN_PAGE = {
  id: 'fixture-interaction-errors-clean',
  path: '/tests/fixtures/fail-interaction/index.html',
  expect: { selectors: ['h1', '[data-action="explode"]', '[data-action="toggle"]'] },
};

const INTERACTIONS = [
  {
    name: 'a healthy interaction still works',
    steps: [
      { click: '[data-action="toggle"]' },
      { expectVisible: '#detail' },
      { expectText: '[data-action="toggle"]', contains: 'Hide' },
    ],
  },
  {
    // Last on purpose: see the header comment. This click logs a console error
    // and requests a file that does not exist.
    name: 'clicking the failure button logs an error and requests a missing file',
    steps: [{ click: '[data-action="explode"]' }],
  },
];

function baseConfig(pages) {
  return {
    viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    reportsDir: REPORTS,
    checks: { visual: { enabled: false } },
    pages,
  };
}

function runCli(configPath) {
  return spawnSync(
    process.execPath,
    ['tools/visual-verify.js', '--config', configPath, '--quiet'],
    { cwd: PROJECT, encoding: 'utf8', timeout: 180_000 },
  );
}

async function latestReport() {
  return JSON.parse(await readFile(path.join(PROJECT, REPORTS, 'latest.json'), 'utf8'));
}

function resultsFor(report, pageId, check) {
  return report.results.filter((entry) => entry.pageId === pageId && entry.check === check);
}

before(async () => {
  await mkdir(TMP, { recursive: true });
  await writeFile(
    CONFIG_WITH_INTERACTIONS,
    `${JSON.stringify(baseConfig([{ ...PAGE, interactions: INTERACTIONS }]), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    CONFIG_WITHOUT_INTERACTIONS,
    `${JSON.stringify(baseConfig([PAGE]), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    CONFIG_TWO_PAGES,
    `${JSON.stringify(baseConfig([{ ...PAGE, interactions: INTERACTIONS }, CLEAN_PAGE]), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    CONFIG_DELAYED,
    `${JSON.stringify(
      baseConfig([
        {
          ...PAGE,
          interactions: [
            {
              name: 'a step whose request is dispatched after the step returns',
              steps: [{ click: '[data-action="explode-later"]' }],
            },
          ],
        },
      ]),
      null,
      2,
    )}\n`,
    'utf8',
  );
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test('the fixture page loads without console or network errors', async () => {
  // Control scenario: the failures below really are caused by the interaction,
  // not by loading the page.
  const result = runCli(CONFIG_WITHOUT_INTERACTIONS);
  assert.equal(result.status, 0, `expected a clean load, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();
  for (const check of ['console', 'network']) {
    const [entry] = resultsFor(report, PAGE.id, check);
    assert.equal(entry.status, 'pass', `${check} must pass on a clean load`);
  }
});

test('errors raised by an interaction are reported, once each, and fail the run', async () => {
  const result = runCli(CONFIG_WITH_INTERACTIONS);
  assert.equal(result.status, 1, `interaction failures must fail the run\n${result.stdout}`);

  const report = await latestReport();

  const consoleResults = resultsFor(report, PAGE.id, 'console');
  const networkResults = resultsFor(report, PAGE.id, 'network');
  assert.equal(consoleResults.length, 1, 'console must be reported exactly once');
  assert.equal(networkResults.length, 1, 'network must be reported exactly once');

  const [consoleResult] = consoleResults;
  assert.equal(consoleResult.status, 'fail', 'a console.error raised by a step is a failure');
  assert.equal(consoleResult.severity, 'error');
  const consoleHits = consoleResult.evidence.items.filter((item) =>
    item.text.includes('deliberate console error from an interaction'),
  );
  assert.equal(
    consoleHits.length,
    1,
    `expected one entry for the interaction error, got ${JSON.stringify(consoleResult.evidence.items)}`,
  );

  const [networkResult] = networkResults;
  assert.equal(networkResult.status, 'fail', 'a 404 requested by a step is a failure');
  assert.equal(networkResult.severity, 'error');
  const networkHits = networkResult.evidence.items.filter(
    (item) => item.url.includes('does-not-exist.json') && item.detail === 'HTTP 404',
  );
  assert.equal(
    networkHits.length,
    1,
    `expected one entry for the missing file, got ${JSON.stringify(networkResult.evidence.items)}`,
  );
  assert.equal(
    networkResult.evidence.count,
    networkResult.evidence.items.length,
    'a settled observation window must not contain duplicate findings',
  );

  // The healthy flow in the same page still passes.
  const [interactions] = resultsFor(report, PAGE.id, 'interactions');
  assert.equal(interactions.status, 'pass', JSON.stringify(interactions.evidence));
  assert.equal(interactions.evidence.interactions.length, 2);
  assert.ok(interactions.evidence.interactions.every((flow) => flow.ok));
});

test('a clean page in the same run is not contaminated by another page', async () => {
  const result = runCli(CONFIG_TWO_PAGES);
  assert.equal(result.status, 1, 'the failing page still fails the run');

  const report = await latestReport();

  const dirtyConsole = resultsFor(report, PAGE.id, 'console');
  const dirtyNetwork = resultsFor(report, PAGE.id, 'network');
  assert.equal(dirtyConsole[0].status, 'fail');
  assert.equal(dirtyNetwork[0].status, 'fail');

  for (const check of ['console', 'network']) {
    const [clean] = resultsFor(report, CLEAN_PAGE.id, check);
    assert.ok(clean, `the clean page must report ${check}`);
    assert.equal(
      clean.status,
      'pass',
      `${check} on a clean page must not inherit another page's findings: ${JSON.stringify(clean.evidence)}`,
    );
  }
});

test('a request dispatched after the last step is still observed', async () => {
  // The click step returns before the request exists (the fixture queues it on a
  // 60 ms timer). Without the bounded settle window the network check is
  // evaluated first and reports a false pass; this assertion is what fails if
  // that window is removed.
  const result = runCli(CONFIG_DELAYED);
  assert.equal(result.status, 1, `a delayed 404 must fail the run\n${result.stdout}`);

  const report = await latestReport();
  const [networkResult] = resultsFor(report, PAGE.id, 'network');
  assert.equal(
    networkResult.status,
    'fail',
    `the delayed 404 was missed: ${JSON.stringify(networkResult.evidence ?? networkResult.message)}`,
  );

  const hits = networkResult.evidence.items.filter(
    (item) => item.url.includes('does-not-exist-later.json') && item.detail === 'HTTP 404',
  );
  assert.equal(
    hits.length,
    1,
    `expected exactly one entry for the delayed request, got ${JSON.stringify(networkResult.evidence.items)}`,
  );

  // The interaction that triggered it is itself healthy: only the network failed.
  const [interactions] = resultsFor(report, PAGE.id, 'interactions');
  assert.equal(interactions.status, 'pass', JSON.stringify(interactions.evidence));
});

test('report order is unchanged even though console and network finalise late', async () => {
  runCli(CONFIG_WITH_INTERACTIONS);
  const report = await latestReport();
  const order = report.results.map((entry) => entry.check);

  assert.deepEqual(order, [
    'console',
    'network',
    'overflow',
    'a11yNames',
    'labels',
    'contrast',
    'links',
    'elements',
    'visual',
    'interactions',
  ]);
  assert.ok(
    report.results.every((entry) => entry !== null && typeof entry.status === 'string'),
    'every reserved slot must be filled',
  );
});
