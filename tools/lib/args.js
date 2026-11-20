/**
 * Minimal CLI argument parser.
 * Supports `--flag`, `--key value`, `--key=value`, and repeated keys (=> array).
 */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const equalsAt = arg.indexOf('=');
    if (equalsAt > -1) {
      add(flags, arg.slice(2, equalsAt), arg.slice(equalsAt + 1));
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      add(flags, key, next);
      index += 1;
    } else {
      add(flags, key, true);
    }
  }

  return { flags, positional };
}

function add(flags, key, value) {
  if (!(key in flags)) {
    flags[key] = value;
    return;
  }
  flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
}

/** Normalise a repeatable flag to an array of strings. */
export function flagList(flags, key) {
  const value = flags[key];
  if (value === undefined) return [];
  if (value === true) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

/** Read a string flag, or `fallback` when absent/boolean. */
export function flagString(flags, key, fallback = null) {
  const value = flags[key];
  if (value === undefined || value === true) return fallback;
  return String(Array.isArray(value) ? value[value.length - 1] : value);
}

/**
 * Names of flags that the caller does not understand.
 *
 * A silently ignored typo is dangerous for a safety tool: `--stirct` would run a
 * non-strict verification while the operator believes warnings are fatal. Each
 * CLI therefore rejects unknown options instead of guessing. `--no-<key>` is
 * accepted when `<key>` is known, matching {@link flagBool}.
 *
 * @param {Record<string, unknown>} flags parsed flags
 * @param {string[]} allowed option names without the leading `--`
 * @returns {string[]} unknown option names, in the order they were given
 */
export function unknownFlags(flags, allowed) {
  const known = new Set(allowed);
  return Object.keys(flags).filter((key) => {
    const base = key.startsWith('no-') ? key.slice(3) : key;
    return !known.has(base);
  });
}

/**
 * Value-taking flags that were given without a value (or followed by another
 * option). Treating `--page` as "all pages" is the kind of silent widening a
 * verification tool must not do.
 *
 * @param {Record<string, unknown>} flags parsed flags
 * @param {string[]} valueFlags option names that require a value
 * @returns {string[]} option names missing a value
 */
export function flagsMissingValue(flags, valueFlags) {
  return valueFlags.filter((key) => flags[key] === true);
}

/** Read a boolean flag. Supports `--no-<key>` to negate. */
export function flagBool(flags, key, fallback = false) {
  if (`no-${key}` in flags) return false;
  if (!(key in flags)) return fallback;
  const value = flags[key];
  if (value === true) return true;
  return !['false', '0', 'no'].includes(String(value).toLowerCase());
}
