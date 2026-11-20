/**
 * Regression coverage for the Phase 26 screenshot-timing defect.
 *
 * The fixture's button turns red when focused. The screenshot must remain green,
 * proving it was captured before the interaction. The primary case disables
 * visual comparison, because that is where the old capture fallback ran after
 * interactions. A second case keeps visual comparison enabled and proves the
 * screenshot capture still happens there too.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-screenshot-timing');
const PAGE = {
  id: 'timing',
  path: '/tests/fixtures/screenshot-timing/index.html',
  expect: { selectors: ['#change'] },
  interactions: [
    {
      name: 'focusing the button changes its background',
      steps: [{ focus: '#change' }, { expectFocus: '#change' }],
    },
  ],
};

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function checks(visualEnabled) {
  return {
    console: { enabled: false },
    network: { enabled: false },
    overflow: { enabled: true },
    a11yNames: { enabled: false },
    labels: { enabled: false },
    contrast: { enabled: false },
    links: { enabled: false },
    elements: { enabled: true },
    interactions: { enabled: true },
    visual: { enabled: visualEnabled },
  };
}

async function runWithVisual(visualEnabled) {
  await mkdir(TMP, { recursive: true });
  const reportsDir = `tests/.tmp-screenshot-timing/reports-${visualEnabled ? 'enabled' : 'disabled'}`;
  const baselinesDir = `tests/.tmp-screenshot-timing/baselines-${visualEnabled ? 'enabled' : 'disabled'}`;
  const configPath = path.join(TMP, `config-${visualEnabled ? 'enabled' : 'disabled'}.json`);

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        viewports: [{ name: 'desktop', width: 240, height: 200 }],
        reportsDir,
        baselinesDir,
        checks: checks(visualEnabled),
        pages: [PAGE],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const configArg = path
    .relative(PROJECT, configPath)
    .split(path.sep)
    .join('/');
  const result = spawnSync(
    process.execPath,
    ['tools/visual-verify.js', '--config', configArg, '--quiet'],
    { cwd: PROJECT, encoding: 'utf8', timeout: 60_000 },
  );

  const entries = await readdir(path.join(PROJECT, reportsDir));
  const runId = entries.find((entry) => /^\d{4}-\d{2}-\d{2}T/.test(entry));
  assert.ok(runId, `the report directory must contain a run: ${entries.join(', ')}`);

  const report = JSON.parse(
    await readFile(path.join(PROJECT, reportsDir, 'latest.json'), 'utf8'),
  );
  const screenshot = path.join(
    PROJECT,
    reportsDir,
    runId,
    'screenshots',
    PAGE.id,
    'desktop.png',
  );

  return { result, report, screenshot, configArg };
}

async function pixelAt(file, x, y) {
  const image = PNG.sync.read(await readFile(file));
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

test('initial screenshot is captured before interactions when visual checks are disabled', async () => {
  const { result, report, screenshot, configArg } = await runWithVisual(false);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(report.run.status, 'pass');

  const [red, green, blue] = await pixelAt(screenshot, 110, 110);
  assert.ok(
    green > 100 && red < 60 && blue < 60,
    `expected the initial green button, got rgb(${red}, ${green}, ${blue})`,
  );

  const configPattern = new RegExp(configArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const visual = report.results.find((entry) => entry.check === 'visual');
  assert.equal(visual.status, 'skipped');
  assert.match(visual.message, configPattern);
  assert.match(visual.message, /initial screenshot is still captured/);
  assert.match(visual.artifacts.screenshot, /screenshots\/timing\/desktop\.png$/);

  const labels = report.results.find((entry) => entry.check === 'labels');
  assert.equal(labels.status, 'skipped');
  assert.match(labels.message, configPattern);
  assert.doesNotMatch(labels.message, /lunik\.config\.json/);
});

test('initial screenshot remains pre-interaction when visual checks are enabled', async () => {
  const { result, report, screenshot } = await runWithVisual(true);

  assert.equal(result.status, 1, 'the enabled visual check has no approved baseline');
  const [red, green, blue] = await pixelAt(screenshot, 110, 110);
  assert.ok(
    green > 100 && red < 60 && blue < 60,
    `expected the initial green button, got rgb(${red}, ${green}, ${blue})`,
  );

  const visual = report.results.find((entry) => entry.check === 'visual');
  assert.equal(visual.status, 'fail');
  assert.match(visual.message, /No approved baseline/);
  assert.match(visual.artifacts.screenshot, /screenshots\/timing\/desktop\.png$/);
});
