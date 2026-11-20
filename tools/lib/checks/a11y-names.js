export const id = 'a11yNames';
export const title = 'Accessible names for controls';

/**
 * Roles that must expose a name to assistive technology. A button whose only
 * content is an icon, or a link around an image with no alt text, appears fine
 * on screen and is unusable with a screen reader.
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'searchbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
]);

/**
 * Reads the real accessibility tree from Chromium rather than guessing names
 * from markup. If the tree cannot be read the result is `inconclusive`, never a
 * pass.
 */
export async function run({ page }) {
  let client;
  try {
    client = await page.context().newCDPSession(page);
    await client.send('Accessibility.enable');
    await client.send('DOM.enable');
    const { nodes } = await client.send('Accessibility.getFullAXTree');

    const unnamedControls = [];
    const unnamedImages = [];

    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      if (!role) continue;

      const name = (node.name?.value ?? '').trim();
      if (name !== '') continue;

      const isControl = INTERACTIVE_ROLES.has(role);
      const isImage = role === 'image' || role === 'img';
      if (!isControl && !isImage) continue;

      const detail = await inspectNode(client, node);
      // Next.js renders its development-tools button in a `nextjs-portal`
      // custom element with a shadow root. That framework-owned control is not
      // application content; its unnamed SVG used to make every page fail in
      // development. Keep the exclusion scoped to that host: ordinary shadow
      // roots and ordinary application SVGs are still inspected below.
      if (detail.inNextDevOverlay) continue;

      const entry = { role, html: detail.html };
      if (isControl) unnamedControls.push(entry);
      else unnamedImages.push(entry);
    }

    const total = unnamedControls.length + unnamedImages.length;
    if (total === 0) {
      return { ok: true, message: 'Every interactive control and image has an accessible name.' };
    }

    return {
      ok: false,
      message:
        `${unnamedControls.length} control(s) and ${unnamedImages.length} image(s) have no accessible name.`,
      evidence: {
        unnamedControls: unnamedControls.slice(0, 10),
        unnamedImages: unnamedImages.slice(0, 10),
      },
      remediation:
        'Give each control a text label (visible text, aria-label, or aria-labelledby) and give images meaningful alt text — or alt="" if they are purely decorative.',
    };
  } catch (error) {
    return {
      inconclusive: `Could not read the accessibility tree: ${String(error.message).split('\n')[0]}`,
    };
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}

/**
 * Resolve a node once, returning both the report snippet and whether it belongs
 * to Next.js's development overlay. The walk crosses shadow boundaries through
 * `ShadowRoot.host`, but only stops at the exact `nextjs-portal` custom element.
 * No other shadow root or SVG is excluded.
 */
async function inspectNode(client, node) {
  if (!node.backendDOMNodeId) return { html: null, inNextDevOverlay: false };
  try {
    const { object } = await client.send('DOM.resolveNode', {
      backendNodeId: node.backendDOMNodeId,
    });
    const { result } = await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        let element = this;
        while (element) {
          if (element.nodeType === 1 && element.localName === 'nextjs-portal') {
            return { overlay: true, html: null };
          }
          element = element.parentNode || element.host || null;
        }
        const html = typeof this.outerHTML === 'string' ? this.outerHTML.slice(0, 200) : null;
        return { overlay: false, html };
      }`,
      returnByValue: true,
    });
    return {
      html: result.value?.html ?? null,
      inNextDevOverlay: result.value?.overlay === true,
    };
  } catch {
    return { html: null, inNextDevOverlay: false };
  }
}
