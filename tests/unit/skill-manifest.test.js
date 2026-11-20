/**
 * Guards against documentation drift: the skill manifest points at files that
 * must exist, and it must stay in step with the package it describes.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brief, loadInstructions, skill } from '../../skills/lunik-ui.js';
import { pathExists } from '../../tools/lib/fs-utils.js';
import { defaultConfig } from '../../tools/lib/config.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('skill version matches the package version', async () => {
  const pkg = JSON.parse(await readFile(path.join(PROJECT, 'package.json'), 'utf8'));
  assert.equal(skill.version, pkg.version);
  assert.equal(skill.name, 'lunik-ui');
});

test('every file the manifest references exists', async () => {
  for (const [key, relative] of Object.entries(skill.files)) {
    assert.equal(await pathExists(path.join(PROJECT, relative)), true, `missing ${key}: ${relative}`);
  }
});

test('the skill instructions carry discoverable frontmatter', async () => {
  const instructions = await loadInstructions(PROJECT);
  assert.ok(instructions.startsWith('---'), 'SKILL.md must start with YAML frontmatter');
  const frontmatter = instructions.slice(3, instructions.indexOf('---', 3));
  assert.match(frontmatter, /^name:\s*lunik-ui$/m);
  assert.match(frontmatter, /^description:\s*\S/m);
});

test('the brief states the baseline prohibition and the no-false-pass rule', () => {
  const text = brief();
  assert.match(text, /Never write baselines/);
  assert.match(text, /Never report a pass you did not observe/);
});

test('every command in the manifest points at a real script', async () => {
  for (const command of Object.values(skill.commands)) {
    const script = command.split(' ').find((part) => part.startsWith('tools/'));
    if (!script) continue;
    assert.equal(await pathExists(path.join(PROJECT, script)), true, `missing script for: ${command}`);
  }
});

test('the default config enables all ten checks with a severity', () => {
  const checks = defaultConfig().checks;
  assert.deepEqual(Object.keys(checks).sort(), [
    'a11yNames',
    'console',
    'contrast',
    'elements',
    'interactions',
    'labels',
    'links',
    'network',
    'overflow',
    'visual',
  ]);
  for (const [name, check] of Object.entries(checks)) {
    assert.ok(['error', 'warning'].includes(check.severity), `${name} needs a valid severity`);
  }
});
