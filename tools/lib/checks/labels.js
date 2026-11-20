export const id = 'labels';
export const title = 'Form label association';

const NON_LABELLED_INPUT_TYPES = ['hidden', 'submit', 'reset', 'button', 'image'];

/**
 * Checks that form controls are programmatically associated with a label, and
 * that no `label[for]` points at an element that does not exist.
 *
 * Complements the accessibility-tree check: a visible-looking label that is not
 * linked to its input passes a human eye and fails a screen reader.
 */
export async function run({ page }) {
  const result = await page.evaluate((skipTypes) => {
    const describe = (el) => {
      let part = el.tagName.toLowerCase();
      if (el.id) part += `#${el.id}`;
      const type = el.getAttribute('type');
      if (type) part += `[type="${type}"]`;
      return part;
    };

    const controls = Array.from(document.querySelectorAll('input, select, textarea'));
    const violations = [];

    for (const el of controls) {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (skipTypes.includes(type)) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;

      const ariaLabel = (el.getAttribute('aria-label') ?? '').trim();
      const labelledBy = (el.getAttribute('aria-labelledby') ?? '').trim();
      const labelledByResolves =
        labelledBy !== '' &&
        labelledBy.split(/\s+/).every((id) => document.getElementById(id) !== null);
      const title = (el.getAttribute('title') ?? '').trim();
      const wrapped = el.closest('label') !== null;
      const explicit =
        el.id !== '' &&
        document.querySelector(`label[for="${CSS.escape(el.id)}"]`) !== null;

      if (ariaLabel || labelledByResolves || title || wrapped || explicit) continue;

      violations.push({
        control: describe(el),
        reason:
          labelledBy !== ''
            ? 'aria-labelledby points at an element that does not exist'
            : 'no aria-label, aria-labelledby, title, wrapping label, or label[for]',
      });
    }

    const danglingLabels = Array.from(document.querySelectorAll('label[for]'))
      .filter((label) => document.getElementById(label.getAttribute('for')) === null)
      .map((label) => ({ for: label.getAttribute('for'), text: label.textContent.trim().slice(0, 60) }));

    return { totalControls: controls.length, violations, danglingLabels };
  }, NON_LABELLED_INPUT_TYPES);

  if (result.violations.length === 0 && result.danglingLabels.length === 0) {
    return {
      ok: true,
      message: `All ${result.totalControls} form control(s) are associated with a label.`,
    };
  }

  return {
    ok: false,
    message:
      `${result.violations.length} unlabelled control(s), ` +
      `${result.danglingLabels.length} label(s) pointing at a missing element.`,
    evidence: {
      violations: result.violations.slice(0, 10),
      danglingLabels: result.danglingLabels.slice(0, 10),
    },
    remediation:
      'Give the control an id and add <label for="…">, or wrap the control in a <label>, or add aria-label. Remove label[for] values whose target no longer exists.',
  };
}
