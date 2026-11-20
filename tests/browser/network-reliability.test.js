/**
 * Phase 10 network reliability regression tests — F-01 to F-04.
 *
 * Each test spawns the real CLI against a page served by a tiny HTTP server
 * owned by this file, and asserts the real verdict, the report entry and the
 * process exit code. The server is in-process on purpose: it is the only way to
 * serve a response body that is never consumed, a connection that never
 * answers, and a response delayed by an exact number of milliseconds without
 * depending on the machine or on the public internet.
 *
 * The CLI is spawned asynchronously (`spawn`, not `spawnSync`): `spawnSync`
 * would block this process's event loop and the fixture server could not answer
 * the browser at all.
 *
 * Determinism rules used throughout:
 *  - delays are measured from the click, and the observation window starts
 *    slightly *after* the click, so an in-window request lands earlier than its
 *    nominal delay and an out-of-window request lands later;
 *  - every margin is at least 100 ms, never a single timer tick;
 *  - each test writes its own report directory, so a run cannot inherit state.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test', 'network-reliability');
const REPORTS = 'tests/.tmp-test/network-reliability/reports';
const FIXTURE = '/tests/fixtures/network/index.html';

/** A single page viewport keeps every run short and comparable. */
const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 800 }];
/** Upper bound for one CLI run: a run that hangs must fail this suite. */
const RUN_BOUND_MS = 120_000;

let origin = '';
let server = null;

/** Tiny fixture server: exact statuses, exact delays, one connection that never answers. */
function startFixtureServer() {
  const sockets = new Set();
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    handleRequest(url, res).catch(() => {
      if (!res.writableEnded) res.destroy();
    });
  });
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${httpServer.address().port}`;
      resolve({
        origin: base,
        close: () =>
          new Promise((done) => {
            // A never-answering request holds its socket open; destroy them so
            // teardown cannot hang.
            httpServer.closeAllConnections?.();
            for (const socket of sockets) socket.destroy();
            httpServer.close(() => done());
          }),
      });
    });
  });
}

async function handleRequest(url, res) {
  const { pathname, searchParams } = url;
  const send = (status, body, contentType = 'text/plain; charset=utf-8') => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(body);
  };
  const sendHtml = (body) => send(200, body, 'text/html; charset=utf-8');

  // A connection that never produces a response. This is what a long poll or an
  // event stream looks like to the collector.
  if (pathname === '/hang') return;

  if (pathname === '/slow') {
    const requested = Number(searchParams.get('ms') ?? 0);
    const ms = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 10_000) : 0;
    setTimeout(() => send(200, 'slow response'), ms);
    return;
  }

  if (pathname === '/ok') return send(200, 'ok');
  if (pathname === '/missing' || pathname === '/missing-image.png') return send(404, 'not found');
  if (pathname === '/error') return send(500, 'boom');

  if (pathname === '/redirect-missing') {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(302, { location: '/missing?case=redirected', 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (pathname === '/other.html') {
    return sendHtml(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<title>Second page</title><link rel="icon" href="data:,"></head>' +
        '<body><main><h1>Second page</h1><p>Navigation target.</p></main></body></html>',
    );
  }

  if (pathname === FIXTURE || pathname === '/tests/fixtures/network/frame.html') {
    return sendHtml(await readFile(path.join(PROJECT, pathname.slice(1)), 'utf8'));
  }

  return send(404, `not found: ${pathname}`);
}

/** Spawn the CLI and wait for it, leaving this process's event loop free. */
function runCli(configPath) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ['tools/visual-verify.js', '--config', configPath, '--quiet'],
      { cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`verification did not finish within ${RUN_BOUND_MS} ms\n${stdout}\n${stderr}`));
    }, RUN_BOUND_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

async function writeConfig(name, { pages, network = {} }) {
  const config = {
    viewports: VIEWPORTS,
    reportsDir: REPORTS,
    checks: { visual: { enabled: false }, network },
    pages,
  };
  await mkdir(TMP, { recursive: true });
  const file = path.join(TMP, `${name}.json`);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

/** A page that runs one scenario selected by its own query string. */
function scenarioPage(id, query, options = {}) {
  return {
    id,
    url: `${origin}${FIXTURE}?${query}`,
    expect: { selectors: ['h1', '[data-action="go"]'] },
    interactions: options.interactions ?? [
      { name: `${id}: run the scenario`, steps: [{ click: '[data-action="go"]' }] },
    ],
  };
}

/** A page whose scenario does nothing: any finding it reports came from elsewhere. */
function cleanPage(id) {
  return scenarioPage(id, 'case=none');
}

const RUN_THEN_TOGGLE = [
  { name: 'start a request', steps: [{ click: '[data-action="go"]' }] },
  { name: 'reload, then interact again', steps: [{ click: '[data-action="toggle"]' }] },
];

async function latestReport() {
  return JSON.parse(await readFile(path.join(PROJECT, REPORTS, 'latest.json'), 'utf8'));
}

function networkFor(report, pageId) {
  return report.results.find((entry) => entry.pageId === pageId && entry.check === 'network');
}

function assertBounded(result, what) {
  assert.equal(result.signal, null, `${what} was killed instead of finishing: ${result.stdout}`);
  assert.ok(
    result.elapsedMs < RUN_BOUND_MS,
    `${what} took ${result.elapsedMs} ms, over its ${RUN_BOUND_MS} ms bound`,
  );
}

function detailsFor(network, predicate = () => true) {
  return (network.evidence?.items ?? []).filter(predicate).map((item) => item.detail);
}

before(async () => {
  server = await startFixtureServer();
  origin = server.origin;
  await mkdir(TMP, { recursive: true });
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
  await server?.close();
});

// ---------------------------------------------------------------------------
// F-01 — a healthy response settles the request, consumed body or not
// ---------------------------------------------------------------------------

test('F-01: an unconsumed response body and a consumed one both pass', async () => {
  const config = await writeConfig('f01', {
    pages: [scenarioPage('body-ignored', 'case=unconsumed'), scenarioPage('body-consumed', 'case=consumed')],
    network: { observationWindowMs: 300, pendingTimeoutMs: 800 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the F-01 run');
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();
  assert.equal(report.run.status, 'pass');

  for (const id of ['body-ignored', 'body-consumed']) {
    const network = networkFor(report, id);
    assert.ok(network, `${id} must report a network result`);
    assert.equal(
      network.status,
      'pass',
      `${id}: a successful fetch must not stay pending: ${network.message}`,
    );
    assert.equal(network.evidence.counts.failed, 0);
    assert.equal(network.evidence.counts.pending, 0);
  }

  // The unconsumed body never produces `requestfinished`; the hook below is what
  // keeps it out of the pending set.
  assert.ok(
    networkFor(report, 'body-ignored').evidence.counts.responsesWithoutFinishEvent >= 1,
    'the unconsumed fetch should be recorded as responded but never finished',
  );
});

// ---------------------------------------------------------------------------
// Failures that must stay failures
// ---------------------------------------------------------------------------

test('F-01: 404 and 500 responses still fail, with their status in the evidence', async () => {
  const config = await writeConfig('statuses', {
    pages: [scenarioPage('http-404', 'case=missing'), scenarioPage('http-500', 'case=error')],
    network: { observationWindowMs: 300, pendingTimeoutMs: 800 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the HTTP status run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();
  const notFound = networkFor(report, 'http-404');
  assert.equal(notFound.status, 'fail');
  assert.deepEqual(detailsFor(notFound), ['HTTP 404']);

  const serverError = networkFor(report, 'http-500');
  assert.equal(serverError.status, 'fail');
  assert.deepEqual(detailsFor(serverError), ['HTTP 500']);
});

test('a transport failure is a failure, not a cancellation', async () => {
  const config = await writeConfig('transport', {
    pages: [scenarioPage('transport-failure', 'case=transport')],
    network: { observationWindowMs: 300, pendingTimeoutMs: 800 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the transport failure run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const network = networkFor(await latestReport(), 'transport-failure');
  assert.equal(network.status, 'fail');
  const items = network.evidence.items;
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].kind, 'request-failed');
  assert.match(items[0].detail, /ERR_/);
  assert.equal(network.evidence.counts.cancelled, 0, 'a transport failure is not a cancellation');
});

test('a redirect followed by a failure reports one finding, not one per hop', async () => {
  const config = await writeConfig('redirect', {
    pages: [scenarioPage('redirect-failure', 'case=redirect')],
    network: { observationWindowMs: 300, pendingTimeoutMs: 800 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the redirect run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const network = networkFor(await latestReport(), 'redirect-failure');
  assert.equal(network.status, 'fail');
  assert.equal(network.evidence.count, 1, JSON.stringify(network.evidence.items));
  assert.equal(network.evidence.items.length, 1);
  assert.deepEqual(detailsFor(network), ['HTTP 404']);
});

test('a request that fails inside a same-origin iframe is detected', async () => {
  const config = await writeConfig('iframe', {
    pages: [scenarioPage('iframe-failure', 'case=none&frame=1')],
    network: { observationWindowMs: 300, pendingTimeoutMs: 800 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the iframe run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const network = networkFor(await latestReport(), 'iframe-failure');
  assert.equal(network.status, 'fail');
  const hits = network.evidence.items.filter((item) => item.url.includes('missing-image.png'));
  assert.equal(hits.length, 1, JSON.stringify(network.evidence.items));
  assert.equal(hits[0].detail, 'HTTP 404');
});

// ---------------------------------------------------------------------------
// F-02 — navigation invalidates the previous document's requests
// ---------------------------------------------------------------------------

test('F-02: a reload cancels the in-flight request and later checks still run', async () => {
  const config = await writeConfig('f02-reload', {
    pages: [
      scenarioPage('reload-pending', 'case=reload', { interactions: RUN_THEN_TOGGLE }),
      scenarioPage('reload-self', 'case=reloadSelf'),
      cleanPage('after-reload'),
    ],
    network: { observationWindowMs: 400, pendingTimeoutMs: 3000 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the reload run');
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();

  for (const id of ['reload-pending', 'reload-self']) {
    const network = networkFor(report, id);
    assert.ok(network, `${id} must report a network result`);
    assert.equal(
      network.status,
      'pass',
      `${id}: a request aborted by navigation must not stay pending: ${network.message}`,
    );
    assert.equal(network.evidence.counts.pending, 0);
    assert.ok(
      network.evidence.counts.cancelled >= 1,
      `${id}: the aborted request must be reported as cancelled, got ${JSON.stringify(network.evidence.counts)}`,
    );
    assert.equal(
      network.evidence.cancelled[0].reason,
      'navigation',
      `${id}: the cancellation reason must name navigation, got ${JSON.stringify(network.evidence.cancelled)}`,
    );
  }

  // The page after the aborted one still ran: cancellation did not poison the run.
  const clean = networkFor(report, 'after-reload');
  assert.equal(clean.status, 'pass');
  assert.equal(clean.evidence.counts.cancelled, 0, 'another page must not inherit a cancellation');
});

test('F-02: navigating to another page cancels the old request without contaminating the next page', async () => {
  const config = await writeConfig('f02-navigate', {
    pages: [scenarioPage('navigate-away', 'case=navigate'), cleanPage('after-navigation')],
    network: { observationWindowMs: 400, pendingTimeoutMs: 3000 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the navigation run');
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();
  const network = networkFor(report, 'navigate-away');
  assert.equal(network.status, 'pass', network.message);
  assert.equal(network.evidence.counts.cancelled, 1);
  assert.equal(network.evidence.cancelled[0].reason, 'navigation');

  const clean = networkFor(report, 'after-navigation');
  assert.equal(clean.status, 'pass');
  assert.equal(clean.evidence.counts.cancelled, 0);
});

// ---------------------------------------------------------------------------
// F-03 — the observation window
// ---------------------------------------------------------------------------

test('F-03: delayed failures at 0-1000 ms inside the window are all detected', async () => {
  const delays = [0, 60, 100, 149, 149, 150, 150, 200, 300, 500, 1000];
  const ids = delays.map((delay, index) => ({
    id: `delayed-${delay}-${index}`,
    delay,
  }));

  const config = await writeConfig('f03-delays', {
    pages: ids.map(({ id, delay }) => scenarioPage(id, `case=delayed&failAt=${delay}`)),
    network: { observationWindowMs: 1500, pendingTimeoutMs: 1500 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the delayed-failure run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();
  for (const { id, delay } of ids) {
    const network = networkFor(report, id);
    assert.ok(network, `${id} must report a network result`);
    assert.equal(
      network.status,
      'fail',
      `a 404 dispatched ${delay} ms after the interaction must not become a pass: ${network.message}`,
    );
    assert.deepEqual(detailsFor(network), ['HTTP 404'], `${id} evidence`);
    assert.equal(network.evidence.counts.pending, 0, `${id} should not be inconclusive`);
  }
});

test('F-03: a request just inside the window boundary is observed, repeatedly', async () => {
  const config = await writeConfig('f03-boundary', {
    pages: [
      scenarioPage('boundary-a', 'case=delayed&failAt=400'),
      scenarioPage('boundary-b', 'case=delayed&failAt=400'),
      scenarioPage('boundary-c', 'case=delayed&failAt=400'),
      scenarioPage('boundary-success', 'case=delayedSuccess&failAt=400'),
    ],
    network: { observationWindowMs: 500, pendingTimeoutMs: 1500 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the boundary run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();
  for (const id of ['boundary-a', 'boundary-b', 'boundary-c']) {
    const network = networkFor(report, id);
    assert.equal(network.status, 'fail', `${id} was missed: ${network.message}`);
    assert.deepEqual(detailsFor(network), ['HTTP 404']);
  }

  const success = networkFor(report, 'boundary-success');
  assert.equal(success.status, 'pass', success.message);
  assert.equal(success.evidence.counts.failed, 0);
});

test('F-03: a request started after the window is disclosed as out of scope, not counted', async () => {
  const config = await writeConfig('f03-outside', {
    pages: [scenarioPage('outside-window', 'case=outside')],
    network: { observationWindowMs: 200, pendingTimeoutMs: 3000 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the out-of-scope run');
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}`);

  const network = networkFor(await latestReport(), 'outside-window');
  assert.equal(network.status, 'pass', network.message);
  assert.ok(
    network.evidence.counts.outsideObservationWindow >= 1,
    `the late request must be disclosed as out of scope: ${JSON.stringify(network.evidence.counts)}`,
  );
  assert.equal(network.evidence.counts.failed, 0);
  assert.match(network.message, /observation window/i);
  assert.match(network.message, /outside the observation scope|not evaluated/i);
  assert.ok(
    network.evidence.observation.scope.includes('outside the observation scope'),
    'the report must state the scope limit in the evidence',
  );
});

test('F-03: invalid observation-window and timeout values are configuration errors', async () => {
  const cases = [
    { name: 'window-negative', network: { observationWindowMs: -1 }, pattern: /checks\.network\.observationWindowMs/ },
    { name: 'window-too-large', network: { observationWindowMs: 10_001 }, pattern: /checks\.network\.observationWindowMs/ },
    { name: 'timeout-too-large', network: { pendingTimeoutMs: 30_001 }, pattern: /checks\.network\.pendingTimeoutMs/ },
    { name: 'ignore-not-strings', network: { ignore: [''] }, pattern: /checks\.network\.ignore/ },
  ];

  for (const entry of cases) {
    const file = await writeConfig(entry.name, {
      pages: [{ id: 'placeholder', path: '/index.html' }],
      network: entry.network,
    });
    const result = await runCli(file);
    assertBounded(result, `the ${entry.name} run`);
    assert.equal(result.status, 2, `${entry.name} must exit 2, got ${result.status}\n${result.stderr}`);
    assert.match(result.stderr, entry.pattern, `${entry.name} message: ${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// F-04 — ignored requests, including pending ones
// ---------------------------------------------------------------------------

test('F-04: an ignored never-resolving request does not force an inconclusive result', async () => {
  // The pending timeout is deliberately much longer than the observation window:
  // if an ignored request still kept the settling operation alive, the run would
  // report having waited for it. `waitedMs` is the measurable difference.
  const config = await writeConfig('f04-ignored-pending', {
    pages: [scenarioPage('ignored-pending', 'case=ignoredPending')],
    network: { ignore: ['ignore-me=1'], observationWindowMs: 200, pendingTimeoutMs: 1500 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the ignored-pending run');
  assert.equal(result.status, 0, `an ignored connection must not exit 3: ${result.stdout}`);

  const network = networkFor(await latestReport(), 'ignored-pending');
  assert.equal(network.status, 'pass', network.message);
  assert.equal(network.evidence.counts.pending, 0, 'the ignored request must not be pending in scope');
  assert.equal(network.evidence.counts.ignored.pending, 1, JSON.stringify(network.evidence.counts));
  assert.ok(
    network.evidence.observation.waitedMs < 1000,
    `an ignored request must not be waited for: the observation took ${network.evidence.observation.waitedMs} ms ` +
      `(window 200 ms, pending timeout 1500 ms)`,
  );
});

test('F-04: an ignored pending request does not hide a 404 on the same page', async () => {
  const config = await writeConfig('f04-alongside', {
    pages: [scenarioPage('ignored-plus-404', 'case=pendingAndMissing'), cleanPage('same-run-clean')],
    network: { ignore: ['ignore-me=1'], observationWindowMs: 200, pendingTimeoutMs: 400 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the ignored-plus-404 run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();
  const network = networkFor(report, 'ignored-plus-404');
  assert.equal(network.status, 'fail', network.message);
  assert.deepEqual(detailsFor(network), ['HTTP 404']);
  assert.equal(network.evidence.counts.ignored.pending, 1);

  const clean = networkFor(report, 'same-run-clean');
  assert.equal(clean.status, 'pass', `the clean page was contaminated: ${JSON.stringify(clean.evidence)}`);
});

test('F-04: a non-ignored persistent connection still times out as inconclusive', async () => {
  const config = await writeConfig('f04-pending', {
    pages: [scenarioPage('non-ignored-pending', 'case=pending')],
    network: { observationWindowMs: 200, pendingTimeoutMs: 300 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the pending run');
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}\n${result.stdout}`);

  const network = networkFor(await latestReport(), 'non-ignored-pending');
  assert.equal(network.status, 'inconclusive');
  assert.equal(network.evidence.counts.pending, 1, JSON.stringify(network.evidence.counts));
  assert.match(network.message, /had not received a response/i);
  assert.match(network.message, /never counted as a success/i);
  assert.ok(network.remediation, 'the inconclusive result must explain how to handle it');
});

// ---------------------------------------------------------------------------
// Lifecycle edge cases
// ---------------------------------------------------------------------------

test('multiple simultaneous requests are each reported once', async () => {
  const config = await writeConfig('multi', {
    pages: [scenarioPage('multi-request', 'case=multi')],
    network: { observationWindowMs: 400, pendingTimeoutMs: 1000 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the multi-request run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const network = networkFor(await latestReport(), 'multi-request');
  assert.equal(network.status, 'fail');
  assert.equal(network.evidence.count, 2, JSON.stringify(network.evidence.items));
  assert.equal(network.evidence.items.length, 2);
  assert.deepEqual(detailsFor(network).sort(), ['HTTP 404', 'HTTP 500']);
  assert.equal(network.evidence.counts.pending, 0);
});

test('duplicate requests and duplicate events produce one finding and one report entry', async () => {
  const config = await writeConfig('duplicate', {
    pages: [scenarioPage('duplicate-failure', 'case=duplicate')],
    network: { observationWindowMs: 300, pendingTimeoutMs: 800 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the duplicate run');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);

  const report = await latestReport();
  const networkResults = report.results.filter(
    (entry) => entry.pageId === 'duplicate-failure' && entry.check === 'network',
  );
  assert.equal(networkResults.length, 1, 'the network check must be reported exactly once');

  const network = networkResults[0];
  assert.equal(network.status, 'fail');
  assert.equal(network.evidence.count, network.evidence.items.length);
  assert.equal(network.evidence.count, 1, JSON.stringify(network.evidence.items));
});

test('an interaction failure still resolves the network and cleans up', async () => {
  const config = await writeConfig('interaction-failure', {
    pages: [
      {
        ...scenarioPage('failing-interaction', 'case=pending'),
        interactions: [
          {
            name: 'click a control that does not exist',
            steps: [{ click: '[data-action="go"]' }, { click: '[data-action="not-there"]' }],
          },
        ],
      },
    ],
    network: { observationWindowMs: 200, pendingTimeoutMs: 300 },
  });

  const result = await runCli(config);
  assertBounded(result, 'the interaction failure run');
  assert.equal(result.status, 1, `a failed interaction fails the run\n${result.stdout}`);

  const report = await latestReport();
  const interactions = report.results.find(
    (entry) => entry.pageId === 'failing-interaction' && entry.check === 'interactions',
  );
  assert.equal(interactions.status, 'fail');
  assert.equal(report.results.filter((entry) => entry.check === 'network').length, 1);
  assert.equal(report.summary.total, 10, 'every reserved result slot must be filled');
  assert.ok(
    report.results.every((entry) => entry !== null && typeof entry.status === 'string'),
    'no result may be left as a null placeholder',
  );
});
