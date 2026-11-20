import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Create a directory tree, ignoring "already exists". */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/**
 * A JSON file was read but its contents are not valid JSON.
 *
 * Distinct from a filesystem problem: callers can classify a parse failure as a
 * user-fixable configuration error instead of an environment failure.
 */
export class JsonReadError extends Error {
  constructor(message, { file = null, cause = null } = {}) {
    super(message);
    this.name = 'JsonReadError';
    this.file = file;
    this.cause = cause;
  }
}

/**
 * Read and parse JSON, or return `fallback` when the file is missing.
 *
 * A missing file is `fallback`; unparseable content is a `JsonReadError`;
 * a genuine filesystem failure (permissions, wrong type, device error) is
 * rethrown untouched so it is never mistaken for a user configuration problem.
 */
export async function readJsonIfExists(file, fallback = null) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new JsonReadError(`Failed to read JSON at ${file}: ${error.message}`, {
      file,
      cause: error,
    });
  }
}

/** Write pretty-printed JSON with a trailing newline (stable, diff-friendly). */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Write JSON by replacing the destination in one step.
 *
 * The approval manifest is the file that proves which image was approved, so a
 * torn or truncated write must be impossible: a reader must see either the old
 * manifest or the new one, never half of either. The sequence is
 *
 *   open(temp, 'wx') -> write -> fsync -> close -> rename(temp, file)
 *
 * and the temporary file always lives in the destination's own directory, so
 * the final `rename` is a same-directory replacement:
 *
 *   - POSIX: `rename(2)` is atomic and replaces an existing destination.
 *   - Windows: `fs.rename` maps to MoveFileEx with MOVEFILE_REPLACE_EXISTING,
 *     which replaces an existing file in the same directory in one step. It is
 *     verified by this project's tests rather than assumed.
 *
 * `rename` is documented as accepting an exclusive-create temporary file within
 * the same directory. It is NOT a cross-file transaction: replacing the
 * manifest and the baseline image are still two separate operations, which is
 * why approvals use a journal on top of this (see approval-transaction.js).
 *
 * On any failure the temporary file is removed, so a handled error leaves no
 * `.tmp` debris and the destination untouched.
 */
export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Replace a file's contents in one step.
 *
 * Same sequence as {@link writeJsonAtomic}; exposed separately because rollback
 * has to restore the *exact bytes* that were there before (a manifest written by
 * an older tool version may not match this tool's canonical formatting, so
 * re-serialising it would not be a faithful restore).
 */
export async function writeFileAtomic(file, payload) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );

  let handle = null;
  try {
    handle = await open(temp, 'wx');
    await handle.writeFile(payload, 'utf8');
    // Durability before replacement: without the flush a power loss can leave a
    // renamed file whose contents were never on disk.
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, file);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The write already failed; a close failure changes nothing.
      }
    }
    try {
      await unlink(temp);
    } catch {
      // ENOENT: the temporary file was never created, or rename already moved it.
    }
    throw error;
  }
}

/** Write UTF-8 text, creating parent directories as needed. */
export async function writeText(file, value) {
  await ensureDir(path.dirname(file));
  await writeFile(file, value, 'utf8');
}

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** SHA-256 of a file's bytes, used to fingerprint approved baselines. */
export async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

/**
 * Convert a Windows path to forward slashes for URLs and report text.
 * Keeps reports identical regardless of the machine that produced them.
 */
export function toPosix(value) {
  return value.split(path.sep).join('/');
}

/** Make a path relative to a root, in posix form, for portable reports. */
export function relativePosix(root, target) {
  return toPosix(path.relative(root, target));
}

/** Round to a fixed number of decimals to keep report numbers stable. */
export function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
