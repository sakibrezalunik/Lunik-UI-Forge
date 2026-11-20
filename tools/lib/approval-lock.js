/**
 * A single-owner lock for approvals against one baseline root.
 *
 * Two `approve-baseline.js --confirm` processes can otherwise both read the
 * manifest, both build a new one from their snapshot, and both write it: the
 * second write silently discards the first approval. The lock makes the whole
 * read-modify-write sequence owned by one process at a time.
 *
 * Design choices worth stating:
 *
 *   - The lock is a file created with `wx` (exclusive create). Creation is the
 *     acquire: no reader can ever observe a lock file with stale content and
 *     "take it over" by writing.
 *   - It is never removed because it *looks* old. A lock is reclaimed only when
 *     the process that wrote it is provably gone: same host, and the recorded
 *     PID does not exist. A lock from another host is never reclaimed, because
 *     its PID cannot be checked from here.
 *   - Reclaiming is itself race-free: the stale lock is claimed by `rename`ing
 *     it to a unique name, so exactly one waiter can win; the loser retries and
 *     finds the winner's lock.
 *   - PID reuse makes a dead-process check optimistic in theory. The failure
 *     direction is safe: if the PID now belongs to some unrelated live process,
 *     `process.kill(pid, 0)` succeeds and the lock is treated as live, so the
 *     tool waits or times out instead of stealing it.
 */
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentError } from './errors.js';
import { ensureDir, toPosix } from './fs-utils.js';

export const LOCK_FILENAME = '.approval.lock';

/** Bounded wait before an approval reports that another one holds the lock. */
export const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

export function lockFileFor(baselinesRoot) {
  return path.join(baselinesRoot, LOCK_FILENAME);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * True when the process exists.
 *
 * `EPERM` means "exists but is not ours", which counts as alive: refusing to
 * steal a lock is always the safe direction.
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLock(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

async function ageOf(file) {
  try {
    const info = await stat(file);
    return Date.now() - info.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Try to claim a lock left behind by a process that no longer exists.
 *
 * Returns a short description when the stale lock was reclaimed, or null when
 * the lock must be treated as live (different host, live PID, unreadable and
 * still young, or another waiter won the race).
 */
async function reclaimIfStale(file, held, staleMs) {
  const age = await ageOf(file);
  const foreign = held && typeof held.host === 'string' && held.host !== os.hostname();
  if (foreign) return null;

  if (held && Number.isInteger(held.pid)) {
    if (isProcessAlive(held.pid)) return null;
  } else if (age < staleMs) {
    // No owner we can verify, and the file is too young to assume the writer is
    // gone: it may be mid-write. Wait rather than steal.
    return null;
  }

  const aside = `${file}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(file, aside);
  } catch {
    // Another waiter reclaimed it first, or the owner released it. Retry.
    return null;
  }
  try {
    await unlink(aside);
  } catch {
    // The claim succeeded even if the evidence copy cannot be removed.
  }
  return `reclaimed a stale approval lock left by PID ${held?.pid ?? '(unknown)'}`;
}

/**
 * Acquire the approval lock for `baselinesRoot`.
 *
 * @returns {Promise<{file: string, release: () => Promise<void>}>}
 * @throws {EnvironmentError} when the lock cannot be acquired within `timeoutMs`
 */
export async function acquireApprovalLock(
  baselinesRoot,
  { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, staleMs = 60_000, pollMs = 50, onReclaim = null } = {},
) {
  const file = lockFileFor(baselinesRoot);
  await ensureDir(baselinesRoot);
  const body = `${JSON.stringify(
    { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), tool: 'approve-baseline' },
    null,
    2,
  )}\n`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(file, 'wx');
      try {
        await handle.writeFile(body, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        file,
        release: async () => {
          // Only remove a lock this process still owns: a successor that got the
          // lock after a timeout must not be unlocked by our cleanup.
          const current = await readLock(file);
          if (current && current.pid !== process.pid) return;
          try {
            await unlink(file);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const held = await readLock(file);
    const reclaimed = await reclaimIfStale(file, held, staleMs);
    if (reclaimed) {
      if (onReclaim) onReclaim(reclaimed);
      continue;
    }

    if (Date.now() >= deadline) {
      throw new EnvironmentError(
        `Another approval holds the lock on ${toPosix(file)} and did not release it within ${timeoutMs}ms.`,
        [
          `Lock owner: PID ${held?.pid ?? '(unknown)'} on ${held?.host ?? '(unknown host)'}` +
            `${held?.startedAt ? `, since ${held.startedAt}` : ''}.`,
          'Nothing was written. Wait for that approval to finish, then re-run the same command.',
          'A crashed approval also leaves this lock: if you can confirm that PID is gone, delete the lock file yourself and re-run.',
          'It is never deleted automatically while the owning process might still be running.',
        ],
      );
    }
    await sleep(pollMs);
  }
}
