import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagBool, flagList, flagString, parseArgs, unknownFlags } from '../../tools/lib/args.js';
import { relativePosix, round, toPosix } from '../../tools/lib/fs-utils.js';

test('boolean flags', () => {
  const { flags } = parseArgs(['--confirm']);
  assert.equal(flagBool(flags, 'confirm'), true);
  assert.equal(flagBool(flags, 'missing'), false);
  assert.equal(flagBool(flags, 'missing', true), true);
});

test('--no-<flag> negates', () => {
  const { flags } = parseArgs(['--no-confirm']);
  assert.equal(flagBool(flags, 'confirm', true), false);
});

test('key value and key=value forms agree', () => {
  assert.equal(flagString(parseArgs(['--page', 'saas']).flags, 'page'), 'saas');
  assert.equal(flagString(parseArgs(['--page=saas']).flags, 'page'), 'saas');
});

test('repeated keys collect into a list', () => {
  const { flags } = parseArgs(['--viewport', 'desktop', '--viewport', 'mobile']);
  assert.deepEqual(flagList(flags, 'viewport'), ['desktop', 'mobile']);
});

test('a flag followed by another flag is boolean', () => {
  const { flags } = parseArgs(['--strict', '--quiet']);
  assert.equal(flagBool(flags, 'strict'), true);
  assert.equal(flagBool(flags, 'quiet'), true);
});

test('a value that looks like a path is preserved', () => {
  const { flags } = parseArgs(['--config', 'tests/fixtures/lunik.fixtures.config.json']);
  assert.equal(flagString(flags, 'config'), 'tests/fixtures/lunik.fixtures.config.json');
});

test('unknown flags are reported so a typo cannot be silently ignored', () => {
  const { flags } = parseArgs(['--strict', '--stirct', '--page', 'x']);
  assert.deepEqual(unknownFlags(flags, ['strict', 'page', 'help']), ['stirct']);
  assert.deepEqual(unknownFlags(flags, ['strict', 'stirct', 'page', 'help']), []);
});

test('--no-<known flag> is not reported as unknown', () => {
  const { flags } = parseArgs(['--no-strict']);
  assert.deepEqual(unknownFlags(flags, ['strict']), []);
});

test('round keeps report numbers stable', () => {
  assert.equal(round(0.123456, 4), 0.1235);
  assert.equal(round(1 / 3, 6), 0.333333);
});

test('toPosix and relativePosix produce portable separators', () => {
  assert.equal(toPosix('a/b/c'), 'a/b/c');
  assert.equal(relativePosix('/root', '/root/a/b.txt'), 'a/b.txt');
});
