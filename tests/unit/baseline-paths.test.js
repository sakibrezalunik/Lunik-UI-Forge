/**
 * M-2 part B — containment is enforced where baseline paths are built, not only
 * by configuration validation. A hostile id or viewport name must fail loudly
 * and must never yield (let alone write) a path outside the baseline root.
 */
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { archiveFileFor, baselineFileFor, resolveInside } from '../../tools/lib/baseline.js';
import { ConfigError } from '../../tools/lib/config.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test', 'baseline-paths');
const ROOT = path.join(TMP, 'baselines');

const HOSTILE_NAMES = [
  '../escape',
  '../../escape',
  '../../../escaped',
  '..\\escape',
  'C:\\outside',
  '/abs/out',
  'sub/dir',
  '..',
  '.',
  '',
];

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  await mkdir(ROOT, { recursive: true });
});

after(async () => {
  // Only this file's artefacts: test files run in parallel and share .tmp-test.
  await rm(TMP, { recursive: true, force: true });
});

test('valid identifiers resolve to the documented locations', () => {
  assert.equal(
    baselineFileFor(ROOT, 'saas-dashboard', 'desktop'),
    path.join(ROOT, 'saas-dashboard', 'desktop.png'),
  );
  assert.equal(
    archiveFileFor(ROOT, 'saas-dashboard', 'desktop', 1234),
    path.join(ROOT, 'saas-dashboard', 'archive', 'desktop-1234.png'),
  );
});

test('a relative root keeps producing a relative path', () => {
  // Existing callers and tests compare against path.join(root, …); the guard
  // must not silently absolutise their results.
  const relativeRoot = path.join('project', 'baselines');
  assert.equal(
    baselineFileFor(relativeRoot, 'page', 'mobile'),
    path.join(relativeRoot, 'page', 'mobile.png'),
  );
});

test('a hostile viewport name is refused', () => {
  for (const name of HOSTILE_NAMES) {
    assert.throws(
      () => baselineFileFor(ROOT, 'saas-dashboard', name),
      ConfigError,
      `viewport name ${JSON.stringify(name)} must not resolve`,
    );
  }
});

test('a hostile page id is refused', () => {
  for (const name of HOSTILE_NAMES) {
    assert.throws(
      () => baselineFileFor(ROOT, name, 'desktop'),
      ConfigError,
      `page id ${JSON.stringify(name)} must not resolve`,
    );
  }
});

test('a hostile archive path is refused too', () => {
  for (const name of HOSTILE_NAMES) {
    assert.throws(() => archiveFileFor(ROOT, 'page', name, 1), ConfigError);
    assert.throws(() => archiveFileFor(ROOT, name, 'desktop', 1), ConfigError);
  }
});

test('a sibling directory sharing a name prefix is not treated as a child', () => {
  const root = path.join(TMP, 'baselines');
  const sibling = path.join(TMP, 'baselines-archive', 'x.png');
  // This is exactly the trap a naive `startsWith(root)` guard falls into.
  assert.equal(sibling.startsWith(root), true);
  assert.throws(() => resolveInside(root, '..', 'baselines-archive', 'x.png'), ConfigError);
});

test('nothing is created for a refused path', async () => {
  for (const name of HOSTILE_NAMES) {
    for (const attempt of [
      () => baselineFileFor(ROOT, 'page', name),
      () => baselineFileFor(ROOT, name, 'desktop'),
      () => archiveFileFor(ROOT, 'page', name, 1),
    ]) {
      try {
        attempt();
      } catch (error) {
        assert.ok(error instanceof ConfigError);
      }
    }
  }

  assert.deepEqual(await readdir(ROOT), [], 'the baseline root must stay empty');

  for (const escape of [
    path.join(TMP, 'escape.png'),
    path.join(TMP, 'escaped.png'),
    path.join(PROJECT, 'tests', 'escape.png'),
    path.join(PROJECT, 'escaped.png'),
    path.resolve('C:/outside.png'),
  ]) {
    assert.equal(await exists(escape), false, `no file may be created at ${escape}`);
  }
});
