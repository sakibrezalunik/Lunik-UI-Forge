/**
 * CLI usability guards.
 *
 * These are the failures a first-time user actually hits: a mistyped option that
 * used to be ignored, and a printed approval command that could not be pasted
 * when the project used a non-default `--config`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-cli-usage');
const RUN = '2026-11-18T12-00-00-000Z';

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, args, { cwd: PROJECT, encoding: 'utf8', timeout: 30_000 });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function png(width, height) {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 40;
    image.data[i + 1] = 80;
    image.data[i + 2] = 120;
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

test('visual-verify rejects an unknown option instead of ignoring it', () => {
  const result = run(['tools/visual-verify.js', '--stirct']);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /Unknown option\(s\): --stirct/);
  assert.match(result.stderr, /Nothing was verified and no report was written/);
});

test('visual-verify rejects a stray positional argument', () => {
  const result = run(['tools/visual-verify.js', 'saas-dashboard']);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /Unexpected argument\(s\): saas-dashboard/);
});

test('approve-baseline rejects an unknown option before reading a config', () => {
  const result = run([
    'tools/approve-baseline.js',
    '--page',
    'x',
    '--viewport',
    'desktop',
    '--bogus',
  ]);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /Unknown option\(s\): --bogus/);
  assert.match(result.stderr, /Nothing was read and nothing was written/);
});

test('a value option without a value is refused, not treated as "all"', () => {
  const result = run(['tools/visual-verify.js', '--page', '--quiet']);

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /Option\(s\) missing a value: --page/);
});

test('serve --help prints usage instead of starting a server', () => {
  const result = run(['tools/serve.js', '--help']);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Usage: node tools\/serve\.js/);
});

test('--help still works and wins over an unknown option', () => {
  const result = run(['tools/visual-verify.js', '--help', '--bogus']);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Usage: node tools\/visual-verify\.js/);
});

test('the printed approval command is copy-pasteable with a custom --config', async () => {
  await rm(TMP, { recursive: true, force: true });
  const screenshots = path.join(TMP, 'reports', RUN, 'screenshots', 'demo');
  await mkdir(screenshots, { recursive: true });
  await writeFile(path.join(screenshots, 'desktop.png'), png(40, 40));
  await writeFile(
    path.join(TMP, 'config.json'),
    `${JSON.stringify(
      {
        viewports: [{ name: 'desktop', width: 40, height: 40 }],
        reportsDir: 'tests/.tmp-cli-usage/reports',
        baselinesDir: 'tests/.tmp-cli-usage/baselines',
        pages: [{ id: 'demo', path: '/tests/fixtures/pass/index.html' }],
      },
      null,
      2,
    )}\n`,
  );

  const dry = run([
    'tools/approve-baseline.js',
    '--config',
    'tests/.tmp-cli-usage/config.json',
    '--page',
    'demo',
    '--viewport',
    'desktop',
  ]);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);

  const printed = /^ {2}(node tools\/approve-baseline\.js.*)$/m.exec(dry.stdout)?.[1];
  assert.ok(printed, `the dry run must print the approval command:\n${dry.stdout}`);
  assert.match(printed, /--config tests\/\.tmp-cli-usage\/config\.json/);

  // Run exactly what was printed. The fixture paths contain no spaces, so a
  // whitespace split reproduces the shell command without a shell.
  const confirmed = run(printed.split(/\s+/).slice(1));
  assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
  assert.equal(
    await exists(path.join(TMP, 'baselines', 'demo', 'desktop.png')),
    true,
    'the pasted command must approve the isolated fixture baseline',
  );
});
