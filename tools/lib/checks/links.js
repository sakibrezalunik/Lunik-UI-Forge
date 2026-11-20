export const id = 'links';
export const title = 'Links and navigation';

/**
 * Checks anchor targets:
 *  - in-page `#fragment` links resolve to an existing element
 *  - same-origin / relative links return a non-error HTTP status
 *  - placeholder links (`href="#"` or empty) are reported, since they silently do nothing
 *
 * External hosts are counted but not fetched: verification must not depend on
 * the public internet, and a remote outage is not a defect in this project.
 */
export async function run({ page, pageUrl }) {
  const anchors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
      href: anchor.getAttribute('href'),
      text: (anchor.textContent ?? '').trim().slice(0, 60),
    })),
  );

  const base = new URL(pageUrl);
  const placeholder = [];
  const missingFragments = [];
  const broken = [];
  const external = [];
  const skippedSchemes = [];
  let checked = 0;

  for (const anchor of anchors) {
    const href = (anchor.href ?? '').trim();

    if (href === '' || href === '#') {
      placeholder.push({ href, text: anchor.text });
      continue;
    }

    if (href.startsWith('#')) {
      const fragment = decodeURIComponent(href.slice(1));
      const exists = await page.evaluate((id) => document.getElementById(id) !== null, fragment);
      if (!exists) missingFragments.push({ href, text: anchor.text });
      continue;
    }

    if (/^(mailto|tel|sms|javascript):/i.test(href)) {
      skippedSchemes.push({ href, text: anchor.text });
      continue;
    }

    let url;
    try {
      url = new URL(href, base);
    } catch {
      broken.push({ href, reason: 'not a valid URL' });
      continue;
    }

    if (url.origin !== base.origin) {
      external.push({ href: url.toString(), text: anchor.text });
      continue;
    }

    checked += 1;
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status >= 400) {
        broken.push({ href, reason: `HTTP ${response.status}` });
      }
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      broken.push({ href, reason: String(error.message).split('\n')[0] });
    }
  }

  const problems = placeholder.length + missingFragments.length + broken.length;
  const notes = [];
  if (external.length > 0) notes.push(`${external.length} external link(s) not fetched`);
  if (skippedSchemes.length > 0) notes.push(`${skippedSchemes.length} mailto/tel link(s) ignored`);
  const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';

  if (problems === 0) {
    return {
      ok: true,
      message: `${checked + missingFragments.length + placeholder.length} link(s) checked, no problems.${suffix}`,
      evidence: {
        checked,
        externalSkipped: external.length,
        external: external.slice(0, 5),
        skippedSchemes,
      },
    };
  }

  return {
    ok: false,
    message:
      `${broken.length} broken, ${missingFragments.length} unresolved fragment(s), ` +
      `${placeholder.length} placeholder link(s).${suffix}`,
    evidence: {
      broken: broken.slice(0, 10),
      missingFragments: missingFragments.slice(0, 10),
      placeholder: placeholder.slice(0, 10),
      externalSkipped: external.length,
    },
    remediation:
      'Point each anchor at a real destination, add the missing id for fragment links, and give placeholder links a real target or convert them to <button>.',
  };
}
