export const id = 'contrast';
export const title = 'Text contrast';

/**
 * WCAG 2.2 contrast for text: 4.5:1 for normal text, 3:1 for large text
 * (>= 24px, or >= 18.66px when bold).
 *
 * Known limits, reported rather than hidden:
 *  - Text over gradients, images, or multi-layer transparency cannot be measured
 *    reliably; those elements are counted as `unverifiable` and never as passes.
 *  - `opacity` on ancestors is not composited.
 *  - Anti-aliasing and subpixel rendering are irrelevant here (we use declared
 *    colours), but a passing ratio is still not a substitute for human review.
 *
 * Default severity is `warning` for exactly this reason.
 */
export async function run({ page, checkConfig }) {
  const minNormal = checkConfig?.minRatioNormal ?? 4.5;
  const minLarge = checkConfig?.minRatioLarge ?? 3;

  const outcome = await page.evaluate(
    ({ normal, large }) => {
      const toHex = (color) => {
        const hex = (value) =>
          Math.max(0, Math.min(255, Math.round(value)))
            .toString(16)
            .padStart(2, '0');
        return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
      };

      const parseColor = (value) => {
        const match = value?.match(/rgba?\(([^)]+)\)/);
        if (!match) return null;
        const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      };

      const composite = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });

      const channel = (value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
      const contrastRatio = (a, b) => {
        const la = luminance(a);
        const lb = luminance(b);
        const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
        return (hi + 0.05) / (lo + 0.05);
      };

      const backgroundFor = (el) => {
        const layers = [];
        let hasImage = false;
        let node = el;
        while (node && node.nodeType === 1) {
          const style = getComputedStyle(node);
          if (style.backgroundImage && style.backgroundImage !== 'none') {
            hasImage = true;
            break;
          }
          const parsed = parseColor(style.backgroundColor);
          if (parsed && parsed.a > 0) {
            layers.push(parsed);
            if (parsed.a >= 1) break;
          }
          node = node.parentElement;
        }
        let base = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = layers.length - 1; i >= 0; i -= 1) base = composite(layers[i], base);
        return { color: base, hasImage };
      };

      const describe = (el) => {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 4) {
          let part = node.tagName.toLowerCase();
          if (node.id) {
            parts.unshift(`${part}#${node.id}`);
            break;
          }
          const classes = (node.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
          if (classes.length > 0) part += `.${classes.join('.')}`;
          parts.unshift(part);
          node = node.parentElement;
        }
        return parts.join(' > ');
      };

      const violations = [];
      const unverifiable = [];
      let checked = 0;

      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('svg, script, style, noscript, template')) continue;
        const hasDirectText = Array.from(el.childNodes).some(
          (child) => child.nodeType === 3 && (child.textContent ?? '').trim() !== '',
        );
        if (!hasDirectText) continue;

        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (Number.parseFloat(style.opacity ?? '1') === 0) continue;
        if (el.getClientRects().length === 0) continue;

        const fontSize = Number.parseFloat(style.fontSize);
        if (!fontSize) continue;

        const foreground = parseColor(style.color);
        if (!foreground) continue;

        const background = backgroundFor(el);
        if (background.hasImage) {
          unverifiable.push({ selector: describe(el), reason: 'text over a background image or gradient' });
          continue;
        }

        checked += 1;
        const fg = foreground.a < 1 ? composite(foreground, background.color) : foreground;
        const weight = Number.parseInt(style.fontWeight, 10) || 400;
        const isLarge = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
        const required = isLarge ? large : normal;
        const ratio = contrastRatio(fg, background.color);

        if (ratio + 1e-9 < required) {
          violations.push({
            selector: describe(el),
            text: (el.textContent ?? '').trim().slice(0, 80),
            ratio: Math.round(ratio * 100) / 100,
            required,
            fontSize: Math.round(fontSize * 10) / 10,
            fontWeight: weight,
            foreground: toHex(fg),
            background: toHex(background.color),
          });
        }
      }

      // One entry per element, not per text node, so a repeated badge does not
      // flood the report with twelve identical rows.
      const seen = new Set();
      const unique = [];
      for (const violation of violations) {
        const key = `${violation.selector}|${violation.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(violation);
      }
      unique.sort((a, b) => a.ratio - b.ratio);

      return {
        checked,
        totalViolations: unique.length,
        violations: unique.slice(0, 20),
        unverifiableCount: unverifiable.length,
        unverifiable: unverifiable.slice(0, 5),
      };
    },
    { normal: minNormal, large: minLarge },
  );

  const limitation =
    outcome.unverifiableCount > 0
      ? ` ${outcome.unverifiableCount} text element(s) over images/gradients were not measurable.`
      : '';

  if (outcome.totalViolations === 0) {
    return {
      ok: true,
      message: `${outcome.checked} text element(s) meet the required contrast ratio.${limitation}`,
      evidence: {
        checked: outcome.checked,
        unverifiableCount: outcome.unverifiableCount,
        unverifiable: outcome.unverifiable,
      },
    };
  }

  return {
    ok: false,
    message:
      `${outcome.totalViolations} of ${outcome.checked} text element(s) fall below the WCAG AA ratio.` +
      limitation,
    evidence: {
      checked: outcome.checked,
      violations: outcome.violations,
      unverifiableCount: outcome.unverifiableCount,
      unverifiable: outcome.unverifiable,
    },
    remediation:
      'Darken the text or lighten the surface until the ratio meets 4.5:1 (3:1 for large text), or move the text off the image. Verify manually where the check could not measure.',
  };
}
