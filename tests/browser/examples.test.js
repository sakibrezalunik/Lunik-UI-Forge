/**
 * M-3 regression — the horizontally scrollable alert table must be reachable by
 * keyboard and named, without changing the table's own semantics or breaking any
 * existing check.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from '../../tools/lib/server.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test', 'examples');
const CONFIG = path.join(TMP, 'config-mobile.json');
const REPORTS = 'tests/.tmp-test/examples/reports';

const REGION_NAME = 'Scrollable security alerts table';
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const DASHBOARD = '/examples/cybersecurity-dashboard/index.html';

let server;
let browser;
let context;
let page;

before(async () => {
  server = await startStaticServer({ root: PROJECT });
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: MOBILE, reducedMotion: 'reduce' });
  page = await context.newPage();
  await page.goto(server.urlFor(DASHBOARD), { waitUntil: 'load' });
});

/** What actually has focus, plus the computed focus styling on it. */
async function focusState(target) {
  return target.evaluate(() => {
    const element = document.activeElement;
    const style = element ? getComputedStyle(element) : null;
    return {
      tag: element?.tagName ?? null,
      action: element?.getAttribute?.('data-action') ?? null,
      alert: element?.getAttribute?.('data-alert') ?? null,
      ariaLabel: element?.getAttribute?.('aria-label') ?? null,
      className: typeof element?.className === 'string' ? element.className : null,
      disabled: typeof element?.disabled === 'boolean' ? element.disabled : null,
      focusVisible: element ? element.matches(':focus-visible') : false,
      outlineStyle: style?.outlineStyle ?? null,
      outlineWidth: style?.outlineWidth ?? null,
    };
  });
}

/**
 * Load a clean dashboard, acknowledge one alert with the keyboard only, and
 * report where focus and the acknowledgement state ended up.
 */
async function acknowledgeWithKeyboard(target, alertId) {
  await target.goto(server.urlFor(DASHBOARD), { waitUntil: 'load' });

  const button = target.locator(`[data-action="acknowledge"][data-alert="${alertId}"]`);
  await button.focus();
  assert.equal(
    await target.evaluate(() => document.activeElement?.getAttribute('data-alert')),
    alertId,
    'precondition: the acknowledge button must have focus before the key press',
  );

  await target.keyboard.press('Enter');

  const stateText = (await target.locator(`[data-state-cell="${alertId}"]`).textContent()).trim();
  assert.match(stateText, /Acknowledged/, 'the acknowledgement must still take effect');

  return focusState(target);
}

after(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  await rm(TMP, { recursive: true, force: true });
});

test('the scroll container can be reached with the keyboard', async () => {
  let reached = false;
  for (let press = 0; press < 60 && !reached; press += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() =>
      document.activeElement?.classList.contains('table-wrap') ?? false,
    );
  }

  assert.equal(reached, true, 'Tab must be able to focus the scrollable alert table wrapper');
  assert.equal(
    await page.locator('.table-wrap').evaluate((element) => element.tabIndex),
    0,
  );

  // The region is focused right now, so the focus ring must be visible on it.
  const outline = await page
    .locator('.table-wrap')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
  assert.notEqual(outline.style, 'none', 'a focused scroll container must show a focus ring');
  assert.notEqual(outline.width, '0px');
});

test('the scroll container has a meaningful accessible name', async () => {
  assert.equal(await page.getByRole('region', { name: REGION_NAME }).count(), 1);

  const wrapper = page.locator('.table-wrap');
  assert.equal(await wrapper.getAttribute('aria-label'), REGION_NAME);
  assert.equal(await wrapper.getAttribute('role'), 'region');
});

test('the wrapper really is the scrolling element at mobile width', async () => {
  // Proves the focus stop is needed rather than decorative: at 390 px the table
  // is wider than the wrapper, so this region genuinely scrolls.
  const metrics = await page.locator('.table-wrap').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));

  assert.equal(metrics.overflowX, 'auto');
  assert.ok(
    metrics.scrollWidth > metrics.clientWidth,
    `expected horizontal scrolling inside the wrapper: ${JSON.stringify(metrics)}`,
  );
});

test('the table keeps its own semantics inside the focusable wrapper', async () => {
  assert.equal(await page.getByRole('table').count(), 1);

  const caption = (await page.locator('[data-alert-table] > caption').textContent()).trim();
  assert.match(caption, /Alerts with severity/);

  const scopeCount = await page.locator('[data-alert-table] th[scope="col"]').count();
  assert.equal(scopeCount, 6, 'every column header keeps scope="col"');

  const rows = await page.locator('[data-alert-table] tbody tr').count();
  assert.ok(rows > 0, 'rendered alert rows remain present');
});

test('acknowledging with the keyboard moves focus to the next alert action', async () => {
  // M-3 follow-up: the acknowledged control is disabled by the re-render, so
  // focusing it is a no-op and focus used to fall back to <body>.
  const focus = await acknowledgeWithKeyboard(page, 'ALT-2041');

  assert.notEqual(focus.tag, 'BODY', 'focus must not fall back to the document body');
  assert.notEqual(focus.tag, null, 'something must be focused after acknowledging');
  assert.equal(focus.disabled, false, 'focus must never end up on a disabled control');
  assert.equal(focus.action, 'acknowledge', 'focus continues at the next alert action');
  assert.equal(focus.alert, 'ALT-2038', 'that action belongs to the next alert in the queue');
  assert.match(
    focus.ariaLabel ?? '',
    /^Acknowledge alert ALT-2038:/,
    'the focused control must carry its alert in its accessible name',
  );
  assert.equal(focus.focusVisible, true, 'keyboard focus must stay visible');
  assert.notEqual(focus.outlineStyle, 'none');
  assert.notEqual(focus.outlineWidth, '0px');
});

test('acknowledging the last alert moves focus to the named table region', async () => {
  const focus = await acknowledgeWithKeyboard(page, 'ALT-2014');

  assert.notEqual(focus.tag, 'BODY');
  assert.equal(focus.disabled, null, 'the region is not a control and cannot be disabled');
  assert.match(focus.className ?? '', /table-wrap/);
  assert.equal(
    await page.getByRole('region', { name: REGION_NAME }).count(),
    1,
    'the fallback target must still be the named scrollable region',
  );
  assert.equal(focus.focusVisible, true, 'keyboard focus must stay visible');
});

test('focus restoration behaves the same at desktop width', async () => {
  const desktopContext = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce' });
  const desktopPage = await desktopContext.newPage();
  try {
    const focus = await acknowledgeWithKeyboard(desktopPage, 'ALT-2041');

    assert.notEqual(focus.tag, 'BODY');
    assert.equal(focus.action, 'acknowledge');
    assert.equal(focus.alert, 'ALT-2038');
    assert.equal(focus.disabled, false);
  } finally {
    await desktopContext.close().catch(() => {});
  }
});

test('the mobile page still passes every enabled check, interactions included', async () => {
  await mkdir(TMP, { recursive: true });
  const real = JSON.parse(await readFile(path.join(PROJECT, 'lunik.config.json'), 'utf8'));
  const cyber = real.pages.find((entry) => entry.id === 'cybersecurity-dashboard');
  assert.ok(cyber, 'the cybersecurity example must stay configured');

  await writeFile(
    CONFIG,
    `${JSON.stringify(
      {
        viewports: [{ name: 'mobile', ...MOBILE }],
        reportsDir: REPORTS,
        checks: { visual: { enabled: false } },
        // Reuse the real page definition so the shipped interactions are covered.
        pages: [cyber],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const result = spawnSync(
    process.execPath,
    ['tools/visual-verify.js', '--config', CONFIG, '--quiet'],
    { cwd: PROJECT, encoding: 'utf8', timeout: 180_000 },
  );

  assert.equal(result.status, 0, `expected a clean mobile run\n${result.stdout}\n${result.stderr}`);

  const report = JSON.parse(await readFile(path.join(PROJECT, REPORTS, 'latest.json'), 'utf8'));
  const byCheck = new Map(report.results.map((entry) => [entry.check, entry]));

  for (const check of [
    'console',
    'network',
    'overflow',
    'a11yNames',
    'labels',
    'contrast',
    'links',
    'elements',
    'interactions',
  ]) {
    assert.equal(byCheck.get(check)?.status, 'pass', `${check} should pass: ${JSON.stringify(byCheck.get(check)?.message)}`);
  }

  const interactions = byCheck.get('interactions');
  assert.equal(interactions.evidence.interactions.length, 3, 'all configured flows ran');
});
