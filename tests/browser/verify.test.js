/**
 * Integration tests for `tools/visual-verify.js`.
 *
 * These spawn the real CLI against the real fixtures in a real browser. They
 * assert the things a unit test cannot: that a healthy page passes, that a
 * deliberately broken page fails with the expected checks, and that the exit
 * code distinguishes a failure from a verification that could not run.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test');
const REPORTS = 'tests/.tmp-test/reports-verify';

const CONFIG_BOTH = 'tests/.tmp-test/config-both.json';
const CONFIG_PASS = 'tests/.tmp-test/config-pass.json';
const CONFIG_MISSING_ROUTE = 'tests/.tmp-test/config-missing-route.json';

function runCli(args) {
  return spawnSync(process.execPath, ['tools/visual-verify.js', ...args], {
    cwd: PROJECT,
    encoding: 'utf8',
    timeout: 180_000,
  });
}

async function readLatestReport() {
  return JSON.parse(await readFile(path.join(PROJECT, REPORTS, 'latest.json'), 'utf8'));
}

const PASS_PAGE = {
  id: 'fixture-pass',
  path: '/tests/fixtures/pass/index.html',
  expect: { selectors: ['h1', 'table', '#query', '[data-action="toggle"]'] },
  interactions: [
    {
      name: 'toggle reveals the detail region',
      steps: [
        { click: '[data-action="toggle"]' },
        { expectVisible: '[data-region="detail"]' },
        { expectText: '[data-action="toggle"]', contains: 'Hide' },
      ],
    },
  ],
};

const FAIL_PAGE = {
  id: 'fixture-fail',
  path: '/tests/fixtures/fail/index.html',
  expect: { selectors: ['h1', '[data-metric-card]'] },
  interactions: [
    {
      name: 'opening the panel reveals #panel',
      steps: [{ click: '[data-action="open"]' }, { expectVisible: '#panel' }],
    },
  ],
};

async function writeConfig(file, pages, extra = {}) {
  const config = {
    viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    reportsDir: REPORTS,
    checks: { visual: { enabled: false } },
    pages,
    ...extra,
  };
  await mkdir(TMP, { recursive: true });
  await (await import('node:fs/promises')).writeFile(
    path.join(PROJECT, file),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
}

before(async () => {
  await writeConfig(CONFIG_BOTH, [PASS_PAGE, FAIL_PAGE]);
  await writeConfig(CONFIG_PASS, [PASS_PAGE]);
  await writeConfig(CONFIG_MISSING_ROUTE, [
    { id: 'missing-page', path: '/tests/fixtures/does-not-exist.html' },
  ]);
});

after(async () => {
  // Remove only this file's artefacts: test files run in parallel and share the
  // scratch directory.
  for (const target of [CONFIG_BOTH, CONFIG_PASS, CONFIG_MISSING_ROUTE]) {
    await rm(path.join(PROJECT, target), { force: true });
  }
  await rm(path.join(PROJECT, REPORTS), { recursive: true, force: true });
});

test('a healthy fixture page passes every enabled check', async () => {
  const result = runCli(['--config', CONFIG_PASS, '--quiet']);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);

  const report = await readLatestReport();
  assert.equal(report.run.status, 'pass');
  const failures = report.results.filter((entry) => entry.status !== 'pass' && entry.status !== 'skipped');
  assert.deepEqual(failures, [], 'no check should fail on the healthy fixture');
});

test('the deliberately broken fixture fails the exact checks it was built to fail', async () => {
  const result = runCli(['--config', CONFIG_BOTH, '--quiet']);
  assert.equal(result.status, 1, 'a failing check must produce exit code 1');
  assert.doesNotMatch(
    result.stdout,
    /\[FAIL\]/,
    '--quiet means the final summary only; per-check details belong to the report',
  );

  const report = await readLatestReport();
  const failing = new Set(
    report.results.filter((entry) => entry.pageId === 'fixture-fail' && entry.status === 'fail')
      .map((entry) => entry.check),
  );

  for (const check of [
    'console',
    'network',
    'overflow',
    'a11yNames',
    'labels',
    'links',
    'elements',
    'interactions',
  ]) {
    assert.ok(failing.has(check), `expected the "${check}" check to fail on the broken fixture`);
  }
});

test('low contrast is reported as a warning, not folded into failures', async () => {
  const result = runCli(['--config', CONFIG_BOTH, '--quiet']);
  assert.equal(result.status, 1);

  const report = await readLatestReport();
  const contrast = report.results.find(
    (entry) => entry.pageId === 'fixture-fail' && entry.check === 'contrast',
  );

  assert.equal(contrast.status, 'warning');
  assert.equal(contrast.severity, 'warning');
  assert.ok(contrast.evidence.violations.length > 0, 'the warning should carry evidence');

  const contrastStatuses = report.results
    .filter((entry) => entry.check === 'contrast')
    .map((entry) => entry.status);
  assert.ok(
    !contrastStatuses.includes('fail'),
    `contrast must never be reported as a hard failure while severity is "warning" (saw ${contrastStatuses.join(', ')})`,
  );
});

test('overflow evidence names the element that causes it', async () => {
  const result = runCli(['--config', CONFIG_BOTH, '--quiet']);
  assert.equal(result.status, 1);

  const report = await readLatestReport();
  const overflow = report.results.find(
    (entry) => entry.pageId === 'fixture-fail' && entry.check === 'overflow',
  );

  assert.ok(overflow.evidence.overflowPx > 0);
  assert.ok(overflow.evidence.culprits.length > 0);
  assert.match(overflow.evidence.culprits[0].selector, /wide/);
});

test('a page that cannot be loaded is inconclusive, never a pass', async () => {
  const result = runCli(['--config', CONFIG_MISSING_ROUTE, '--quiet']);

  assert.equal(result.status, 3, 'an unloadable page must exit 3, not 0');

  const report = await readLatestReport();
  assert.equal(report.run.status, 'inconclusive');
  const navigation = report.results[0];
  assert.equal(navigation.check, 'navigation');
  assert.equal(navigation.status, 'inconclusive');
  assert.match(navigation.message, /404/);
});

test('an unknown page id is a usage error, not a test failure', () => {
  const result = runCli(['--config', CONFIG_PASS, '--page', 'not-a-page']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown page id/);
});

test('an unknown viewport is a usage error', () => {
  const result = runCli(['--config', CONFIG_PASS, '--viewport', 'watch']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown viewport/);
});

test('the report records the browser and tool versions actually used', async () => {
  runCli(['--config', CONFIG_PASS, '--quiet']);
  const report = await readLatestReport();

  assert.equal(report.tool.name, 'lunik-ui-forge');
  assert.match(report.environment.node, /^v\d+/);
  assert.ok(report.environment.browser.version.length > 0);
  assert.equal(report.environment.timezone, 'UTC');
  assert.ok(report.run.durationMs >= 0);
});
