/**
 * L-4 regression — baseline manifest integrity must fail closed.
 *
 * The hole the Phase 7 audit found: the visual check only compared the recorded
 * hash `if (entry.sha256)`, so an approval record without a fingerprint silently
 * skipped integrity verification. A baseline swapped outside the approval
 * workflow would still be compared against as if it had been approved.
 *
 * These tests drive the real production path (`readManifest` -> `visual.run`)
 * against fixtures under `tests/.tmp-test/`. They never touch `baselines/` and
 * never create or approve a real baseline.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import {
  manifestFileFor,
  readManifest,
  recordApproval,
} from '../../tools/lib/baseline.js';
import { ConfigError } from '../../tools/lib/config.js';
import { sha256File } from '../../tools/lib/fs-utils.js';
import * as visualCheck from '../../tools/lib/checks/visual.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(PROJECT, 'tests', '.tmp-test', 'manifest-integrity');

const VALID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** A minimal, real PNG so the comparison runs the same path as production. */
function pngBytes(width = 4, height = 3, rgb = [12, 34, 56]) {
  const data = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = rgb[0];
    data[pixel * 4 + 1] = rgb[1];
    data[pixel * 4 + 2] = rgb[2];
    data[pixel * 4 + 3] = 255;
  }
  return PNG.sync.write({ width, height, data });
}

/** Build a case directory with a baseline image and (optionally) a manifest. */
async function fixture(name, { manifest, withImage = true } = {}) {
  const root = path.join(WORK, name);
  await mkdir(path.join(root, 'page'), { recursive: true });
  const baselinePath = path.join(root, 'page', 'desktop.png');
  if (withImage) await writeFile(baselinePath, pngBytes());

  if (manifest !== undefined) {
    const text = typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestFileFor(root), text, 'utf8');
  }

  return { root, baselinePath };
}

/** Run the visual check exactly as the runner does. */
async function runVisual(root, baselinePath, manifest) {
  return visualCheck.run({
    pageId: 'page',
    viewport: { name: 'desktop', width: 4, height: 3 },
    artifacts: {
      screenshot: 'tests/.tmp-test/manifest-integrity/screenshot.png',
      screenshotPath: baselinePath,
      diff: null,
      diffPath: null,
    },
    baselinePath,
    manifest,
    checkConfig: {},
    browserVersion: null,
    root,
  });
}

before(async () => {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
});

after(async () => {
  await rm(WORK, { recursive: true, force: true });
});

test('1. a manifest whose fingerprint matches the image is trusted', async () => {
  const { root, baselinePath } = await fixture('match', { withImage: false });
  await writeFile(baselinePath, pngBytes());
  const hash = await sha256File(baselinePath);

  await writeFile(
    manifestFileFor(root),
    `${JSON.stringify(
      {
        version: 1,
        entries: {
          'page/desktop': {
            pageId: 'page',
            viewport: 'desktop',
            file: 'page/desktop.png',
            sha256: hash,
            width: 4,
            height: 3,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const manifest = await readManifest(root);
  const outcome = await runVisual(root, baselinePath, manifest);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
});

test('2. a validly formatted fingerprint that does not match the image is not trusted', async () => {
  const { root, baselinePath } = await fixture('mismatch');

  await writeFile(
    manifestFileFor(root),
    `${JSON.stringify({ version: 1, entries: { 'page/desktop': { sha256: OTHER } } })}\n`,
    'utf8',
  );

  const loaded = await readManifest(root);
  const outcome = await runVisual(root, baselinePath, loaded);
  assert.match(
    outcome.inconclusive ?? '',
    /does not match the hash recorded at approval time/,
    JSON.stringify(outcome),
  );
});

test('3-6. a missing, empty, malformed or wrong-length fingerprint is rejected', async () => {
  const cases = [
    ['missing', {}, /sha256 is missing/],
    ['empty', { sha256: '' }, /sha256 is empty/],
    ['null', { sha256: null }, /sha256 is null/],
    ['malformed', { sha256: 'zzzz'.padEnd(64, 'z') }, /not a hexadecimal digest/],
    ['wrong-length-short', { sha256: 'a'.repeat(63) }, /63 characters instead of 64/],
    ['wrong-length-long', { sha256: 'a'.repeat(65) }, /65 characters instead of 64/],
    ['uppercase', { sha256: 'A'.repeat(64) }, /not a hexadecimal digest/],
    ['non-string', { sha256: 12345 }, /not a string/],
  ];

  for (const [name, entry, expected] of cases) {
    const { root, baselinePath } = await fixture(`invalid-${name}`);
    await writeFile(
      manifestFileFor(root),
      `${JSON.stringify({ version: 1, entries: { 'page/desktop': entry } })}\n`,
      'utf8',
    );

    await assert.rejects(
      () => readManifest(root),
      (error) =>
        error instanceof ConfigError &&
        error.details.some((detail) => expected.test(detail)),
      `${name}: readManifest must refuse this manifest`,
    );

    // Defence in depth: even a manifest built by hand (bypassing readManifest)
    // must not let the visual check verify against an un-fingerprinted image.
    const handBuilt = { version: 1, entries: { 'page/desktop': entry } };
    const outcome = await runVisual(root, baselinePath, handBuilt);
    assert.match(
      outcome.inconclusive ?? '',
      /no valid SHA-256 fingerprint/,
      `${name}: the visual check must fail closed, got ${JSON.stringify(outcome)}`,
    );
  }
});

test('7. a missing baseline image is a failure with instructions, not a pass', async () => {
  const { root, baselinePath } = await fixture('missing-image', {
    withImage: false,
    manifest: { version: 1, entries: { 'page/desktop': { sha256: VALID } } },
  });

  const manifest = await readManifest(root);
  const outcome = await runVisual(root, baselinePath, manifest);
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /No approved baseline/);
  assert.ok(outcome.remediation.includes('--confirm'));
});

test('8. an unparseable manifest is a configuration error, not a silent empty manifest', async () => {
  const { root } = await fixture('malformed', { manifest: '{not json', withImage: false });

  await assert.rejects(
    () => readManifest(root),
    (error) =>
      error instanceof ConfigError && /Invalid JSON in the baseline manifest/.test(error.message),
  );
});

test('8b. a manifest with the wrong shape is rejected', async () => {
  const cases = [
    ['array', '[]', /not a JSON object/],
    ['entries-array', '{"version":1,"entries":[]}', /invalid "entries" field/],
    ['entry-string', '{"version":1,"entries":{"page/desktop":"x"}}', /the entry is not an object/],
  ];

  for (const [name, text, expected] of cases) {
    const { root } = await fixture(`shape-${name}`, { manifest: text, withImage: false });
    await assert.rejects(
      () => readManifest(root),
      (error) =>
        error instanceof ConfigError &&
        (expected.test(error.message) || error.details.some((detail) => expected.test(detail))),
      `${name}: expected a configuration error`,
    );
  }
});

test('9. a manifest written by recordApproval is accepted and verified', async () => {
  const { root, baselinePath } = await fixture('roundtrip', { withImage: false });
  await writeFile(baselinePath, pngBytes(4, 3, [200, 100, 50]));
  const hash = await sha256File(baselinePath);

  await recordApproval({
    baselinesRoot: root,
    pageId: 'page',
    viewportName: 'desktop',
    runId: '2026-01-01T09-00-00-000Z',
    sha256: hash,
    width: 4,
    height: 3,
    approvedBy: 'audit',
    note: 'phase 8 fixture',
  });

  const manifest = await readManifest(root);
  assert.equal(manifest.entries['page/desktop'].sha256, hash);

  const outcome = await runVisual(root, baselinePath, manifest);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));

  // The manifest is written where the tool documents it, and it round-trips.
  const raw = JSON.parse(await readFile(manifestFileFor(root), 'utf8'));
  assert.equal(raw.entries['page/desktop'].sha256, hash);
});

test('the project baselines directory is never touched by these tests', async () => {
  const realRoot = path.join(PROJECT, 'baselines');
  const entries = await readFile(path.join(realRoot, 'README.md'), 'utf8').then(
    () => true,
    () => false,
  );
  assert.equal(entries, true, 'baselines/README.md must still be there');

  await assert.rejects(
    () => readFile(path.join(realRoot, 'manifest.json'), 'utf8'),
    /ENOENT/,
    'no production manifest may exist after this test file runs',
  );
});
