/**
 * M-1 — configuration loading must classify failures correctly:
 *
 *   missing file      -> ConfigError (exit 2), as before
 *   malformed JSON    -> ConfigError (exit 2), clean message, no stack trace
 *   filesystem error  -> EnvironmentError (exit 3), never "your JSON is wrong"
 *
 * M-2 part A — viewport names are path segments, so they are validated as slugs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  VIEWPORT_NAME_PATTERN,
  defaultConfig,
  loadConfig,
  validateConfig,
} from '../../tools/lib/config.js';
import { EnvironmentError } from '../../tools/lib/errors.js';
import { JsonReadError, readJsonIfExists } from '../../tools/lib/fs-utils.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test', 'config-errors');

const VALID = path.join(TMP, 'valid.json');
const MALFORMED = path.join(TMP, 'malformed.json');
const EMPTY = path.join(TMP, 'empty.json');
const MISSING = path.join(TMP, 'missing.json');
const HOSTILE_VIEWPORT = path.join(TMP, 'hostile-viewport.json');

function page(overrides = {}) {
  return { id: 'page-one', path: '/index.html', ...overrides };
}

function configWith(viewports) {
  const config = { ...defaultConfig(), pages: [page()] };
  config.viewports = viewports;
  return config;
}

function runCli(args) {
  return spawnSync(process.execPath, ['tools/visual-verify.js', ...args], {
    cwd: PROJECT,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

before(async () => {
  await mkdir(TMP, { recursive: true });
  await writeFile(
    VALID,
    `${JSON.stringify({ viewports: [{ name: 'desktop', width: 1440, height: 900 }], pages: [page()] }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(MALFORMED, '{ "pages": [ } // trailing garbage\n', 'utf8');
  await writeFile(EMPTY, '', 'utf8');
  await writeFile(
    HOSTILE_VIEWPORT,
    `${JSON.stringify({ viewports: [{ name: '../../../escaped', width: 1440, height: 900 }], pages: [page()] }, null, 2)}\n`,
    'utf8',
  );
});

after(async () => {
  // Only this file's artefacts: browser tests run in parallel and share .tmp-test.
  await rm(TMP, { recursive: true, force: true });
});

test('a valid configuration loads and merges over the defaults', async () => {
  const { config, configPath } = await loadConfig(PROJECT, VALID);
  assert.equal(configPath, VALID);
  assert.equal(config.viewports.length, 1);
  assert.equal(config.viewports[0].name, 'desktop');
  assert.equal(config.checks.contrast.severity, 'warning', 'defaults still apply');
});

test('malformed JSON is a ConfigError that names the file', async () => {
  await assert.rejects(
    () => loadConfig(PROJECT, MALFORMED),
    (error) => {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error.name}`);
      assert.match(error.message, /Invalid JSON in configuration file/);
      assert.ok(error.message.includes(MALFORMED), 'the message must name the file');
      assert.ok(
        error.details.some((detail) => /Failed to read JSON/.test(detail)),
        'the underlying syntax problem should be preserved for debugging',
      );
      return true;
    },
  );
});

test('an empty configuration file is a ConfigError, not an environment failure', async () => {
  await assert.rejects(() => loadConfig(PROJECT, EMPTY), ConfigError);
});

test('a missing configuration file keeps its "not found" classification', async () => {
  await assert.rejects(
    () => loadConfig(PROJECT, MISSING),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /No configuration found/);
      return true;
    },
  );
});

test('a filesystem failure is an EnvironmentError, not a configuration error', async () => {
  // A directory is readable-but-not-a-file: readFile throws EISDIR before any
  // JSON is involved, which must not be blamed on the user's configuration.
  await assert.rejects(
    () => loadConfig(PROJECT, path.join(PROJECT, 'tests')),
    (error) => {
      assert.ok(error instanceof EnvironmentError, `expected EnvironmentError, got ${error.name}`);
      assert.equal(error instanceof ConfigError, false);
      assert.match(error.message, /Could not read the configuration file/);
      return true;
    },
  );
});

test('readJsonIfExists still reports unreadable JSON with the documented wording', async () => {
  // `readManifest` relies on this wording, and its existing test asserts it.
  await assert.rejects(
    () => readJsonIfExists(MALFORMED),
    (error) => {
      assert.ok(error instanceof JsonReadError);
      assert.match(error.message, /Failed to read JSON/);
      assert.equal(error.file, MALFORMED);
      return true;
    },
  );
});

test('readJsonIfExists returns the fallback for a missing file and the value otherwise', async () => {
  assert.equal(await readJsonIfExists(MISSING, 'fallback'), 'fallback');
  assert.deepEqual(await readJsonIfExists(VALID), {
    viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    pages: [page()],
  });
});

test('the CLI exits 2 on malformed JSON without printing a stack trace', () => {
  const result = runCli(['--config', MALFORMED]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /Configuration error: Invalid JSON in configuration file/);
  assert.ok(result.stderr.includes(MALFORMED));
  assert.equal(
    /^\s+at /m.test(result.stderr),
    false,
    `an expected configuration error must not print stack frames:\n${result.stderr}`,
  );
});

test('the CLI exits 2 when the configuration file is missing', () => {
  const result = runCli(['--config', MISSING]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No configuration found/);
});

test('the CLI exits 3 when the configuration path is not a readable file', () => {
  const result = runCli(['--config', path.join(PROJECT, 'tests')]);
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /Environment error: Could not read the configuration file/);
});

test('the CLI rejects a configuration whose viewport name is a path', () => {
  const result = runCli(['--config', HOSTILE_VIEWPORT]);
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /must match/);
  assert.ok(result.stderr.includes('../../../escaped'));
});

test('the existing viewport names remain valid', () => {
  for (const name of ['desktop', 'tablet', 'mobile']) {
    assert.ok(VIEWPORT_NAME_PATTERN.test(name), `${name} must stay valid`);
    const errors = validateConfig(configWith([{ name, width: 800, height: 600 }]));
    assert.deepEqual(errors, [], `${name} should produce no validation errors`);
  }
});

test('viewport names that are paths or unsafe file names are rejected', () => {
  const hostile = [
    '../escape',
    '../../escape',
    '../../../escaped',
    '..\\escape',
    'C:\\outside',
    '/abs/out',
    'sub/dir',
    '',
    '   ',
    'Mobile',
    'with space',
    '..',
    '.',
  ];

  for (const name of hostile) {
    const errors = validateConfig(configWith([{ name, width: 800, height: 600 }]));
    assert.ok(
      errors.some((error) => error.includes('viewports[0].name')),
      `expected ${JSON.stringify(name)} to be rejected, got ${JSON.stringify(errors)}`,
    );
  }
});
