import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the publish whitelist includes the local examples the default config verifies', async () => {
  const pkg = JSON.parse(await readFile(path.join(PROJECT, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(PROJECT, 'lunik.config.json'), 'utf8'));

  assert.ok(Array.isArray(pkg.files), 'package.json must declare a publish whitelist');

  for (const page of config.pages.filter((entry) => entry.path)) {
    const relative = page.path.replace(/^\/+/, '');
    const topLevel = relative.split('/')[0];
    const included = pkg.files.some(
      (entry) => entry === `${topLevel}/` || entry.startsWith(`${topLevel}/`),
    );

    assert.ok(
      included,
      `${topLevel}/ is used by the default config but is not in package.json "files"`,
    );
    await access(path.join(PROJECT, relative));
  }
});
