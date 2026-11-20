/**
 * The safety model for visual baselines, proved end to end:
 *
 *  1. verification writes screenshots but NEVER a baseline
 *  2. a missing baseline is a failure, not a silent pass
 *  3. approval without --confirm changes nothing
 *  4. with --confirm, the baseline and manifest are written
 *  5. a re-run then passes
 *  6. a baseline edited outside the tool is detected and reported as inconclusive
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { sha256File } from '../../tools/lib/fs-utils.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test');
const CONFIG = 'tests/.tmp-test/config-visual.json';
const REPORTS = 'tests/.tmp-test/reports-visual';
const BASELINES = 'tests/.tmp-test/baselines-visual';

const PAGE_ID = 'fixture-pass';
const VIEWPORT = 'desktop';

const baselinePng = path.join(PROJECT, BASELINES, PAGE_ID, `${VIEWPORT}.png`);
const manifestFile = path.join(PROJECT, BASELINES, 'manifest.json');

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(visualEnabled) {
  const config = {
    viewports: [{ name: VIEWPORT, width: 1440, height: 900 }],
    reportsDir: REPORTS,
    baselinesDir: BASELINES,
    checks: {
      visual: { enabled: visualEnabled, severity: 'error', maxDiffRatio: 0.001 },
    },
    pages: [
      {
        id: PAGE_ID,
        path: '/tests/fixtures/pass/index.html',
        expect: { selectors: ['h1', 'table'] },
      },
    ],
  };
  await mkdir(TMP, { recursive: true });
  await writeFile(path.join(PROJECT, CONFIG), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function verify() {
  return spawnSync(process.execPath, ['tools/visual-verify.js', '--config', CONFIG, '--quiet'], {
    cwd: PROJECT,
    encoding: 'utf8',
    timeout: 180_000,
  });
}

function approve(extraArgs) {
  return spawnSync(
    process.execPath,
    [
      'tools/approve-baseline.js',
      '--config',
      CONFIG,
      '--page',
      PAGE_ID,
      '--viewport',
      VIEWPORT,
      ...extraArgs,
    ],
    { cwd: PROJECT, encoding: 'utf8', timeout: 180_000 },
  );
}

/** The run id and candidate hash a dry run printed. */
function parseDryRun(stdout) {
  return {
    run: /^Run:\s+(\S+)$/m.exec(stdout)?.[1] ?? null,
    hash: /^SHA-256:\s+([0-9a-f]{64})$/m.exec(stdout)?.[1] ?? null,
  };
}

/**
 * Run the dry run and return the values an approval has to repeat back.
 *
 * This is the intended workflow, so the tests follow it rather than reaching
 * into the filesystem for a hash: a human reads these two lines off the dry run
 * and hands them back with `--confirm`.
 */
function dryRun() {
  const result = approve([]);
  assert.equal(result.status, 0, `the dry run must succeed\n${result.stdout}\n${result.stderr}`);
  const parsed = parseDryRun(result.stdout);
  assert.ok(
    parsed.run && parsed.hash,
    `the dry run must print the run and the candidate hash:\n${result.stdout}`,
  );
  return { ...parsed, result };
}

/**
 * Copy a run's screenshot into a new run directory with one pixel changed.
 *
 * This manufactures a second candidate whose bytes differ while its dimensions
 * still satisfy the viewport contract, which is what a re-capture after a real
 * UI change looks like.
 */
async function cloneRunWithChangedPixel(sourceRunId, targetRunId) {
  const source = path.join(
    PROJECT,
    REPORTS,
    sourceRunId,
    'screenshots',
    PAGE_ID,
    `${VIEWPORT}.png`,
  );
  const png = PNG.sync.read(await readFile(source));
  png.data[0] = (png.data[0] + 128) % 256;

  const target = path.join(PROJECT, REPORTS, targetRunId, 'screenshots', PAGE_ID);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, `${VIEWPORT}.png`), PNG.sync.write(png));
  return targetRunId;
}

after(async () => {
  // Remove only this file's artefacts: test files run in parallel and share the
  // scratch directory.
  await rm(path.join(PROJECT, CONFIG), { force: true });
  await rm(path.join(PROJECT, REPORTS), { recursive: true, force: true });
  await rm(path.join(PROJECT, BASELINES), { recursive: true, force: true });
});

test('verification captures screenshots but never writes a baseline', async () => {
  await writeConfig(false);
  const result = verify();

  assert.equal(result.status, 0, `expected a clean run, got ${result.status}\n${result.stderr}`);
  assert.equal(await exists(baselinePng), false, 'verification must not create baselines');

  const screenshot = path.join(PROJECT, REPORTS, 'latest.json');
  assert.equal(await exists(screenshot), true);
});

test('a missing baseline fails the visual check with instructions', async () => {
  await writeConfig(true);
  const result = verify();

  assert.equal(result.status, 1, 'a missing baseline must fail the run');

  const report = JSON.parse(await readFile(path.join(PROJECT, REPORTS, 'latest.json'), 'utf8'));
  const visual = report.results.find((entry) => entry.check === 'visual');

  assert.equal(visual.status, 'fail');
  assert.match(visual.message, /No approved baseline/);
  assert.match(visual.remediation, /approve-baseline\.js/);
  assert.equal(
    visual.evidence.expectedBaseline,
    `${BASELINES}/${PAGE_ID}/${VIEWPORT}.png`,
    'report evidence paths are posix and relative to the project root',
  );
  assert.equal(await exists(baselinePng), false, 'a failed visual check must not create the file it wants');
});

test('approval without --confirm is a dry run that writes nothing', async () => {
  const result = approve([]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/);
  assert.equal(await exists(baselinePng), false, 'a dry run must not write a baseline');
  assert.equal(await exists(manifestFile), false, 'a dry run must not write the manifest');
});

test('approval with --confirm writes the baseline and records its hash', async () => {
  const { run, hash } = dryRun();
  const result = approve([
    '--run',
    run,
    '--approve-hash',
    hash,
    '--confirm',
    '--note',
    'first approved baseline for the fixture',
    '--by',
    'fixture reviewer',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await exists(baselinePng), true);

  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const entry = manifest.entries[`${PAGE_ID}/${VIEWPORT}`];

  assert.ok(entry, 'the manifest must record the approval');
  assert.equal(manifest.version, 2, 'the manifest is written at the current schema version');
  assert.equal(entry.width, 1440);
  assert.equal(entry.height, 900);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.sha256, hash, 'the approved bytes are the ones the dry run printed');
  assert.equal(entry.note, 'first approved baseline for the fixture');
  assert.equal(entry.approvedBy, 'fixture reviewer');
  assert.match(entry.approvedAt, /^\d{4}-\d{2}-\d{2}T/);

  // The audit trail: which run, which candidate, which configuration.
  assert.equal(entry.runId, run);
  assert.equal(entry.candidate.runId, run);
  assert.equal(entry.candidate.sha256, hash);
  assert.match(
    entry.candidate.path,
    new RegExp(`screenshots/${PAGE_ID}/${VIEWPORT}\\.png$`),
    'the candidate path is recorded relative to the project root',
  );
  assert.equal(entry.config.path, CONFIG);
  assert.deepEqual(entry.config.viewport, { name: VIEWPORT, width: 1440, height: 900 });
  assert.equal(entry.previous, null, 'the first approval replaced nothing');
  assert.deepEqual(entry.history, []);
});

test('after approval, verification passes against the baseline', async () => {
  const result = verify();

  assert.equal(result.status, 0, `expected exit 0 after approval\n${result.stdout}\n${result.stderr}`);

  const report = JSON.parse(await readFile(path.join(PROJECT, REPORTS, 'latest.json'), 'utf8'));
  const visual = report.results.find((entry) => entry.check === 'visual');

  assert.equal(visual.status, 'pass');
  assert.match(visual.message, /Pixel-identical/);
});

test('a baseline edited outside the approval workflow is inconclusive, not a pass', async () => {
  await appendFile(baselinePng, Buffer.from('\n# edited by hand\n'), 'utf8');

  const result = verify();
  assert.equal(result.status, 3, 'a tampered baseline must exit 3, not 0');

  const report = JSON.parse(await readFile(path.join(PROJECT, REPORTS, 'latest.json'), 'utf8'));
  const visual = report.results.find((entry) => entry.check === 'visual');

  assert.equal(visual.status, 'inconclusive');
  assert.match(visual.message, /does not match the hash/);
});

test('approving a byte-identical candidate reports that nothing needed to change', async () => {
  // Restore a trusted state first: re-approve the current screenshot.
  const first = dryRun();
  const restored = approve([
    '--run',
    first.run,
    '--approve-hash',
    first.hash,
    '--confirm',
    '--note',
    're-approved after tamper test',
  ]);
  assert.equal(restored.status, 0, restored.stderr);

  const second = dryRun();
  const repeat = approve([
    '--run',
    second.run,
    '--approve-hash',
    second.hash,
    '--confirm',
  ]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(repeat.stdout, /byte-identical/);
});

/* ---------------------------------------------------- hash-bound approval --- */

// Everything below runs against tests/.tmp-test/baselines-visual and
// tests/.tmp-test/reports-visual only. The project's own baselines/ directory is
// never a target: a test must not be able to approve a real baseline.

test('a confirmation that does not name its run and candidate is refused', async () => {
  const { run, hash } = dryRun();
  const baselineBefore = await sha256File(baselinePng);

  const noRun = approve(['--approve-hash', hash, '--confirm']);
  assert.equal(noRun.status, 2, noRun.stdout);
  assert.match(noRun.stderr, /requires an explicit `--run/);

  const noHash = approve(['--run', run, '--confirm']);
  assert.equal(noHash.status, 2, noHash.stdout);
  assert.match(noHash.stderr, /requires `--approve-hash/);

  const malformed = approve(['--run', run, '--approve-hash', 'deadbeef', '--confirm']);
  assert.equal(malformed.status, 2, malformed.stdout);
  assert.match(malformed.stderr, /is not a SHA-256 digest/);

  const wrongHash = approve(['--run', run, '--approve-hash', 'f'.repeat(64), '--confirm']);
  assert.equal(wrongHash.status, 2, wrongHash.stdout);
  assert.match(wrongHash.stderr, /does not match the candidate/);
  assert.match(wrongHash.stderr, new RegExp(hash), 'the refusal must name the real candidate hash');

  const hashWithoutConfirm = approve(['--approve-hash', hash]);
  assert.equal(hashWithoutConfirm.status, 2, hashWithoutConfirm.stdout);
  assert.match(hashWithoutConfirm.stderr, /only means something with `--confirm`/);

  assert.equal(
    await sha256File(baselinePng),
    baselineBefore,
    'a refused approval must not touch the baseline',
  );
});

test('the approval path still refuses a hostile run id', async () => {
  for (const hostile of ['../../../etc', '..\..\escape', 'C:\outside', '/abs/out']) {
    const result = approve(['--run', hostile, '--approve-hash', 'a'.repeat(64), '--confirm']);
    assert.equal(result.status, 2, `${hostile}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /is not a verification run id/);
  }
});

test('an approval is always exactly one page at one viewport', async () => {
  const result = spawnSync(
    process.execPath,
    ['tools/approve-baseline.js', '--config', CONFIG, '--page', PAGE_ID],
    { cwd: PROJECT, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /Both --page and --viewport are required/);
  assert.match(result.stderr, /One invocation approves one page at one viewport/);
});

test('a stale candidate hash is refused, and a real replacement is archived', async () => {
  const before = JSON.parse(await readFile(manifestFile, 'utf8')).entries[`${PAGE_ID}/${VIEWPORT}`];
  const baselineHash = before.sha256;
  // Earlier tests in this file have approved this fixture more than once, so the
  // history is expected to grow by exactly one record, not to start empty.
  const historyBefore = before.history?.length ?? 0;

  const { run, hash } = dryRun();
  const laterRun = await cloneRunWithChangedPixel(run, '2099-01-01T00-00-00-000Z');

  // The hash printed for the earlier candidate must not approve the new bytes.
  const stale = approve(['--run', laterRun, '--approve-hash', hash, '--confirm']);
  assert.equal(stale.status, 2, `${stale.stdout}${stale.stderr}`);
  assert.match(stale.stderr, /does not match the candidate/);
  assert.equal(
    await sha256File(baselinePng),
    baselineHash,
    'a stale approval must leave the baseline alone',
  );

  // The dry run has to be enough to review: candidate path, run, dimensions,
  // candidate hash, the hash of the baseline it would replace, a difference
  // summary and a diff image to look at.
  const dry = approve(['--run', laterRun]);
  assert.equal(dry.status, 0, dry.stderr);
  for (const pattern of [
    /^Candidate:\s+\S+\.png$/m,
    /^Run:\s+\S+$/m,
    /^Size:\s+1440x900 px$/m,
    /^SHA-256:\s+[0-9a-f]{64}$/m,
    /^Current baseline SHA-256:\s+[0-9a-f]{64}$/m,
    /px differ/,
    /^Diff image:\s+\S+$/m,
  ]) {
    assert.match(dry.stdout, pattern, `the dry run must report ${pattern}`);
  }

  const diffArtifact = /^Diff image:\s+(\S+)$/m.exec(dry.stdout)[1];
  assert.match(
    diffArtifact,
    /reports-visual\/.+\/approval\/fixture-pass\/desktop-diff\.png$/,
    'the diff belongs in the run directory, never in baselines/',
  );
  assert.equal(
    await exists(path.join(PROJECT, diffArtifact)),
    true,
    'the diff image must actually be written',
  );

  // Approving the candidate this invocation actually read does work, and the
  // replaced image is archived rather than lost.
  const fresh = parseDryRun(dry.stdout);
  assert.ok(fresh.hash, 'the dry run must print the candidate hash');
  assert.notEqual(fresh.hash, hash, 'the cloned candidate must have different bytes');

  const approved = approve([
    '--run',
    laterRun,
    '--approve-hash',
    fresh.hash,
    '--confirm',
    '--note',
    'replaced deliberately',
  ]);
  assert.equal(approved.status, 0, `${approved.stdout}${approved.stderr}`);
  assert.equal(await sha256File(baselinePng), fresh.hash);

  const entry = JSON.parse(await readFile(manifestFile, 'utf8')).entries[`${PAGE_ID}/${VIEWPORT}`];
  assert.equal(entry.runId, laterRun);
  assert.equal(entry.candidate.runId, laterRun);
  assert.equal(entry.candidate.sha256, fresh.hash);
  assert.equal(entry.previous.sha256, baselineHash, "the replaced image's hash is recorded");
  assert.equal(entry.previous.runId, before.runId, 'and the run that produced it');
  assert.equal(entry.previous.manifestSha256, baselineHash);
  assert.ok(entry.previous.archive, 'the archive path is recorded');
  assert.match(entry.previous.replacedAt, /^\d{4}-\d{2}-\d{2}T/);

  const archivePath = path.join(PROJECT, BASELINES, entry.previous.archive);
  assert.equal(await exists(archivePath), true, 'the previous baseline is kept in archive/');
  assert.equal(
    await sha256File(archivePath),
    baselineHash,
    'the archived bytes still hash to what the manifest says they replace',
  );
  assert.equal(entry.previous.archiveSha256, baselineHash);

  assert.equal(
    entry.history.length,
    historyBefore + 1,
    'the replaced approval is appended to history, not dropped',
  );
  const replaced = entry.history.at(-1);
  assert.equal(replaced.sha256, baselineHash);
  assert.equal(replaced.runId, before.runId);
  assert.equal(replaced.replacedBy.sha256, fresh.hash);
  assert.equal(replaced.replacedBy.runId, laterRun);
});
