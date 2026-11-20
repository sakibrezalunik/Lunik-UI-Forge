/**
 * A serialized, recoverable approval transaction.
 *
 * Approving one baseline touches two independent files — the image at
 * `baselines/<page>/<viewport>.png` and the record at `baselines/manifest.json`.
 * No filesystem makes two such replacements atomic together, and pretending
 * otherwise is how a tool loses the very evidence it exists to keep. So the
 * operation is a *transaction* with a journal:
 *
 *   1. stage the candidate and hash the staged bytes (the bytes that will land)
 *   2. prepare and validate the next manifest (nothing written yet)
 *   3. write a journal describing the intended and previous state
 *   4. archive the image being replaced, verifying its hash
 *   5. rename the staged image over the baseline (atomic, same directory)
 *   6. rewrite the manifest (atomic, same directory)
 *   7. read both back and verify
 *   8. mark the journal committed, then delete it
 *
 * A failure before step 5 changes nothing and cleans up. A failure after step 5
 * rolls back from the journal and verifies the restored bytes. A crash between
 * any two steps leaves the journal behind, and the next approval recovers or
 * refuses instead of building on an unknown state.
 *
 * The journal lives *inside* the baseline root it protects, so it moves with the
 * state it describes and cannot be separated from it.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, open, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentError } from './errors.js';
import {
  ensureDir,
  pathExists,
  readJsonIfExists,
  sha256File,
  toPosix,
  writeJsonAtomic,
} from './fs-utils.js';
import {
  applyApproval,
  baselineFileFor,
  getEntry,
  isValidSha256,
  manifestFileFor,
  readManifest,
  validateManifest,
} from './baseline.js';
import { faultPoint } from './faults.js';
import { isRunId } from './report.js';

export const JOURNAL_FILENAME = '.approval-journal.json';
export const JOURNAL_VERSION = 1;

export function journalFileFor(baselinesRoot) {
  return path.join(baselinesRoot, JOURNAL_FILENAME);
}

/** A staged candidate must sit beside the baseline so the replacement is a rename. */
function stagedFileFor(baselinesRoot, pageId, viewportName) {
  return path.join(
    baselinesRoot,
    pageId,
    `.staged-${viewportName}-${process.pid}-${randomBytes(5).toString('hex')}.png`,
  );
}

async function safeUnlink(target) {
  if (!target) return;
  try {
    await unlink(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function hashOrNull(target) {
  try {
    return await sha256File(target);
  } catch {
    return null;
  }
}

/** Stages a journal can legitimately be in, in the order they are written. */
const JOURNAL_STAGES = new Set(['prepared', 'baseline-replaced', 'committed']);

/** Mirrors the identifier guard in baseline.js. */
const PLAIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainName(value) {
  return typeof value === 'string' && PLAIN_NAME_PATTERN.test(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function journalError(journalPath, problems) {
  return new EnvironmentError(
    `The approval journal at ${toPosix(journalPath)} is invalid or incomplete (${problems.length} problem(s)).`,
    [
      ...problems.slice(0, 12),
      'Refusing to guess or repair journal values: recovery could otherwise touch a file the transaction never owned.',
      'The journal has been preserved for manual inspection. Nothing was modified.',
    ],
  );
}

/**
 * Validate the complete journal structure before recovery reads a nested field.
 *
 * The previous gate only checked `version`, `baseline` and `manifest`, so a
 * journal like `{version: 1, baseline: {...}, manifest: {...}}` passed and then
 * threw a raw `TypeError` on `journal.candidate.sha256`. This validator models
 * the journal the transaction code above actually writes, including the values
 * that legitimately differ by stage:
 *
 *   - `prepared`: the archive hash is not known yet and may be null.
 *   - `baseline-replaced` / `committed`: the archive hash must be recorded
 *     whenever a previous baseline existed.
 *
 * Unknown or missing fields fail closed. A null where a value is required,
 * a wrong primitive type, an invalid hash or an inconsistent combination all
 * raise one classified `EnvironmentError`, and the journal is left untouched.
 */
export function validateJournal(journal, journalPath = JOURNAL_FILENAME) {
  const problems = [];
  const add = (message) => problems.push(message);

  if (!isPlainObject(journal)) {
    add('The journal is not a JSON object.');
    throw journalError(journalPath, problems);
  }

  if (journal.version !== JOURNAL_VERSION) {
    add(`version must be the number ${JOURNAL_VERSION}, got ${JSON.stringify(journal.version)}.`);
  }
  if (!JOURNAL_STAGES.has(journal.stage)) {
    add(`stage must be one of ${[...JOURNAL_STAGES].join(', ')}, got ${JSON.stringify(journal.stage)}.`);
  }

  for (const field of ['tool', 'startedAt', 'host', 'pageId', 'viewport']) {
    if (typeof journal[field] !== 'string' || journal[field] === '') {
      add(`${field} must be a non-empty string.`);
    }
  }
  if (!isRunId(journal.runId)) {
    add('runId must be a verification run id.');
  }
  if (!Number.isInteger(journal.pid) || journal.pid <= 0) {
    add('pid must be a positive integer.');
  }

  if (!isPlainName(journal.pageId)) {
    add(`pageId ${JSON.stringify(journal.pageId)} is not a plain identifier.`);
  }
  if (!isPlainName(journal.viewport)) {
    add(`viewport ${JSON.stringify(journal.viewport)} is not a plain identifier.`);
  }

  if (!isPlainObject(journal.candidate)) {
    add('candidate must be an object.');
  } else {
    if (!isValidSha256(journal.candidate.sha256)) add('candidate.sha256 must be a SHA-256 digest.');
    if (!isPositiveInteger(journal.candidate.width)) add('candidate.width must be a positive integer.');
    if (!isPositiveInteger(journal.candidate.height)) add('candidate.height must be a positive integer.');
  }

  if (!isPlainObject(journal.staged)) {
    add('staged must be an object.');
  } else {
    if (typeof journal.staged.path !== 'string' || journal.staged.path === '') {
      add('staged.path must be a non-empty string.');
    }
    if (!isValidSha256(journal.staged.sha256)) add('staged.sha256 must be a SHA-256 digest.');
  }
  if (
    isPlainObject(journal.candidate) &&
    isPlainObject(journal.staged) &&
    isValidSha256(journal.candidate.sha256) &&
    isValidSha256(journal.staged.sha256) &&
    journal.candidate.sha256 !== journal.staged.sha256
  ) {
    add('candidate.sha256 and staged.sha256 must describe the same bytes.');
  }

  if (!isPlainObject(journal.baseline)) {
    add('baseline must be an object.');
  } else {
    if (typeof journal.baseline.path !== 'string' || journal.baseline.path === '') {
      add('baseline.path must be a non-empty string.');
    }
    if (typeof journal.baseline.existed !== 'boolean') {
      add('baseline.existed must be a boolean.');
    }
    if (journal.baseline.existed === true) {
      if (!isValidSha256(journal.baseline.sha256)) {
        add('baseline.sha256 must be the SHA-256 of the baseline being restored.');
      }
    } else if (journal.baseline.existed === false && journal.baseline.sha256 !== null) {
      add('baseline.sha256 must be null when baseline.existed is false.');
    }
  }

  if (!isPlainObject(journal.manifest)) {
    add('manifest must be an object.');
  } else {
    if (typeof journal.manifest.path !== 'string' || journal.manifest.path === '') {
      add('manifest.path must be a non-empty string.');
    }
    if (typeof journal.manifest.existed !== 'boolean') {
      add('manifest.existed must be a boolean.');
    }
    if (journal.manifest.existed === true) {
      if (typeof journal.manifest.beforeText !== 'string') {
        add('manifest.beforeText must be the exact previous manifest text.');
      }
    } else if (journal.manifest.existed === false && journal.manifest.beforeText !== null) {
      add('manifest.beforeText must be null when manifest.existed is false.');
    }
  }

  // Stage-dependent archive metadata: an early journal may not have hashed the
  // archive yet, but a journal that has replaced the baseline must name it.
  if (isPlainObject(journal.baseline) && journal.baseline.existed === true) {
    if (!isPlainObject(journal.archive)) {
      add('archive must be an object when a previous baseline existed.');
    } else {
      if (typeof journal.archive.path !== 'string' || journal.archive.path === '') {
        add('archive.path must be a non-empty string.');
      }
      if (journal.archive.sha256 !== null && !isValidSha256(journal.archive.sha256)) {
        add('archive.sha256 must be null or a SHA-256 digest.');
      }
      if (
        (journal.stage === 'baseline-replaced' || journal.stage === 'committed') &&
        !isValidSha256(journal.archive.sha256)
      ) {
        add(`archive.sha256 must be recorded once the journal reaches stage "${journal.stage}".`);
      }
      if (
        isValidSha256(journal.archive.sha256) &&
        isValidSha256(journal.baseline.sha256) &&
        journal.archive.sha256 !== journal.baseline.sha256
      ) {
        add('archive.sha256 and baseline.sha256 must describe the same previous image.');
      }
    }
  } else if (isPlainObject(journal.baseline) && journal.baseline.existed === false && journal.archive !== null) {
    add('archive must be null when no previous baseline existed.');
  }

  if (problems.length > 0) throw journalError(journalPath, problems);
  return journal;
}

/** Case-insensitive on Windows, exact elsewhere, after resolving to absolute. */
function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function realpathOrNull(target) {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

function isInsideReal(rootReal, candidateReal) {
  const relative = path.relative(rootReal, candidateReal);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Derive every path recovery may touch and require the journal to agree.
 *
 * A journal parsing and carrying the right version is not evidence that its
 * paths belong to this transaction. Everything is re-derived from the trusted
 * baseline root plus the journal's validated page id and viewport, then compared
 * by exact resolved equality — never by string prefix, which would accept a
 * sibling such as `baselines-archive/`. Archive and staging paths are additionally
 * constrained to the transaction's own `<page>/archive/` and `<page>/`
 * directories and to the names the transaction writes.
 *
 * @returns {Promise<{baselinePath: string, manifestPath: string, archivePath: string|null, stagedPath: string}>}
 * @throws {EnvironmentError} when any path or identity field disagrees
 */
export async function resolveJournalPaths(journal, baselinesRoot) {
  const problems = [];
  const root = path.resolve(baselinesRoot);

  if (!isPlainName(journal.pageId) || !isPlainName(journal.viewport)) {
    problems.push('pageId and viewport must be plain identifiers before any path can be derived.');
    throw journalError(journalFileFor(root), problems);
  }

  const expectedBaseline = path.resolve(baselineFileFor(root, journal.pageId, journal.viewport));
  const expectedManifest = path.resolve(manifestFileFor(root));

  if (!samePath(journal.baseline.path, expectedBaseline)) {
    problems.push(
      `baseline.path must be exactly ${toPosix(expectedBaseline)} for page ` +
        `"${journal.pageId}" at viewport "${journal.viewport}"; got ${toPosix(journal.baseline.path)}.`,
    );
  }
  if (!samePath(journal.manifest.path, expectedManifest)) {
    problems.push(
      `manifest.path must be exactly ${toPosix(expectedManifest)}; got ${toPosix(journal.manifest.path)}.`,
    );
  }

  const pageDir = path.resolve(root, journal.pageId);
  let archivePath = null;
  if (journal.archive) {
    const resolved = path.resolve(journal.archive.path);
    const archiveDir = path.join(pageDir, 'archive');
    if (!samePath(path.dirname(resolved), archiveDir)) {
      problems.push(
        `archive.path must be inside ${toPosix(archiveDir)}; got ${toPosix(journal.archive.path)}.`,
      );
    } else if (!new RegExp(`^${escapePattern(journal.viewport)}-[0-9]+\\.png$`).test(path.basename(resolved))) {
      problems.push(
        `archive.path must be named "${journal.viewport}-<timestamp>.png"; ` +
          `got ${JSON.stringify(path.basename(resolved))}.`,
      );
    } else {
      archivePath = resolved;
    }
  }

  const stagedPath = path.resolve(journal.staged.path);
  if (!samePath(path.dirname(stagedPath), pageDir)) {
    problems.push(`staged.path must be inside ${toPosix(pageDir)}; got ${toPosix(journal.staged.path)}.`);
  } else if (
    !new RegExp(`^\\.staged-${escapePattern(journal.viewport)}-[0-9]+-[0-9a-f]+\\.png$`).test(
      path.basename(stagedPath),
    )
  ) {
    problems.push(
      `staged.path must be named ".staged-${journal.viewport}-<pid>-<hex>.png"; ` +
        `got ${JSON.stringify(path.basename(stagedPath))}.`,
    );
  }

  if (problems.length > 0) throw journalError(journalFileFor(root), problems);

  // A textually correct path can still be redirected by a junction or symlink.
  // Compare real paths for the directories and files that already exist.
  const rootReal = await realpathOrNull(root);
  const pageReal = await realpathOrNull(pageDir);
  if (rootReal && pageReal && !isInsideReal(rootReal, pageReal)) {
    problems.push(`${toPosix(pageDir)} resolves to ${toPosix(pageReal)}, outside ${toPosix(root)}.`);
  }
  if (archivePath) {
    const archiveDirReal = await realpathOrNull(path.dirname(archivePath));
    const archiveReal = await realpathOrNull(archivePath);
    if (pageReal && archiveDirReal && !samePath(archiveDirReal, path.join(pageReal, 'archive'))) {
      problems.push(`${toPosix(path.dirname(archivePath))} resolves outside the transaction archive directory.`);
    }
    if (archiveReal && archiveDirReal && !samePath(archiveReal, path.join(archiveDirReal, path.basename(archivePath)))) {
      problems.push(`${toPosix(archivePath)} resolves outside its transaction archive directory.`);
    }
  }
  if (pageReal) {
    const baselineReal = await realpathOrNull(expectedBaseline);
    if (baselineReal && !samePath(baselineReal, path.join(pageReal, path.basename(expectedBaseline)))) {
      problems.push(`${toPosix(expectedBaseline)} resolves outside ${toPosix(pageDir)}.`);
    }
    const stagedReal = await realpathOrNull(stagedPath);
    if (stagedReal && !samePath(stagedReal, path.join(pageReal, path.basename(stagedPath)))) {
      problems.push(`${toPosix(stagedPath)} resolves outside ${toPosix(pageDir)}.`);
    }
  }

  if (problems.length > 0) throw journalError(journalFileFor(root), problems);

  return { baselinePath: expectedBaseline, manifestPath: expectedManifest, archivePath, stagedPath };
}

/**
 * Copy `source` to a unique temporary file beside `destination`, hash the
 * temporary bytes, and rename it over the destination only after they match.
 *
 * This is the repair for the Phase 20 finding: the old order copied the archive
 * straight over the baseline and only then discovered a hash mismatch, so a
 * corrupt archive had already destroyed the destination. A failure here removes
 * only the temporary file and leaves the destination byte-for-byte intact.
 */
async function restoreBytesVerified({ sourcePath, destinationPath, expectedHash, ops }) {
  const dir = path.dirname(destinationPath);
  const temp = path.join(
    dir,
    `.restore-${path.basename(destinationPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const copy = ops.copyFile ?? copyFile;
  const move = ops.rename ?? rename;

  let tempExists = false;
  try {
    await ensureDir(dir);
    await copy(sourcePath, temp);
    tempExists = true;

    const observed = await hashOrNull(temp);
    if (observed !== expectedHash) {
      throw new EnvironmentError(
        'The archived bytes do not match the hash recorded when they were archived, so restoring them would corrupt the baseline.',
        [
          `Archive: ${toPosix(sourcePath)}`,
          `expected ${expectedHash}`,
          `observed ${observed ?? '(unreadable)'}`,
          `Baseline: ${toPosix(destinationPath)} (left unchanged)`,
          'The current baseline was not modified. The journal is preserved.',
        ],
      );
    }

    await move(temp, destinationPath);
    tempExists = false;
  } catch (error) {
    if (tempExists) {
      try {
        await safeUnlink(temp);
      } catch {
        // Best effort: the destination is still untouched either way.
      }
    }
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError(
      'Restoring the previous baseline failed before the destination was replaced, so the current baseline is unchanged.',
      [
        `Archive: ${toPosix(sourcePath)}`,
        `Baseline: ${toPosix(destinationPath)}`,
        `Temporary file: ${toPosix(temp)} (removed when it existed)`,
        `Cause: ${error?.message ?? String(error)}`,
      ],
    );
  }

  return hashOrNull(destinationPath);
}

/** Stage the exact previous manifest text, verify it, then replace atomically. */
async function restoreTextVerified({ destinationPath, text, ops }) {
  const dir = path.dirname(destinationPath);
  const temp = path.join(
    dir,
    `.${path.basename(destinationPath)}.${process.pid}.${randomBytes(6).toString('hex')}.restore.tmp`,
  );
  const move = ops.rename ?? rename;
  const openFile = ops.open ?? open;
  const read = ops.readFile ?? readFile;

  let handle = null;
  let tempExists = false;
  let replaced = false;
  try {
    await ensureDir(dir);
    handle = await openFile(temp, 'wx');
    tempExists = true;
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    const staged = await read(temp, 'utf8');
    if (staged !== text) {
      throw new EnvironmentError('The staged manifest text did not read back as the text recorded in the journal.', [
        `Manifest: ${toPosix(destinationPath)} (left unchanged)`,
      ]);
    }

    await move(temp, destinationPath);
    tempExists = false;
    replaced = true;
    return (await read(destinationPath, 'utf8')) === text;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The write already failed; a close failure changes nothing.
      }
    }
    if (tempExists) {
      try {
        await safeUnlink(temp);
      } catch {
        // Best effort: the destination is still the previous manifest.
      }
    }
    if (error instanceof EnvironmentError) throw error;
    if (replaced) {
      throw new EnvironmentError(
        'The previous manifest was renamed into place but could not be read back for verification.',
        [
          `Manifest: ${toPosix(destinationPath)} (replaced; verification incomplete)`,
          'The journal is preserved so the state can be checked by hand.',
          `Cause: ${error?.message ?? String(error)}`,
        ],
      );
    }
    throw new EnvironmentError(
      'Restoring the previous manifest failed before the destination was replaced, so the current manifest is unchanged.',
      [`Manifest: ${toPosix(destinationPath)}`, `Cause: ${error?.message ?? String(error)}`],
    );
  }
}

/**
 * Put the pre-approval state back, from validated journal paths, and verify it.
 *
 * Used both by a failed commit and by startup recovery, which is why it takes
 * the paths derived by {@link resolveJournalPaths}: the same code path proves the
 * same invariants, and no operation below ever consumes a raw journal path.
 *
 * @param {object} journal a journal that passed {@link validateJournal}
 * @param {{baselinePath: string, manifestPath: string, archivePath: string|null, stagedPath: string}} paths
 * @param {{copyFile?: Function, rename?: Function, open?: Function, readFile?: Function}} [ops]
 *   Test-only injection for deterministic filesystem failures; production always
 *   uses the real fs functions.
 */
export async function restoreFromJournal(journal, paths, ops = {}) {
  faultPoint('during-rollback');

  const problems = [];

  if (journal.baseline.existed) {
    if (!paths.archivePath) {
      throw new EnvironmentError(
        'Cannot restore the previous baseline: the journal records one but no archive of it.',
        [
          `Baseline: ${toPosix(paths.baselinePath)}`,
          `Manifest: ${toPosix(paths.manifestPath)}`,
          'The current baseline was not modified.',
        ],
      );
    }
    if (!(await pathExists(paths.archivePath))) {
      throw new EnvironmentError('Cannot restore the previous baseline: its archive is missing.', [
        `Archive: ${toPosix(paths.archivePath)}`,
        `Baseline: ${toPosix(paths.baselinePath)} (left unchanged)`,
        'The journal has been preserved for inspection.',
      ]);
    }

    const restored = await restoreBytesVerified({
      sourcePath: paths.archivePath,
      destinationPath: paths.baselinePath,
      expectedHash: journal.baseline.sha256,
      ops,
    });
    if (restored !== journal.baseline.sha256) {
      problems.push(
        `baseline: expected ${journal.baseline.sha256}, restored ${restored ?? '(missing)'} ` +
          `from ${toPosix(paths.archivePath)}`,
      );
    }
  } else {
    await safeUnlink(paths.baselinePath);
    if (await pathExists(paths.baselinePath)) {
      problems.push(`baseline: ${toPosix(paths.baselinePath)} should not exist but does`);
    }
  }

  if (journal.manifest.existed) {
    const restored = await restoreTextVerified({
      destinationPath: paths.manifestPath,
      text: journal.manifest.beforeText,
      ops,
    });
    if (!restored) {
      problems.push(`manifest: ${toPosix(paths.manifestPath)} was not restored to its previous text`);
    }
  } else {
    await safeUnlink(paths.manifestPath);
    if (await pathExists(paths.manifestPath)) {
      problems.push(`manifest: ${toPosix(paths.manifestPath)} should not exist but does`);
    }
  }

  if (problems.length > 0) {
    throw new EnvironmentError('Rollback did not restore the previous approval state.', problems);
  }
}

function classify(error, phase, details) {
  const lines = [`Phase: ${phase}`, ...details];
  if (error?.name === 'ConfigError') {
    error.details = [...(error.details ?? []), ...lines];
    return error;
  }
  return new EnvironmentError(error?.message ?? String(error), [...lines, ...(error?.details ?? [])]);
}

/**
 * Commit one approval. The caller must hold the approval lock.
 *
 * @returns {Promise<object>} the manifest entry that was recorded
 */
export async function commitApproval({
  baselinesRoot,
  pageId,
  viewportName,
  runId,
  sourcePath,
  candidate,
  previous = null,
  archivePath = null,
  approval = {},
}) {
  const baselinePath = baselineFileFor(baselinesRoot, pageId, viewportName);
  const manifestPath = manifestFileFor(baselinesRoot);
  const journalPath = journalFileFor(baselinesRoot);
  const stagedPath = stagedFileFor(baselinesRoot, pageId, viewportName);
  const startedAt = new Date().toISOString();

  let journal = null;
  let baselineReplaced = false;
  let archiveCreated = null;

  try {
    // Everything below is read fresh: the caller holds the lock, so this is the
    // current state rather than a snapshot taken before it was acquired.
    const manifestExisted = await pathExists(manifestPath);
    const beforeText = manifestExisted ? await readFile(manifestPath, 'utf8') : null;
    const manifestBefore = await readManifest(baselinesRoot);

    await ensureDir(path.dirname(stagedPath));
    faultPoint('staging');
    await copyFile(sourcePath, stagedPath);
    const stagedHash = await sha256File(stagedPath);
    if (stagedHash !== candidate.sha256) {
      throw new EnvironmentError(
        'The candidate changed while it was being staged, so the approved hash no longer describes these bytes.',
        [
          `expected ${candidate.sha256}`,
          `staged   ${stagedHash}`,
          'Nothing was replaced. Re-run the dry run and approve the hash it prints for the current run.',
        ],
      );
    }

    const archiveRelative =
      previous && archivePath ? toPosix(path.relative(baselinesRoot, archivePath)) : null;
    const prepared = applyApproval(manifestBefore, {
      pageId,
      viewportName,
      runId,
      sha256: stagedHash,
      width: candidate.width,
      height: candidate.height,
      candidatePath: approval.candidatePath ?? null,
      configPath: approval.configPath ?? null,
      pixelThreshold: approval.pixelThreshold ?? null,
      previous: previous
        ? { ...previous, archive: archiveRelative, archiveSha256: null, replacedAt: null }
        : null,
      browserVersion: approval.browserVersion ?? null,
      approvedBy: approval.approvedBy ?? null,
      note: approval.note ?? null,
      approvedAt: startedAt,
    });
    // The next manifest must satisfy the schema before anything on disk changes.
    validateManifest(prepared.manifest, manifestPath);

    journal = {
      version: JOURNAL_VERSION,
      tool: 'approve-baseline',
      startedAt,
      pid: process.pid,
      host: os.hostname(),
      pageId,
      viewport: viewportName,
      runId,
      candidate: { sha256: stagedHash, width: candidate.width, height: candidate.height },
      staged: { path: stagedPath, sha256: stagedHash },
      baseline: { path: baselinePath, existed: await pathExists(baselinePath), sha256: previous?.sha256 ?? null },
      archive: archivePath ? { path: archivePath, sha256: null } : null,
      manifest: { path: manifestPath, existed: manifestExisted, beforeText },
      stage: 'prepared',
    };
    await writeJsonAtomic(journalPath, journal);
    faultPoint('after-journal');

    if (previous && archivePath) {
      await ensureDir(path.dirname(archivePath));
      faultPoint('archive');
      await copyFile(baselinePath, archivePath);
      const archiveHash = await sha256File(archivePath);
      if (archiveHash !== previous.sha256) {
        throw new EnvironmentError(
          'The archived copy does not match the baseline it replaced, so the trail cannot be trusted.',
          [
            `Archive: ${toPosix(archivePath)}`,
            `expected ${previous.sha256}, archive is ${archiveHash}`,
            'Nothing was replaced. Investigate the filesystem before retrying.',
          ],
        );
      }
      archiveCreated = archivePath;
      journal.archive.sha256 = archiveHash;
      journal.baseline.sha256 = previous.sha256;
      // The record must name the archive and the moment of replacement, and the
      // archive hash is only knowable after the copy above.
      if (prepared.entry.previous) {
        prepared.entry.previous.archiveSha256 = archiveHash;
        prepared.entry.previous.replacedAt = new Date().toISOString();
      }
      await writeJsonAtomic(journalPath, journal);
    }
    faultPoint('after-archive');

    await rename(stagedPath, baselinePath);
    baselineReplaced = true;
    journal.stage = 'baseline-replaced';
    await writeJsonAtomic(journalPath, journal);

    const writtenHash = await sha256File(baselinePath);
    if (writtenHash !== stagedHash) {
      throw new EnvironmentError('The baseline replacement did not produce the staged bytes.', [
        `expected ${stagedHash}`,
        `observed ${writtenHash}`,
      ]);
    }
    faultPoint('after-baseline-replace');

    faultPoint('before-manifest-write');
    await writeJsonAtomic(manifestPath, prepared.manifest);

    const recorded = getEntry(await readManifest(baselinesRoot), pageId, viewportName);
    if (!recorded || recorded.sha256 !== stagedHash) {
      throw new EnvironmentError('The manifest did not read back the approval that was just written.', [
        `Baseline: ${toPosix(baselinePath)} (${writtenHash})`,
        `Manifest: ${toPosix(manifestPath)}`,
      ]);
    }

    journal.stage = 'committed';
    await writeJsonAtomic(journalPath, journal);
    faultPoint('before-journal-cleanup');
    await safeUnlink(journalPath);
    return prepared.entry;
  } catch (error) {
    if (journal?.stage === 'committed') {
      // The approval itself succeeded; only the cleanup failed. Never roll back.
      throw new EnvironmentError('The approval committed, but its transaction journal could not be removed.', [
        `Approved: ${toPosix(baselinePath)}`,
        `Journal: ${toPosix(journalPath)} (left in place; the next approval finishes the cleanup)`,
        `Cause: ${error?.message ?? String(error)}`,
      ]);
    }

    if (!baselineReplaced) {
      try {
        await safeUnlink(stagedPath);
        await safeUnlink(archiveCreated);
        await safeUnlink(journalPath);
      } catch {
        // Cleanup problems must never hide the original failure.
      }
      throw classify(error, 'before any baseline or manifest replacement', [
        `Baseline: ${toPosix(baselinePath)} (unchanged)`,
        `Manifest: ${toPosix(manifestPath)} (unchanged)`,
      ]);
    }

    try {
      const paths = await resolveJournalPaths(journal, baselinesRoot);
      await restoreFromJournal(journal, paths);
    } catch (rollbackError) {
      const observed = await hashOrNull(baselinePath);
      throw new EnvironmentError(
        'The approval failed after replacing the baseline, and rollback did not complete. ' +
          'Manual recovery is required.',
        [
          `Approval: ${pageId} @ ${viewportName}, run ${runId}`,
          `Baseline: ${toPosix(baselinePath)}`,
          `Expected baseline SHA-256: ${journal.baseline.existed ? journal.baseline.sha256 : '(file should not exist)'}`,
          `Observed baseline SHA-256: ${observed ?? '(file is missing)'}`,
          `Manifest: ${toPosix(manifestPath)} (its pre-approval text is kept in the journal)`,
          `Journal: ${toPosix(journalPath)} (deliberately kept)`,
          `Original failure: ${error?.message ?? String(error)}`,
          `Rollback failure: ${rollbackError?.message ?? String(rollbackError)}`,
          ...(rollbackError?.details ?? []).map((line) => `  ${line}`),
          'Fix the cause named above, then re-run the same approval: it detects the journal and retries the rollback.',
        ],
      );
    }

    try {
      await safeUnlink(journalPath);
      await safeUnlink(stagedPath);
    } catch {
      // Rollback already restored the state; leftover debris is reported by the
      // next run rather than failing this one twice.
    }

    throw classify(error, 'after a baseline replacement, rolled back successfully', [
      `Baseline: ${toPosix(baselinePath)} (restored, SHA-256 ${journal.baseline.sha256 ?? 'n/a'})`,
      `Manifest: ${toPosix(manifestPath)} (restored from the journal)`,
    ]);
  }
}

/**
 * Delete staging debris for one page/viewport.
 *
 * Only called while the lock is held, and only for files that are old enough
 * that no live approval can still own them, so it cannot race a concurrent
 * writer. It exists because a crash *before* the journal is written leaves a
 * staged file that no journal points at.
 */
export async function sweepStagedFiles(baselinesRoot, pageId, viewportName, { olderThanMs = 300_000 } = {}) {
  const dir = path.join(baselinesRoot, pageId);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefix = `.staged-${viewportName}-`;
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const full = path.join(dir, entry.name);
    try {
      const info = await stat(full);
      if (Date.now() - info.mtimeMs < olderThanMs) continue;
      await unlink(full);
      removed.push(toPosix(path.relative(baselinesRoot, full)));
    } catch {
      // Best effort: a file we cannot inspect is left alone.
    }
  }
  return removed;
}

/**
 * Recover a transaction left behind by an interrupted approval.
 *
 * Called at the start of every approval, while holding the lock, before any
 * state is read for the new approval. It is idempotent: a recovered or committed
 * transaction has no journal, so a second call does nothing.
 *
 * @returns {Promise<string|null>} a human-readable description, or null
 */
export async function recoverUnfinishedApproval({ baselinesRoot }) {
  const journalPath = journalFileFor(baselinesRoot);
  if (!(await pathExists(journalPath))) return null;

  let journal;
  try {
    journal = await readJsonIfExists(journalPath, null);
  } catch (error) {
    throw new EnvironmentError(
      `An unfinished approval journal exists at ${toPosix(journalPath)} but cannot be read.`,
      [
        error.message,
        'Refusing to start a new approval on top of an unknown state.',
        `Inspect ${toPosix(path.dirname(journalPath))} by hand: confirm the baseline image and manifest agree, delete ${JOURNAL_FILENAME}, then re-run.`,
      ],
    );
  }

  // Fail closed on every malformed or incomplete journal: no recovery operation
  // may run, and the journal is left in place for inspection.
  validateJournal(journal, journalPath);
  const paths = await resolveJournalPaths(journal, baselinesRoot);

  if (journal.stage === 'committed') {
    await safeUnlink(journalPath);
    await safeUnlink(paths.stagedPath);
    return 'an earlier approval had already committed; its journal has been removed';
  }

  const baselineNow = await hashOrNull(paths.baselinePath);
  let recorded = null;
  try {
    recorded = getEntry(await readManifest(baselinesRoot), journal.pageId, journal.viewport);
  } catch {
    recorded = null;
  }

  // Both files already describe the new approval: the crash happened after the
  // last write, so finish it rather than undoing good work.
  if (baselineNow === journal.candidate.sha256 && recorded?.sha256 === journal.candidate.sha256) {
    journal.stage = 'committed';
    await writeJsonAtomic(journalPath, journal);
    await safeUnlink(journalPath);
    await safeUnlink(paths.stagedPath);
    return `an interrupted approval of ${journal.pageId} @ ${journal.viewport} had already committed; it was kept`;
  }

  try {
    await restoreFromJournal(journal, paths);
  } catch (rollbackError) {
    throw new EnvironmentError(
      `An interrupted approval of ${journal.pageId} @ ${journal.viewport} could not be recovered.`,
      [
        `Journal: ${toPosix(journalPath)} (kept)`,
        `Baseline: ${toPosix(paths.baselinePath)}`,
        `Expected baseline SHA-256: ${journal.baseline.existed ? journal.baseline.sha256 : '(file should not exist)'}`,
        `Observed baseline SHA-256: ${baselineNow ?? '(file is missing)'}`,
        `Manifest: ${toPosix(paths.manifestPath)}`,
        `Cause: ${rollbackError?.message ?? String(rollbackError)}`,
        ...(rollbackError?.details ?? []).map((line) => `  ${line}`),
        'Nothing new was attempted. Resolve the cause above, then re-run.',
      ],
    );
  }

  await safeUnlink(journalPath);
  await safeUnlink(paths.stagedPath);
  return `rolled back an interrupted approval of ${journal.pageId} @ ${journal.viewport}`;
}
