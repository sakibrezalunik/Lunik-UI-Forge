import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { ensureDir, round } from './fs-utils.js';

/**
 * Compare two PNG screenshots pixel by pixel.
 *
 * Limitations that are inherent to this technique and are repeated in the docs:
 *  - Font rasterisation and anti-aliasing differ across OS versions and GPUs,
 *    so a baseline is only meaningful on the machine class that produced it.
 *  - Animated content, carets, scrollbars, and time-dependent text produce
 *    differences that are not defects.
 *  - A pixel diff says nothing about accessibility or semantic correctness.
 *
 * @param {object} options
 * @param {string} options.baselinePath
 * @param {string} options.actualPath
 * @param {string} [options.diffPath] where to write the visual diff image
 * @param {number} [options.pixelThreshold] pixelmatch colour tolerance (0-1)
 */
export async function compareScreenshots({
  baselinePath,
  actualPath,
  diffPath,
  pixelThreshold = 0.1,
}) {
  const baseline = PNG.sync.read(await readFile(baselinePath));
  const actual = PNG.sync.read(await readFile(actualPath));

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      ok: false,
      reason: 'size-mismatch',
      baseline: { width: baseline.width, height: baseline.height },
      actual: { width: actual.width, height: actual.height },
      diffPixels: null,
      totalPixels: null,
      diffRatio: null,
      diffPath: null,
    };
  }

  const { width, height } = actual;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(baseline.data, actual.data, diff.data, width, height, {
    threshold: pixelThreshold,
  });
  const totalPixels = width * height;

  let writtenDiffPath = null;
  if (diffPath) {
    await ensureDir(path.dirname(diffPath));
    await writeFile(diffPath, PNG.sync.write(diff));
    writtenDiffPath = diffPath;
  }

  return {
    ok: diffPixels === 0,
    reason: diffPixels === 0 ? 'identical' : 'pixels-differ',
    baseline: { width, height },
    actual: { width, height },
    diffPixels,
    totalPixels,
    diffRatio: round(diffPixels / totalPixels, 6),
    diffPath: writtenDiffPath,
  };
}
