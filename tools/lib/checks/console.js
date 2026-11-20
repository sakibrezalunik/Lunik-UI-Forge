export const id = 'console';
export const title = 'Browser console errors';

/**
 * Uncaught exceptions and `console.error` calls captured across the whole
 * verification window: page load *and* the configured interactions. The runner
 * defers this check until after interactions run, so it stays a pure function
 * over the collectors.
 *
 * Warnings and logs are ignored on purpose: they are too noisy to gate a build.
 */
export function run({ collectors }) {
  const items = [
    ...collectors.pageErrors.map((error) => ({
      kind: 'uncaught-exception',
      text: error.message,
      source: null,
    })),
    ...collectors.consoleErrors.map((entry) => ({
      kind: `console.${entry.type}`,
      text: entry.text,
      source: entry.location,
    })),
  ];

  if (items.length === 0) {
    return { ok: true, message: 'No console errors or uncaught exceptions.' };
  }

  return {
    ok: false,
    message: `${items.length} console error(s) during load and interactions.`,
    evidence: { count: items.length, items: items.slice(0, 10) },
    remediation:
      'Fix the underlying exception or remove the failing console.error call. Re-run to confirm it is gone.',
  };
}
