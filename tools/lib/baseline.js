import path from 'node:path';
import { ConfigError } from './config.js';
import { EnvironmentError } from './errors.js';
import { JsonReadError, ensureDir, readJsonIfExists, writeJsonAtomic } from './fs-utils.js';
import { isRunId } from './report.js';

export const MANIFEST_FILENAME = 'manifest.json';

/**
 * Manifest schema written by this tool.
 *
 * Version 2 adds the audit trail: which verification run and candidate image
 * were approved (`runId`, `candidate`), which configuration produced them
 * (`config`), what they replaced (`previous`, including the archived file's
 * SHA-256) and an append-only `history` of earlier approvals.
 *
 * Version 1 manifests are still **read**: their entries carry the fingerprint
 * and metadata that the integrity check actually uses, so refusing to read them
 * would break every existing approval for no safety gain. They are upgraded in
 * place the next time an entry is approved — nothing is discarded, because every
 * v1 field keeps its meaning in v2.
 */
export const MANIFEST_VERSION = 2;

/**
 * Versions this tool is willing to read. Anything else fails closed: a future
 * schema could store approvals somewhere this build would not look, so guessing
 * is more dangerous than refusing.
 */
export const MANIFEST_READABLE_VERSIONS = Object.freeze([1, 2]);

/** `pageId/viewport` — the key used in the baseline manifest. */
export function entryKey(pageId, viewportName) {
  return `${pageId}/${viewportName}`;
}

/**
 * Resolve `segments` under `root`, refusing anything that escapes it.
 *
 * Configuration validation already rejects path-like ids, but this guard does
 * not depend on it: it runs at the point where the path is actually built, so a
 * hand-built call or a config loaded by another tool cannot write outside the
 * baseline tree either.
 *
 * `path.relative` is used deliberately instead of a string prefix test: a
 * prefix test would accept a sibling directory such as `baselines-archive`
 * (`startsWith('baselines')`), and would mishandle drive-qualified Windows
 * paths. `relative` returns '' for the root itself and an absolute path when
 * the drives differ — both are rejected here.
 *
 * @param {string} root directory every result must stay inside
 * @param {...string} segments path segments to append
 * @returns {string} the joined path, in the same form as `root` (relative stays relative)
 */
export function resolveInside(root, ...segments) {
  const resolvedRoot = path.resolve(root);

  for (const segment of segments) {
    if (
      typeof segment !== 'string' ||
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      // Rejects separators, walk-up syntax and drive-qualified Windows paths
      // such as `C:\outside` (which also carries an illegal ':' here).
      /[\\/:]/.test(segment)
    ) {
      throw new ConfigError(`Refusing to build a path from the segment ${JSON.stringify(segment)}`, [
        'Page ids and viewport names must be plain names, not paths.',
      ]);
    }
  }

  const candidate = path.join(root, ...segments);
  const relative = path.relative(resolvedRoot, path.resolve(candidate));

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ConfigError(`Refusing to use a path outside ${resolvedRoot}`, [
      `Resolved target: ${candidate}`,
      'Page ids and viewport names must be plain names, not paths.',
    ]);
  }

  return candidate;
}

/**
 * Mirrors PAGE_ID_PATTERN / VIEWPORT_NAME_PATTERN in config.js. Duplicated on
 * purpose: this guard must hold even when a config was not validated (another
 * tool calling in, or a hand-built invocation).
 */
const SAFE_PATH_SEGMENT_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Refuse an identifier that cannot be used as a plain file name. */
function assertPlainName(value, label) {
  if (typeof value !== 'string' || !SAFE_PATH_SEGMENT_NAME.test(value)) {
    throw new ConfigError(
      `Refusing to use the ${label} ${JSON.stringify(value)} in a baseline path`,
      [`Identifiers used as file names must match ${SAFE_PATH_SEGMENT_NAME}.`],
    );
  }
}

/**
 * Deterministic baseline location: baselines/<pageId>/<viewport>.png
 * Contained within `baselinesRoot` even if an id or viewport name is hostile.
 */
export function baselineFileFor(baselinesRoot, pageId, viewportName) {
  assertPlainName(pageId, 'page id');
  assertPlainName(viewportName, 'viewport name');
  return resolveInside(baselinesRoot, pageId, `${viewportName}.png`);
}

/** Archived previous baseline: baselines/<pageId>/archive/<viewport>-<stamp>.png */
export function archiveFileFor(baselinesRoot, pageId, viewportName, stamp) {
  assertPlainName(pageId, 'page id');
  assertPlainName(viewportName, 'viewport name');
  return resolveInside(baselinesRoot, pageId, 'archive', `${viewportName}-${stamp}.png`);
}

export function manifestFileFor(baselinesRoot) {
  return path.join(baselinesRoot, MANIFEST_FILENAME);
}

/**
 * Read the approval manifest. A missing manifest is not an error — it means
 * nothing has been approved yet.
 *
 * Anything present is validated before it is trusted: every entry must carry a
 * SHA-256 fingerprint of the approved image. A manifest that does not satisfy
 * that schema is a configuration error (exit 2), never a silently weaker run.
 */
export async function readManifest(baselinesRoot) {
  const file = manifestFileFor(baselinesRoot);
  let manifest;
  try {
    manifest = await readJsonIfExists(file, null);
  } catch (error) {
    if (error instanceof JsonReadError) {
      // Unparseable manifest JSON is something the user must fix, exactly like an
      // unparseable config file, so it is classified the same way (exit 2).
      throw new ConfigError(`Invalid JSON in the baseline manifest at ${file}.`, [
        error.message,
        'Fix the file, or delete it and re-approve the baselines that matter.',
      ]);
    }
    throw error;
  }

  if (!manifest) {
    return { version: MANIFEST_VERSION, entries: {} };
  }
  return validateManifest(manifest, file);
}

/**
 * Structural checks for the audit fields a version 2 entry may carry.
 *
 * Absent is fine — a version 1 entry has none of them — but present-and-wrong is
 * not. A history that is not a list of records could hide the fact that an entry
 * was approved more than once, and a `previous` record that is not an object
 * could not vouch for the image it claims to have replaced.
 */
function auditProblems(key, entry, problems) {
  for (const field of ['runId', 'file', 'viewport', 'pageId']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') {
      problems.push(`${key}: ${field} must be a string when present.`);
    }
  }

  if (entry.previous !== undefined && entry.previous !== null) {
    if (typeof entry.previous !== 'object' || Array.isArray(entry.previous)) {
      problems.push(`${key}: previous must be an object or null.`);
    } else if (entry.previous.sha256 !== undefined && !isValidSha256(entry.previous.sha256)) {
      problems.push(
        `${key}: previous.${describeHash(entry.previous.sha256)} — a replaced image must be fingerprinted.`,
      );
    }
  }

  if (entry.candidate !== undefined) {
    if (typeof entry.candidate !== 'object' || entry.candidate === null || Array.isArray(entry.candidate)) {
      problems.push(`${key}: candidate must be an object.`);
    } else if (entry.candidate.sha256 !== undefined && !isValidSha256(entry.candidate.sha256)) {
      problems.push(
        `${key}: candidate.${describeHash(entry.candidate.sha256)} — the approved candidate must be fingerprinted.`,
      );
    }
  }

  if (entry.history !== undefined) {
    if (!Array.isArray(entry.history)) {
      problems.push(`${key}: history must be an array of approval records.`);
      return;
    }
    entry.history.forEach((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        problems.push(`${key}: history[${index}] is not an approval record.`);
        return;
      }
      if (record.sha256 !== undefined && !isValidSha256(record.sha256)) {
        problems.push(`${key}: history[${index}].${describeHash(record.sha256)}`);
      }
      if (
        record.replacedBy !== undefined &&
        (typeof record.replacedBy !== 'object' ||
          record.replacedBy === null ||
          Array.isArray(record.replacedBy))
      ) {
        problems.push(`${key}: history[${index}].replacedBy must be an object.`);
      }
    });
  }
}

/**
 * Fail-closed schema validation for a parsed manifest.
 *
 * The integrity guarantee rests entirely on `entry.sha256`: if an entry could
 * omit it, a baseline swapped outside the approval workflow would be compared
 * against as if it had been approved. So a missing, empty, malformed or
 * wrong-length fingerprint is a hard error, not a skipped check.
 *
 * @param {unknown} manifest parsed JSON
 * @param {string} [file] path, for the error message
 * @returns {{version: number, entries: object}}
 */
export function validateManifest(manifest, file = MANIFEST_FILENAME) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ConfigError(`The baseline manifest at ${file} is not a JSON object.`, [
      'Delete it and re-approve the baselines you want to keep.',
    ]);
  }

  // An absent version means "written before versions existed". A *present* but
  // unreadable one — including null — is refused rather than guessed: treating a
  // corrupted field as absent is how a future schema gets misread as this one.
  const declared = Object.prototype.hasOwnProperty.call(manifest, 'version');
  const version = declared ? manifest.version : MANIFEST_VERSION;
  if (!MANIFEST_READABLE_VERSIONS.includes(version)) {
    throw new ConfigError(
      `The baseline manifest at ${file} declares schema version ${JSON.stringify(manifest.version)}, ` +
        'which this tool cannot read.',
      [
        `Readable versions: ${MANIFEST_READABLE_VERSIONS.join(', ')}.`,
        'Refusing to guess: an unrecognised schema could describe approvals this build would misread.',
        'Upgrade the tool, or delete the manifest and re-approve the baselines you want to keep.',
      ],
    );
  }

  const entries = manifest.entries ?? {};
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new ConfigError(`The baseline manifest at ${file} has an invalid "entries" field.`, [
      'It must be an object keyed by "<page id>/<viewport>".',
    ]);
  }

  const problems = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${key}: the entry is not an object.`);
      continue;
    }
    if (!isValidSha256(entry.sha256)) {
      problems.push(`${key}: ${describeHash(entry.sha256)} — every baseline needs a SHA-256 fingerprint.`);
    }
    auditProblems(key, entry, problems);
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `The baseline manifest at ${file} does not satisfy its schema (${problems.length} problem(s)).`,
      [
        ...problems.slice(0, 10),
        'A baseline without a recorded fingerprint cannot be trusted, so this run is refused.',
        'Fix the manifest, or delete the broken entries and re-approve those baselines explicitly.',
      ],
    );
  }

  return { version, entries };
}

/** A SHA-256 fingerprint as {@link sha256File} writes it: 64 lowercase hex digits. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** True only for a well-formed, lowercase hexadecimal SHA-256 digest. */
export function isValidSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function describeHash(value) {
  if (value === undefined) return 'sha256 is missing';
  if (value === null) return 'sha256 is null';
  if (value === '') return 'sha256 is empty';
  if (typeof value !== 'string') return `sha256 is a ${typeof value}, not a string`;
  if (/^[0-9a-f]+$/i.test(value) && value.length !== 64) {
    return `sha256 has ${value.length} characters instead of 64`;
  }
  return `sha256 ${JSON.stringify(value.slice(0, 24))} is not a hexadecimal digest`;
}

export function getEntry(manifest, pageId, viewportName) {
  return manifest.entries?.[entryKey(pageId, viewportName)] ?? null;
}

/**
 * Record an approval in the manifest.
 *
 * This is only ever called by `tools/approve-baseline.js` after a human has
 * confirmed the replacement. `tools/visual-verify.js` must never call it.
 *
 * The entry has to answer, later and without the terminal that produced it:
 * which candidate run was approved, which configuration produced it, which
 * candidate bytes were approved, what they replaced (including the replaced
 * image's archive and its fingerprint), and who approved it when. `runId` is
 * therefore required — an approval that cannot name its source run is exactly
 * the record that lets an unrelated candidate slip in unnoticed.
 *
 * Earlier approvals are not overwritten in place: the previous record is copied
 * into `history` first, so the trail is append-only.
 */
export async function recordApproval(options) {
  const manifest = await readManifest(options.baselinesRoot);
  const { manifest: next, entry } = applyApproval(manifest, options);
  await ensureDir(options.baselinesRoot);
  // Atomic: a reader sees the previous manifest or the new one, never a torn file.
  await writeJsonAtomic(manifestFileFor(options.baselinesRoot), next);
  return entry;
}

/**
 * Build the next manifest from an approval, without touching the filesystem.
 *
 * Pure on purpose: the approval transaction prepares and validates the next
 * manifest *before* replacing anything, and keeps the previous one in its
 * journal so a failed commit can put it back byte for byte. Returning a new
 * object (rather than mutating `manifest`) is what makes that rollback honest.
 *
 * @returns {{manifest: object, entry: object}}
 */
export function applyApproval(
  manifest,
  {
    pageId,
    viewportName,
    runId,
    sha256,
    width,
    height,
    candidatePath = null,
    configPath = null,
    pixelThreshold = null,
    previous = null,
    browserVersion,
    approvedBy,
    note,
    approvedAt = new Date().toISOString(),
  },
) {
  if (!isValidSha256(sha256)) {
    throw new EnvironmentError(
      `Refusing to record an approval without a valid SHA-256 fingerprint (got ${describeHash(sha256)}).`,
      ['The baseline copy could not be fingerprinted. Nothing was recorded in the manifest.'],
    );
  }

  if (!isRunId(runId)) {
    throw new EnvironmentError(
      `Refusing to record an approval without the verification run it came from ` +
        `(got ${JSON.stringify(runId)}).`,
      [
        'The manifest must be able to answer "which candidate run was approved?".',
        'Nothing was recorded in the manifest.',
      ],
    );
  }

  const key = entryKey(pageId, viewportName);
  const existing = manifest.entries[key] ?? null;

  // Append-only trail: keep whatever history the entry already had, then add a
  // record of the approval that is about to be replaced.
  const history = Array.isArray(existing?.history) ? [...existing.history] : [];
  if (existing) {
    history.push({
      runId: existing.runId ?? existing.candidate?.runId ?? null,
      sha256: existing.sha256 ?? null,
      width: existing.width ?? null,
      height: existing.height ?? null,
      approvedAt: existing.approvedAt ?? null,
      approvedBy: existing.approvedBy ?? null,
      browserVersion: existing.browserVersion ?? null,
      note: existing.note ?? null,
      replacedBy: { runId, sha256, approvedAt },
    });
  }

  const next = { ...manifest, version: MANIFEST_VERSION, entries: { ...manifest.entries } };
  next.entries[key] = {
    pageId,
    viewport: viewportName,
    file: `${pageId}/${viewportName}.png`,
    sha256,
    width,
    height,
    approvedAt,
    approvedBy: approvedBy ?? null,
    browserVersion: browserVersion ?? null,
    note: note ?? null,
    runId,
    candidate: {
      runId,
      path: candidatePath ?? null,
      sha256,
      width,
      height,
    },
    config: {
      path: configPath ?? null,
      viewport: { name: viewportName, width, height },
      pixelThreshold: pixelThreshold ?? null,
    },
    previous: previous ?? null,
    history,
  };
  return { manifest: next, entry: next.entries[key] };
}
