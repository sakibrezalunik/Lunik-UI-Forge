import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildReport, makeRunId, renderMarkdown, writeReport } from '../../tools/lib/report.js';
import { STATUS } from '../../tools/lib/severity.js';

const RESULTS = [
  {
    pageId: 'page-one',
    pageUrl: 'http://127.0.0.1:1/index.html',
    viewport: 'desktop',
    check: 'overflow',
    title: 'Horizontal overflow',
    severity: 'error',
    status: STATUS.FAIL,
    message: 'Page is 40px wider than the 1440px viewport.',
    evidence: { overflowPx: 40 },
    remediation: 'Constrain the element.',
    artifacts: { screenshot: 'reports/x/screenshots/page-one/desktop.png' },
  },
  {
    pageId: 'page-one',
    pageUrl: 'http://127.0.0.1:1/index.html',
    viewport: 'desktop',
    check: 'contrast',
    title: 'Text contrast',
    severity: 'warning',
    status: STATUS.WARNING,
    message: '1 of 6 text elements fall below the ratio.',
    evidence: null,
    remediation: 'Darken the text.',
    artifacts: null,
  },
  {
    pageId: 'page-one',
    pageUrl: 'http://127.0.0.1:1/index.html',
    viewport: 'desktop',
    check: 'a11yNames',
    title: 'Accessible names',
    severity: 'error',
    status: STATUS.PASS,
    message: 'All controls named.',
    evidence: null,
    remediation: null,
    artifacts: null,
  },
];

function report(overrides = {}) {
  return buildReport({
    tool: { name: 'lunik-ui-forge', version: '0.1.0' },
    environment: {
      node: 'v24.0.0',
      platform: 'test',
      arch: 'x64',
      browser: { name: 'chromium', version: '1', channel: null },
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    configPath: '/project/lunik.config.json',
    pages: ['page-one'],
    viewports: ['desktop'],
    results: RESULTS,
    ...overrides,
  });
}

test('buildReport counts statuses and derives the run status', () => {
  const built = report();
  assert.equal(built.summary.total, 3);
  assert.equal(built.summary.fail, 1);
  assert.equal(built.summary.warning, 1);
  assert.equal(built.summary.pass, 1);
  assert.equal(built.run.status, STATUS.FAIL);
  assert.equal(built.run.durationMs, 2000);
});

test('buildReport never invents an execution date', () => {
  const built = report();
  assert.equal(built.run.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(built.run.finishedAt, '2026-01-01T00:00:02.000Z');
});

test('strict mode turns warnings into a failing run', () => {
  const built = report({ strict: true, results: [RESULTS[1]] });
  assert.equal(built.run.status, STATUS.FAIL);
});

test('markdown separates failures from warnings and includes remediation', () => {
  const markdown = renderMarkdown(report());

  assert.match(markdown, /Result: FAIL/);
  assert.match(markdown, /### FAIL · Horizontal overflow/);
  assert.match(markdown, /### WARN · Text contrast/);
  assert.match(markdown, /Suggested fix: Constrain the element\./);
  assert.match(markdown, /Passing checks/);
});

test('markdown says so plainly when nothing needs attention', () => {
  const markdown = renderMarkdown(report({ results: [RESULTS[2]] }));
  assert.match(markdown, /No failures, warnings, or inconclusive checks\./);
});

test('run ids are filesystem-safe', () => {
  const id = makeRunId('2026-01-01T12:34:56.789Z');
  assert.equal(id, '2026-01-01T12-34-56-789Z');
  assert.doesNotMatch(id, /[:.]/);
});

test('writeReport writes json, markdown, and a latest copy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lunik-report-'));
  const written = await writeReport(report(), { reportsDir: dir, runId: 'run-1' });

  const json = JSON.parse(await readFile(written.json, 'utf8'));
  assert.equal(json.summary.total, 3);
  assert.ok((await readFile(written.markdown, 'utf8')).includes('Lunik UI Forge'));

  const latest = JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8'));
  assert.equal(latest.summary.total, 3);

  // The summary prints these paths, so a custom reportsDir must be reflected.
  assert.equal(written.latestJson, path.join(dir, 'latest.json'));
  assert.equal(written.latestMarkdown, path.join(dir, 'latest.md'));
});
