export const id = 'elements';
export const title = 'Expected page elements';

/**
 * Verifies that the elements a page is supposed to render are actually present
 * and visible. Catches the "the app didn't boot" class of failure, which a
 * screenshot alone can miss when the empty page looks plausible.
 *
 * Configured per page:
 *   "expect": { "selectors": [".metric-grid", { "selector": "#table", "text": "Alerts" }] }
 */
export async function run({ page, pageDef }) {
  const expected = pageDef.expect?.selectors ?? [];
  if (expected.length === 0) {
    return { skip: 'No expected selectors configured for this page.' };
  }

  const missing = [];
  const invisible = [];
  const wrongText = [];

  for (const entry of expected) {
    const selector = typeof entry === 'string' ? entry : entry.selector;
    const expectedText = typeof entry === 'string' ? null : entry.text ?? null;

    const locator = page.locator(selector).first();
    const count = await page.locator(selector).count();
    if (count === 0) {
      missing.push(selector);
      continue;
    }
    if (!(await locator.isVisible())) {
      invisible.push(selector);
      continue;
    }
    if (expectedText !== null) {
      const actual = ((await locator.textContent()) ?? '').trim();
      if (!actual.includes(expectedText)) {
        wrongText.push({ selector, expectedText, actual: actual.slice(0, 120) });
      }
    }
  }

  if (missing.length === 0 && invisible.length === 0 && wrongText.length === 0) {
    return {
      ok: true,
      message: `All ${expected.length} expected element(s) are present and visible.`,
    };
  }

  return {
    ok: false,
    message:
      `${missing.length} missing, ${invisible.length} hidden, ${wrongText.length} with unexpected text.`,
    evidence: { missing, invisible, wrongText },
    remediation:
      'Render the expected content, or update lunik.config.json if the page legitimately changed.',
  };
}
