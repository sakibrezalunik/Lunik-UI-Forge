export const id = 'overflow';
export const title = 'Horizontal overflow';

/**
 * Detects content that is wider than the viewport, which forces sideways
 * scrolling and is the most common responsive defect.
 *
 * The culprit list is what makes this actionable: knowing the page overflows by
 * 240px is useless without knowing which element caused it.
 */
export async function run({ page, checkConfig }) {
  const tolerance = checkConfig?.tolerance ?? 1;

  const measurement = await page.evaluate((tol) => {
    const describe = (el) => {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 4) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`${part}#${node.id}`);
          break;
        }
        const classes = (node.getAttribute('class') ?? '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2);
        if (classes.length > 0) part += `.${classes.join('.')}`;
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    };

    const viewportWidth = window.innerWidth;
    const documentWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
    );

    const culprits = [];
    if (documentWidth > viewportWidth + tol) {
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const overflow = Math.max(rect.right - viewportWidth, -rect.left);
        if (overflow > tol) {
          culprits.push({
            selector: describe(el),
            overflowPx: Math.round(overflow),
            rect: {
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              width: Math.round(rect.width),
            },
          });
        }
      }
      culprits.sort((a, b) => b.overflowPx - a.overflowPx);
    }

    return {
      viewportWidth,
      documentWidth,
      overflowPx: Math.max(0, documentWidth - viewportWidth),
      culprits: culprits.slice(0, 5),
      culpritCount: culprits.length,
    };
  }, tolerance);

  if (measurement.overflowPx <= tolerance) {
    return {
      ok: true,
      message: `No horizontal overflow at ${measurement.viewportWidth}px.`,
      evidence: { viewportWidth: measurement.viewportWidth, documentWidth: measurement.documentWidth },
    };
  }

  return {
    ok: false,
    message:
      `Page is ${measurement.overflowPx}px wider than the ${measurement.viewportWidth}px viewport ` +
      `(${measurement.culpritCount} element(s) extend past the edge).`,
    evidence: measurement,
    remediation:
      'Constrain the offending elements: use max-width: 100%, allow wrapping, avoid fixed widths larger than the viewport, and check grid/flex children for min-width: auto.',
  };
}
