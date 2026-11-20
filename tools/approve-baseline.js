#!/usr/bin/env node
/**
 * Lunik UI Forge — explicit visual baseline approval.
 *
 *   node tools/approve-baseline.js --page <id> --viewport <name> [options]
 *
 *   --page <id>         page id from lunik.config.json (required)
 *   --viewport <name>   viewport name (required)
 *   --run <runId>       which verification run to take the screenshot from. Required
 *                       with --confirm: the dry run may auto-select the newest run
 *                       that captured this page/viewport, an approval may not.
 *   --approve-hash <sha256>  the candidate hash printed by the dry run. Required with
 *                       --confirm, and it must match the candidate this invocation
 *                       actually read, so a stale or mistaken hash cannot approve.
 *   --confirm           actually write the baseline. Without it this is a dry run.
 *   --note "<text>"     reason for the change, stored in baselines/manifest.json
 *   --by "<name>"       who approved it, stored in the manifest (optional)
 *   --config, --root    same meaning as in visual-verify.js
 *   --help
 *
 * This is the only script in the project that may write into `baselines/`.
 * `visual-verify.js` never does.
 *
 * What this cannot do: prove a human looked at the image. Requiring the exact
 * candidate hash makes it hard to approve the *wrong* image by accident or by
 * reusing an old command line, and the dry run writes a diff artifact next to the
 * run so there is something concrete to look at. The review itself is still a
 * human responsibility, and is recorded as an assertion (`--by`, `--note`), not as
 * evidence.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  flagBool,
  flagString,
  flagsMissingValue,
  parseArgs,
  unknownFlags,
} from './lib/args.js';
import { ConfigError, loadConfig } from './lib/config.js';
import { EnvironmentError } from './lib/errors.js';
import { pathExists, sha256File, toPosix } from './lib/fs-utils.js';
import { displayPath, invocationFlags, quoteIfNeeded } from './lib/invocation.js';
import {
  archiveFileFor,
  baselineFileFor,
  getEntry,
  isValidSha256,
  manifestFileFor,
  readManifest,
} from './lib/baseline.js';
import { DEFAULT_LOCK_TIMEOUT_MS, acquireApprovalLock } from './lib/approval-lock.js';
import {
  commitApproval,
  recoverUnfinishedApproval,
  sweepStagedFiles,
} from './lib/approval-transaction.js';
import { compareScreenshots } from './lib/diff.js';
import { assertRunId, isRunId } from './lib/report.js';
import { EXIT } from './lib/severity.js';

const HELP = `Lunik UI Forge — approve a visual baseline

Usage: node tools/approve-baseline.js --page <id> --viewport <name> [options]

Options:
  --page <id>              Page id from lunik.config.json (required)
  --viewport <name>        Viewport name (required)
  --run <runId>            Verification run to take the screenshot from
                           (default for a dry run: the newest run holding this page/viewport)
  --approve-hash <sha256>  Candidate SHA-256 printed by the dry run
  --confirm                Write the baseline. Without this flag nothing is written,
                           and --run and --approve-hash are required together with it.
  --note "<text>"          Why the baseline changed (recorded in the manifest)
  --by "<name>"            Who approved it (recorded in the manifest)
  --root <path>            Project root (default: current directory)
  --config <path>          Config file (default: lunik.config.json)
  --help                   Show this help

Only one page and one viewport can be approved per invocation.

An approval is serialized and recoverable:
  * It takes a lock at baselines/.approval.lock, so two approvals cannot
    overwrite each other's manifest entries. A second approval waits (bounded)
    and then fails with the lock owner named; a lock left by a process that no
    longer exists is reclaimed automatically.
  * It writes a journal at baselines/.approval-journal.json, stages the candidate,
    then replaces the image and the manifest. If a step fails after the image is
    replaced, the previous state is restored and verified; if that is impossible,
    the error names the exact paths and hashes to fix. A crashed approval is
    rolled back (or kept, if it had already committed) by the next one.

Exit codes: 0 success · 2 usage/configuration error · 3 environment problem.
`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KNOWN_FLAGS = [
  'config',
  'root',
  'page',
  'viewport',
  'run',
  'approve-hash',
  'confirm',
  'note',
  'by',
  'help',
];

// `run` is validated below with a message that explains what the flag does, so
// it is deliberately not part of this generic check.
const VALUE_FLAGS = ['config', 'root', 'page', 'viewport', 'approve-hash', 'note', 'by'];

/** A path for a copy-pasteable command: relative to the caller when possible. */
async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flagBool(flags, 'help')) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const unknown = unknownFlags(flags, KNOWN_FLAGS);
  if (unknown.length > 0 || positional.length > 0) {
    const problems = [];
    if (unknown.length > 0) {
      problems.push(`Unknown option(s): ${unknown.map((name) => `--${name}`).join(', ')}.`);
    }
    if (positional.length > 0) {
      problems.push(`Unexpected argument(s): ${positional.join(' ')}.`);
    }
    throw new ConfigError(problems.join(' '), [
      'Options are passed as --name value; run with --help to see the supported options.',
      'Nothing was read and nothing was written.',
    ]);
  }

  const missingValue = flagsMissingValue(flags, VALUE_FLAGS);
  if (missingValue.length > 0) {
    throw new ConfigError(
      `Option(s) missing a value: ${missingValue.map((name) => `--${name}`).join(', ')}.`,
      [
        'Each of these options takes a value, for example --page saas-dashboard.',
        'Nothing was read and nothing was written.',
      ],
    );
  }

  const root = path.resolve(flagString(flags, 'root', process.cwd()));
  const pageId = flagString(flags, 'page');
  const viewportName = flagString(flags, 'viewport');
  const confirmed = flagBool(flags, 'confirm');
  const note = flagString(flags, 'note');
  const approvedBy = flagString(flags, 'by');
  const approveHash = normalizeApprovalHash(flagString(flags, 'approve-hash'));

  // Both flags are required, so an approval line cannot be produced by habit:
  // it names the run it approves and the exact candidate bytes it approves.
  if (confirmed && !('run' in flags)) {
    throw new ConfigError('`--confirm` requires an explicit `--run <runId>`.', [
      'Without it the newest run that happens to hold this page/viewport is used, which is not a decision anyone made.',
      'Run this command without `--confirm` first: the dry run prints the run, the candidate path and its SHA-256.',
    ]);
  }
  if (confirmed && !approveHash) {
    throw new ConfigError('`--confirm` requires `--approve-hash <sha256>`.', [
      'Copy the value the dry run printed after "SHA-256:" so the approval is tied to those exact bytes.',
      'Nothing was written.',
    ]);
  }
  if (!confirmed && approveHash) {
    throw new ConfigError('`--approve-hash` only means something with `--confirm`.', [
      'A dry run approves nothing; drop the flag or add `--confirm`.',
    ]);
  }

  if (!pageId || !viewportName) {
    throw new ConfigError('Both --page and --viewport are required.', [
      'One invocation approves one page at one viewport. Example:',
      '  node tools/approve-baseline.js --page saas-dashboard --viewport desktop',
    ]);
  }

  const { config, configPath } = await loadConfig(root, flagString(flags, 'config'));
  const pageDef = config.pages.find((page) => page.id === pageId);
  if (!pageDef) {
    throw new ConfigError(`Unknown page id "${pageId}".`, [
      `Configured ids: ${config.pages.map((page) => page.id).join(', ')}`,
    ]);
  }
  const viewport = config.viewports.find((entry) => entry.name === viewportName);
  if (!viewport) {
    throw new ConfigError(`Unknown viewport "${viewportName}".`, [
      `Configured viewports: ${config.viewports.map((entry) => entry.name).join(', ')}`,
    ]);
  }

  const baselinesRoot = path.join(root, config.baselinesDir);
  const reportsRoot = path.join(root, config.reportsDir);
  const target = baselineFileFor(baselinesRoot, pageId, viewportName);

  // `--run` is raw user input and is about to be joined into a filesystem path,
  // so it is validated first. A value like `../../../Windows` must fail here,
  // not be resolved into a directory outside reports/.
  const requestedRun = flagString(flags, 'run');
  if ('run' in flags) {
    if (requestedRun === null) {
      throw new ConfigError('`--run` needs a run id after it.', [
        'Example: --run 2026-11-15T15-16-10-725Z',
        'Omit the flag entirely to use the newest run that captured this page/viewport.',
      ]);
    }
    assertRunId(requestedRun);
  }

  const runId = requestedRun ?? (await findLatestRun(reportsRoot, pageId, viewportName));
  if (!runId) {
    throw new ConfigError(`No verification run contains a screenshot for ${pageId} @ ${viewportName}.`, [
      'Run the verification first: node tools/visual-verify.js',
    ]);
  }

  const source = path.join(reportsRoot, runId, 'screenshots', pageId, `${viewportName}.png`);
  if (!(await pathExists(source))) {
    throw new ConfigError(`Screenshot not found: ${toPosix(path.relative(root, source))}`, [
      'Run the verification first, or pass the correct --run <runId>.',
    ]);
  }

  await assertIsPng(source);
  const candidate = PNG.sync.read(await readFile(source));
  const candidateHash = await sha256File(source);

  process.stdout.write(`Page:      ${pageId}\n`);
  process.stdout.write(`Viewport:  ${viewportName} (${viewport.width}x${viewport.height})\n`);
  process.stdout.write(`Run:       ${runId}\n`);
  process.stdout.write(`Candidate: ${toPosix(path.relative(root, source))}\n`);
  process.stdout.write(`Size:      ${candidate.width}x${candidate.height} px\n`);
  process.stdout.write(`SHA-256:   ${candidateHash}\n`);

  if (candidate.width !== viewport.width || candidate.height !== viewport.height) {
    throw new EnvironmentError(
      `Candidate is ${candidate.width}x${candidate.height} but viewport "${viewportName}" is ` +
        `${viewport.width}x${viewport.height}.`,
      ['The screenshot does not match its viewport. Re-run verification before approving.'],
    );
  }

  // The confirmed hash has to be this candidate. A mismatch means the run was
  // re-captured since the dry run, or the hash belongs to another candidate —
  // both are the accident this flag exists to prevent.
  if (approveHash && approveHash !== candidateHash) {
    throw new ConfigError('`--approve-hash` does not match the candidate that was read.', [
      `confirmed: ${approveHash}`,
      `candidate: ${candidateHash} (${toPosix(path.relative(root, source))})`,
      'Nothing was approved. Re-run the dry run and confirm the hash it prints for this run.',
    ]);
  }

  const describeCurrentState = async () => {
    const manifest = await readManifest(baselinesRoot);
    const manifestEntry = getEntry(manifest, pageId, viewportName);

    if (!(await pathExists(target))) {
      process.stdout.write('\nNo baseline exists yet — this would create the first one.\n');
      return { identical: false, previous: null, archivePath: null };
    }

    const previousHash = await sha256File(target);
    if (previousHash === candidateHash) {
      process.stdout.write('\nThe candidate is byte-identical to the current baseline.\n');
      process.stdout.write('Nothing to approve; the baseline is already correct.\n');
      return { identical: true, previous: null, archivePath: null };
    }

    process.stdout.write(`\nCurrent baseline: ${toPosix(path.relative(root, target))}\n`);
    process.stdout.write(`Current baseline SHA-256: ${previousHash}\n`);
    if (manifestEntry) {
      process.stdout.write(
        `Recorded approval: run ${manifestEntry.runId ?? '(version 1 record, no run id)'}, ` +
          `at ${manifestEntry.approvedAt ?? '(unknown)'}, ` +
          `by ${manifestEntry.approvedBy ?? '(unrecorded)'}\n`,
      );
      if (manifestEntry.sha256 && manifestEntry.sha256 !== previousHash) {
        process.stdout.write(
          'WARNING: the file on disk does not match the hash recorded at approval time.\n' +
            'It was changed outside this workflow. Approving below replaces it either way.\n',
        );
      }
    } else {
      process.stdout.write('No manifest record exists for that file.\n');
    }

    let comparison = null;
    // The diff lands in the run's own report directory, never in baselines/, so
    // there is something concrete to review next to the screenshot it describes.
    const diffPath = path.join(reportsRoot, runId, 'approval', pageId, `${viewportName}-diff.png`);
    try {
      comparison = await compareScreenshots({
        baselinePath: target,
        actualPath: source,
        diffPath,
        pixelThreshold: config.checks?.visual?.pixelThreshold ?? 0.1,
      });
    } catch (error) {
      // A damaged or non-PNG baseline cannot be compared; say so instead of
      // blocking the approval the human is deliberately asking for.
      comparison = null;
      process.stdout.write(
        `\nThe current baseline could not be compared (${String(error.message).split('\n')[0]}).\n` +
          'It will be archived rather than diffed.\n',
      );
    }

    process.stdout.write('\n--- Change against the current baseline ---\n');
    if (!comparison) {
      process.stdout.write('Comparison unavailable; treating the change as wholesale.\n');
    } else if (comparison.reason === 'size-mismatch') {
      process.stdout.write(
        `Size changed: ${comparison.baseline.width}x${comparison.baseline.height} -> ` +
          `${comparison.actual.width}x${comparison.actual.height}\n`,
      );
    } else {
      process.stdout.write(
        `${comparison.diffPixels} of ${comparison.totalPixels} px differ ` +
          `(${(comparison.diffRatio * 100).toFixed(3)}%)\n`,
      );
    }
    if (comparison?.diffPath) {
      process.stdout.write(`Diff image: ${toPosix(path.relative(root, comparison.diffPath))}\n`);
    }

    let previousSize = comparison?.baseline ?? null;
    if (!previousSize) {
      try {
        const decoded = PNG.sync.read(await readFile(target));
        previousSize = { width: decoded.width, height: decoded.height };
      } catch {
        previousSize = null;
      }
    }

    return {
      identical: false,
      previous: {
        file: `${pageId}/${viewportName}.png`,
        runId: manifestEntry?.runId ?? null,
        manifestSha256: manifestEntry?.sha256 ?? null,
        sha256: previousHash,
        width: previousSize?.width ?? null,
        height: previousSize?.height ?? null,
        approvedAt: manifestEntry?.approvedAt ?? null,
        approvedBy: manifestEntry?.approvedBy ?? null,
      },
      archivePath: archiveFileFor(baselinesRoot, pageId, viewportName, Date.now()),
    };
  };

  if (!confirmed) {
    const state = await describeCurrentState();
    if (state.identical) return EXIT.OK;
    process.stdout.write(
      '\nDRY RUN — nothing was written into baselines/ and nothing was recorded.\n' +
        'Review the candidate above (and the diff image, when one was produced).\n' +
        'If, and only if, that image is what you intend, approve exactly these bytes:\n' +
        `  node tools/approve-baseline.js${invocationFlags(root, configPath)} ` +
        `--page ${pageId} --viewport ${viewportName} ` +
        `--run ${runId} --approve-hash ${candidateHash} --confirm\n`,
    );
    return EXIT.OK;
  }

  // The approval is serialized against every other approval on this baseline
  // root, and any interrupted earlier approval is resolved before this one
  // reads the state it is about to change.
  const lock = await acquireApprovalLock(baselinesRoot, {
    timeoutMs: lockTimeoutMs(),
    onReclaim: (message) => process.stderr.write(`Approval lock: ${message}\n`),
  });

  try {
    const recovered = await recoverUnfinishedApproval({ baselinesRoot });
    if (recovered) process.stderr.write(`Recovered: ${recovered}\n`);
    await sweepStagedFiles(baselinesRoot, pageId, viewportName);

    // Re-read the candidate under the lock: a verification run that finished in
    // the meantime must not be approved with a hash printed before it existed.
    const lockedHash = await sha256File(source);
    if (lockedHash !== candidateHash) {
      throw new ConfigError('The candidate changed after the hash was read.', [
        `reviewed: ${candidateHash}`,
        `on disk:  ${lockedHash}`,
        'Nothing was approved. Re-run the dry run and confirm the hash it prints now.',
      ]);
    }

    const state = await describeCurrentState();
    if (state.identical) return EXIT.OK;

    const entry = await commitApproval({
      baselinesRoot,
      pageId,
      viewportName,
      runId,
      sourcePath: source,
      candidate: { sha256: candidateHash, width: candidate.width, height: candidate.height },
      previous: state.previous,
      archivePath: state.archivePath,
      approval: {
        candidatePath: toPosix(path.relative(root, source)),
        configPath: configPath ? toPosix(path.relative(root, configPath)) : null,
        pixelThreshold: config.checks?.visual?.pixelThreshold ?? 0.1,
        browserVersion: await readRunBrowserVersion(reportsRoot, runId),
        approvedBy,
        note,
      },
    });

    process.stdout.write(
      `\nApproved: ${toPosix(path.relative(root, target))}\n` +
        `Recorded in ${toPosix(path.relative(root, manifestFileFor(baselinesRoot)))} against run ${runId}.\n` +
        (entry.previous
          ? `Replaced ${entry.previous.file} (${entry.previous.sha256}), archived as ` +
            `${entry.previous.archive}.\n`
          : 'This was the first baseline for this page/viewport.\n') +
        'Commit this file deliberately if you want it shared with the project.\n',
    );
    return EXIT.OK;
  } finally {
    await lock.release();
  }
}
/**
 * Normalise `--approve-hash`, refusing anything that cannot be a digest.
 *
 * Rejecting the format here (rather than comparing strings later) means a
 * truncated or mistyped hash is reported as a usage error, not as a mysterious
 * mismatch against a candidate the caller never meant.
 */
/**
 * How long to wait for another approval to finish.
 *
 * A bounded wait, not an infinite one: an approval that cannot take the lock
 * must fail with a message rather than hang. The environment override exists so
 * the tests can prove the timeout without waiting fifteen seconds.
 */
function lockTimeoutMs() {
  const raw = process.env.LUNIK_APPROVAL_LOCK_TIMEOUT_MS;
  if (!raw) return DEFAULT_LOCK_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LOCK_TIMEOUT_MS;
}

function normalizeApprovalHash(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!isValidSha256(normalized)) {
    throw new ConfigError(`\`--approve-hash ${value}\` is not a SHA-256 digest.`, [
      'Pass the 64-character hexadecimal value the dry run printed after "SHA-256:".',
      'Nothing was written.',
    ]);
  }
  return normalized;
}

async function assertIsPng(file) {
  const handle = await readFile(file);
  if (!handle.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new EnvironmentError(`${toPosix(file)} is not a PNG file.`, [
      'Refusing to approve a file that is not a real screenshot.',
    ]);
  }
}

async function findLatestRun(reportsRoot, pageId, viewportName) {
  let entries;
  try {
    entries = await readdir(reportsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  // Run ids are ISO timestamps with punctuation replaced, so name order is time
  // order. Names that are not generated run ids are skipped rather than joined
  // into a path.
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isRunId(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const runId of candidates) {
    const screenshot = path.join(reportsRoot, runId, 'screenshots', pageId, `${viewportName}.png`);
    if (await pathExists(screenshot)) return runId;
  }
  return null;
}

async function readRunBrowserVersion(reportsRoot, runId) {
  try {
    const report = JSON.parse(
      await readFile(path.join(reportsRoot, runId, 'report.json'), 'utf8'),
    );
    return report?.environment?.browser?.version ?? null;
  } catch {
    return null;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`  - ${detail}\n`);
      process.exitCode = EXIT.USAGE;
      return;
    }
    if (error instanceof EnvironmentError) {
      process.stderr.write(`Environment error: ${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`  - ${detail}\n`);
      process.exitCode = EXIT.ENVIRONMENT;
      return;
    }
    process.stderr.write(`Unexpected error: ${error?.stack ?? error}\n`);
    process.exitCode = EXIT.ENVIRONMENT;
  });
