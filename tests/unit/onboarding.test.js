/**
 * First-run and onboarding guards.
 *
 * `--plan` is the only safe way to inspect a project before spending time in a
 * browser: it must report the effective configuration and output locations,
 * never launch a browser, and never write a report or a baseline. The hint after
 * a fresh-checkout failure must appear only when every failure is a missing
 * baseline, so it can never excuse a real regression.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-onboarding');
const CONFIG = 'tests/.tmp-onboarding/config.json';

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, args, { cwd: PROJECT, encoding: 'utf8', timeout: 60_000 });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(dir, { reportsDir, baselinesDir, pages }) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'config.json'),
    `${JSON.stringify(
      {
        viewports: [{ name: 'desktop', width: 1440, height: 900 }],
        reportsDir,
        baselinesDir,
        pages,
      },
      null,
      2,
    )}\n`,
  );
}

test('--plan reports the effective config and writes nothing', async () => {
  await rm(TMP, { recursive: true, force: true });
  await writeConfig(TMP, {
    reportsDir: 'tests/.tmp-onboarding/reports',
    baselinesDir: 'tests/.tmp-onboarding/baselines',
    pages: [{ id: 'demo', path: '/tests/fixtures/pass/index.html' }],
  });

  const result = run(['tools/visual-verify.js', '--config', CONFIG, '--plan']);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /first-run plan/);
  assert.match(result.stdout, /Nothing is verified and no files are written/);
  assert.match(result.stdout, /Configuration: tests\/\.tmp-onboarding\/config\.json/);
  assert.match(result.stdout, /Reports\s+: tests\/\.tmp-onboarding\/reports\//);
  assert.match(result.stdout, /Screenshots : tests\/\.tmp-onboarding\/reports\/<run-id>/);
  assert.match(result.stdout, /Baselines\s+: tests\/\.tmp-onboarding\/baselines\//);
  assert.match(result.stdout, /node tools\/visual-verify\.js --config tests\/\.tmp-onboarding\/config\.json/);
  assert.match(
    result.stdout,
    /node tools\/approve-baseline\.js --config tests\/\.tmp-onboarding\/config\.json --page demo --viewport desktop/,
  );
  assert.doesNotMatch(result.stdout, /Browser: chromium/, 'plan must not launch a browser');

  assert.equal(await exists(path.join(TMP, 'reports')), false, 'plan must not create reports');
  assert.equal(await exists(path.join(TMP, 'baselines')), false, 'plan must not create baselines');
});

test('--plan suppresses baseline guidance when visual checks are disabled in a default config', async () => {
  await rm(TMP, { recursive: true, force: true });
  const root = path.join(TMP, 'disabled-default');
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'lunik.config.json'),
    `${JSON.stringify(
      {
        viewports: [{ name: 'desktop', width: 1440, height: 900 }],
        reportsDir: 'tests/.tmp-onboarding/disabled-default/reports',
        baselinesDir: 'tests/.tmp-onboarding/disabled-default/baselines',
        checks: { visual: { enabled: false } },
        pages: [{ id: 'demo', path: '/tests/fixtures/pass/index.html' }],
      },
      null,
      2,
    )}\n`,
  );

  const relativeRoot = path.relative(PROJECT, root).split(path.sep).join('/');
  const result = run(['tools/visual-verify.js', '--root', relativeRoot, '--plan']);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /Configuration: tests\/\.tmp-onboarding\/disabled-default\/lunik\.config\.json/,
  );
  assert.doesNotMatch(result.stdout, /0 of 1 baseline image/);
  assert.doesNotMatch(result.stdout, /approve-baseline/);
  assert.doesNotMatch(result.stdout, /Visual checks without a baseline fail/);
  assert.match(result.stdout, /not used; visual comparison is disabled/);
  assert.match(result.stdout, /still captured for manual review/);
  assert.match(result.stdout, /Screenshots for review:/);
  assert.equal(await exists(path.join(root, 'reports')), false);
  assert.equal(await exists(path.join(root, 'baselines')), false);
});

test('--plan suppresses baseline guidance with a custom pilot.config.json', async () => {
  await rm(TMP, { recursive: true, force: true });
  const config = path.join(TMP, 'disabled-pilot', 'pilot.config.json');
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(
    config,
    `${JSON.stringify(
      {
        viewports: [{ name: 'desktop', width: 1440, height: 900 }],
        reportsDir: 'tests/.tmp-onboarding/disabled-pilot/reports',
        baselinesDir: 'tests/.tmp-onboarding/disabled-pilot/baselines',
        checks: { visual: { enabled: false } },
        pages: [{ id: 'demo', path: '/tests/fixtures/pass/index.html' }],
      },
      null,
      2,
    )}\n`,
  );

  const relativeConfig = path.relative(PROJECT, config).split(path.sep).join('/');
  const result = run(['tools/visual-verify.js', '--config', relativeConfig, '--plan']);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /Configuration: tests\/\.tmp-onboarding\/disabled-pilot\/pilot\.config\.json/,
  );
  assert.doesNotMatch(result.stdout, /0 of 1 baseline image/);
  assert.doesNotMatch(result.stdout, /approve-baseline/);
  assert.match(result.stdout, /not used; visual comparison is disabled/);
  assert.match(result.stdout, /still captured for manual review/);
  assert.equal(await exists(path.join(TMP, 'disabled-pilot', 'reports')), false);
  assert.equal(await exists(path.join(TMP, 'disabled-pilot', 'baselines')), false);
});

test('--plan honours --page and --viewport selections', () => {
  const result = run([
    'tools/visual-verify.js',
    '--plan',
    '--page',
    'saas-dashboard',
    '--viewport',
    'mobile',
  ]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Pages \(1\):/);
  assert.match(result.stdout, /Viewports \(1\):/);
  assert.match(result.stdout, /\(1 total\)/);
  assert.doesNotMatch(result.stdout, /cybersecurity-dashboard/);
});

test('--plan respects a custom --root and prints flags that reproduce it', async () => {
  await rm(TMP, { recursive: true, force: true });
  const root = path.join(TMP, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><h1>Demo</h1>\n');
  await writeConfig(root, {
    reportsDir: 'out/reports',
    baselinesDir: 'out/baselines',
    pages: [{ id: 'demo', path: '/index.html' }],
  });

  const relativeRoot = path.relative(PROJECT, root).split(path.sep).join('/');
  const result = run([
    'tools/visual-verify.js',
    '--root',
    relativeRoot,
    '--config',
    'config.json',
    '--plan',
  ]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`Project root : .*${'project'}`));
  assert.match(result.stdout, new RegExp(`--root ${relativeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, new RegExp(`--config ${relativeRoot}/config\\.json`));
  assert.match(result.stdout, /Reports\s+: out\/reports\//);

  assert.equal(await exists(path.join(root, 'out')), false, 'plan must not create output dirs');
});

test('--plan still fails cleanly when the configuration is missing', () => {
  const result = run([
    'tools/visual-verify.js',
    '--config',
    'tests/.tmp-onboarding/missing.json',
    '--plan',
  ]);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /No configuration found/);
  assert.doesNotMatch(result.stderr, /Unexpected error/);
});

test('a fresh checkout explains missing baselines but never creates one', async () => {
  await rm(TMP, { recursive: true, force: true });
  await writeConfig(TMP, {
    reportsDir: 'tests/.tmp-onboarding/reports',
    baselinesDir: 'tests/.tmp-onboarding/baselines',
    pages: [{ id: 'demo', path: '/tests/fixtures/pass/index.html' }],
  });

  const result = run(['tools/visual-verify.js', '--config', CONFIG]);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /First run: 1 visual check has no approved baseline/);
  assert.match(result.stdout, /expected on a fresh checkout/);
  assert.match(result.stdout, /--plan/);

  assert.equal(await exists(path.join(TMP, 'baselines')), false, 'verify must never create a baseline');
});
