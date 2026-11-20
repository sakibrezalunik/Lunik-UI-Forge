import { chromium } from 'playwright';
import { EnvironmentError } from './errors.js';

/**
 * Launch the browser used for verification.
 *
 * Resolution order:
 *   1. `LUNIK_BROWSER_CHANNEL` environment variable
 *   2. `browser.channel` from lunik.config.json
 *   3. Playwright's bundled Chromium
 *
 * Using `channel: "chrome"` lets a machine verify without downloading
 * Playwright's Chromium, at the cost of depending on the local Chrome version.
 *
 * @param {{channel?: string|null, headless?: boolean}} options
 */
export async function launchBrowser({ channel = null, headless = true } = {}) {
  const effectiveChannel = process.env.LUNIK_BROWSER_CHANNEL || channel || null;
  const launchOptions = { headless };
  if (effectiveChannel) launchOptions.channel = effectiveChannel;

  try {
    const browser = await chromium.launch(launchOptions);
    return {
      browser,
      info: {
        name: browser.browserType().name(),
        version: browser.version(),
        channel: effectiveChannel,
        headless,
      },
    };
  } catch (error) {
    throw new EnvironmentError(
      `Could not launch a browser: ${firstLine(error.message)}`,
      [
        effectiveChannel
          ? `Requested channel "${effectiveChannel}". Confirm that browser is installed.`
          : 'Bundled Chromium is missing. Run: npx playwright install chromium',
        'Or set browser.channel to "chrome" / "msedge" in lunik.config.json to use an installed browser.',
        'Or set LUNIK_BROWSER_CHANNEL=chrome to override for one run.',
      ],
    );
  }
}

function firstLine(message) {
  return String(message).split('\n')[0].trim();
}
