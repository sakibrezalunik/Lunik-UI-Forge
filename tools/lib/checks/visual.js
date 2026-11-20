import path from 'node:path';
import { pathExists, sha256File, toPosix } from '../fs-utils.js';
import { getEntry, isValidSha256 } from '../baseline.js';
import { compareScreenshots } from '../diff.js';

export const id = 'visual';
export const title = 'Visual regressions';

/**
 * ` --config <path>` when the run used something other than the default config.
 *
 * The remediation is printed so a human can paste it. A command that silently
 * falls back to `lunik.config.json` would read the wrong project settings.
 */
function configFlagFor(root, configPath) {
  if (!configPath || !root) return '';
  const relative = path.relative(root, configPath);
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  const display = toPosix(inside ? relative : configPath);
  if (display === 'lunik.config.json') return '';
  return ` --config ${/\s/.test(display) ? `"${display}"` : display}`;
}

/**
 * Compares the current screenshot against the approved baseline.
 *
 * Safety rules enforced here:
 *  - A missing baseline is a FAILURE with instructions, never a silent pass and
 *    never an automatic write.
 *  - A baseline whose bytes do not match the hash recorded at approval time is
 *    treated as `inconclusive`: it was changed outside the approval workflow.
 *  - An approval record without a valid SHA-256 fingerprint is `inconclusive`
 *    too: without it there is no evidence the image is the approved one.
 *  - Nothing in this module ever writes to the baselines directory.
 */
export async function run({
  pageId,
  viewport,
  artifacts,
  baselinePath,
  manifest,
  checkConfig,
  browserVersion,
  root,
  configPath,
}) {
  const maxDiffRatio = checkConfig?.maxDiffRatio ?? 0.001;
  const pixelThreshold = checkConfig?.pixelThreshold ?? 0.1;

  // Approval is two steps now: the dry run prints the candidate, its SHA-256 and a
  // diff image, and the approval has to name that run and that hash back. The
  // remediation therefore starts with the step a human performs first.
  const approvalCommand =
    'node tools/approve-baseline.js' +
    configFlagFor(root, configPath) +
    ` --page ${pageId} --viewport ${viewport.name}`;
  const confirmCommand =
    `${approvalCommand} --run <runId> --approve-hash <sha256> --confirm`;

  if (!(await pathExists(baselinePath))) {
    return {
      ok: false,
      message: `No approved baseline for ${pageId} @ ${viewport.name}.`,
      evidence: {
        expectedBaseline: toPosix(path.relative(root, baselinePath)),
        screenshotCaptured: artifacts.screenshot,
      },
      remediation:
        'Review the captured screenshot, then approve a baseline deliberately. ' +
        `${approvalCommand} prints the candidate path, its SHA-256 and a diff image; ` +
        `confirm exactly those bytes with: ${confirmCommand}. ` +
        'Baselines are never created automatically.',
    };
  }

  const entry = getEntry(manifest, pageId, viewport.name);
  if (!entry) {
    return {
      inconclusive:
        `A baseline file exists but has no approval record in baselines/manifest.json. ` +
        `Delete it and approve a fresh baseline: ${approvalCommand}`,
    };
  }

  // Fail closed: an approval record without a usable fingerprint cannot vouch
  // for the image on disk. `readManifest` already rejects such a manifest, so
  // this is a second line of defence for callers that build one by hand.
  if (!isValidSha256(entry.sha256)) {
    return {
      inconclusive:
        `The approval record for ${pageId} @ ${viewport.name} has no valid SHA-256 fingerprint, ` +
        'so the baseline cannot be trusted. ' +
        `Re-approve it explicitly: ${approvalCommand}`,
    };
  }

  const currentHash = await sha256File(baselinePath);
  if (currentHash !== entry.sha256) {
    return {
      inconclusive:
        'The baseline file does not match the hash recorded at approval time. ' +
        'It was modified outside the approval workflow, so the comparison cannot be trusted. ' +
        `Re-approve it explicitly: ${approvalCommand}`,
    };
  }

  if (entry.browserVersion && browserVersion && entry.browserVersion !== browserVersion) {
    // Font rasterisation and layout rounding change between browser builds.
    // Surfacing this prevents a "regression" that is really a browser upgrade.
    return {
      inconclusive:
        `Baseline was approved on ${entry.browserVersion} but this run used ${browserVersion}. ` +
        'Rendering differences between browser builds make a pixel comparison unreliable. ' +
        'Re-approve on the current browser if the UI is unchanged.',
    };
  }

  const comparison = await compareScreenshots({
    baselinePath,
    actualPath: artifacts.screenshotPath,
    diffPath: artifacts.diffPath,
    pixelThreshold,
  });

  const artifactsOut = { screenshot: artifacts.screenshot };
  if (comparison.diffPath) artifactsOut.diff = artifacts.diff;

  if (comparison.reason === 'size-mismatch') {
    return {
      ok: false,
      message:
        `Screenshot size changed: baseline ${comparison.baseline.width}x${comparison.baseline.height}, ` +
        `current ${comparison.actual.width}x${comparison.actual.height}.`,
      evidence: { baseline: comparison.baseline, actual: comparison.actual },
      artifacts: artifactsOut,
      remediation:
        'A size change usually means layout or scrollbar behaviour changed. Confirm the intent, then re-approve the baseline.',
    };
  }

  if (comparison.ok) {
    return {
      ok: true,
      message: `Pixel-identical to the approved baseline (${comparison.totalPixels} px compared).`,
      evidence: { baseline: entry.file, diffPixels: 0 },
      artifacts: artifactsOut,
    };
  }

  const withinTolerance = comparison.diffRatio <= maxDiffRatio;
  return {
    ok: withinTolerance,
    message: withinTolerance
      ? `${comparison.diffPixels} px differ (${(comparison.diffRatio * 100).toFixed(3)}%), within the ${(maxDiffRatio * 100).toFixed(2)}% tolerance.`
      : `${comparison.diffPixels} px differ (${(comparison.diffRatio * 100).toFixed(3)}%), ` +
        `above the ${(maxDiffRatio * 100).toFixed(2)}% tolerance.`,
    evidence: {
      baseline: entry.file,
      diffPixels: comparison.diffPixels,
      totalPixels: comparison.totalPixels,
      diffRatio: comparison.diffRatio,
      maxDiffRatio,
    },
    artifacts: artifactsOut,
    remediation: withinTolerance
      ? null
      : 'If the change is intentional, approve the new baseline deliberately; otherwise fix the regression.',
  };
}
