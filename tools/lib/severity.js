/**
 * Shared vocabulary for verification outcomes.
 *
 * The distinction that matters most: a check that could not run is NOT a pass.
 * `inconclusive` exists so that "we failed to measure" can never be silently
 * folded into "everything is fine".
 */

/** How badly a violation matters. Configured per check. */
export const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
});

/** The outcome of actually running a check. */
export const STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  WARNING: 'warning',
  /** The check ran but could not produce a trustworthy answer. Never a pass. */
  INCONCLUSIVE: 'inconclusive',
  /** The check did not apply (not configured, nothing to inspect). */
  SKIPPED: 'skipped',
});

/**
 * Process exit codes. A caller must be able to tell "verified and broken"
 * apart from "verification never happened".
 */
export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  ENVIRONMENT: 3,
});

export const VALID_SEVERITIES = Object.freeze(Object.values(SEVERITY));
export const VALID_STATUSES = Object.freeze(Object.values(STATUS));

/**
 * Turn a check's raw verdict into a status, honouring the configured severity.
 * A violation of a `warning`-severity check is reported as `warning`, not `fail`.
 *
 * @param {boolean} ok
 * @param {string} severity
 * @returns {string}
 */
export function statusFor(ok, severity) {
  if (ok) return STATUS.PASS;
  return severity === SEVERITY.WARNING ? STATUS.WARNING : STATUS.FAIL;
}

/**
 * Reduce a list of results into counts plus an overall verdict.
 *
 * @param {Array<{status: string}>} results
 * @param {{strict?: boolean}} [options] strict makes warnings fatal
 */
export function summarize(results, options = {}) {
  const counts = {
    [STATUS.PASS]: 0,
    [STATUS.FAIL]: 0,
    [STATUS.WARNING]: 0,
    [STATUS.INCONCLUSIVE]: 0,
    [STATUS.SKIPPED]: 0,
  };
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }

  const failing = counts[STATUS.FAIL] + (options.strict ? counts[STATUS.WARNING] : 0);
  let status = STATUS.PASS;
  if (failing > 0) status = STATUS.FAIL;
  else if (counts[STATUS.INCONCLUSIVE] > 0) status = STATUS.INCONCLUSIVE;
  else if (counts[STATUS.WARNING] > 0) status = STATUS.WARNING;

  return { counts, status };
}

/**
 * Map an overall verdict to a process exit code.
 *
 * @param {string} status overall status from {@link summarize}
 * @returns {number}
 */
export function exitCodeFor(status) {
  if (status === STATUS.PASS || status === STATUS.WARNING || status === STATUS.SKIPPED) {
    return EXIT.OK;
  }
  if (status === STATUS.INCONCLUSIVE) return EXIT.ENVIRONMENT;
  return EXIT.FAILURE;
}
