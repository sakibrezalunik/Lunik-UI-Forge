export const id = 'interactions';
export const title = 'Interaction behaviour';

const STEP_TIMEOUT_MS = 2500;

/**
 * Replays scripted interaction sequences and asserts the visible result.
 * Configured per page in lunik.config.json:
 *
 *   "interactions": [
 *     { "name": "status filter narrows the table",
 *       "steps": [
 *         { "click": "[data-filter='failed']" },
 *         { "expectVisible": "[data-row][hidden] , [data-empty-state]" }
 *       ] }
 *   ]
 *
 * A failing interaction reloads the page so later interactions start clean.
 */
export async function run({ page, pageDef }) {
  const interactions = pageDef.interactions ?? [];
  if (interactions.length === 0) {
    return { skip: 'No interactions configured for this page.' };
  }

  const outcomes = [];

  for (const [index, interaction] of interactions.entries()) {
    const steps = interaction.steps ?? [];
    // Every flow starts from a fresh load so one interaction's state cannot
    // silently change the meaning of the next one.
    if (index > 0) {
      await page.reload({ waitUntil: 'load' }).catch(() => {});
    }
    try {
      for (const [index, step] of steps.entries()) {
        await executeStep(page, step, index);
      }
      outcomes.push({ name: interaction.name, ok: true });
    } catch (error) {
      outcomes.push({
        name: interaction.name,
        ok: false,
        error: String(error.message).split('\n')[0],
      });
    }
  }

  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length === 0) {
    return {
      ok: true,
      message: `All ${outcomes.length} interaction(s) behaved as expected.`,
      evidence: { interactions: outcomes },
    };
  }

  return {
    ok: false,
    message: `${failed.length} of ${outcomes.length} interaction(s) failed.`,
    evidence: { interactions: outcomes },
    remediation:
      'Fix the behaviour, or correct the selector/expectation in lunik.config.json if the interaction was described incorrectly.',
  };
}

async function executeStep(page, step, index) {
  const at = `step ${index + 1}`;
  const require = (condition, message) => {
    if (!condition) throw new Error(`${at}: ${message}`);
  };

  if (typeof step.click === 'string') {
    await page.locator(step.click).first().click({ timeout: STEP_TIMEOUT_MS });
    return;
  }

  if (typeof step.fill === 'string') {
    require(step.value !== undefined, 'fill needs a "value"');
    await page.locator(step.fill).first().fill(String(step.value), { timeout: STEP_TIMEOUT_MS });
    return;
  }

  if (typeof step.select === 'string') {
    require(step.value !== undefined, 'select needs a "value"');
    await page.locator(step.select).first().selectOption(String(step.value), { timeout: STEP_TIMEOUT_MS });
    return;
  }

  if (typeof step.press === 'string') {
    require(step.key !== undefined, 'press needs a "key"');
    await page.locator(step.press).first().press(String(step.key), { timeout: STEP_TIMEOUT_MS });
    return;
  }

  if (typeof step.hover === 'string') {
    await page.locator(step.hover).first().hover({ timeout: STEP_TIMEOUT_MS });
    return;
  }

  if (typeof step.focus === 'string') {
    await page.locator(step.focus).first().focus({ timeout: STEP_TIMEOUT_MS });
    return;
  }

  if (typeof step.expectVisible === 'string') {
    await page
      .locator(step.expectVisible)
      .first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error(`${at}: expected "${step.expectVisible}" to be visible`);
      });
    return;
  }

  if (typeof step.expectHidden === 'string') {
    const locator = page.locator(step.expectHidden);
    const count = await locator.count();
    if (count > 0 && (await locator.first().isVisible())) {
      throw new Error(`${at}: expected "${step.expectHidden}" to be hidden`);
    }
    return;
  }

  if (typeof step.expectText === 'string') {
    require(step.contains !== undefined, 'expectText needs "contains"');
    const locator = page.locator(step.expectText).first();
    await locator.waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
    const text = ((await locator.textContent()) ?? '').trim();
    if (!text.includes(String(step.contains))) {
      throw new Error(
        `${at}: "${step.expectText}" text did not contain ${JSON.stringify(String(step.contains))} (got ${JSON.stringify(text.slice(0, 80))})`,
      );
    }
    return;
  }

  if (typeof step.expectCount === 'string') {
    const count = await page.locator(step.expectCount).count();
    const { equals, atLeast } = step;
    if (equals !== undefined && count !== equals) {
      throw new Error(`${at}: expected ${equals} match(es) for "${step.expectCount}", got ${count}`);
    }
    if (atLeast !== undefined && count < atLeast) {
      throw new Error(`${at}: expected at least ${atLeast} match(es) for "${step.expectCount}", got ${count}`);
    }
    return;
  }

  if (typeof step.expectFocus === 'string') {
    const focused = await page.evaluate(
      (selector) => document.activeElement?.matches(selector) ?? false,
      step.expectFocus,
    );
    if (!focused) throw new Error(`${at}: expected focus to be on "${step.expectFocus}"`);
    return;
  }

  throw new Error(`${at}: unrecognised step ${JSON.stringify(step)}`);
}
