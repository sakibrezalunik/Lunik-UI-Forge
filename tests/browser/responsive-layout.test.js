/**
 * Phase 13 responsive regressions for the four defects the independent visual
 * audit confirmed:
 *
 *  V1  the sample-data disclosure was below the fold at every width (and
 *      `display: none` below 1024px), so no screenshot ever showed it
 *  V2  the metric row produced three columns plus an orphaned fourth card at
 *      1024–1199px and at tablet width on both example pages
 *  V3  the SaaS mobile header pushed the notification button onto its own row
 *  V4  the cybersecurity tablet alert table crushed the asset column instead of
 *      scrolling, breaking `edge-gateway-01` mid-identifier
 *
 * Every assertion below is made against rendered geometry or runtime behaviour
 * (bounding boxes, range rects, scroll offsets) rather than against the CSS
 * declarations that are supposed to produce them, so a refactor cannot make a
 * test pass while the page still looks wrong.
 *
 * Phase 15 extended this file rather than starting a second suite:
 *
 *  V1  nine sample points across the disclosure instead of one centre point,
 *      so a partly covered note can no longer pass unnoticed
 *  V2  the four-up transition moved to 1220px, because at 1200px each card's
 *      content box was 160px while the label needed 160.9px. Every case now
 *      also asserts one line per label and value and a shared value baseline
 *      per row — precisely the symptom that boundary produced
 *  V3  the header search field is checked for usability at 320px
 *  V4  the last column is checked for reachability at maximum scroll, keyboard
 *      focus is checked to leave the scroll box, and the right-edge scroll
 *      affordance is checked against rendered pixels at four scroll states
 *
 * Phase 17 replaced the scroll affordance and hardened the assertions around it:
 *
 *  - the affordance is no longer a darkening gradient. Measured, a dark veil on
 *    this surface cannot exceed 1.19:1, and the 64px `local` layer that hid it
 *    at the rightmost position also hid it for any overflow smaller than 64px.
 *    It is now a labelled cue above the table whose visibility follows the real
 *    scroll state (see `.table-scroll-hint` in styles.css and
 *    `syncScrollHint()` in app.js).
 *  - "is the cue visible" is answered by rendered pixels: the cue crop is read
 *    back and its actual glyph colours are compared with the surface behind
 *    them, so the threshold is a WCAG contrast ratio computed from what the
 *    browser drew, not from a declared colour string.
 *  - the sample-data disclosure gets the same treatment: a real computed
 *    foreground/background ratio, with the background resolved by compositing
 *    the actual ancestor colours instead of assuming a solid one.
 *  - every page is opened through a helper that collects `console` errors and
 *    uncaught `pageerror`s before any application code runs, and each case
 *    asserts the collection is empty.
 *  - scroll positions are committed by waiting for the requested `scrollLeft`
 *    to be the observed one, with bounded timeouts and a diagnostic that names
 *    what was requested and what was seen. No fixed sleeps stand in for that.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import { startStaticServer } from '../../tools/lib/server.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PAGES = {
  'saas-dashboard': {
    url: '/examples/saas-dashboard/index.html',
    disclosure: /no network requests/,
  },
  'cybersecurity-dashboard': {
    url: '/examples/cybersecurity-dashboard/index.html',
    disclosure: /no external connection/,
  },
};

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
};

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

/**
 * Open one page at one width in its own context so state never leaks between cases.
 *
 * Browser errors are collected from the moment the page exists, before `goto`,
 * so a failure thrown by application code during load is recorded rather than
 * missed. `console.warn`/`log`/`info` are deliberately not collected: the
 * project's own `console` check ignores them too, and they are too noisy to gate
 * a test. Nothing is filtered out otherwise — no "known" error is excused.
 */
async function openPage(url, { width, height }) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = { console: [], pageerror: [] };

  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', (error) => {
    errors.pageerror.push(error?.message ?? String(error));
  });

  await page.goto(server.urlFor(url), { waitUntil: 'load' });
  return { context, page, errors };
}

/** Fail with the exact errors the page produced, so the diagnostic is actionable. */
function assertNoPageErrors(errors, label) {
  assert.deepEqual(
    errors.console,
    [],
    `${label}: the page must not log console errors, saw ${JSON.stringify(errors.console)}`,
  );
  assert.deepEqual(
    errors.pageerror,
    [],
    `${label}: the page must not throw uncaught errors, saw ${JSON.stringify(errors.pageerror)}`,
  );
}

/* ------------------------------------------------------- measured colour --- */

/**
 * Effective text colour, effective background and WCAG ratio for an element.
 *
 * The background is *resolved*, never assumed: every ancestor's
 * `background-color` is collected and composited in paint order, so an element
 * with a transparent background inherits whatever is actually painted behind it
 * and a semi-transparent layer is blended over the layer below. A
 * `background-image` anywhere in the chain (gradient, picture) would make the
 * ratio unknowable, so it is reported as `unverifiable` and every caller treats
 * that as a failure rather than quietly measuring the colour underneath.
 *
 * Returns numbers only; no CSS colour literal appears in an assertion.
 */
async function measureTextContrast(locator) {
  return locator.evaluate((element) => {
    const parse = (value) => {
      const match = /^rgba?\(([^)]+)\)$/.exec(value);
      if (!match) return null;
      const parts = match[1].split(/[,\/\s]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };

    // Paint order is outermost first, so the accumulator starts empty and each
    // layer is composited over what is already there.
    const layers = [];
    let hasBackgroundImage = false;
    let unparseableLayer = null;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== 'none') hasBackgroundImage = true;

      const rawBackground = style.backgroundColor;
      const colour = parse(rawBackground);
      if (!colour) {
        // A layer we cannot read must not be skipped. Skipping it computes the
        // ratio against whatever is behind it — a backdrop the reader never
        // sees — so a page whose ancestor is `oklab()`, `color(display-p3 …)`
        // or `color-mix()` would report a confident, wrong ratio. Chromium
        // serialises fully transparent backgrounds as `rgba(0, 0, 0, 0)`, which
        // parses, so reaching here means a colour space this helper does not
        // understand.
        unparseableLayer = `${node.tagName?.toLowerCase() ?? 'element'} has background-color ${rawBackground}`;
        break;
      }
      if (colour.a > 0) layers.unshift(colour);
    }

    if (unparseableLayer) {
      return { unverifiable: `cannot resolve the text backdrop: ${unparseableLayer}` };
    }

    let backdrop = { r: 0, g: 0, b: 0, a: 0 };
    for (const layer of layers) {
      const alpha = layer.a + backdrop.a * (1 - layer.a);
      if (alpha === 0) continue;
      backdrop = {
        r: (layer.r * layer.a + backdrop.r * backdrop.a * (1 - layer.a)) / alpha,
        g: (layer.g * layer.a + backdrop.g * backdrop.a * (1 - layer.a)) / alpha,
        b: (layer.b * layer.a + backdrop.b * backdrop.a * (1 - layer.a)) / alpha,
        a: alpha,
      };
    }

    const style = getComputedStyle(element);
    const raw = parse(style.color);
    if (!raw) return { unverifiable: `unparseable color ${style.color}` };
    // A translucent foreground is blended over the resolved backdrop, which is
    // what a reader actually sees.
    const foreground = {
      r: raw.r * raw.a + backdrop.r * (1 - raw.a),
      g: raw.g * raw.a + backdrop.g * (1 - raw.a),
      b: raw.b * raw.a + backdrop.b * (1 - raw.a),
    };
    const opaqueBackdrop = {
      r: backdrop.r * backdrop.a + 255 * (1 - backdrop.a),
      g: backdrop.g * backdrop.a + 255 * (1 - backdrop.a),
      b: backdrop.b * backdrop.a + 255 * (1 - backdrop.a),
    };

    const luminance = ({ r, g, b }) => {
      const channel = (value) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const first = luminance(foreground);
    const second = luminance(opaqueBackdrop);
    const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

    return {
      ratio: Math.round(ratio * 100) / 100,
      foreground: [foreground.r, foreground.g, foreground.b].map(Math.round),
      background: [opaqueBackdrop.r, opaqueBackdrop.g, opaqueBackdrop.b].map(Math.round),
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number(style.fontWeight) || 400,
      hasBackgroundImage,
    };
  });
}

/** WCAG 2.2 AA minimum for the measured text, derived from its rendered size. */
function requiredContrast({ fontSize, fontWeight }) {
  const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
  return large ? 3 : 4.5;
}

/**
 * Bounding boxes, text legibility and per-row grouping for the metric cards.
 * Line counts come from a Range over the text node, so they describe how the
 * text actually laid out rather than how tall the element happens to be.
 */
async function measureMetrics(page) {
  return page.evaluate(() => {
    const lines = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    };

    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        labelLines: lines(element.querySelector('.metric-label')),
        valueLines: lines(element.querySelector('.metric-value')),
        valueTop: Math.round(element.querySelector('.metric-value').getBoundingClientRect().top),
      };
    };

    const cards = [...document.querySelectorAll('.metric')].map(box);
    const rowKeys = [...new Set(cards.map((card) => card.top))].sort((a, b) => a - b);

    return {
      cards,
      rows: rowKeys.map((top) => cards.filter((card) => card.top === top)),
      viewportWidth: window.innerWidth,
      documentWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
    };
  });
}

/* ------------------------------------------------------------------ V1 ---- */

for (const [id, page] of Object.entries(PAGES)) {
  test(`V1: ${id} shows the whole sample-data disclosure in the first viewport`, async () => {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const { context, page: rendered, errors } = await openPage(page.url, viewport);
      try {
        const note = rendered.locator('.sidebar-note');
        assert.equal(await note.count(), 1, `${name}: the disclosure must exist`);

        const state = await note.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);

          // Nine points across the rendered box. One centre probe would still
          // report "visible" for a note whose first and last lines were covered
          // by an overlapping panel, because hit testing only answers for the
          // point it is given.
          const blocked = [];
          for (const fx of [0.02, 0.5, 0.98]) {
            for (const fy of [0.02, 0.5, 0.98]) {
              const x = rect.left + rect.width * fx;
              const y = rect.top + rect.height * fy;
              const topmost = document.elementFromPoint(x, y);
              if (!(topmost === element || element.contains(topmost))) {
                blocked.push({
                  fx,
                  fy,
                  covering: topmost ? `${topmost.tagName.toLowerCase()}.${topmost.className}` : 'nothing',
                });
              }
            }
          }

          const range = document.createRange();
          range.selectNodeContents(element);

          return {
            text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
            display: style.display,
            visibility: style.visibility,
            opacity: Number(style.opacity),
            fontSize: Number.parseFloat(style.fontSize),
            rect: {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              width: rect.width,
              height: rect.height,
            },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            blockedPoints: blocked,
            // Every line the text laid out on, so a note that is present but
            // visually truncated is visible to the assertion below.
            textLines: range.getClientRects().length,
            clipped:
              element.scrollHeight > element.clientHeight + 1 ||
              element.scrollWidth > element.clientWidth + 1,
          };
        });

        assert.match(state.text, /Sample data only/, `${name}: the disclosure text is intact`);
        assert.match(
          state.text,
          page.disclosure,
          `${name}: the disclosure still states that nothing is fetched`,
        );

        assert.notEqual(state.display, 'none', `${name}: the disclosure must not be hidden`);
        assert.equal(state.visibility, 'visible', `${name}: the disclosure must be visible`);
        assert.equal(state.opacity, 1, `${name}: the disclosure must not be transparent`);
        assert.ok(state.rect.width > 0 && state.rect.height > 0, `${name}: it must occupy space`);
        assert.equal(state.clipped, false, `${name}: the disclosure must not be clipped`);

        assert.ok(
          state.rect.top >= 0 && state.rect.bottom <= state.viewport.height,
          `${name}: the whole disclosure must sit inside the ${state.viewport.height}px viewport, ` +
            `got ${Math.round(state.rect.top)}–${Math.round(state.rect.bottom)}`,
        );
        assert.ok(
          state.rect.left >= 0 && state.rect.right <= state.viewport.width,
          `${name}: the disclosure must stay within the horizontal viewport`,
        );

        assert.ok(
          state.textLines >= 1,
          `${name}: the disclosure text must lay out on at least one line`,
        );

        // Nothing may paint over it at any of the nine sample points.
        assert.deepEqual(
          state.blockedPoints,
          [],
          `${name}: the disclosure must not be overlapped by other content, ` +
            `blocked at ${JSON.stringify(state.blockedPoints)}`,
        );

        assert.ok(
          state.fontSize >= 12,
          `${name}: the disclosure must stay readable, got ${state.fontSize}px`,
        );

        assertNoPageErrors(errors, `${id} ${name} disclosure`);
      } finally {
        await context.close();
      }
    }
  });
}

/* ------------------------------------------------ V1: disclosure contrast --- */

/**
 * The disclosure is small, muted text on a dark panel, which is exactly the
 * combination that fails a legibility requirement without breaking any layout
 * assertion. V1 proves it is *present*; this proves it stays *readable*, at the
 * three viewports the visual baseline contract covers.
 *
 * The expected ratio is not written down here: it is derived from the rendered
 * font size and weight (WCAG 2.2 AA: 4.5:1, or 3:1 for large text), and the
 * colours come from `getComputedStyle` with the background composited from the
 * real ancestor chain. If the palette changes, the test follows it; if the
 * disclosure becomes too dim, the test fails.
 */
for (const [id, page] of Object.entries(PAGES)) {
  test(`V1: ${id} keeps the sample-data disclosure above the AA contrast floor`, async (t) => {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const { context, page: rendered, errors } = await openPage(page.url, viewport);
      try {
        const note = rendered.locator('.sidebar-note');
        assert.equal(await note.count(), 1, `${name}: the disclosure must exist`);

        const measured = await measureTextContrast(note);

        // A gradient or image behind the text makes the ratio unknowable. Fail
        // loudly instead of measuring whatever colour happens to sit underneath.
        assert.equal(
          measured.hasBackgroundImage,
          false,
          `${name}: the disclosure background must be a plain colour to be measurable, ` +
            `found a background-image in its ancestor chain`,
        );
        assert.equal(measured.unverifiable, undefined, `${name}: ${measured.unverifiable}`);

        const required = requiredContrast(measured);
        t.diagnostic(
          `${name}: ${measured.fontSize}px/${measured.fontWeight} text ` +
            `rgb(${measured.foreground.join(', ')}) on rgb(${measured.background.join(', ')}) ` +
            `= ${measured.ratio}:1 (needs ${required}:1)`,
        );

        assert.ok(
          measured.ratio >= required,
          `${name}: the disclosure must clear ${required}:1, measured ${measured.ratio}:1 ` +
            `(rgb(${measured.foreground.join(', ')}) on rgb(${measured.background.join(', ')}))`,
        );

        assertNoPageErrors(errors, `${id} ${name} disclosure contrast`);
      } finally {
        await context.close();
      }
    }
  });
}

/* ------------------------------------------------------------------ V2 ---- */

// The documented intent is 4 columns on desktop, 2 on tablet, 1 on mobile, with
// the four-up transition at 1220px (see the responsive block in each styles.css:
// at 1200px the card content box was 160px and the longest label needed
// 160.9px, so the label wrapped and its value dropped out of line with the row).
// Both sides of every transition are covered, plus the widths inside the former
// wrap window, so a future tweak cannot reintroduce either the 3 + 1 orphan or
// the wrapped-label state.
const METRIC_COLUMN_CASES = [
  { name: 'desktop', width: 1440, height: 900, columns: 4 },
  { name: 'four-up breakpoint', width: 1220, height: 900, columns: 4 },
  { name: 'just below four-up', width: 1219, height: 900, columns: 2 },
  { name: 'former four-up candidate', width: 1210, height: 900, columns: 2 },
  { name: 'former wrap window (1205)', width: 1205, height: 900, columns: 2 },
  { name: 'former wrap window (1204)', width: 1204, height: 900, columns: 2 },
  { name: 'former wrap window (1200)', width: 1200, height: 900, columns: 2 },
  { name: 'old breakpoint', width: 1199, height: 900, columns: 2 },
  { name: 'small desktop', width: 1024, height: 900, columns: 2 },
  { name: 'tablet', width: 834, height: 1112, columns: 2 },
  { name: 'tablet lower boundary', width: 768, height: 1024, columns: 2 },
  { name: 'mobile upper boundary', width: 767, height: 900, columns: 1 },
  { name: 'mobile', width: 390, height: 844, columns: 1 },
  { name: 'mobile narrow', width: 360, height: 844, columns: 1 },
  { name: 'mobile narrowest', width: 320, height: 844, columns: 1 },
];

for (const [id, page] of Object.entries(PAGES)) {
  /**
   * F-18-01 — fail closed on a background the helper cannot read.
   *
   * Before Phase 19 the scan skipped an unparseable ancestor layer, so the
   * backdrop fell through to a *further* ancestor and the suite reported a
   * confident 8.43:1 for text whose real backdrop made it 2.09:1. Skipping an
   * unreadable layer is worse than refusing: it turns an unknown into a pass.
   * Chromium keeps wide-gamut and `color-mix()` values in their own notation,
   * which is exactly the case that used to slip through.
   */
  test(`V1: ${id} refuses to report contrast it cannot compute`, async (t) => {
    const cases = [
      ['color(display-p3 1 1 1)', 'display-p3'],
      ['oklab(0.9 0 0)', 'oklab'],
      ['color-mix(in oklab, white, black)', 'color-mix'],
    ];

    for (const [css, label] of cases) {
      const { context, page: rendered, errors } = await openPage(page.url, { width: 1024, height: 900 });
      try {
        await rendered.evaluate((value) => {
          document.querySelector('.sidebar').style.setProperty('background-color', value, 'important');
        }, css);
        // Styles commit on the next pass, so wait for the injected notation to
        // be the computed value before measuring anything.
        await rendered.waitForFunction(
          () => !/^rgba?\(/.test(getComputedStyle(document.querySelector('.sidebar')).backgroundColor),
          undefined,
          { timeout: 2000, polling: 16 },
        );
        const computed = await rendered.evaluate(
          () => getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
        );
        assert.ok(
          !/^rgba?\(/.test(computed),
          `${label}: the injected colour must stay outside rgb() to reach this path, saw ${computed}`,
        );

        const measured = await measureTextContrast(rendered.locator('.sidebar-note'));
        t.diagnostic(`${label}: ${computed} -> ${measured.unverifiable ?? `${measured.ratio}:1`}`);

        assert.equal(measured.ratio, undefined, `${label}: a ratio must not be reported`);
        assert.match(String(measured.unverifiable), /backdrop/, `${label}: the reason must be explicit`);
        assertNoPageErrors(errors, `${label} contrast control`);
      } finally {
        await context.close();
      }
    }
  });

  test(`V1: ${id} stops at an unreadable layer even when nearer ancestors are transparent`, async (t) => {
    // The disclosure is transparent and so is `.shell` between the sidebar and
    // body: the scan must stop at the sidebar rather than look past it to a
    // readable colour and call that the backdrop.
    const { context, page: rendered } = await openPage(page.url, { width: 1024, height: 900 });
    try {
      await rendered.evaluate(() => {
        document.querySelector('.sidebar').style.setProperty('background-color', 'oklch(0.95 0.02 250)', 'important');
      });
      await rendered.waitForFunction(
        () => getComputedStyle(document.querySelector('.sidebar')).backgroundColor.startsWith('oklch('),
        undefined,
        { timeout: 2000, polling: 16 },
      );
      const measured = await measureTextContrast(rendered.locator('.sidebar-note'));
      t.diagnostic(`transparent-then-unreadable: ${measured.unverifiable}`);
      assert.equal(measured.ratio, undefined);
      assert.match(String(measured.unverifiable), /aside has background-color oklch/);
    } finally {
      await context.close();
    }
  });

  test(`V1: ${id} still measures colours the browser normalises to rgb()`, async (t) => {
    // The guard must be narrow: hsl() and hwb() compute to rgb(), so they are
    // readable and must still yield a ratio instead of a refusal.
    for (const [css, label] of [
      ['hsl(210 20% 90%)', 'hsl'],
      ['hwb(210 10% 10%)', 'hwb'],
    ]) {
      const { context, page: rendered } = await openPage(page.url, { width: 1024, height: 900 });
      try {
        await rendered.evaluate((value) => {
          document.querySelector('.sidebar').style.setProperty('background-color', value, 'important');
        }, css);
        await rendered.waitForFunction(
          () => /^rgba?\(/.test(getComputedStyle(document.querySelector('.sidebar')).backgroundColor),
          undefined,
          { timeout: 2000, polling: 16 },
        );
        const measured = await measureTextContrast(rendered.locator('.sidebar-note'));
        t.diagnostic(`${label}: ${measured.ratio}:1 on rgb(${measured.background.join(', ')})`);
        assert.equal(measured.unverifiable, undefined, `${label}: must remain measurable`);
        assert.ok(measured.ratio > 0, `${label}: a ratio must be reported`);
      } finally {
        await context.close();
      }
    }
  });

  test(`V2: ${id} lays its four metrics out in fixed 4 / 2 / 1 columns`, async () => {
    for (const testCase of METRIC_COLUMN_CASES) {
      const { context, page: rendered, errors } = await openPage(page.url, testCase);
      try {
        const measured = await measureMetrics(rendered);
        const label = `${testCase.name} (${testCase.width}px)`;

        assert.equal(measured.cards.length, 4, `${label}: four metric cards must render`);

        const expectedRows = 4 / testCase.columns;
        assert.equal(
          measured.rows.length,
          expectedRows,
          `${label}: expected ${expectedRows} row(s) of ${testCase.columns} card(s), ` +
            `got row sizes ${JSON.stringify(measured.rows.map((row) => row.length))}`,
        );

        for (const [index, row] of measured.rows.entries()) {
          assert.equal(
            row.length,
            testCase.columns,
            `${label}: row ${index + 1} must hold ${testCase.columns} cards, not ${row.length}`,
          );

          const widths = row.map((card) => card.width);
          assert.ok(
            Math.max(...widths) - Math.min(...widths) <= 1,
            `${label}: cards in row ${index + 1} must be equal width, got ${JSON.stringify(widths)}`,
          );

          // One baseline per row: a wrapped label pushes its own value down and
          // that is exactly what the 1200px four-up layout used to do.
          const valueTops = row.map((card) => card.valueTop);
          assert.ok(
            Math.max(...valueTops) - Math.min(...valueTops) <= 1,
            `${label}: metric values in row ${index + 1} must share a baseline, ` +
              `got tops ${JSON.stringify(valueTops)}`,
          );
        }

        // Legibility: no label or value may wrap at any width in scope.
        const wrappedLabels = measured.cards
          .map((card, index) => ({ index, lines: card.labelLines }))
          .filter((entry) => entry.lines !== 1);
        assert.deepEqual(
          wrappedLabels,
          [],
          `${label}: every metric label must stay on one line, wrapped: ` +
            `${JSON.stringify(wrappedLabels)}`,
        );

        const wrappedValues = measured.cards
          .map((card, index) => ({ index, lines: card.valueLines }))
          .filter((entry) => entry.lines !== 1);
        assert.deepEqual(
          wrappedValues,
          [],
          `${label}: every metric value must stay on one line, wrapped: ` +
            `${JSON.stringify(wrappedValues)}`,
        );

        // No two cards may overlap, whatever the column count.
        for (let a = 0; a < measured.cards.length; a += 1) {
          for (let b = a + 1; b < measured.cards.length; b += 1) {
            const first = measured.cards[a];
            const second = measured.cards[b];
            const overlapX = Math.min(first.right, second.right) - Math.max(first.left, second.left);
            const overlapY = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
            assert.ok(
              overlapX <= 0 || overlapY <= 0,
              `${label}: cards ${a} and ${b} must not overlap ` +
                `(overlap ${overlapX}x${overlapY}px)`,
            );
          }
        }

        // The last card must share a row with another card: no orphan.
        const lastRow = measured.rows.at(-1);
        assert.ok(
          lastRow.length > 1 || testCase.columns === 1,
          `${label}: the fourth card must not sit alone on its own row`,
        );

        assert.ok(
          measured.documentWidth <= measured.viewportWidth,
          `${label}: the metric row must not cause horizontal page overflow ` +
            `(${measured.documentWidth}px document vs ${measured.viewportWidth}px viewport)`,
        );

        assertNoPageErrors(errors, `${id} ${label} metrics`);
      } finally {
        await context.close();
      }
    }
  });
}

/* ------------------------------------------------------------------ V3 ---- */

test('V3: the SaaS notification button stays in the mobile header row', async (t) => {
  for (const width of [390, 360, 320]) {
    const { context, page, errors } = await openPage(PAGES['saas-dashboard'].url, {
      width,
      height: 844,
    });
    try {
      const label = `${width}px`;
      const measured = await page.evaluate(() => {
        const box = (element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            centreY: rect.top + rect.height / 2,
          };
        };

        const actions = document.querySelector('.topbar-actions');
        const notification = document.querySelector('.topbar-actions [aria-label="Open notifications"]');
        const exportButton = document.querySelector('.topbar-actions [data-action="export"]');
        const search = document.querySelector('[data-search]');

        return {
          actions: actions ? box(actions) : null,
          notification: notification ? box(notification) : null,
          exportButton: exportButton ? box(exportButton) : null,
          search: search ? box(search) : null,
          ariaLabel: notification?.getAttribute('aria-label') ?? null,
          insideActions: Boolean(notification && actions?.contains(notification)),
          documentWidth: Math.max(
            document.documentElement.scrollWidth,
            document.body?.scrollWidth ?? 0,
          ),
          viewportWidth: window.innerWidth,
        };
      });

      assert.ok(measured.notification, `${label}: the notification button must exist`);
      assert.equal(
        measured.insideActions,
        true,
        `${label}: the notification button must stay in the header action group`,
      );
      assert.ok(measured.ariaLabel, `${label}: the icon button must keep its accessible name`);

      assert.ok(
        measured.notification.width >= 40 && measured.notification.height >= 40,
        `${label}: the touch target must stay at least 40x40, got ` +
          `${measured.notification.width}x${measured.notification.height}`,
      );

      // Same row means the two buttons share a vertical centre, regardless of
      // their differing heights (41px vs 40px).
      assert.ok(
        Math.abs(measured.notification.centreY - measured.exportButton.centreY) <= 2,
        `${label}: the notification button must sit on the Export button's row, ` +
          `centres ${Math.round(measured.notification.centreY)} vs ` +
          `${Math.round(measured.exportButton.centreY)}`,
      );

      assert.ok(
        measured.notification.left >= measured.exportButton.right - 1,
        `${label}: the notification button must stay to the right of Export`,
      );

      assert.ok(
        measured.notification.right <= measured.viewportWidth,
        `${label}: the notification button must stay inside the viewport`,
      );

      assert.ok(
        measured.documentWidth <= measured.viewportWidth,
        `${label}: the mobile header must not create horizontal page overflow ` +
          `(${measured.documentWidth}px document vs ${measured.viewportWidth}px viewport)`,
      );

      // The search field must still be on that row too, so no action is isolated.
      assert.ok(
        measured.search.top < measured.notification.bottom &&
          measured.search.bottom > measured.notification.top,
        `${label}: the search field must overlap the action row`,
      );

      assert.ok(
        measured.search.right <= measured.viewportWidth,
        `${label}: the search field must stay inside the viewport`,
      );

      // The narrowest supported width still has to leave a field someone can
      // type into. A shortened placeholder is a reasonable trade-off for
      // keeping all three header actions on one row, so truncation is measured
      // and reported rather than asserted.
      const field = await page.evaluate(() => {
        const input = document.querySelector('[data-search]');
        const style = getComputedStyle(input);
        const canvas = document.createElement('canvas');
        const drawing = canvas.getContext('2d');
        drawing.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const rect = input.getBoundingClientRect();
        const usable =
          input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          usable: Math.round(usable),
          placeholder: input.placeholder,
          placeholderWidth: Math.round(drawing.measureText(input.placeholder).width),
          documentWidth: Math.max(
            document.documentElement.scrollWidth,
            document.body?.scrollWidth ?? 0,
          ),
        };
      });

      assert.ok(
        field.width >= 96 && field.height >= 30,
        `${label}: the search field must stay usable at its narrowest, ` +
          `got ${field.width}x${field.height}`,
      );

      await page.locator('[data-search]').focus();
      await page.keyboard.type('tail');
      assert.equal(
        await page.locator('[data-search]').inputValue(),
        'tail',
        `${label}: the search field must accept keyboard input`,
      );

      t.diagnostic(
        `${label}: field ${field.width}x${field.height}px, ${field.usable}px of text space; ` +
          `placeholder "${field.placeholder}" needs ${field.placeholderWidth}px ` +
          (field.placeholderWidth > field.usable ? '(truncated, field usable)' : '(fits)'),
      );

      assertNoPageErrors(errors, `saas header ${label}`);
    } finally {
      await context.close();
    }
  }
});

/* ------------------------------------------------------------------ V4 ---- */

/** Per-cell line counts plus the wrapper's scroll and semantics state. */
async function measureAlertTable(page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector('.table-wrap');
    const table = document.querySelector('[data-alert-table]');

    const cellLines = [...table.querySelectorAll('tbody td.mono')].map((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return {
        text: (cell.textContent ?? '').trim(),
        lines: range.getClientRects().length,
      };
    });

    const rowHeights = [...table.querySelectorAll('tbody tr')].map((row) =>
      Math.round(row.getBoundingClientRect().height),
    );

    const wrapStyle = getComputedStyle(wrapper);

    return {
      wrapper: {
        clientWidth: wrapper.clientWidth,
        scrollWidth: wrapper.scrollWidth,
        overflowX: wrapStyle.overflowX,
        tabIndex: wrapper.tabIndex,
        role: wrapper.getAttribute('role'),
        ariaLabel: wrapper.getAttribute('aria-label'),
      },
      cellLines,
      rowHeights,
      scopeHeaders: table.querySelectorAll('th[scope="col"]').length,
      hasCaption: Boolean(table.querySelector('caption')?.textContent?.trim()),
      documentWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
      viewportWidth: window.innerWidth,
    };
  });
}

/**
 * Set the wrapper's `scrollLeft` and wait for that value to be the committed one.
 *
 * The earlier version assigned `scrollLeft` and slept for 90ms. That is both
 * slower than it needs to be and not an assertion: a browser that ignored the
 * assignment would still sleep, and the next reading would quietly describe the
 * previous position. This waits, bounded to 1s and polled every frame, for the
 * requested offset to be the observed one, and on timeout reports the requested
 * value, the observed value and the wrapper's maximum — so the diagnostic says
 * which of the three is wrong instead of leaving a misleading number behind.
 *
 * @returns {Promise<number>} the clamped offset that was requested
 */
async function scrollWrapperTo(page, wrapper, target) {
  const max = await wrapper.evaluate((element) => element.scrollWidth - element.clientWidth);
  const requested = Math.max(0, Math.min(Math.round(target), max));

  await wrapper.evaluate((element, position) => {
    element.scrollLeft = position;
  }, requested);

  try {
    await page.waitForFunction(
      (position) => Math.abs(document.querySelector('.table-wrap').scrollLeft - position) < 0.5,
      requested,
      { timeout: 1000, polling: 16 },
    );
  } catch {
    const observed = await wrapper.evaluate((element) => element.scrollLeft);
    assert.fail(
      `scrollLeft did not commit: requested ${requested}px of a ${max}px range, ` +
        `observed ${observed.toFixed(2)}px after 1000ms`,
    );
  }

  return requested;
}

/**
 * Wait until the horizontal-overflow cue reflects the requested state.
 *
 * The cue is recomputed from a `scroll` listener (see `syncScrollHint()` in
 * examples/cybersecurity-dashboard/app.js), so it settles one frame after the
 * scroll commits. Waiting for the observable state is not a sleep: a timeout is
 * a hard failure that prints what the element actually reports, so a cue that
 * never appears cannot pass as a timing artefact.
 */
async function waitForCue(page, expectVisible) {
  const want = expectVisible ? 'visible' : 'hidden';
  try {
    await page.waitForFunction(
      (state) => {
        const hint = document.querySelector('[data-scroll-hint]');
        if (!hint) return false;
        return (
          hint.dataset.visible === state &&
          getComputedStyle(hint).visibility === (state === 'true' ? 'visible' : 'hidden')
        );
      },
      String(expectVisible),
      { timeout: 1000, polling: 16 },
    );
  } catch {
    const observed = await page.evaluate(() => {
      const hint = document.querySelector('[data-scroll-hint]');
      return hint
        ? { attr: hint.dataset.visible ?? null, visibility: getComputedStyle(hint).visibility }
        : 'the cue element is missing entirely';
    });
    assert.fail(
      `the overflow cue never became ${want} (waited 1000ms); observed ${JSON.stringify(observed)}`,
    );
  }
}

/**
 * Copy a rectangle out of a PNG, in device pixels.
 *
 * The crop is done here rather than with a screenshot `clip` so the band cannot
 * be shifted by a coordinate-convention mismatch: the input is a plain viewport
 * screenshot and the rectangle is the element's own viewport box, rounded once.
 * `deviceScaleFactor` is 1 in this suite, so CSS pixels and device pixels are
 * the same.
 */
function clipPng(source, { x, y, width, height }) {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(source.width, Math.round(x + width));
  const bottom = Math.min(source.height, Math.round(y + height));
  const out = new PNG({ width: Math.max(1, right - left), height: Math.max(1, bottom - top) });
  PNG.bitblt(source, out, left, top, out.width, out.height, 0, 0);
  return out;
}

/**
 * Measure the cue from the rendered page: geometry, semantics, and pixels.
 *
 * The pixel half is the important one. A crop of the cue band is read back and
 * its most common colour is taken as the surface behind the text; every pixel
 * far enough from that colour counts as painted ink, and the strongest of those
 * pixels becomes the measured glyph colour. That gives a contrast ratio for
 * what the browser actually drew — a cue that is declared but clipped, covered,
 * or painted in the surface colour measures as no cue at all.
 */
async function measureCue(page) {
  const geometry = await page.evaluate(() => {
    const hint = document.querySelector('[data-scroll-hint]');
    if (!hint) return null;
    const style = getComputedStyle(hint);
    const rect = hint.getBoundingClientRect();
    const wrapper = document.querySelector('.table-wrap');
    const table = document.querySelector('[data-alert-table]');
    return {
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      display: style.display,
      text: (hint.textContent ?? '').replace(/\s+/g, ' ').trim(),
      clipped: hint.scrollWidth > hint.clientWidth + 1 || hint.scrollHeight > hint.clientHeight + 1,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      tableTop: table ? table.getBoundingClientRect().top : null,
      wrapperBottom: wrapper ? wrapper.getBoundingClientRect().bottom : null,
      overflow: wrapper ? wrapper.scrollWidth - wrapper.clientWidth : 0,
      scrollLeft: wrapper ? wrapper.scrollLeft : 0,
    };
  });
  if (!geometry) return null;

  // Bring the band on screen without touching the wrapper's own scroll offset.
  await page.evaluate(() => {
    document.querySelector('[data-scroll-hint]')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  const { box, pointerTarget } = await page.evaluate(() => {
    const hint = document.querySelector('[data-scroll-hint]');
    const rect = hint.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      // Viewport coordinates on purpose: the crop is cut in memory from a plain
      // viewport screenshot below, so no clip-coordinate convention can shift
      // the band and make a border row look like painted glyphs.
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      pointerTarget: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className)}` : 'nothing',
    };
  });

  const png = clipPng(PNG.sync.read(await page.screenshot()), box);
  const counts = new Map();
  for (let i = 0; i < png.data.length; i += 4) {
    const key = `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const surfaceKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const surface = surfaceKey.split(',').map(Number);

  const relative = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]) => 0.2126 * relative(r) + 0.7152 * relative(g) + 0.0722 * relative(b);
  const contrast = (a, b) => {
    const first = luminance(a);
    const second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };

  let ink = 0;
  let best = null;
  for (let i = 0; i < png.data.length; i += 4) {
    const pixel = [png.data[i], png.data[i + 1], png.data[i + 2]];
    const delta = Math.max(...pixel.map((value, channel) => Math.abs(value - surface[channel])));
    if (delta < 24) continue;
    ink += 1;
    if (!best || contrast(pixel, surface) > best.ratio) {
      best = { pixel, ratio: contrast(pixel, surface) };
    }
  }

  return {
    ...geometry,
    pointerTarget,
    surface,
    ink,
    inkRatio: Math.round((ink / (png.width * png.height)) * 10000) / 100,
    glyphContrast: best ? Math.round(best.ratio * 100) / 100 : 1,
    glyphPixel: best ? best.pixel : null,
  };
}

test('V4: the cybersecurity alert table keeps identifiers whole at tablet width', async () => {
  const { context, page, errors } = await openPage(
    PAGES['cybersecurity-dashboard'].url,
    VIEWPORTS.tablet,
  );
  try {
    const measured = await measureAlertTable(page);
    const label = 'tablet (834px)';

    const identifiers = measured.cellLines.map((cell) => cell.text);
    assert.ok(
      identifiers.includes('edge-gateway-01'),
      `${label}: the sample host identifier must be present`,
    );

    for (const cell of measured.cellLines) {
      assert.equal(
        cell.lines,
        1,
        `${label}: "${cell.text}" must stay on one line, not break mid-identifier`,
      );
    }

    const spread = Math.max(...measured.rowHeights) - Math.min(...measured.rowHeights);
    assert.ok(
      spread <= 2,
      `${label}: row heights must stay consistent, got ${JSON.stringify(measured.rowHeights)}`,
    );

    assert.equal(measured.wrapper.overflowX, 'auto', `${label}: the wrapper must scroll`);
    assert.ok(
      measured.wrapper.scrollWidth > measured.wrapper.clientWidth,
      `${label}: the table must be genuinely wider than the wrapper so it scrolls ` +
        `(${measured.wrapper.scrollWidth} vs ${measured.wrapper.clientWidth})`,
    );

    assert.equal(measured.wrapper.tabIndex, 0, `${label}: the scroll box must be focusable`);
    assert.equal(measured.wrapper.role, 'region', `${label}: the scroll box must be a named region`);
    assert.ok(measured.wrapper.ariaLabel, `${label}: the scroll box must have an accessible name`);
    assert.equal(
      await page.getByRole('region', { name: measured.wrapper.ariaLabel }).count(),
      1,
      `${label}: the accessible name must resolve to exactly one region`,
    );

    assert.equal(measured.scopeHeaders, 6, `${label}: the table must keep its column headers`);
    assert.equal(measured.hasCaption, true, `${label}: the table must keep its caption`);

    assert.ok(
      measured.documentWidth <= measured.viewportWidth,
      `${label}: the page itself must not scroll sideways ` +
        `(${measured.documentWidth}px document vs ${measured.viewportWidth}px viewport)`,
    );

    // Keyboard users must be able to scroll the wrapper they can focus. The
    // scroll is committed by the compositor after the key event, so poll for it
    // rather than reading scrollLeft once and racing the frame.
    const wrapper = page.locator('.table-wrap');
    await wrapper.focus();
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains('table-wrap')),
      true,
      `${label}: the wrapper must take keyboard focus`,
    );

    let scrollLeft = 0;
    for (let attempt = 0; attempt < 20 && scrollLeft === 0; attempt += 1) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(50);
      scrollLeft = await wrapper.evaluate((element) => element.scrollLeft);
    }
    assert.ok(
      scrollLeft > 0,
      `${label}: arrow keys must scroll the focused wrapper, scrollLeft stayed ${scrollLeft}`,
    );

    assertNoPageErrors(errors, `${label} alert table`);
  } finally {
    await context.close();
  }
});

test('V4: the alert table behaves at desktop and mobile widths too', async () => {
  for (const [name, viewport] of [
    ['desktop', VIEWPORTS.desktop],
    ['mobile', VIEWPORTS.mobile],
  ]) {
    const { context, page, errors } = await openPage(
      PAGES['cybersecurity-dashboard'].url,
      viewport,
    );
    try {
      const measured = await measureAlertTable(page);

      for (const cell of measured.cellLines) {
        assert.equal(cell.lines, 1, `${name}: "${cell.text}" must stay on one line`);
      }

      const spread = Math.max(...measured.rowHeights) - Math.min(...measured.rowHeights);
      assert.ok(
        spread <= 2,
        `${name}: row heights must stay consistent, got ${JSON.stringify(measured.rowHeights)}`,
      );

      assert.ok(
        measured.documentWidth <= measured.viewportWidth,
        `${name}: the page must not scroll sideways`,
      );

      if (name === 'desktop') {
        assert.ok(
          measured.wrapper.scrollWidth <= measured.wrapper.clientWidth,
          `${name}: a 1440px viewport must fit the table without scrolling it`,
        );
      } else {
        assert.ok(
          measured.wrapper.scrollWidth > measured.wrapper.clientWidth,
          `${name}: the table must still scroll inside the wrapper`,
        );
      }

      assertNoPageErrors(errors, `${name} alert table`);
    } finally {
      await context.close();
    }
  }
});

test('V4: the last column and its control are reachable at maximum scroll', async () => {
  for (const [name, viewport] of [
    ['tablet', VIEWPORTS.tablet],
    ['mobile', VIEWPORTS.mobile],
  ]) {
    const { context, page, errors } = await openPage(
      PAGES['cybersecurity-dashboard'].url,
      viewport,
    );
    try {
      const start = await page.evaluate(() => {
        const wrap = document.querySelector('.table-wrap');
        const button = document.querySelector(
          '[data-alert-table] tbody tr:last-child [data-action="acknowledge"]',
        );
        const wrapperRect = wrap.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return {
          label: (button.textContent ?? '').trim(),
          max: wrap.scrollWidth - wrap.clientWidth,
          fullyVisible:
            buttonRect.left >= wrapperRect.left - 0.5 &&
            buttonRect.right <= wrapperRect.right + 0.5,
        };
      });

      assert.ok(start.label, `${name}: the last row must keep its Acknowledge control`);
      assert.ok(
        start.max > 0,
        `${name}: the table must genuinely overflow, otherwise reachability is meaningless`,
      );
      assert.equal(
        start.fullyVisible,
        false,
        `${name}: the last column must start beyond the right edge, not already visible`,
      );

      const wrapper = page.locator('.table-wrap');
      await scrollWrapperTo(page, wrapper, start.max);

      const reached = await page.evaluate(() => {
        const wrap = document.querySelector('.table-wrap');
        const button = document.querySelector(
          '[data-alert-table] tbody tr:last-child [data-action="acknowledge"]',
        );
        const wrapperRect = wrap.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return {
          scrollLeft: Math.round(wrap.scrollLeft),
          gapLeft: Math.round(buttonRect.left - wrapperRect.left),
          gapRight: Math.round(wrapperRect.right - buttonRect.right),
          fullyVisible:
            buttonRect.left >= wrapperRect.left - 0.5 &&
            buttonRect.right <= wrapperRect.right + 0.5,
        };
      });

      assert.equal(
        reached.fullyVisible,
        true,
        `${name}: at maximum scroll (${reached.scrollLeft}px) the last Acknowledge control must be ` +
          `fully visible; it sits ${reached.gapLeft}px from the left edge and ` +
          `${reached.gapRight}px from the right`,
      );

      assertNoPageErrors(errors, `${name} last column reachability`);
    } finally {
      await context.close();
    }
  }
});

test('V4: keyboard focus enters and leaves the scroll container', async () => {
  const { context, page, errors } = await openPage(
    PAGES['cybersecurity-dashboard'].url,
    VIEWPORTS.tablet,
  );
  try {
    // Enter the region from the last filter chip so this is about the real tab
    // order rather than about focusing the box programmatically.
    await page.locator('.filter-group .chip').last().focus();
    let entered = false;
    for (let press = 0; press < 6 && !entered; press += 1) {
      await page.keyboard.press('Tab');
      entered = await page.evaluate(
        () => document.activeElement?.classList.contains('table-wrap') ?? false,
      );
    }
    assert.equal(entered, true, 'tablet: Tab must reach the focusable scroll container');

    // A focusable scroll region must not be a keyboard trap.
    let pressesToEscape = null;
    for (let press = 1; press <= 20; press += 1) {
      await page.keyboard.press('Tab');
      const stillInside = await page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(active && active.closest('.table-wrap'));
      });
      if (!stillInside) {
        pressesToEscape = press;
        break;
      }
    }
    assert.ok(
      pressesToEscape !== null,
      'tablet: Tab must eventually leave the scroll container (no keyboard trap)',
    );

    await page.locator('.table-wrap').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(
      await page.evaluate(() => {
        const active = document.activeElement;
        return !(active && active.closest('.table-wrap'));
      }),
      true,
      'tablet: Shift+Tab must leave the scroll container immediately',
    );

    assertNoPageErrors(errors, 'tablet scroll container focus');
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------ V4: scroll affordance --- */

// Every width the brief requires, with the state the table must be in at that
// width. `overflows` is asserted rather than assumed: if the table's min-width
// or the wrapper's padding changes, the case must be re-derived instead of
// silently testing a state the page is no longer in.
//
// The table is 864px wide and the scrollport is narrower than that between
// roughly 1024 and 1185, and again below about 905px; 1200 and 1440 are the
// no-overflow controls. 900px is the interesting small-overflow case at this
// width (30px hidden), which the old gradient could not cue at all.
const CUE_CASES = [
  { name: 'desktop', width: 1440, height: 900, overflows: false },
  { name: 'wide desktop', width: 1200, height: 900, overflows: false },
  { name: 'small desktop', width: 1100, height: 900, overflows: true },
  { name: 'compact desktop', width: 1024, height: 900, overflows: true },
  { name: 'small overflow', width: 900, height: 900, overflows: true },
  { name: 'below the split breakpoint', width: 860, height: 900, overflows: true },
  { name: 'tablet', width: 834, height: 1112, overflows: true },
  { name: 'mobile', width: 390, height: 844, overflows: true },
  { name: 'narrowest', width: 320, height: 844, overflows: true },
];

// The cue is 13px semibold text, so the AA floor for it is 4.5:1 — the same
// threshold the disclosure test derives from its own rendered font. Ink coverage
// is asserted too: a label of this length paints several hundred pixels, so a
// handful of stray anti-aliased pixels cannot pass as a rendered cue.
const CUE_MIN_INK = 150;
const CUE_MIN_INK_RATIO = 2;
const CUE_MIN_CONTRAST = 4.5;

test('V4: the overflow cue is painted, legible, and shown only when content is hidden', async (t) => {
  for (const testCase of CUE_CASES) {
    const { context, page, errors } = await openPage(
      PAGES['cybersecurity-dashboard'].url,
      testCase,
    );
    try {
      const label = `${testCase.name} (${testCase.width}x${testCase.height})`;

      const documentWidth = await page.evaluate(() =>
        Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      );
      assert.ok(
        documentWidth <= testCase.width,
        `${label}: the cue must not create page-level horizontal overflow ` +
          `(${documentWidth}px document vs ${testCase.width}px viewport)`,
      );

      await waitForCue(page, testCase.overflows);
      const cue = await measureCue(page);
      assert.ok(cue, `${label}: the cue element must exist`);
      assert.match(cue.text, /more columns/i, `${label}: the cue must name what is hidden`);

      t.diagnostic(
        `${label}: overflow ${cue.overflow}px · cue ${cue.visibility} · ink ${cue.ink}px ` +
          `(${cue.inkRatio}% of the band) · glyph contrast ${cue.glyphContrast}:1 · ` +
          `pointer target ${cue.pointerTarget}`,
      );

      if (!testCase.overflows) {
        assert.ok(
          cue.overflow <= 0,
          `${label}: this case is the no-overflow control, but ${cue.overflow}px is hidden`,
        );
        assert.equal(
          cue.visibility,
          'hidden',
          `${label}: no cue may be shown when nothing is hidden to the right`,
        );
        assert.equal(
          cue.ink,
          0,
          `${label}: nothing may be painted where the cue would sit, saw ${cue.ink} painted pixels`,
        );
        assertNoPageErrors(errors, `${label} cue`);
        continue;
      }

      assert.ok(cue.overflow > 0, `${label}: the table must genuinely overflow here`);
      assert.equal(
        cue.visibility,
        'visible',
        `${label}: the cue must be visible while ${cue.overflow}px of table is hidden`,
      );
      assert.equal(cue.clipped, false, `${label}: the cue must not be clipped`);
      assert.ok(
        cue.rect.width > 0 && cue.rect.height > 0,
        `${label}: the cue must occupy space, got ${cue.rect.width}x${cue.rect.height}`,
      );
      assert.ok(
        cue.rect.left >= 0 && cue.rect.right <= cue.viewport.width,
        `${label}: the cue must stay inside the horizontal viewport ` +
          `(${Math.round(cue.rect.left)}–${Math.round(cue.rect.right)} of ${cue.viewport.width}px)`,
      );
      assert.ok(
        cue.rect.bottom <= cue.tableTop + 0.5,
        `${label}: the cue must sit above the table, never over it ` +
          `(cue bottom ${Math.round(cue.rect.bottom)}, table top ${Math.round(cue.tableTop)})`,
      );
      assert.equal(
        cue.pointerEvents,
        'none',
        `${label}: the cue must not be a pointer or touch target`,
      );
      assert.ok(
        !/table-scroll-hint/.test(cue.pointerTarget),
        `${label}: a hit test at the cue's centre must not land on the cue, hit ${cue.pointerTarget}`,
      );

      // The threshold that matters: what the browser actually drew.
      assert.ok(
        cue.ink >= CUE_MIN_INK,
        `${label}: the cue must be genuinely painted, only ${cue.ink} of the band's pixels ` +
          `differ from the surface colour rgb(${cue.surface.join(', ')})`,
      );
      assert.ok(
        cue.inkRatio >= CUE_MIN_INK_RATIO,
        `${label}: too little of the band carries paint (${cue.inkRatio}%)`,
      );
      assert.ok(
        cue.glyphContrast >= CUE_MIN_CONTRAST,
        `${label}: the cue's rendered glyphs must clear ${CUE_MIN_CONTRAST}:1 against the ` +
          `surface, measured ${cue.glyphContrast}:1 ` +
          `(rgb(${(cue.glyphPixel ?? []).join(', ')}) on rgb(${cue.surface.join(', ')}))`,
      );

      assertNoPageErrors(errors, `${label} cue`);
    } finally {
      await context.close();
    }
  }
});

test('V4: the overflow cue tracks the scroll position in both directions', async (t) => {
  for (const testCase of [
    { name: 'compact desktop', width: 1024, height: 900 },
    { name: 'tablet', width: 834, height: 1112 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const { context, page, errors } = await openPage(
      PAGES['cybersecurity-dashboard'].url,
      testCase,
    );
    try {
      const label = `${testCase.name} (${testCase.width}px)`;
      const wrapper = page.locator('.table-wrap');
      const max = await wrapper.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      assert.ok(max > 0, `${label}: the table must overflow here, otherwise this is vacuous`);

      await waitForCue(page, true);
      const rest = await measureCue(page);
      t.diagnostic(
        `${label}: range ${max}px · rest ${rest.visibility} ink ${rest.ink}px ` +
          `contrast ${rest.glyphContrast}:1`,
      );
      assert.equal(rest.visibility, 'visible', `${label}: the cue must be shown at rest`);
      assert.ok(rest.ink >= CUE_MIN_INK, `${label}: the cue must be painted at rest`);
      assert.ok(
        rest.glyphContrast >= CUE_MIN_CONTRAST,
        `${label}: the cue must be legible at rest, measured ${rest.glyphContrast}:1`,
      );

      const middle = Math.round(max / 2);
      await scrollWrapperTo(page, wrapper, middle);
      await waitForCue(page, true);
      const mid = await measureCue(page);
      assert.ok(
        Math.abs(mid.scrollLeft - middle) < 1,
        `${label}: the intermediate position must be committed before measuring, ` +
          `wanted ${middle}px, wrapper reports ${mid.scrollLeft}px`,
      );
      assert.equal(
        mid.visibility,
        'visible',
        `${label}: the cue must stay visible mid-scroll (${mid.scrollLeft}px of ${max}px) with ` +
          `${mid.overflow - mid.scrollLeft}px still hidden`,
      );
      assert.ok(mid.ink >= CUE_MIN_INK, `${label}: the cue must still be painted mid-scroll`);
      assert.ok(
        mid.glyphContrast >= CUE_MIN_CONTRAST,
        `${label}: the cue must still be legible mid-scroll, measured ${mid.glyphContrast}:1`,
      );

      await scrollWrapperTo(page, wrapper, max);
      await waitForCue(page, false);
      const end = await measureCue(page);
      assert.equal(
        end.visibility,
        'hidden',
        `${label}: the cue must be gone at the rightmost position ` +
          `(${Math.round(end.scrollLeft)}px of ${max}px)`,
      );
      assert.equal(
        end.ink,
        0,
        `${label}: nothing may remain painted at the rightmost position, saw ${end.ink} pixels`,
      );

      await scrollWrapperTo(page, wrapper, 0);
      await waitForCue(page, true);
      const back = await measureCue(page);
      assert.equal(back.visibility, 'visible', `${label}: the cue must return after scrolling back`);
      assert.ok(back.ink >= CUE_MIN_INK, `${label}: the cue must be painted again after scrolling back`);

      // Keyboard scrolling must keep working with the cue in place.
      await wrapper.focus();
      const before = await wrapper.evaluate((element) => element.scrollLeft);
      await page.keyboard.press('ArrowRight');
      try {
        await page.waitForFunction(
          (previous) => document.querySelector('.table-wrap').scrollLeft > previous,
          before,
          { timeout: 1000, polling: 16 },
        );
      } catch {
        const observed = await wrapper.evaluate((element) => element.scrollLeft);
        assert.fail(
          `${label}: arrow keys must still scroll the focused wrapper, ${before} -> ${observed}`,
        );
      }

      assertNoPageErrors(errors, `${label} cue scroll states`);
    } finally {
      await context.close();
    }
  }
});

test('V4: the cue reacts to small overflow, and to overflow disappearing', async (t) => {
  // 1200px is a width where the table fits, so a test-only min-width is the only
  // way to manufacture an exact overflow here. The resulting overflow is
  // measured and asserted, never assumed: the assertion is about the cue's
  // behaviour at 1px, 30px and 63px of hidden table, which is the range the old
  // 64px-wide gradient cover went blind in.
  for (const target of [0, 1, 30, 63]) {
    const { context, page, errors } = await openPage(
      PAGES['cybersecurity-dashboard'].url,
      { width: 1200, height: 900 },
    );
    try {
      const label = `${target}px of hidden table`;
      const clientWidth = await page.evaluate(
        () => document.querySelector('.table-wrap').clientWidth,
      );
      await page.addStyleTag({
        content: `.table { min-width: ${clientWidth + target}px !important; }`,
      });

      await waitForCue(page, target > 0);
      const cue = await measureCue(page);
      t.diagnostic(
        `${label}: measured overflow ${cue.overflow}px · cue ${cue.visibility} · ` +
          `ink ${cue.ink}px · contrast ${cue.glyphContrast}:1`,
      );

      assert.ok(
        Math.abs(cue.overflow - target) <= 1,
        `${label}: the fixture must produce ~${target}px of overflow, measured ${cue.overflow}px`,
      );

      if (target === 0) {
        assert.equal(cue.visibility, 'hidden', `${label}: no cue when the table fits`);
        assert.equal(cue.ink, 0, `${label}: nothing may be painted when the table fits`);
      } else {
        assert.equal(
          cue.visibility,
          'visible',
          `${label}: the cue must be shown for even ${target}px of hidden table`,
        );
        assert.ok(cue.ink >= CUE_MIN_INK, `${label}: the cue must be painted`);
        assert.ok(
          cue.glyphContrast >= CUE_MIN_CONTRAST,
          `${label}: the cue must be legible, measured ${cue.glyphContrast}:1`,
        );
      }

      assertNoPageErrors(errors, `${label} cue`);
    } finally {
      await context.close();
    }
  }
});

test('V4: the cue assertions fail when the cue is removed (negative control)', async () => {
  // A threshold nobody can fail proves nothing. This removes exactly the paint
  // the assertions above require, in the page, and shows the same measurements
  // reject it — so a regression that hides the cue cannot pass silently.
  const { context, page, errors } = await openPage(PAGES['cybersecurity-dashboard'].url, {
    width: 1024,
    height: 900,
  });
  try {
    await waitForCue(page, true);
    const control = await measureCue(page);
    assert.ok(
      control.ink >= CUE_MIN_INK && control.glyphContrast >= CUE_MIN_CONTRAST,
      `the cue must pass before the control is applied, saw ink ${control.ink}px and ` +
        `contrast ${control.glyphContrast}:1`,
    );

    await page.addStyleTag({
      content: '.table-scroll-hint { visibility: hidden !important; }',
    });
    // This browser applies stylesheet changes on the next style pass, so the
    // control is confirmed to have taken effect before it is measured — a
    // control that silently did nothing would make this test meaningless.
    try {
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('[data-scroll-hint]')).visibility === 'hidden',
        undefined,
        { timeout: 1000, polling: 16 },
      );
    } catch {
      assert.fail('the negative control did not take effect: the cue is still visible');
    }

    const suppressed = await measureCue(page);

    assert.equal(
      suppressed.visibility,
      'hidden',
      'the control must actually take the cue out of the rendering',
    );
    assert.equal(
      suppressed.ink,
      0,
      `a cue that is not painted must measure as no paint, saw ${suppressed.ink} pixels`,
    );
    assert.ok(
      !(suppressed.visibility === 'visible' && suppressed.ink >= CUE_MIN_INK),
      'the cue assertions must not be satisfiable with the cue removed',
    );

    assertNoPageErrors(errors, 'cue negative control');
  } finally {
    await context.close();
  }
});
