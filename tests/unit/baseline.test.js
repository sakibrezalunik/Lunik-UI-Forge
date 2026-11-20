import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  baselineFileFor,
  entryKey,
  getEntry,
  manifestFileFor,
  readManifest,
  recordApproval,
} from '../../tools/lib/baseline.js';
import { ConfigError } from '../../tools/lib/config.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Kept inside the project: a test must not write into the OS temp directory.
const WORK = path.join(PROJECT, 'tests', '.tmp-test', 'baseline');

// Real fingerprints are 64 lowercase hex digits; the manifest now refuses
// anything else, so the fixtures use well-formed values.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

// recordApproval refuses to record an approval that cannot name the verification
// run it came from, so every fixture names one. These are real run-id shapes.
const RUN = '2026-01-01T09-00-00-000Z';
const RUN_LATER = '2026-01-02T09-00-00-000Z';

async function tempRoot() {
  await mkdir(WORK, { recursive: true });
  return mkdtemp(path.join(WORK, 'case-'));
}

after(async () => {
  await rm(WORK, { recursive: true, force: true });
});

test('baseline paths are deterministic and slug-based', () => {
  const root = path.join('project', 'baselines');
  assert.equal(
    baselineFileFor(root, 'saas-dashboard', 'desktop'),
    path.join(root, 'saas-dashboard', 'desktop.png'),
  );
  assert.equal(
    baselineFileFor(root, 'saas-dashboard', 'desktop'),
    baselineFileFor(root, 'saas-dashboard', 'desktop'),
  );
});

test('a baseline for a different viewport never collides', () => {
  const root = path.join('project', 'baselines');
  assert.notEqual(
    baselineFileFor(root, 'page', 'desktop'),
    baselineFileFor(root, 'page', 'mobile'),
  );
});

test('entryKey is pageId/viewport', () => {
  assert.equal(entryKey('page', 'mobile'), 'page/mobile');
});

test('a missing manifest reads as empty rather than throwing', async () => {
  const root = await tempRoot();
  const manifest = await readManifest(root);
  assert.deepEqual(manifest.entries, {});
  assert.equal(manifest.version, 2);
});

test('recordApproval stores the hash, size, and note', async () => {
  const root = await tempRoot();
  const entry = await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN,
    sha256: HASH_A,
    width: 1440,
    height: 900,
    browserVersion: '156.0.0.0',
    approvedBy: 'tester',
    note: 'deliberate layout change',
    approvedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(entry.sha256, HASH_A);
  assert.equal(entry.width, 1440);
  assert.equal(entry.note, 'deliberate layout change');
  assert.equal(entry.approvedAt, '2026-01-01T00:00:00.000Z');

  const manifest = await readManifest(root);
  assert.equal(getEntry(manifest, 'page', 'desktop').sha256, HASH_A);
});

test('recordApproval preserves other entries and updates an existing one', async () => {
  const root = await tempRoot();
  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN,
    sha256: HASH_A,
    width: 1440,
    height: 900,
  });
  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'mobile',
    runId: RUN,
    sha256: HASH_B,
    width: 390,
    height: 844,
  });
  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN_LATER,
    sha256: HASH_C,
    width: 1440,
    height: 900,
  });

  const manifest = await readManifest(root);
  assert.deepEqual(Object.keys(manifest.entries).sort(), ['page/desktop', 'page/mobile']);
  assert.equal(getEntry(manifest, 'page', 'desktop').sha256, HASH_C);
});

test('the manifest file is valid json at the documented path', async () => {
  const root = await tempRoot();
  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN,
    sha256: HASH_D,
    width: 1,
    height: 1,
  });

  const raw = await readFile(manifestFileFor(root), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2);
  assert.ok(raw.endsWith('\n'), 'manifest should end with a newline');
});

test('a corrupt manifest surfaces as a clear error instead of silent data loss', async () => {
  const root = await tempRoot();
  await writeFile(manifestFileFor(root), '{not json', 'utf8');
  // Classified as a configuration error (exit 2), like an unparseable config.
  await assert.rejects(
    () => readManifest(root),
    (error) => error instanceof ConfigError && /Invalid JSON in the baseline manifest/.test(error.message),
  );
});

test('recordApproval refuses to write an entry without a valid fingerprint', async () => {
  const root = await tempRoot();
  for (const bad of [undefined, null, '', 'abc123', 'A'.repeat(64), 'a'.repeat(63)]) {
    await assert.rejects(
      () =>
        recordApproval({
          baselinesRoot: root,
          pageId: 'page',
          viewportName: 'desktop',
          runId: RUN,
          sha256: bad,
          width: 1,
          height: 1,
        }),
      /valid SHA-256 fingerprint/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }

  // Nothing was recorded by the refused calls.
  const manifest = await readManifest(root);
  assert.deepEqual(manifest.entries, {});
});

test('an approval records the run, candidate, configuration and replacement', async () => {
  const root = await tempRoot();
  const entry = await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN,
    sha256: HASH_A,
    width: 1440,
    height: 900,
    candidatePath: `reports/${RUN}/screenshots/page/desktop.png`,
    configPath: 'lunik.config.json',
    pixelThreshold: 0.1,
    previous: {
      file: 'page/desktop.png',
      runId: '2025-12-31T09-00-00-000Z',
      sha256: HASH_B,
      width: 1440,
      height: 900,
      archive: 'page/archive/desktop-1.png',
      archiveSha256: HASH_B,
      replacedAt: '2026-01-01T09:05:00.000Z',
    },
    browserVersion: '156.0.0.0',
    approvedBy: 'tester',
    note: 'affordance rebuilt',
    approvedAt: '2026-01-01T09:00:00.000Z',
  });

  // Every question the audit trail has to answer, answered from the record.
  assert.equal(entry.runId, RUN, 'which candidate run was approved');
  assert.deepEqual(
    entry.candidate,
    {
      runId: RUN,
      path: `reports/${RUN}/screenshots/page/desktop.png`,
      sha256: HASH_A,
      width: 1440,
      height: 900,
    },
    'which candidate image, and its hash, was approved',
  );
  assert.equal(entry.config.path, 'lunik.config.json', 'which configuration was used');
  assert.deepEqual(entry.config.viewport, { name: 'desktop', width: 1440, height: 900 });
  assert.equal(entry.config.pixelThreshold, 0.1);
  assert.equal(entry.previous.file, 'page/desktop.png', 'which previous image was replaced');
  assert.equal(entry.previous.sha256, HASH_B, "the previous image's hash");
  assert.equal(entry.previous.archive, 'page/archive/desktop-1.png');
  assert.equal(entry.previous.archiveSha256, HASH_B, 'the archived copy can be verified');
  assert.equal(entry.approvedAt, '2026-01-01T09:00:00.000Z');
  assert.equal(entry.approvedBy, 'tester');
  assert.equal(entry.note, 'affordance rebuilt');
  assert.equal(entry.browserVersion, '156.0.0.0');
  assert.deepEqual(entry.history, [], 'the first approval replaces nothing older');

  const manifest = await readManifest(root);
  assert.equal(manifest.version, 2);
  assert.equal(getEntry(manifest, 'page', 'desktop').runId, RUN);
});

test('a second approval appends to history instead of discarding the first', async () => {
  const root = await tempRoot();
  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN,
    sha256: HASH_A,
    width: 1440,
    height: 900,
    approvedBy: 'first reviewer',
    note: 'initial approval',
    approvedAt: '2026-01-01T09:00:00.000Z',
    browserVersion: '155.0.0.0',
  });
  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN_LATER,
    sha256: HASH_B,
    width: 1440,
    height: 900,
    approvedBy: 'second reviewer',
    approvedAt: '2026-01-02T09:00:00.000Z',
  });

  const entry = getEntry(await readManifest(root), 'page', 'desktop');
  assert.equal(entry.sha256, HASH_B);
  assert.equal(entry.history.length, 1);
  assert.equal(entry.history[0].sha256, HASH_A);
  assert.equal(entry.history[0].runId, RUN);
  assert.equal(entry.history[0].approvedBy, 'first reviewer');
  assert.equal(entry.history[0].note, 'initial approval');
  assert.equal(entry.history[0].browserVersion, '155.0.0.0');
  assert.equal(entry.history[0].approvedAt, '2026-01-01T09:00:00.000Z');
  assert.equal(entry.history[0].replacedBy.sha256, HASH_B);
  assert.equal(entry.history[0].replacedBy.runId, RUN_LATER);

  // A third approval keeps the whole trail, oldest first.
  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN_LATER,
    sha256: HASH_C,
    width: 1440,
    height: 900,
  });
  const third = getEntry(await readManifest(root), 'page', 'desktop');
  assert.deepEqual(
    third.history.map((record) => record.sha256),
    [HASH_A, HASH_B],
    'history must be append-only',
  );
});

test('an approval without a usable run id is refused', async () => {
  const root = await tempRoot();
  for (const bad of [undefined, null, '', 'not-a-run', '../escape', '2026-01-01T09:00:00.000Z']) {
    await assert.rejects(
      () =>
        recordApproval({
          baselinesRoot: root,
          pageId: 'page',
          viewportName: 'desktop',
          runId: bad,
          sha256: HASH_A,
          width: 1,
          height: 1,
        }),
      /without the verification run/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }

  assert.deepEqual((await readManifest(root)).entries, {});
});

test('a version 1 manifest is still readable and is upgraded on the next approval', async () => {
  const root = await tempRoot();
  const legacy = {
    version: 1,
    entries: {
      'page/desktop': {
        pageId: 'page',
        viewport: 'desktop',
        file: 'page/desktop.png',
        sha256: HASH_A,
        width: 1440,
        height: 900,
        approvedAt: '2025-12-01T09:00:00.000Z',
        approvedBy: 'legacy reviewer',
        browserVersion: '154.0.0.0',
        note: 'approved before the audit trail existed',
      },
    },
  };
  await writeFile(manifestFileFor(root), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const read = await readManifest(root);
  assert.equal(read.version, 1, 'the recorded version is reported as recorded');
  assert.equal(getEntry(read, 'page', 'desktop').sha256, HASH_A);

  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: RUN,
    sha256: HASH_B,
    width: 1440,
    height: 900,
  });

  const upgraded = await readManifest(root);
  assert.equal(upgraded.version, 2);
  const entry = getEntry(upgraded, 'page', 'desktop');
  assert.equal(entry.sha256, HASH_B);
  assert.equal(entry.history.length, 1, 'the version 1 approval is kept, not discarded');
  assert.equal(entry.history[0].sha256, HASH_A);
  assert.equal(entry.history[0].approvedBy, 'legacy reviewer');
  assert.equal(entry.history[0].browserVersion, '154.0.0.0');
  assert.equal(entry.history[0].note, 'approved before the audit trail existed');
  assert.equal(entry.history[0].runId, null, 'a version 1 record has no run id to carry forward');
});

test('a malformed audit trail fails closed', async () => {
  const cases = [
    ['history-not-a-list', { history: 'nope' }, /history must be an array/],
    ['history-record-not-an-object', { history: ['x'] }, /is not an approval record/],
    ['history-hash', { history: [{ sha256: 'abc' }] }, /history\[0\]/],
    ['history-replacedBy', { history: [{ sha256: HASH_A, replacedBy: 'x' }] }, /replacedBy must be an object/],
    ['previous-not-an-object', { previous: 'x' }, /previous must be an object/],
    ['previous-hash', { previous: { sha256: 'abc' } }, /previous\./],
    ['candidate-not-an-object', { candidate: 'x' }, /candidate must be an object/],
    ['runId-not-a-string', { runId: 12 }, /runId must be a string/],
  ];

  for (const [name, entry, expected] of cases) {
    const root = await tempRoot();
    await writeFile(
      manifestFileFor(root),
      `${JSON.stringify({ version: 2, entries: { 'page/desktop': { sha256: HASH_A, ...entry } } })}\n`,
      'utf8',
    );
    await assert.rejects(
      () => readManifest(root),
      (error) =>
        error instanceof ConfigError && error.details.some((detail) => expected.test(detail)),
      `${name}: readManifest must refuse this manifest`,
    );
  }
});

test('a manifest from an unknown schema version fails closed', async () => {
  for (const version of [0, 3, 99, '2', null]) {
    const root = await tempRoot();
    await writeFile(manifestFileFor(root), `${JSON.stringify({ version, entries: {} })}\n`, 'utf8');
    await assert.rejects(
      () => readManifest(root),
      (error) => error instanceof ConfigError && /cannot read/.test(error.message),
      `version ${JSON.stringify(version)} must not be read`,
    );
  }
});
