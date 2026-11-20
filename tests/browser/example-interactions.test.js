/**
 * Phase 25 — permanent interaction coverage for the two example dashboards.
 *
 * Focus continuation after acknowledgement, the last-action fallback, the
 * focusable scroll region, and the overflow cue's 1px behaviour are already
 * covered permanently in examples.test.js and responsive-layout.test.js. This
 * file covers the interactions added in Phase 24 and the narrow-width fixes:
 *
 *   - Northwind notifications, sorting, CSV export, "/" search, empty state,
 *     live MRR, and the 320px search presentation.
 *   - Sentinel severity counts, filter/reset, acknowledgement state, refresh
 *     honesty, "/" search, and the soft overflow edge.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from '../../tools/lib/server.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAAS = '/examples/saas-dashboard/index.html';
const CYBER = '/examples/cybersecurity-dashboard/index.html';

const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 834, height: 1112 };
const NARROW = { width: 320, height: 844 };

let server;
let browser;

before(async () => {
  server = await startStaticServer({ root: PROJECT });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
});

/** Open one page in its own context and collect every browser error. */
async function open(url, viewport = DESKTOP) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: 'reduce',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = { console: [], pageerror: [] };

  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', (error) => errors.pageerror.push(error?.message ?? String(error)));

  await page.goto(server.urlFor(url), { waitUntil: 'load' });
  return { context, page, errors };
}

function assertNoErrors(errors, label) {
  assert.deepEqual(errors.console, [], `${label}: no console errors`);
  assert.deepEqual(errors.pageerror, [], `${label}: no uncaught errors`);
}

async function firstAccountName(page) {
  return (await page.locator('[data-row] .account-name').first().textContent()).trim();
}

async function sortState(page, key) {
  return page.locator(`[data-sort="${key}"]`).evaluate((button) => ({
    ariaSort: button.closest('th').getAttribute('aria-sort'),
    direction: button.dataset.direction ?? null,
    iconOpacity: Number(getComputedStyle(button.querySelector('.sort-icon')).opacity),
  }));
}

/**
 * The example's reduced-motion rule gives every element a 0.01ms transition, so
 * a computed style read in the same task as the click can still be the starting
 * value. Wait for the rendered state, not for a fixed sleep.
 */
async function waitForSortIcon(page, key, visible) {
  await page.waitForFunction(
    ({ sortKey, expected }) => {
      const icon = document.querySelector(`[data-sort="${sortKey}"] .sort-icon`);
      if (!icon) return false;
      const opacity = Number(getComputedStyle(icon).opacity);
      return expected ? opacity > 0 : opacity === 0;
    },
    { sortKey: key, expected: visible },
    { timeout: 1000, polling: 16 },
  );
}

/** Read the CSV produced by the Export button. */
async function exportCsv(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="export"]').click(),
  ]);
  const stream = await download.createReadStream();
  assert.ok(stream, 'the export must produce a readable download');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function firstCsvField(line) {
  return line.split(',')[0].replace(/^"|"$/g, '').replace(/""/g, '"');
}

/* ------------------------------------------------------------------ Northwind */

test('Northwind: notifications open with focus on Mark all read, then mark read', async () => {
  const { context, page, errors } = await open(SAAS);
  try {
    const trigger = page.locator('[data-action="notifications"]');
    const panel = page.locator('[data-notifications-panel]');
    const markRead = page.locator('[data-action="mark-read"]');

    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.click();

    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await panel.isVisible(), true);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-action')),
      'mark-read',
      'opening the panel must move focus to its first action',
    );
    assert.equal(await page.locator('[data-unread]').count(), 3);

    await markRead.click();

    assert.equal(await panel.getAttribute('data-read'), 'true');
    assert.equal(await page.locator('.notifications').evaluate((el) => el.classList.contains('is-read')), true);
    assert.equal(await page.locator('[data-notification-dot]').isVisible(), false);
    assert.equal(await markRead.isDisabled(), true);
    assert.equal((await markRead.textContent()).trim(), 'All read');
    assert.match(
      (await page.locator('[data-notifications-status]').textContent()).trim(),
      /All notifications marked as read/,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-action')),
      'notifications',
      'the trigger must receive focus back after marking all read',
    );

    assertNoErrors(errors, 'Northwind notifications');
  } finally {
    await context.close();
  }
});

test('Northwind: Escape closes notifications and restores focus', async () => {
  const { context, page, errors } = await open(SAAS);
  try {
    const trigger = page.locator('[data-action="notifications"]');
    await trigger.click();
    assert.equal(await page.locator('[data-notifications-panel]').isVisible(), true);

    await page.keyboard.press('Escape');

    assert.equal(await page.locator('[data-notifications-panel]').isVisible(), false);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-action')),
      'notifications',
      'Escape must return focus to the trigger',
    );

    assertNoErrors(errors, 'Northwind notification Escape');
  } finally {
    await context.close();
  }
});

test('Northwind: an outside click closes notifications', async () => {
  const { context, page, errors } = await open(SAAS);
  try {
    const trigger = page.locator('[data-action="notifications"]');
    await trigger.click();
    assert.equal(await page.locator('[data-notifications-panel]').isVisible(), true);

    await page.locator('h1').click();

    assert.equal(await page.locator('[data-notifications-panel]').isVisible(), false);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

    assertNoErrors(errors, 'Northwind notification outside click');
  } finally {
    await context.close();
  }
});

test('Northwind: Account, Seats and MRR sorting agree with aria-sort and the arrow', async () => {
  const { context, page, errors } = await open(SAAS);
  try {
    assert.equal(await firstAccountName(page), 'Tailspin Toys');
    await waitForSortIcon(page, 'mrr', true);
    let state = await sortState(page, 'mrr');
    assert.equal(state.ariaSort, 'descending');
    assert.equal(state.direction, 'desc');
    assert.ok(state.iconOpacity > 0);

    await page.locator('[data-sort="seats"]').click();
    assert.equal(await firstAccountName(page), 'Tailspin Toys');
    await waitForSortIcon(page, 'seats', true);
    await waitForSortIcon(page, 'mrr', false);
    state = await sortState(page, 'seats');
    assert.equal(state.ariaSort, 'descending');
    assert.equal(state.direction, 'desc');
    assert.ok(state.iconOpacity > 0);
    assert.equal((await sortState(page, 'mrr')).ariaSort, 'none');
    assert.equal((await sortState(page, 'mrr')).direction, null);
    assert.equal((await sortState(page, 'mrr')).iconOpacity, 0);

    await page.locator('[data-sort="seats"]').click();
    assert.equal(await firstAccountName(page), 'Coho Vineyard');
    await waitForSortIcon(page, 'seats', true);
    assert.equal((await sortState(page, 'seats')).ariaSort, 'ascending');
    assert.equal((await sortState(page, 'seats')).direction, 'asc');

    await page.locator('[data-sort="name"]').click();
    assert.equal(await firstAccountName(page), 'Adventure Works');
    await waitForSortIcon(page, 'name', true);
    assert.equal((await sortState(page, 'name')).ariaSort, 'ascending');

    await page.locator('[data-sort="name"]').click();
    assert.equal(await firstAccountName(page), 'Wide World Importers');
    await waitForSortIcon(page, 'name', true);
    assert.equal((await sortState(page, 'name')).ariaSort, 'descending');

    await page.locator('[data-sort="mrr"]').click();
    assert.equal(await firstAccountName(page), 'Tailspin Toys');
    await waitForSortIcon(page, 'mrr', true);
    assert.equal((await sortState(page, 'mrr')).ariaSort, 'descending');

    await page.locator('[data-sort="mrr"]').click();
    assert.equal(await firstAccountName(page), 'Coho Vineyard');
    await waitForSortIcon(page, 'mrr', true);
    assert.equal((await sortState(page, 'mrr')).ariaSort, 'ascending');

    assertNoErrors(errors, 'Northwind sorting');
  } finally {
    await context.close();
  }
});

test('Northwind: CSV export respects the current filter, search and sort', async () => {
  const { context, page, errors } = await open(SAAS);
  try {
    await page.locator('[data-filter="paused"]').click();
    await page.locator('[data-search]').fill('o');
    assert.equal(await page.locator('[data-row]').count(), 2);
    assert.equal((await page.locator('[data-total-mrr]').textContent()).trim(), '$2,720');

    await page.locator('[data-sort="name"]').click();
    const csv = await exportCsv(page);
    const lines = csv.replace(/\r\n/g, '\n').trim().split('\n');

    assert.equal(lines[0], 'Account,Plan,Status,Seats,MRR');
    assert.equal(lines.length, 3, 'header plus the two filtered, searched rows');
    assert.deepEqual(lines.slice(1).map(firstCsvField), ['Adventure Works', 'Coho Vineyard']);
    assert.equal(csv.includes('Litware'), false, 'the filtered-out account must not be exported');

    assertNoErrors(errors, 'Northwind CSV export');
  } finally {
    await context.close();
  }
});

test('Northwind: "/" focuses search only when focus is not in a control', async () => {
  const { context, page, errors } = await open(SAAS);
  try {
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'account-search');

    await page.locator('[data-action="export"]').focus();
    await page.keyboard.press('/');
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-action')),
      'export',
      'a focused button must keep the slash key',
    );
    assert.equal(await page.locator('[data-search]').inputValue(), '');

    await page.locator('[data-search]').focus();
    await page.keyboard.press('/');
    assert.equal(await page.locator('[data-search]').inputValue(), '/');

    assertNoErrors(errors, 'Northwind slash shortcut');
  } finally {
    await context.close();
  }
});

test('Northwind: empty state, reset and live MRR stay in sync', async () => {
  const { context, page, errors } = await open(SAAS);
  try {
    assert.equal((await page.locator('[data-total-mrr]').textContent()).trim(), '$87,700');

    await page.locator('[data-search]').fill('tailspin');
    assert.equal(await page.locator('[data-row]').count(), 1);
    assert.equal((await page.locator('[data-total-mrr]').textContent()).trim(), '$21,600');

    await page.locator('[data-filter="churned"]').click();
    assert.equal(await page.locator('[data-empty-state]').isVisible(), true);
    assert.equal(await page.locator('[data-accounts-table]').isVisible(), false);
    assert.equal((await page.locator('[data-result-count]').textContent()).trim(), '0');
    assert.equal((await page.locator('[data-total-mrr]').textContent()).trim(), '$0');

    await page.locator('[data-action="reset-filters"]').click();
    assert.equal(await page.locator('[data-row]').count(), 12);
    assert.equal((await page.locator('[data-total-mrr]').textContent()).trim(), '$87,700');
    assert.equal(await page.locator('[data-search]').inputValue(), '');
    assert.equal(await page.locator('[data-filter="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'account-search');

    await page.locator('[data-filter="paused"]').click();
    assert.equal(await page.locator('[data-row]').count(), 3);
    assert.equal((await page.locator('[data-total-mrr]').textContent()).trim(), '$3,200');

    await page.locator('[data-filter="all"]').click();
    assert.equal(await page.locator('[data-row]').count(), 12);
    assert.equal((await page.locator('[data-total-mrr]').textContent()).trim(), '$87,700');

    assertNoErrors(errors, 'Northwind empty state and total');
  } finally {
    await context.close();
  }
});

test('Northwind: the 320px search field shows the full placeholder', async () => {
  const { context, page, errors } = await open(SAAS, NARROW);
  try {
    const measured = await page.evaluate(() => {
      const input = document.querySelector('[data-search]');
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const drawing = canvas.getContext('2d');
      drawing.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {
        placeholderWidth: drawing.measureText(input.placeholder).width,
        usable:
          input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        documentWidth: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
        ),
      };
    });

    // Chromium reserves roughly 16px inside a search field for its native
    // cancel control. The canvas measurement alone overstates the visible text
    // area and would pass a placeholder that still clips.
    const SEARCH_DECORATION = 16;
    assert.ok(
      measured.placeholderWidth <= measured.usable - SEARCH_DECORATION,
      `the placeholder must fit beside the native search control, needs ` +
        `${measured.placeholderWidth}px of ${measured.usable - SEARCH_DECORATION}px`,
    );
    assert.ok(measured.documentWidth <= NARROW.width);
    assertNoErrors(errors, 'Northwind narrow search');
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------- Sentinel */

test('Sentinel: severity counts match the queue, and filter/reset work', async () => {
  const { context, page, errors } = await open(CYBER);
  try {
    const count = async (key) =>
      (await page.locator(`[data-count="${key}"]`).textContent()).trim();
    assert.equal(await count('all'), '8');
    assert.equal(await count('critical'), '2');
    assert.equal(await count('high'), '2');
    assert.equal(await count('medium'), '3');

    await page.locator('[data-severity="critical"]').click();
    assert.equal(await page.locator('[data-row]').count(), 2);
    assert.equal((await page.locator('[data-result-count]').textContent()).trim(), '2');
    assert.deepEqual(
      await page.locator('[data-row] .badge').allTextContents(),
      ['Critical', 'Critical'],
    );

    await page.locator('[data-severity="high"]').click();
    assert.equal(await page.locator('[data-row]').count(), 2);
    assert.deepEqual(await page.locator('[data-row] .badge').allTextContents(), ['High', 'High']);

    await page.locator('[data-severity="all"]').click();
    assert.equal(await page.locator('[data-row]').count(), 8);

    await page.locator('[data-search]').fill('zzzz-no-match');
    assert.equal(await page.locator('[data-empty-state]').isVisible(), true);
    assert.equal(await page.locator('[data-alert-table]').isVisible(), false);
    assert.equal((await page.locator('[data-result-count]').textContent()).trim(), '0');

    await page.locator('[data-action="reset-filters"]').click();
    assert.equal(await page.locator('[data-row]').count(), 8);
    assert.equal(await page.locator('[data-alert-table]').isVisible(), true);
    assert.equal(await page.locator('[data-search]').inputValue(), '');
    assert.equal(await page.locator('[data-severity="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'alert-search');

    assertNoErrors(errors, 'Sentinel counts and filters');
  } finally {
    await context.close();
  }
});

test('Sentinel: acknowledgement changes only its row and disables its action', async () => {
  const { context, page, errors } = await open(CYBER);
  try {
    const acknowledgedButton = page.locator(
      '[data-action="acknowledge"][data-alert="ALT-2038"]',
    );
    await acknowledgedButton.click();

    assert.match(
      (await page.locator('[data-state-cell="ALT-2038"]').textContent()).trim(),
      /Acknowledged/,
    );
    assert.equal(
      await page.locator('[data-alert-row="ALT-2038"]').evaluate((el) =>
        el.classList.contains('is-acknowledged'),
      ),
      true,
    );
    assert.equal(await acknowledgedButton.isDisabled(), true);

    assert.match(
      (await page.locator('[data-state-cell="ALT-2041"]').textContent()).trim(),
      /Investigating/,
      'the neighbouring row must keep its state',
    );
    assert.equal(
      await page.locator('[data-action="acknowledge"][data-alert="ALT-2041"]').isEnabled(),
      true,
    );
    assert.equal(await page.locator('[data-row]').count(), 8);

    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-alert')),
      'ALT-2035',
      'focus must continue at the next actionable alert',
    );

    assertNoErrors(errors, 'Sentinel acknowledgement');
  } finally {
    await context.close();
  }
});

test('Sentinel: refresh updates the timestamp and claims no fetch', async () => {
  const { context, page, errors } = await open(CYBER);
  try {
    assert.equal((await page.locator('[data-last-refreshed]').textContent()).trim(), 'Updated 09:41');

    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.waitForTimeout(50);
    requests.length = 0;

    await page.locator('[data-action="refresh"]').click();
    await page.waitForTimeout(100);

    assert.equal((await page.locator('[data-last-refreshed]').textContent()).trim(), 'Updated just now');
    assert.match(
      (await page.locator('[data-live-status]').textContent()).trim(),
      /No external request was made/,
    );
    assert.deepEqual(requests, [], 'refresh must stay local');
    assert.equal(await page.locator('[data-row]').count(), 8);

    assertNoErrors(errors, 'Sentinel refresh');
  } finally {
    await context.close();
  }
});

test('Sentinel: "/" focuses search only when focus is not in a control', async () => {
  const { context, page, errors } = await open(CYBER);
  try {
    await page.locator('[data-action="refresh"]').focus();
    await page.keyboard.press('/');
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-action')),
      'refresh',
    );
    assert.equal(await page.locator('[data-search]').inputValue(), '');

    await page.locator('.table-wrap').focus();
    await page.keyboard.press('/');
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains('table-wrap')),
      true,
      'the focusable scroll region must keep the slash key',
    );
    assert.equal(await page.locator('[data-search]').inputValue(), '');

    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'alert-search');
    await page.keyboard.press('/');
    assert.equal(await page.locator('[data-search]').inputValue(), '/');

    assertNoErrors(errors, 'Sentinel slash shortcut');
  } finally {
    await context.close();
  }
});

test('Sentinel: the soft edge covers the clipped action only while overflow remains', async () => {
  const wide = await open(CYBER, DESKTOP);
  try {
    const desktopEdge = await wide.page.locator('[data-scroll-edge]').evaluate((el) => ({
      visible: el.dataset.visible,
      opacity: getComputedStyle(el).opacity,
    }));
    assert.notEqual(desktopEdge.visible, 'true');
    assert.equal(desktopEdge.opacity, '0');
    assertNoErrors(wide.errors, 'Sentinel edge at desktop');
  } finally {
    await wide.context.close();
  }

  const narrow = await open(CYBER, TABLET);
  try {
    await narrow.page.waitForFunction(
      () => {
        const edge = document.querySelector('[data-scroll-edge]');
        return (
          edge?.dataset.visible === 'true' && getComputedStyle(edge).opacity === '1'
        );
      },
      undefined,
      { timeout: 2000, polling: 16 },
    );

    const rest = await narrow.page.evaluate(() => {
      const edge = document.querySelector('[data-scroll-edge]');
      const button = document.querySelector('[data-action="acknowledge"]');
      return {
        edgeOpacity: getComputedStyle(edge).opacity,
        edgePointerEvents: getComputedStyle(edge).pointerEvents,
        edgeLeft: edge.getBoundingClientRect().left,
        buttonLeft: button.getBoundingClientRect().left,
        wrapper: document.querySelector('.table-wrap').getBoundingClientRect().right,
      };
    });

    assert.equal(rest.edgeOpacity, '1');
    assert.equal(rest.edgePointerEvents, 'none');
    assert.ok(
      rest.edgeLeft <= rest.buttonLeft,
      `the fade must reach the clipped action: edge ${rest.edgeLeft}, button ${rest.buttonLeft}`,
    );
    assert.ok(rest.buttonLeft < rest.wrapper, 'precondition: the action is partially clipped');

    await narrow.page.locator('.table-wrap').evaluate((el) => {
      el.scrollLeft = el.scrollWidth - el.clientWidth;
    });
    await narrow.page.waitForFunction(
      () => {
        const edge = document.querySelector('[data-scroll-edge]');
        return (
          edge?.dataset.visible === 'false' && getComputedStyle(edge).opacity === '0'
        );
      },
      undefined,
      { timeout: 2000, polling: 16 },
    );
    assert.equal(
      await narrow.page.locator('[data-scroll-edge]').evaluate((el) => getComputedStyle(el).opacity),
      '0',
      'the edge must disappear at the rightmost position',
    );

    assertNoErrors(narrow.errors, 'Sentinel edge at tablet');
  } finally {
    await narrow.context.close();
  }
});
