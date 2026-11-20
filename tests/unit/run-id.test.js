/**
 * L-5 regression — `--run` must be validated before it is joined into a path.
 *
 * The Phase 7 audit reproduced a read-side traversal:
 *   --run "../../../../../../Windows"
 * reached `path.join(reportsRoot, runId, 'screenshots', ...)` and probed the
 * filesystem outside the project. Approval writes were already contained, but
 * the value should never have been resolved at all.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RUN_ID_PATTERN, assertRunId, isRunId, makeRunId } from '../../tools/lib/report.js';
import { ConfigError } from '../../tools/lib/config.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test', 'run-id');
const CONFIG = path.join(TMP, 'config.json');

const HOSTILE = [
  '../../../../../../Windows',
  '..',
  '../escape',
  '..\\escape',
  'C:\\Windows',
  '/etc',
  'sub/dir',
  'sub\\dir',
  '',
  '   ',
  '2026-11-15T15-16-10-725Z/../../escape',
  '2026-11-15T15-16-10-725Z.png',
  'not-a-run-id',
  '2026-11-15',
  '2026-11-15T15:16:10.725Z',
  '2026-11-15T15-16-10-72Z',
  '2026-11-15T15-16-10-725Z\n',
];

function runApprove(extraArgs) {
  return spawnSync(
    process.execPath,
    [
      'tools/approve-baseline.js',
      '--config',
      CONFIG,
      '--page',
      'saas-dashboard',
      '--viewport',
      'desktop',
      ...extraArgs,
    ],
    { cwd: PROJECT, encoding: 'utf8', timeout: 60_000 },
  );
}

before(async () => {
  await mkdir(path.join(TMP, 'reports'), { recursive: true });

  // An isolated copy of the real config: reports and baselines both point inside
  // the test workspace, so an approval attempt can never touch the real tree.
  const real = JSON.parse(await readFile(path.join(PROJECT, 'lunik.config.json'), 'utf8'));
  await writeFile(
    CONFIG,
    `${JSON.stringify(
      {
        ...real,
        reportsDir: 'tests/.tmp-test/run-id/reports',
        baselinesDir: 'tests/.tmp-test/run-id/baselines',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test('makeRunId always produces a value the validator accepts', () => {
  for (const stamp of [
    '2026-11-15T15:16:10.725Z',
    '2026-01-01T00:00:00.000Z',
    '2026-12-31T23:59:59.999Z',
  ]) {
    const runId = makeRunId(stamp);
    assert.match(runId, RUN_ID_PATTERN, `${runId} must match the documented shape`);
    assert.equal(isRunId(runId), true);
    assert.equal(assertRunId(runId), runId);
  }
});

test('only generated run ids are accepted', () => {
  assert.equal(isRunId('2026-11-15T15-16-10-725Z'), true);

  for (const hostile of HOSTILE) {
    assert.equal(isRunId(hostile), false, `${JSON.stringify(hostile)} must be rejected`);
    assert.throws(
      () => assertRunId(hostile),
      (error) => error instanceof ConfigError && /not a verification run id/.test(error.message),
      `${JSON.stringify(hostile)} must throw a configuration error`,
    );
  }

  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(isRunId(value), false);
    assert.throws(() => assertRunId(value), ConfigError);
  }
});

test('a hostile --run is refused before any screenshot path is built', () => {
  for (const hostile of ['../../../../../../Windows', 'C:\\Windows', 'sub/dir', 'not-a-run-id']) {
    const result = runApprove(['--run', hostile]);

    assert.equal(result.status, 2, `expected a usage error for ${hostile}\n${result.stderr}`);
    assert.match(
      result.stderr,
      /not a verification run id/,
      'the value must be rejected as a run id, not resolved by the filesystem',
    );
    // The old behaviour reported "Screenshot not found: ../../Windows/...",
    // which proves the join happened. It must not be reachable any more.
    assert.doesNotMatch(
      result.stderr,
      /Screenshot not found/,
      'no path may be constructed from an invalid run id',
    );
    assert.doesNotMatch(result.stderr, /Unexpected error/, 'this is a usage error, not a crash');
  }
});

test('--run without a value is a usage error instead of silently using the newest run', () => {
  const result = runApprove(['--run']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs a run id/);
});

test('a well-formed run id passes validation and then fails only on the missing screenshot', () => {
  const result = runApprove(['--run', '2026-01-01T00-00-00-000Z']);

  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /not a verification run id/);
  assert.match(
    result.stderr,
    /Screenshot not found: tests\/\.tmp-test\/run-id\/reports\/2026-01-01T00-00-00-000Z\/screenshots\/saas-dashboard\/desktop\.png/,
    'a legitimate id must still be used to look for the screenshot',
  );
});

test('no baseline or manifest was written by any of these attempts', async () => {
  await assert.rejects(
    () => readFile(path.join(TMP, 'baselines', 'manifest.json'), 'utf8'),
    /ENOENT/,
    'approval attempts must not record anything',
  );
  await assert.rejects(
    () => readFile(path.join(PROJECT, 'baselines', 'manifest.json'), 'utf8'),
    /ENOENT/,
    'the real baseline manifest must not exist',
  );
});
