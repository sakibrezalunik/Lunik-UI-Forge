import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, defaultConfig, resolvePageUrl, selectPages, selectViewports, validateConfig } from '../../tools/lib/config.js';

function basePage(overrides = {}) {
  return { id: 'page-one', path: '/index.html', ...overrides };
}

test('defaults cover every check with an explicit severity', () => {
  const config = defaultConfig();
  for (const [name, check] of Object.entries(config.checks)) {
    assert.equal(typeof check.enabled, 'boolean', `${name}.enabled`);
    assert.ok(['error', 'warning'].includes(check.severity), `${name}.severity`);
  }
  assert.ok(config.checks.visual.enabled);
});

test('a minimal valid config passes validation', () => {
  const config = {
    ...defaultConfig(),
    pages: [basePage()],
  };
  assert.deepEqual(validateConfig(config), []);
});

test('duplicate page ids are rejected', () => {
  const config = { ...defaultConfig(), pages: [basePage(), basePage()] };
  const errors = validateConfig(config);
  assert.ok(errors.some((error) => error.includes('duplicated')));
});

test('page ids that are not safe slugs are rejected', () => {
  for (const id of ['../escape', 'Upper Case', '', 'has/slash']) {
    const config = { ...defaultConfig(), pages: [basePage({ id })] };
    assert.ok(
      validateConfig(config).some((error) => error.includes('id must match')),
      `expected id "${id}" to be rejected`,
    );
  }
});

test('a page without path or url is rejected', () => {
  const config = { ...defaultConfig(), pages: [{ id: 'page-one' }] };
  assert.ok(validateConfig(config).some((error) => error.includes('needs either')));
});

test('an unknown severity is rejected', () => {
  const config = defaultConfig();
  config.pages = [basePage()];
  config.checks.contrast.severity = 'fatal';
  assert.ok(validateConfig(config).some((error) => error.includes('severity must be one of')));
});

test('zero or negative viewport dimensions are rejected', () => {
  const config = defaultConfig();
  config.pages = [basePage()];
  config.viewports = [{ name: 'desktop', width: 0, height: 900 }];
  assert.ok(validateConfig(config).some((error) => error.includes('width must be a positive integer')));
});

test('duplicate viewport names are rejected', () => {
  const config = defaultConfig();
  config.pages = [basePage()];
  config.viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'desktop', width: 390, height: 844 },
  ];
  assert.ok(validateConfig(config).some((error) => error.includes('duplicated')));
});

test('an interaction without steps is rejected', () => {
  const config = {
    ...defaultConfig(),
    pages: [basePage({ interactions: [{ name: 'does something', steps: [] }] })],
  };
  assert.ok(validateConfig(config).some((error) => error.includes('steps must be a non-empty array')));
});

test('resolvePageUrl joins the served path onto the origin', () => {
  assert.equal(
    resolvePageUrl({ id: 'a', path: '/examples/x/index.html' }, 'http://127.0.0.1:1234'),
    'http://127.0.0.1:1234/examples/x/index.html',
  );
});

test('resolvePageUrl keeps absolute urls untouched', () => {
  const url = 'https://example.test/app/';
  assert.equal(resolvePageUrl({ id: 'a', url }, 'http://127.0.0.1:1234'), url);
});

test('resolvePageUrl refuses a local path without a server', () => {
  assert.throws(() => resolvePageUrl({ id: 'a', path: '/x.html' }, null), ConfigError);
});

test('selectPages preserves configured order and rejects unknown ids', () => {
  const config = { ...defaultConfig(), pages: [basePage({ id: 'one' }), basePage({ id: 'two' })] };

  assert.deepEqual(
    selectPages(config, ['two', 'one']).map((page) => page.id),
    ['one', 'two'],
  );
  assert.deepEqual(selectPages(config, []).map((page) => page.id), ['one', 'two']);
  assert.throws(() => selectPages(config, ['nope']), ConfigError);
});

test('selectViewports rejects unknown names', () => {
  const config = defaultConfig();
  assert.throws(() => selectViewports(config, ['watch']), ConfigError);
  assert.equal(selectViewports(config, ['mobile'])[0].name, 'mobile');
});
