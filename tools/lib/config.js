import path from 'node:path';
import { EnvironmentError } from './errors.js';
import { JsonReadError, readJsonIfExists } from './fs-utils.js';
import { VALID_SEVERITIES } from './severity.js';

export const CONFIG_FILENAME = 'lunik.config.json';

/** A page id becomes a directory name under `baselines/`, so it must be a safe slug. */
export const PAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A viewport name becomes a baseline file name (`<name>.png`) and an archive
 * prefix, so it obeys the same rule as a page id. Without this, a name such as
 * `../../../escaped` would resolve outside the baselines directory.
 */
export const VIEWPORT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Post-interaction observation window: how long after the last interaction step
 * the runner keeps counting newly initiated requests as in scope.
 *
 * 1000 ms covers a debounce (150–300 ms), a `setTimeout`, a couple of animation
 * frames and a request that misses the previous 150 ms floor entirely. It is a
 * bound on what is *observed*, not a claim that nothing can happen later.
 */
export const NETWORK_OBSERVATION_DEFAULT_MS = 1000;
/** Upper bound on the observation window, so verification stays predictable. */
export const NETWORK_OBSERVATION_MAX_MS = 10_000;
/**
 * Pending-request timeout: how long a request that started inside the
 * observation window may stay unanswered before its outcome is unknown. It is a
 * separate budget from the observation window on purpose — one decides what is
 * in scope, the other how long a known request may take.
 */
export const NETWORK_PENDING_DEFAULT_MS = 2000;
/** Upper bound on the pending-request timeout. */
export const NETWORK_PENDING_MAX_MS = 30_000;

/**
 * Defaults for every check. Anything a project does not configure keeps these
 * values, so behaviour is predictable for a fresh checkout.
 */
export function defaultConfig() {
  return {
    viewports: [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 834, height: 1112 },
      { name: 'mobile', width: 390, height: 844 },
    ],
    browser: {
      /** null => bundled Chromium. Set to "chrome"/"msedge" to use an installed browser. */
      channel: null,
      headless: true,
      /** Fixed so screenshots do not depend on the machine's theme. */
      colorScheme: 'light',
    },
    reportsDir: 'reports',
    baselinesDir: 'baselines',
    checks: {
      console: { enabled: true, severity: 'error' },
      network: {
        enabled: true,
        severity: 'error',
        ignore: ['/favicon.ico'],
        observationWindowMs: NETWORK_OBSERVATION_DEFAULT_MS,
        pendingTimeoutMs: NETWORK_PENDING_DEFAULT_MS,
      },
      overflow: { enabled: true, severity: 'error', tolerance: 1 },
      a11yNames: { enabled: true, severity: 'error' },
      labels: { enabled: true, severity: 'error' },
      contrast: {
        enabled: true,
        severity: 'warning',
        minRatioNormal: 4.5,
        minRatioLarge: 3,
      },
      links: { enabled: true, severity: 'error' },
      elements: { enabled: true, severity: 'error' },
      interactions: { enabled: true, severity: 'error' },
      visual: {
        enabled: true,
        severity: 'error',
        maxDiffRatio: 0.001,
        pixelThreshold: 0.1,
      },
    },
    pages: [],
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge `override` onto `base` without mutating either. */
function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] =
      isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return result;
}

/**
 * Load the project config, merged over defaults.
 *
 * @param {string} root absolute project root
 * @param {string} [configPath] absolute or root-relative config path
 */
export async function loadConfig(root, configPath) {
  const resolved = configPath
    ? path.resolve(root, configPath)
    : path.join(root, CONFIG_FILENAME);

  let raw;
  try {
    raw = await readJsonIfExists(resolved, null);
  } catch (error) {
    // Malformed JSON is a configuration mistake: the user can fix it by editing
    // the file, so it must exit 2 with a readable message, not 3 with a stack.
    if (error instanceof JsonReadError) {
      throw new ConfigError(`Invalid JSON in configuration file: ${resolved}`, [
        error.message,
        'Fix the JSON syntax (a comment, trailing comma, or unrelated file), then re-run.',
      ]);
    }
    // A genuine filesystem problem — a directory, permissions, a device error —
    // is not fixable by editing JSON, so it stays an environment failure.
    throw new EnvironmentError(`Could not read the configuration file at ${resolved}`, [
      `${error.code ?? 'ERROR'}: ${error.message}`,
    ]);
  }

  if (raw === null) {
    throw new ConfigError(`No configuration found at ${resolved}`, [
      `Create ${CONFIG_FILENAME} at the project root, or pass --config <path>.`,
    ]);
  }

  const config = merge(defaultConfig(), raw);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigError(`Invalid configuration: ${resolved}`, errors);
  }
  return { config, configPath: resolved };
}

/** Thrown for user-fixable configuration problems (exit code 2, not 1). */
export class ConfigError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

/**
 * Validate a merged config.
 * @returns {string[]} human-readable problems; empty means valid
 */
export function validateConfig(config) {
  const errors = [];

  if (!Array.isArray(config.viewports) || config.viewports.length === 0) {
    errors.push('`viewports` must be a non-empty array.');
  } else {
    const seen = new Set();
    config.viewports.forEach((viewport, index) => {
      const where = `viewports[${index}]`;
      if (!viewport || typeof viewport.name !== 'string' || viewport.name.trim() === '') {
        errors.push(`${where}.name must be a non-empty string.`);
      } else if (!VIEWPORT_NAME_PATTERN.test(viewport.name)) {
        errors.push(
          `${where}.name "${viewport.name}" must match ${VIEWPORT_NAME_PATTERN} ` +
            '(lowercase letters, digits, dot, dash, underscore). Viewport names are ' +
            'used as file names for baselines, so paths are not allowed.',
        );
      } else if (seen.has(viewport.name)) {
        errors.push(`${where}.name "${viewport.name}" is duplicated.`);
      } else {
        seen.add(viewport.name);
      }
      for (const dim of ['width', 'height']) {
        const value = viewport?.[dim];
        if (!Number.isInteger(value) || value <= 0) {
          errors.push(`${where}.${dim} must be a positive integer.`);
        }
      }
    });
  }

  if (!Array.isArray(config.pages) || config.pages.length === 0) {
    errors.push('`pages` must be a non-empty array.');
  } else {
    const ids = new Set();
    config.pages.forEach((page, index) => {
      const where = `pages[${index}]`;
      if (typeof page?.id !== 'string' || !PAGE_ID_PATTERN.test(page.id)) {
        errors.push(
          `${where}.id must match ${PAGE_ID_PATTERN} (lowercase, used as a directory name).`,
        );
      } else if (ids.has(page.id)) {
        errors.push(`${where}.id "${page.id}" is duplicated.`);
      } else {
        ids.add(page.id);
      }

      const hasPath = typeof page?.path === 'string' && page.path.startsWith('/');
      const hasUrl = typeof page?.url === 'string' && /^https?:\/\//.test(page.url);
      if (!hasPath && !hasUrl) {
        errors.push(`${where} needs either "path" (starting with "/") or an absolute "url".`);
      }

      if (page?.expect?.selectors && !Array.isArray(page.expect.selectors)) {
        errors.push(`${where}.expect.selectors must be an array of CSS selectors.`);
      }

      if (page?.interactions && !Array.isArray(page.interactions)) {
        errors.push(`${where}.interactions must be an array.`);
      } else {
        (page?.interactions ?? []).forEach((interaction, i) => {
          if (typeof interaction?.name !== 'string' || interaction.name.trim() === '') {
            errors.push(`${where}.interactions[${i}].name is required.`);
          }
          if (!Array.isArray(interaction?.steps) || interaction.steps.length === 0) {
            errors.push(`${where}.interactions[${i}].steps must be a non-empty array.`);
          }
        });
      }
    });
  }

  if (config.browser?.channel !== null && typeof config.browser?.channel !== 'string') {
    errors.push('`browser.channel` must be null or a string such as "chrome".');
  }

  for (const [name, check] of Object.entries(config.checks ?? {})) {
    if (!isPlainObject(check)) {
      errors.push(`checks.${name} must be an object.`);
      continue;
    }
    if (typeof check.enabled !== 'boolean') {
      errors.push(`checks.${name}.enabled must be a boolean.`);
    }
    if (!VALID_SEVERITIES.includes(check.severity)) {
      errors.push(`checks.${name}.severity must be one of: ${VALID_SEVERITIES.join(', ')}.`);
    }
  }

  const visual = config.checks?.visual;
  if (visual && (typeof visual.maxDiffRatio !== 'number' || visual.maxDiffRatio < 0)) {
    errors.push('checks.visual.maxDiffRatio must be a number >= 0.');
  }

  const network = config.checks?.network;
  if (network) {
    // The ignore syntax is unchanged from earlier versions: an array of URL
    // substrings. Non-string entries used to be accepted and silently never
    // matched, which hid real findings, so they are a configuration error now.
    if (!Array.isArray(network.ignore)) {
      errors.push('checks.network.ignore must be an array of URL substrings.');
    } else {
      network.ignore.forEach((pattern, index) => {
        if (typeof pattern !== 'string' || pattern === '') {
          errors.push(
            `checks.network.ignore[${index}] must be a non-empty string ` +
              '(a substring of the request URL).',
          );
        }
      });
    }

    assertNetworkDuration(errors, network, 'observationWindowMs', NETWORK_OBSERVATION_MAX_MS, {
      what: 'the post-interaction observation window',
      hint:
        'It bounds what the runner observes after the last interaction step; ' +
        '0 skips the window and observes nothing new.',
    });
    assertNetworkDuration(errors, network, 'pendingTimeoutMs', NETWORK_PENDING_MAX_MS, {
      what: 'the pending-request timeout',
      hint:
        'It bounds how long a request that started inside the observation window may stay ' +
        'unanswered before its outcome is reported as unknown.',
    });
  }

  return errors;
}

/**
 * Validate one duration-valued key of `checks.network`.
 *
 * Durations are whole milliseconds inside a hard bound: a negative value or a
 * value above the bound is rejected instead of silently clamped, so a config
 * that would make verification hang cannot be accepted.
 */
function assertNetworkDuration(errors, network, key, maximum, { what, hint }) {
  const value = network[key];
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    errors.push(
      `checks.network.${key} must be an integer between 0 and ${maximum} (milliseconds) — ${what}. ${hint}`,
    );
  }
}

/**
 * Resolve a page definition to the absolute URL the browser should open.
 *
 * @param {object} page
 * @param {string|null} serverBase e.g. "http://127.0.0.1:51234"
 */
export function resolvePageUrl(page, serverBase) {
  if (page.url) return page.url;
  if (!serverBase) {
    throw new ConfigError(
      `Page "${page.id}" uses a local "path" but no static server is available.`,
    );
  }
  return new URL(page.path, `${serverBase}/`).toString();
}

/**
 * Select pages by id, preserving configured order.
 * @param {object} config
 * @param {string[]} [ids]
 */
export function selectPages(config, ids) {
  if (!ids || ids.length === 0) return config.pages;
  const wanted = new Set(ids);
  const unknown = ids.filter((id) => !config.pages.some((page) => page.id === id));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown page id(s): ${unknown.join(', ')}`,
      [`Configured ids: ${config.pages.map((page) => page.id).join(', ')}`],
    );
  }
  return config.pages.filter((page) => wanted.has(page.id));
}

/** Select viewports by name, preserving configured order. */
export function selectViewports(config, names) {
  if (!names || names.length === 0) return config.viewports;
  const wanted = new Set(names);
  const unknown = names.filter((name) => !config.viewports.some((v) => v.name === name));
  if (unknown.length > 0) {
    throw new ConfigError(`Unknown viewport name(s): ${unknown.join(', ')}`, [
      `Configured viewports: ${config.viewports.map((v) => v.name).join(', ')}`,
    ]);
  }
  return config.viewports.filter((v) => wanted.has(v.name));
}
