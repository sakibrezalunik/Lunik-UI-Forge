/**
 * Phase 19 — approval transactions: locking, atomic writes, journal recovery.
 *
 * Every test here runs the real CLI as a child process against a throwaway
 * baseline root under `tests/.tmp-txn/`. Nothing touches the project's real
 * `baselines/`, which contains no manifest and no approved image.
 *
 * Failure injection uses one gated seam (`LUNIK_APPROVAL_FAULT`, see
 * tools/lib/faults.js) because the interesting failures happen between two
 * filesystem calls and cannot be reached from outside without it. A `:crash`
 * mode exits the process without unwinding, which is the only honest way to
 * test what a killed approval leaves behind.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { writeJsonAtomic } from '../../tools/lib/fs-utils.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-txn');
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

async function readManifest(root) {
  const text = await readFile(path.join(root, 'baselines', 'manifest.json'), 'utf8').catch(() => null);
  return text === null ? null : JSON.parse(text);
}

async function fixture(name, { pages = ['test-page'] } = {}) {
  const root = path.join(TMP, name);
  await rm(root, { recursive: true, force: true });
  const config = {
    viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    reportsDir: `tests/.tmp-txn/${name}/reports`,
    baselinesDir: `tests/.tmp-txn/${name}/baselines`,
    checks: { visual: { enabled: true, severity: 'error', maxDiffRatio: 0.001, pixelThreshold: 0.1 } },
    pages: pages.map((id) => ({ id, path: '/tests/fixtures/pass/index.html', expect: { selectors: ['h1'] } })),
  };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  for (const page of pages) {
    for (const run of [RUN_A, RUN_B]) {
      const dir = path.join(root, 'reports', run, 'screenshots', page);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'desktop.png'), png(1440, 900, run === RUN_A ? [10, 20, 30] : [200, 100, 50]));
      await writeFile(
        path.join(root, 'reports', run, 'report.json'),
        JSON.stringify({ environment: { browser: { version: '156.0.8078.4' } } }),
      );
    }
  }
  return root;
}

function args(root, page, extra) {
  return [
    'tools/approve-baseline.js',
    '--config',
    `tests/.tmp-txn/${path.basename(root)}/config.json`,
    '--page',
    page,
    '--viewport',
    'desktop',
    ...extra,
  ];
}

function run(root, page, extra, env = {}) {
  return spawnSync(process.execPath, args(root, page, extra), {
    cwd: PROJECT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

function runAsync(root, page, extra, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args(root, page, extra), {
      cwd: PROJECT,
      env: { ...process.env, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => resolve({ status: code, output }));
  });
}

async function dryHash(root, page = 'test-page', runId = RUN_A) {
  const result = run(root, page, ['--run', runId]);
  return /^SHA-256:\s+([0-9a-f]{64})$/m.exec(result.stdout)?.[1] ?? null;
}

async function approved(root, page = 'test-page') {
  const hash = await dryHash(root, page);
  return run(root, page, ['--run', RUN_A, '--approve-hash', hash, '--confirm']);
}

const baselinePath = (root, page = 'test-page') =>
  path.join(root, 'baselines', page, 'desktop.png');
const manifestPath = (root) => path.join(root, 'baselines', 'manifest.json');
const journalPath = (root) => path.join(root, 'baselines', '.approval-journal.json');
const lockPath = (root) => path.join(root, 'baselines', '.approval.lock');

async function leftovers(root) {
  const baselines = await list(path.join(root, 'baselines'));
  const page = await list(path.join(root, 'baselines', 'test-page'));
  return [...baselines, ...page].filter((name) => name.startsWith('.') || name.includes('.tmp'));
}

test('writeJsonAtomic replaces an existing file and leaves no temporary file', async () => {
  const dir = path.join(TMP, 'atomic');
  const file = path.join(dir, 'nested', 'state.json');
  await rm(dir, { recursive: true, force: true });
  await writeJsonAtomic(file, { generation: 1 });
  await writeJsonAtomic(file, { generation: 2 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { generation: 2 });
  assert.deepEqual(
    (await list(path.dirname(file))).filter((name) => name.includes('.tmp')),
    [],
    'a successful replacement must not leave its temporary file',
  );

  // Replacing a directory cannot work; the failure must not leave debris either.
  const broken = path.join(dir, 'broken.json');
  await mkdir(broken, { recursive: true });
  await assert.rejects(writeJsonAtomic(broken, { generation: 3 }));
  assert.deepEqual(
    (await list(path.dirname(broken))).filter((name) => name.includes('.tmp')),
    [],
    'a failed replacement must not leave its temporary file',
  );
  assert.ok((await stat(broken)).isDirectory(), 'the destination must be untouched');
});

test('the first approval commits and leaves no lock, journal or staged file', async () => {
  const root = await fixture('first');
  const result = await approved(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Approved: tests\/\.tmp-txn\/first\/baselines\/test-page\/desktop\.png/);

  const entry = (await readManifest(root)).entries['test-page/desktop'];
  assert.equal(entry.runId, RUN_A);
  assert.equal(entry.sha256, await sha(baselinePath(root)));
  assert.equal(entry.previous, null, 'a first approval replaces nothing');
  assert.deepEqual(entry.history, []);
  assert.equal(await exists(journalPath(root)), false, 'the journal must be gone');
  assert.equal(await exists(lockPath(root)), false, 'the lock must be released');
  assert.deepEqual(await leftovers(root), [], 'no staging debris may remain');

  // Second run of the same bytes is a no-op, not a rewrite.
  const again = await approved(root);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /byte-identical/);
});

test('six simultaneous approvals are all recorded, five rounds over', async () => {
  const pages = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  for (let round = 1; round <= 5; round += 1) {
    const root = await fixture(`concurrent-${round}`, { pages });
    const hashes = await Promise.all(pages.map((page) => dryHash(root, page)));

    const results = await Promise.all(
      pages.map((page, index) =>
        runAsync(root, page, ['--run', RUN_A, '--approve-hash', hashes[index], '--confirm']),
      ),
    );
    for (const result of results) {
      assert.equal(result.status, 0, `round ${round}: ${result.output}`);
    }

    const manifest = await readManifest(root);
    const recorded = Object.keys(manifest.entries).sort();
    assert.deepEqual(
      recorded,
      pages.map((page) => `${page}/desktop`).sort(),
      `round ${round}: every successful approval must survive`,
    );
    for (const page of pages) {
      assert.equal(
        manifest.entries[`${page}/desktop`].sha256,
        await sha(baselinePath(root, page)),
        `round ${round}: the record for ${page} must describe the image on disk`,
      );
    }
    assert.equal(await exists(lockPath(root)), false, `round ${round}: the lock must be released`);
    assert.equal(await exists(journalPath(root)), false, `round ${round}: the journal must be gone`);
  }
});

test('a live lock blocks the second approval, is preserved, and is released on request', async () => {
  const root = await fixture('lock-live');
  await mkdir(path.join(root, 'baselines'), { recursive: true });
  await writeFile(
    lockPath(root),
    JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), tool: 'test' }),
  );

  const hash = await dryHash(root);
  const blocked = run(root, 'test-page', ['--run', RUN_A, '--approve-hash', hash, '--confirm'], {
    LUNIK_APPROVAL_LOCK_TIMEOUT_MS: '300',
  });

  assert.equal(blocked.status, 3, blocked.stdout + blocked.stderr);
  assert.match(blocked.stderr, /holds the lock/);
  assert.match(blocked.stderr, new RegExp(`PID ${process.pid}`), 'the owner must be named');
  assert.match(blocked.stderr, /Nothing was written/);
  assert.equal(await exists(lockPath(root)), true, 'a live lock must never be deleted');
  assert.equal(await exists(baselinePath(root)), false, 'nothing may be written while blocked');
  assert.equal(await exists(journalPath(root)), false);

  await unlink(lockPath(root));
  const allowed = run(root, 'test-page', ['--run', RUN_A, '--approve-hash', hash, '--confirm']);
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('a lock left by a dead process is reclaimed', async () => {
  const root = await fixture('lock-dead');
  await mkdir(path.join(root, 'baselines'), { recursive: true });
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  await writeFile(
    lockPath(root),
    JSON.stringify({
      pid: exited.pid,
      host: os.hostname(),
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      tool: 'test',
    }),
  );

  const result = await approved(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /reclaimed a stale approval lock/);
  assert.equal(await exists(lockPath(root)), false);
});

test('a lock from another host is treated as live, never reclaimed', async () => {
  const root = await fixture('lock-foreign');
  await mkdir(path.join(root, 'baselines'), { recursive: true });
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  await writeFile(
    lockPath(root),
    JSON.stringify({ pid: exited.pid, host: 'another-machine', startedAt: new Date().toISOString(), tool: 'test' }),
  );

  const hash = await dryHash(root);
  const blocked = run(root, 'test-page', ['--run', RUN_A, '--approve-hash', hash, '--confirm'], {
    LUNIK_APPROVAL_LOCK_TIMEOUT_MS: '300',
  });
  assert.equal(blocked.status, 3);
  assert.equal(await exists(lockPath(root)), true, 'a foreign lock cannot be checked, so it is kept');
});

test('a failure before any replacement changes nothing and leaves no debris', async () => {
  for (const fault of ['staging', 'after-journal', 'after-archive']) {
    const root = await fixture(`fault-${fault}`);
    assert.equal((await approved(root)).status, 0, `${fault}: the setup approval must succeed`);

    const beforeBase = await sha(baselinePath(root));
    const beforeManifest = await readFile(manifestPath(root), 'utf8');
    const hashB = await dryHash(root, 'test-page', RUN_B);

    const result = run(root, 'test-page', ['--run', RUN_B, '--approve-hash', hashB, '--confirm'], {
      LUNIK_APPROVAL_FAULT: fault,
    });

    assert.equal(result.status, 3, `${fault}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /before any baseline or manifest replacement/);
    assert.match(result.stderr, new RegExp(fault), 'the failing stage must be named');

    assert.equal(await sha(baselinePath(root)), beforeBase, `${fault}: the baseline must be untouched`);
    assert.equal(await readFile(manifestPath(root), 'utf8'), beforeManifest, `${fault}: the manifest must be untouched`);
    assert.equal(await exists(journalPath(root)), false, `${fault}: no journal may remain`);
    assert.equal(await exists(lockPath(root)), false, `${fault}: the lock must be released`);
    assert.deepEqual(await leftovers(root), [], `${fault}: no staged file may remain`);
  }
});

test('a failure after the baseline is replaced rolls back and verifies the restore', async () => {
  for (const fault of ['after-baseline-replace', 'before-manifest-write']) {
    const root = await fixture(`rollback-${fault}`);
    assert.equal((await approved(root)).status, 0);

    const beforeBase = await sha(baselinePath(root));
    const beforeManifest = await readFile(manifestPath(root), 'utf8');
    const hashB = await dryHash(root, 'test-page', RUN_B);

    const result = run(root, 'test-page', ['--run', RUN_B, '--approve-hash', hashB, '--confirm'], {
      LUNIK_APPROVAL_FAULT: fault,
    });

    assert.equal(result.status, 3, `${fault}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /rolled back successfully/, `${fault}: the outcome must be stated`);
    assert.match(result.stderr, /restored/, `${fault}: the restored state must be described`);

    assert.equal(await sha(baselinePath(root)), beforeBase, `${fault}: the old image must be back`);
    assert.equal(await readFile(manifestPath(root), 'utf8'), beforeManifest, `${fault}: the old manifest must be back`);
    assert.equal(await exists(journalPath(root)), false, `${fault}: the journal must be removed after rollback`);
    assert.equal(await exists(lockPath(root)), false, `${fault}: the lock must be released`);
    assert.deepEqual(await leftovers(root), [], `${fault}: no staged file may remain`);

    // The archive created during the failed attempt must not be recorded falsely:
    // the manifest is the pre-approval text, so the entry names the old image.
    const entry = (await readManifest(root)).entries['test-page/desktop'];
    assert.equal(entry.sha256, beforeBase, `${fault}: the record still describes the restored image`);
  }
});

test('a rollback that cannot complete keeps the journal and reports the exact state', async () => {
  const root = await fixture('rollback-fails');
  assert.equal((await approved(root)).status, 0);
  const beforeBase = await sha(baselinePath(root));
  const beforeManifest = await readFile(manifestPath(root), 'utf8');

  // A read-only manifest makes the manifest write fail; the injected rollback
  // fault then makes recovery of it fail too, which is the worst case.
  await chmod(manifestPath(root), 0o444);
  const hashB = await dryHash(root, 'test-page', RUN_B);
  const failed = run(root, 'test-page', ['--run', RUN_B, '--approve-hash', hashB, '--confirm'], {
    LUNIK_APPROVAL_FAULT: 'during-rollback',
  });
  await chmod(manifestPath(root), 0o666);

  assert.equal(failed.status, 3, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /Manual recovery is required/);
  assert.match(failed.stderr, /Expected baseline SHA-256/);
  assert.match(failed.stderr, /Observed baseline SHA-256/);
  assert.match(failed.stderr, /Journal: .*deliberately kept/, 'the journal must be kept for recovery');
  assert.equal(await exists(journalPath(root)), true);
  assert.equal(await exists(lockPath(root)), false, 'the lock is released even when rollback fails');
  assert.notEqual(await sha(baselinePath(root)), beforeBase, 'the failed attempt is still on disk');
  assert.equal(await readFile(manifestPath(root), 'utf8'), beforeManifest, 'the manifest is untouched');

  // The next approval recovers first, then proceeds from a known state.
  const next = await approved(root);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.match(next.stderr, /Recovered: rolled back an interrupted approval/);
  assert.equal(await exists(journalPath(root)), false);
  assert.equal(await sha(baselinePath(root)), beforeBase, 'recovery restored the previous image');
  assert.equal((await readManifest(root)).entries['test-page/desktop'].sha256, beforeBase);
});

test('a crashed approval is rolled back by the next one, before it reads any state', async () => {
  const root = await fixture('crash');
  assert.equal((await approved(root)).status, 0);
  const beforeBase = await sha(baselinePath(root));
  const hashB = await dryHash(root, 'test-page', RUN_B);

  const crashed = run(root, 'test-page', ['--run', RUN_B, '--approve-hash', hashB, '--confirm'], {
    LUNIK_APPROVAL_FAULT: 'after-baseline-replace:crash',
  });
  assert.equal(crashed.status, 70, 'the crash must be simulated, not caught');
  assert.equal(await exists(journalPath(root)), true, 'a crash leaves the journal behind');

  const next = await approved(root);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.match(next.stderr, /Recovered: rolled back an interrupted approval/);
  assert.equal(await exists(journalPath(root)), false);
  assert.equal(await exists(lockPath(root)), false);
  assert.equal(await sha(baselinePath(root)), beforeBase);
  assert.equal((await readManifest(root)).entries['test-page/desktop'].sha256, beforeBase);
});

test('a crash after the commit keeps the approval and only clears the journal', async () => {
  const root = await fixture('crash-committed');
  const hashA = await dryHash(root);
  const crashed = run(root, 'test-page', ['--run', RUN_A, '--approve-hash', hashA, '--confirm'], {
    LUNIK_APPROVAL_FAULT: 'before-journal-cleanup:crash',
  });
  assert.equal(crashed.status, 70);
  assert.equal(await exists(journalPath(root)), true);
  assert.equal(
    (await readManifest(root)).entries['test-page/desktop'].sha256,
    hashA,
    'the approval itself completed before the crash',
  );

  const next = await approved(root);
  assert.match(next.stderr, /had already committed/);
  assert.equal(await exists(journalPath(root)), false);
  assert.equal((await readManifest(root)).entries['test-page/desktop'].sha256, hashA);
});

test('an unreadable journal refuses to start rather than guessing', async () => {
  const root = await fixture('journal-garbage');
  await mkdir(path.join(root, 'baselines'), { recursive: true });
  await writeFile(journalPath(root), '{ this is not json');
  const hash = await dryHash(root);

  const result = run(root, 'test-page', ['--run', RUN_A, '--approve-hash', hash, '--confirm']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot be read/);
  assert.match(result.stderr, /Refusing to start a new approval/);
  assert.equal(await exists(journalPath(root)), true, 'the unreadable journal must be preserved');
  assert.equal(await exists(baselinePath(root)), false, 'nothing may be approved');
});

test('a version 1 manifest is read, upgraded, and its record kept in history', async () => {
  const root = await fixture('v1');
  await mkdir(path.dirname(baselinePath(root)), { recursive: true });
  await writeFile(baselinePath(root), png(1440, 900, [5, 5, 5]));
  const oldHash = await sha(baselinePath(root));
  await writeFile(
    manifestPath(root),
    `${JSON.stringify(
      {
        version: 1,
        entries: {
          'test-page/desktop': {
            pageId: 'test-page',
            viewport: 'desktop',
            file: 'test-page/desktop.png',
            sha256: oldHash,
            width: 1440,
            height: 900,
            approvedAt: '2026-11-01T00:00:00.000Z',
            approvedBy: 'legacy',
            browserVersion: '155.0.0.0',
            note: 'v1 note',
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const result = await approved(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const manifest = await readManifest(root);
  assert.equal(manifest.version, 2);
  const entry = manifest.entries['test-page/desktop'];
  assert.equal(entry.runId, RUN_A);
  assert.equal(entry.history.length, 1, 'the replaced v1 record must be kept');
  assert.equal(entry.history[0].sha256, oldHash);
  assert.equal(entry.history[0].note, 'v1 note');
  assert.equal(entry.history[0].approvedBy, 'legacy');
  assert.equal(entry.previous.archiveSha256, oldHash, 'the archived image must be fingerprinted');
  assert.equal(await sha(path.join(root, 'baselines', entry.previous.archive)), oldHash);
});

test('a baseline edited outside the workflow is warned about, then replaced on request', async () => {
  // F-18-09: reproduced, not changed. The warning is advisory by design; this
  // test pins the current contract so a future change to it is deliberate.
  const root = await fixture('tampered');
  assert.equal((await approved(root)).status, 0);
  await writeFile(baselinePath(root), png(1440, 900, [99, 99, 99]));

  const dry = run(root, 'test-page', ['--run', RUN_A]);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /WARNING: the file on disk does not match the hash recorded at approval time/);
  assert.match(dry.stdout, /changed outside this workflow/);

  const hash = /^SHA-256:\s+([0-9a-f]{64})$/m.exec(dry.stdout)[1];
  const confirmed = run(root, 'test-page', ['--run', RUN_A, '--approve-hash', hash, '--confirm']);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal((await readManifest(root)).entries['test-page/desktop'].sha256, hash);
});

test('a refused approval never creates a lock, a journal or a baseline', async () => {
  const root = await fixture('refused');
  const result = run(root, 'test-page', ['--run', RUN_A, '--approve-hash', '0'.repeat(64), '--confirm']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not match the candidate/);
  assert.deepEqual(await list(path.join(root, 'baselines')), [], 'the baseline root must stay empty');
});
