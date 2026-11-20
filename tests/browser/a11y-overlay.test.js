/**
 * Regression coverage for the Phase 26 accessibility false positive.
 *
 * Next.js development tooling renders an unnamed SVG inside a `nextjs-portal`
 * shadow root. That framework control is not application content. The exclusion
 * must be narrow: ordinary SVGs, unnamed controls, and legitimate application
 * shadow roots must still be reported.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { run } from '../../tools/lib/checks/a11y-names.js';

let browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

const OVERLAY = `
  <nextjs-portal
    style="position:fixed;left:0;bottom:0;width:40px;height:40px;display:block"
  ></nextjs-portal>
`;

const OVERLAY_SETUP = `
  const portal = document.querySelector('nextjs-portal');
  if (portal) {
    portal.attachShadow({ mode: 'open' }).innerHTML =
      '<svg data-overlay-svg role="img" width="40" height="40">' +
      '<circle cx="20" cy="20" r="18" fill="#000"></circle></svg>';
  }
`;

function page(body, setup = '') {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>A11y fixture</title></head>
  <body style="margin:0;background:#fff;min-height:300px">
    ${body}
    <script>${setup}</script>
  </body>
</html>`;
}

async function inspect(html) {
  const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
  const pageUnderTest = await context.newPage();
  try {
    await pageUnderTest.setContent(html);
    await pageUnderTest.waitForTimeout(50);
    return await run({ page: pageUnderTest });
  } finally {
    await context.close();
  }
}

test("ignores the Next.js development overlay's unnamed SVG", async () => {
  const result = await inspect(page(OVERLAY, OVERLAY_SETUP));

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.evidence, undefined);
});

test('still reports an unnamed SVG in ordinary application content', async () => {
  const result = await inspect(
    page(
      '<svg data-app-svg role="img" width="40" height="40">' +
        '<circle cx="20" cy="20" r="18" fill="#123456"></circle></svg>',
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.evidence.unnamedImages.length, 1);
  assert.match(result.evidence.unnamedImages[0].html, /data-app-svg/);
});

test('still reports an unnamed interactive control', async () => {
  const result = await inspect(
    page('<button data-app-button style="width:40px;height:40px"></button>'),
  );

  assert.equal(result.ok, false);
  assert.equal(result.evidence.unnamedControls.length, 1);
  assert.match(result.evidence.unnamedControls[0].html, /data-app-button/);
});

test('still inspects legitimate shadow DOM content', async () => {
  const result = await inspect(
    page(
      '<legit-widget style="display:block;width:30px;height:30px"></legit-widget>',
      `
        const host = document.querySelector('legit-widget');
        host.attachShadow({ mode: 'open' }).innerHTML =
          '<svg data-shadow-svg role="img" width="30" height="30">' +
          '<circle cx="15" cy="15" r="12" fill="#654321"></circle></svg>' +
          '<button data-shadow-button style="width:40px;height:40px"></button>';
      `,
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.evidence.unnamedImages.length, 1);
  assert.equal(result.evidence.unnamedControls.length, 1);
  assert.match(result.evidence.unnamedImages[0].html, /data-shadow-svg/);
  assert.match(result.evidence.unnamedControls[0].html, /data-shadow-button/);
});
