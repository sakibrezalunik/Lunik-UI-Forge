import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXIT,
  SEVERITY,
  STATUS,
  exitCodeFor,
  statusFor,
  summarize,
} from '../../tools/lib/severity.js';

test('a violation of an error-severity check is a failure', () => {
  assert.equal(statusFor(false, SEVERITY.ERROR), STATUS.FAIL);
});

test('a violation of a warning-severity check is a warning, not a failure', () => {
  assert.equal(statusFor(false, SEVERITY.WARNING), STATUS.WARNING);
});

test('a satisfied check passes regardless of severity', () => {
  assert.equal(statusFor(true, SEVERITY.ERROR), STATUS.PASS);
  assert.equal(statusFor(true, SEVERITY.WARNING), STATUS.PASS);
});

test('summarize counts every status', () => {
  const { counts, status } = summarize([
    { status: STATUS.PASS },
    { status: STATUS.PASS },
    { status: STATUS.FAIL },
    { status: STATUS.WARNING },
    { status: STATUS.SKIPPED },
  ]);

  assert.deepEqual(counts, { pass: 2, fail: 1, warning: 1, inconclusive: 0, skipped: 1 });
  assert.equal(status, STATUS.FAIL);
});

test('warnings alone do not fail a run, but do under --strict', () => {
  const results = [{ status: STATUS.PASS }, { status: STATUS.WARNING }];

  assert.equal(summarize(results).status, STATUS.WARNING);
  assert.equal(summarize(results, { strict: true }).status, STATUS.FAIL);
});

test('an inconclusive result is never reported as a pass', () => {
  const { status } = summarize([{ status: STATUS.PASS }, { status: STATUS.INCONCLUSIVE }]);
  assert.equal(status, STATUS.INCONCLUSIVE);
  assert.notEqual(exitCodeFor(status), EXIT.OK);
});

test('failures outrank inconclusive results for the exit code', () => {
  const { status } = summarize([{ status: STATUS.FAIL }, { status: STATUS.INCONCLUSIVE }]);
  assert.equal(status, STATUS.FAIL);
  assert.equal(exitCodeFor(status), EXIT.FAILURE);
});

test('exit codes separate pass, failure, and could-not-run', () => {
  assert.equal(exitCodeFor(STATUS.PASS), 0);
  assert.equal(exitCodeFor(STATUS.WARNING), 0);
  assert.equal(exitCodeFor(STATUS.FAIL), 1);
  assert.equal(exitCodeFor(STATUS.INCONCLUSIVE), 3);
});

test('an empty result set passes without inventing checks', () => {
  const { counts, status } = summarize([]);
  assert.equal(counts.pass, 0);
  assert.equal(status, STATUS.PASS);
});
