/**
 * Phase 21 — journal trust-boundary and rollback integrity hardening.
 *
 * These tests attack a *real* journal produced by the existing implementation:
 * each case approves run A, then crashes an approval of run B after the baseline
 * has been replaced, which leaves the journal, the archive of run A and the
 * run-B baseline on disk. That is the exact state recovery has to reason about.
 *
 * Nothing here touches the project's real `baselines/`; every fixture lives
 * under `tests/.tmp-txn-hardening/` and is removed afterwards.
 *
 * R1 — no journal-provided path is trusted: baseline and manifest paths must be
 *      exactly the paths derived from the trusted root and validated identity;
 *      archive and staging paths must sit in their own transaction directories.
 * R2 — the complete journal structure is validated before recovery reads any
 *      nested field, so a shallow or malformed journal is refused with one
 *      classified error instead of a TypeError.
 * R3 — archive bytes are hashed in a temporary file and only then renamed over
 *      the destination, so a corrupt archive can never replace the baseline.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { EnvironmentError } from '../../tools/lib/errors.js';
import { restoreFromJournal } from '../../tools/lib/approval-transaction.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-txn-hardening');
const RUN_A = '2026-11-18T10-00-00-000Z';
const RUN_B = '2026-11-18T11-00-00-000Z';

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function png(width, height, rgb) {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = rgb[0];
    image.data[i + 1] = rgb[1];
    image.data[i + 2] = rgb[2];
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

async function sha(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function list(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function fixture(name) {
  const root = path.join(TMP, name);
  await rm(root, { recursive: true, force: true });
  const config = {
    viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    reportsDir: `tests/.tmp-txn-hardening/${name}/reports`,
    baselinesDir: `tests/.tmp-txn-hardening/${name}/baselines`,
    checks: { visual: { enabled: true, severity: 'error', maxDiffRatio: 0.001, pixelThreshold: 0.1 } },
    pages: [{ id: 'test-page', path: '/tests/fixtures/pass/index.html', expect: { selectors: ['h1'] } }],
  };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  for (const run of [RUN_A, RUN_B]) {
    const dir = path.join(root, 'reports', run, 'screenshots', 'test-page');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'desktop.png'),
      png(1440, 900, run === RUN_A ? [10, 20, 30] : [200, 100, 50]),
    );
    await writeFile(
      path.join(root, 'reports', run, 'report.json'),
      JSON.stringify({ environment: { browser: { version: '156.0.8078.4' } } }),
    );
  }
  return root;
}

const configPath = (root) => `tests/.tmp-txn-hardening/${path.basename(root)}/config.json`;
const baselinePath = (root) => path.join(root, 'baselines', 'test-page', 'desktop.png');
const manifestPath = (root) => path.join(root, 'baselines', 'manifest.json');
const journalPath = (root) => path.join(root, 'baselines', '.approval-journal.json');
const lockPath = (root) => path.join(root, 'baselines', '.approval.lock');
const baselinesRoot = (root) => path.join(root, 'baselines');
const archiveDir = (root) => path.join(root, 'baselines', 'test-page', 'archive');
const pageDir = (root) => path.join(root, 'baselines', 'test-page');

function args(root, extra) {
  return ['tools/approve-baseline.js', '--config', configPath(root), '--page', 'test-page', '--viewport', 'desktop', ...extra];
}

function run(root, extra, env = {}) {
  return spawnSync(process.execPath, args(root, extra), {
    cwd: PROJECT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

async function dryHash(root, runId) {
  const result = run(root, ['--run', runId]);
  return /^SHA-256:\s+([0-9a-f]{64})$/m.exec(result.stdout)?.[1] ?? null;
}

async function approve(root, runId) {
  const hash = await dryHash(root, runId);
  return run(root, ['--run', runId, '--approve-hash', hash, '--confirm']);
}

async function sourceHash(root, runId) {
  return sha(path.join(root, 'reports', runId, 'screenshots', 'test-page', 'desktop.png'));
}

async function confirmWithRunB(root, env = {}) {
  const hash = await sourceHash(root, RUN_B);
  return run(root, ['--run', RUN_B, '--approve-hash', hash, '--confirm'], env);
}

async function archiveState(root) {
  const dir = archiveDir(root);
  const names = (await list(dir)).sort();
  const records = [];
  for (const name of names) records.push([name, await sha(path.join(dir, name))]);
  return records;
}

async function tempDebris(root) {
  return (await list(pageDir(root))).filter(
    (name) => name.startsWith('.restore-') || name.includes('.tmp') || name.includes('.restore.tmp'),
  );
}

async function writeJournal(root, journal) {
  const text = `${JSON.stringify(journal, null, 2)}\n`;
  await writeFile(journalPath(root), text, 'utf8');
  return readFile(journalPath(root));
}

/**
 * Build the post-crash state: run A is approved, then an approval of run B is
 * killed after the baseline replacement. Also creates an external victim file
 * that no journal is allowed to name.
 */
async function crashSetup(name) {
  const root = await fixture(name);
  assert.equal((await approve(root, RUN_A)).status, 0, `${name}: setup approval must succeed`);

  const crashed = await confirmWithRunB(root, { LUNIK_APPROVAL_FAULT: 'after-baseline-replace:crash' });
  assert.equal(crashed.status, 70, `${name}: the crash must be simulated, not caught`);

  const victim = path.join(root, 'victim.png');
  await writeFile(victim, 'external victim bytes\n', 'utf8');

  const journal = JSON.parse(await readFile(journalPath(root), 'utf8'));
  return {
    root,
    journal,
    journalBytes: await readFile(journalPath(root)),
    baselineHash: await sha(baselinePath(root)),
    manifestText: await readFile(manifestPath(root), 'utf8'),
    victimHash: await sha(victim),
    victimPath: victim,
  };
}

function assertNoTeardown(result) {
  assert.doesNotMatch(result.stderr, /Unexpected error/);
  assert.doesNotMatch(result.stderr, /TypeError/);
  assert.doesNotMatch(result.stderr, /^\s+at .*\(.*:\d+:\d+\)$/m, 'no raw stack trace may escape');
}

async function assertRefusedWithoutDamage(fixtureState, result, journalBytes) {
  const { root, baselineHash, manifestText, victimHash, victimPath } = fixtureState;

  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /is invalid or incomplete/, 'one classified error must explain the refusal');
  assertNoTeardown(result);

  assert.deepEqual(await readFile(journalPath(root)), journalBytes, 'the journal must remain byte-identical');
  assert.equal(await sha(baselinePath(root)), baselineHash, 'the current baseline must be untouched');
  assert.equal(await readFile(manifestPath(root), 'utf8'), manifestText, 'the manifest must be untouched');
  assert.equal(await sha(victimPath), victimHash, 'no external victim file may be modified');
  assert.equal(await exists(lockPath(root)), false, 'the lock must be released');
  assert.deepEqual(await tempDebris(root), [], 'no restoration temporary file may remain');
}

// ---------------------------------------------------------------------------
// R2 — complete journal schema validation
// ---------------------------------------------------------------------------

test('R2: every malformed or incomplete journal is refused with one classified error', async () => {
  const cases = [
    ['phase20-shallow', (j) => ({ version: 1, baseline: j.baseline, manifest: j.manifest })],
    ['missing-candidate', (j) => { delete j.candidate; return j; }],
    ['missing-staged', (j) => { delete j.staged; return j; }],
    ['candidate-null', (j) => { j.candidate = null; return j; }],
    ['staged-null', (j) => { j.staged = null; return j; }],
    ['baseline-null', (j) => { j.baseline = null; return j; }],
    ['manifest-null', (j) => { j.manifest = null; return j; }],
    ['candidate-hash', (j) => { j.candidate.sha256 = 'zz'; return j; }],
    ['staged-hash', (j) => { j.staged.sha256 = 'not-a-hash'; return j; }],
    ['candidate-staged-mismatch', (j) => { j.staged.sha256 = 'a'.repeat(64); return j; }],
    ['invalid-stage', (j) => { j.stage = 'partway'; return j; }],
    ['wrong-version', (j) => { j.version = 2; return j; }],
    ['invalid-run-id', (j) => { j.runId = 'not-a-run'; return j; }],
    ['manifest-null-text', (j) => { j.manifest.existed = true; j.manifest.beforeText = null; return j; }],
    ['manifest-existed-type', (j) => { j.manifest.existed = 'yes'; return j; }],
    ['baseline-existed-type', (j) => { j.baseline.existed = 'true'; return j; }],
    ['baseline-hash-null', (j) => { j.baseline.sha256 = null; return j; }],
    ['archive-missing', (j) => { delete j.archive; return j; }],
    ['archive-hash-not-recorded', (j) => { j.archive.sha256 = null; return j; }],
    ['archive-baseline-hash-disagree', (j) => { j.archive.sha256 = 'c'.repeat(64); return j; }],
    ['wrong-primitive-types', (j) => {
      j.pageId = 42;
      j.viewport = ['desktop'];
      j.candidate.width = '1440';
      j.archive.path = 123;
      return j;
    }],
    ['missing-identity', (j) => { delete j.pageId; delete j.viewport; return j; }],
  ];

  for (const [name, mutate] of cases) {
    const state = await crashSetup(`r2-${name}`);
    const bytes = await writeJournal(state.root, mutate(structuredClone(state.journal)));
    const result = await confirmWithRunB(state.root);
    await assertRefusedWithoutDamage(state, result, bytes);
  }
});

// ---------------------------------------------------------------------------
// R1 — journal path containment and identity validation
// ---------------------------------------------------------------------------

test('R1: journal-provided paths outside their transaction directories are refused', async () => {
  const cases = [
    ['absolute-outside', (j, c) => { j.baseline.path = c.victimPath; return j; }],
    ['dotdot-traversal', (j, c) => {
      j.baseline.path = path.join(c.baselinesRoot, 'test-page', '..', '..', 'victim.png');
      return j;
    }],
    ['sibling-prefix', (j, c) => {
      j.baseline.path = path.join(c.root, 'baselines-archive', 'test-page', 'desktop.png');
      return j;
    }],
    ['windows-drive-letter', (j) => { j.baseline.path = 'C:\\Windows\\System32\\drivers\\etc\\hosts'; return j; }],
    ['windows-unc', (j) => { j.baseline.path = '\\\\server\\share\\victim.png'; return j; }],
    ['separator-traversal', (j, c) => {
      j.baseline.path = `${c.baselinesRoot}\\test-page\\..\\..\\victim.png`;
      return j;
    }],
    ['case-varied-sibling', (j, c) => {
      j.baseline.path = path.join(c.root, 'BASELINES-ARCHIVE', 'test-page', 'desktop.png');
      return j;
    }],
    ['manifest-outside', (j, c) => { j.manifest.path = path.join(c.root, 'victim-manifest.json'); return j; }],
    ['archive-outside', (j, c) => { j.archive.path = c.victimPath; return j; }],
    ['archive-sibling-prefix', (j, c) => {
      j.archive.path = path.join(c.root, 'baselines-archive', 'test-page', 'archive', 'desktop-1.png');
      return j;
    }],
    ['archive-wrong-directory', (j, c) => {
      j.archive.path = path.join(c.root, 'elsewhere', 'archive', 'desktop-1.png');
      return j;
    }],
    ['archive-wrong-name', (j, c) => {
      j.archive.path = path.join(c.baselinesRoot, 'test-page', 'archive', 'mobile-1.png');
      return j;
    }],
    ['staged-outside', (j, c) => { j.staged.path = c.victimPath; return j; }],
    ['baseline-other-page', (j, c) => {
      j.baseline.path = path.join(c.baselinesRoot, 'other-page', 'desktop.png');
      return j;
    }],
    ['baseline-other-viewport', (j, c) => {
      j.baseline.path = path.join(c.baselinesRoot, 'test-page', 'mobile.png');
      return j;
    }],
    ['journal-pageid-mismatch', (j) => { j.pageId = 'other-page'; return j; }],
    ['journal-viewport-mismatch', (j) => { j.viewport = 'mobile'; return j; }],
    ['journal-pageid-traversal', (j) => { j.pageId = '..'; return j; }],
  ];

  for (const [name, mutate] of cases) {
    const state = await crashSetup(`r1-${name}`);
    const context = {
      root: state.root,
      baselinesRoot: baselinesRoot(state.root),
      victimPath: state.victimPath,
    };
    const before = await archiveState(state.root);
    const bytes = await writeJournal(state.root, mutate(structuredClone(state.journal), context));
    const result = await confirmWithRunB(state.root);
    await assertRefusedWithoutDamage(state, result, bytes);
    assert.deepEqual(await archiveState(state.root), before, `${name}: no archive file may be touched`);
  }
});

test('R1: an unmodified journal produced by the existing implementation recovers safely', async () => {
  const state = await crashSetup('r1-valid');
  const before = await archiveState(state.root);

  const result = await confirmWithRunB(state.root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Recovered: rolled back an interrupted approval/);
  assert.equal(await exists(journalPath(state.root)), false, 'the journal must be removed after recovery');
  assert.equal(await exists(lockPath(state.root)), false, 'the lock must be released');
  assert.deepEqual(await tempDebris(state.root), [], 'successful recovery must remove temporary files');

  // The follow-up approval is for run B, so the final baseline is run B's bytes.
  const entry = JSON.parse(await readFile(manifestPath(state.root), 'utf8')).entries['test-page/desktop'];
  assert.equal(entry.sha256, await sourceHash(state.root, RUN_B));
  assert.ok((await archiveState(state.root)).length >= before.length, 'the recovered history remains on disk');
});

test('R1: equivalent separator spellings of the same path are normalised, not rejected', async () => {
  const state = await crashSetup('r1-separators');
  const normalized = structuredClone(state.journal);
  for (const key of ['baseline', 'manifest', 'staged', 'archive']) {
    if (normalized[key]?.path) normalized[key].path = normalized[key].path.split('\\').join('/');
  }
  await writeJournal(state.root, normalized);

  const result = await confirmWithRunB(state.root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Recovered: rolled back an interrupted approval/);
  assert.equal(await exists(journalPath(state.root)), false);
});

// ---------------------------------------------------------------------------
// R3 — verify archive bytes before replacing the baseline
// ---------------------------------------------------------------------------

test('R3: a corrupt archive never replaces the current baseline', async () => {
  const state = await crashSetup('r3-corrupt');
  const archiveFile = path.resolve(PROJECT, state.journal.archive.path);
  await writeFile(archiveFile, Buffer.from('this is not the archived baseline image'));
  const corruptHash = await sha(archiveFile);
  const beforeJournal = await readFile(journalPath(state.root));

  const result = await confirmWithRunB(state.root);

  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /archived bytes do not match/);
  assert.match(result.stderr, new RegExp(state.journal.baseline.sha256), 'the expected hash must be reported');
  assert.match(result.stderr, new RegExp(corruptHash), 'the observed hash must be reported');
  assertNoTeardown(result);

  assert.equal(await sha(baselinePath(state.root)), state.baselineHash, 'the current baseline must not be overwritten');
  assert.equal(await readFile(manifestPath(state.root), 'utf8'), state.manifestText);
  assert.deepEqual(await readFile(journalPath(state.root)), beforeJournal, 'the journal must be preserved');
  assert.equal(await exists(lockPath(state.root)), false, 'the lock must be released');
  assert.deepEqual(await tempDebris(state.root), [], 'the rejected temporary copy must be removed');
  assert.equal(await sha(archiveFile), corruptHash, 'the archive itself must not be silently repaired');
});

test('R3: a missing archive preserves the baseline and the journal', async () => {
  const state = await crashSetup('r3-missing');
  const archiveFile = path.resolve(PROJECT, state.journal.archive.path);
  await unlink(archiveFile);
  const beforeJournal = await readFile(journalPath(state.root));

  const result = await confirmWithRunB(state.root);

  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /its archive is missing/);
  assertNoTeardown(result);
  assert.equal(await sha(baselinePath(state.root)), state.baselineHash);
  assert.deepEqual(await readFile(journalPath(state.root)), beforeJournal);
  assert.equal(await exists(lockPath(state.root)), false);
});

test('R3: temporary-file creation failure leaves the destination and journal intact', async () => {
  const state = await crashSetup('r3-tempfail');
  const paths = {
    baselinePath: path.resolve(PROJECT, state.journal.baseline.path),
    manifestPath: path.resolve(PROJECT, state.journal.manifest.path),
    archivePath: path.resolve(PROJECT, state.journal.archive.path),
    stagedPath: path.resolve(PROJECT, state.journal.staged.path),
  };

  const failure = Object.assign(new Error('injected temporary-file creation failure'), { code: 'EACCES' });
  await assert.rejects(
    () => restoreFromJournal(state.journal, paths, { copyFile: async () => { throw failure; } }),
    (error) =>
      error instanceof EnvironmentError &&
      /failed before the destination was replaced/.test(error.message) &&
      error.details.some((line) => /injected temporary-file creation failure/.test(line)),
  );

  assert.equal(await sha(baselinePath(state.root)), state.baselineHash, 'the destination must be unchanged');
  assert.deepEqual(await tempDebris(state.root), []);
  assert.equal(await exists(journalPath(state.root)), true, 'the journal must be kept');
});

test('R3: rename failure leaves the previous destination intact and cleans the temporary file', async () => {
  const state = await crashSetup('r3-renamefail');
  const paths = {
    baselinePath: path.resolve(PROJECT, state.journal.baseline.path),
    manifestPath: path.resolve(PROJECT, state.journal.manifest.path),
    archivePath: path.resolve(PROJECT, state.journal.archive.path),
    stagedPath: path.resolve(PROJECT, state.journal.staged.path),
  };

  await assert.rejects(
    () =>
      restoreFromJournal(state.journal, paths, {
        rename: async () => {
          throw Object.assign(new Error('injected rename failure'), { code: 'EPERM' });
        },
      }),
    (error) =>
      error instanceof EnvironmentError && /failed before the destination was replaced/.test(error.message),
  );

  assert.equal(await sha(baselinePath(state.root)), state.baselineHash, 'the previous destination must be intact');
  assert.deepEqual(await tempDebris(state.root), [], 'the verified temporary file must be cleaned up');
  assert.equal(await exists(journalPath(state.root)), true);
});

test('R3: a second recovery after a successful rollback is harmless', async () => {
  const state = await crashSetup('r3-idempotent');
  const first = await confirmWithRunB(state.root);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(await exists(journalPath(state.root)), false);

  const second = await confirmWithRunB(state.root);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.doesNotMatch(second.stderr, /Recovered:/, 'there is no journal left to recover');
  assert.equal(await exists(journalPath(state.root)), false);
  assert.equal(await exists(lockPath(state.root)), false);
});

// ---------------------------------------------------------------------------
// Negative controls — the unsafeguarded behaviours really are destructive.
// These reproduce the pre-Phase-21 logic in the test process only; production
// code is never modified to weaken the guard.
// ---------------------------------------------------------------------------

test('negative control: blindly trusting journal paths and copy-then-verify are unsafe', async () => {
  const dir = path.join(TMP, 'negative-control');
  await mkdir(dir, { recursive: true });
  const victim = path.join(dir, 'victim.png');
  const destination = path.join(dir, 'destination.png');
  const corruptArchive = path.join(dir, 'corrupt-archive.png');

  await writeFile(victim, 'original victim bytes');
  await writeFile(destination, 'original destination bytes');
  await writeFile(corruptArchive, 'corrupt archive bytes');

  const victimBefore = await sha(victim);
  const destinationBefore = await sha(destination);

  // R1 hazard: a naive `copyFile(journal.archive.path, journal.baseline.path)`
  // with a journal-named victim outside baselines/ writes to that victim.
  await writeFile(victim, await readFile(corruptArchive));
  assert.notEqual(await sha(victim), victimBefore, 'legacy path following would modify an external victim');
  await writeFile(victim, 'original victim bytes');

  // R3 hazard: the old copy-then-verify order overwrites the destination before
  // the hash mismatch is discovered.
  await writeFile(destination, await readFile(corruptArchive));
  assert.notEqual(
    await sha(destination),
    destinationBefore,
    'legacy copy-then-verify would replace the destination with corrupt bytes',
  );

  // R2 hazard: the old shallow gate accepted this journal, then the nested read
  // threw an unclassified TypeError.
  const shallow = { version: 1, baseline: {}, manifest: {} };
  assert.throws(() => shallow.candidate.sha256, TypeError);
});
