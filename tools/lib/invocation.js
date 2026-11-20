import path from 'node:path';
import { toPosix } from './fs-utils.js';

/**
 * A path as the user should read or paste it: relative to the current working
 * directory when that stays inside the project, absolute otherwise.
 */
export function displayPath(target) {
  const relative = path.relative(process.cwd(), target);
  const value =
    relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : target;
  return toPosix(value);
}

export function quoteIfNeeded(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * The `--config`/`--root` flags that reproduce this invocation.
 *
 * Printed commands are meant to be pasted as-is. Without these, a project using
 * a non-default config would copy a command that reads `lunik.config.json`
 * instead, and fail or act on the wrong project.
 */
export function invocationFlags(root, configPath) {
  const parts = [];
  if (path.resolve(configPath) !== path.resolve(root, 'lunik.config.json')) {
    parts.push(`--config ${quoteIfNeeded(displayPath(configPath))}`);
  }
  if (path.resolve(root) !== path.resolve(process.cwd())) {
    parts.push(`--root ${quoteIfNeeded(displayPath(root))}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
