/**
 * H-1 regression — a browser that will not launch must terminate the CLI with
 * exit 3.
 *
 * The original defect was a resource leak: the static server was started before
 * `launchBrowser()` and the launch happened outside the `try/finally` that closed
 * it, so the open listener kept Node alive forever. The error was printed and
 * `process.exitCode` was set, but the process never ended.
 *
 * This test therefore asserts the child *process* exits, not the message it
 * prints and not the value of an in-process property.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TMP = path.join(PROJECT, 'tests', '.tmp-test', 'launch-failure');
const CONFIG = path.join(TMP, 'config.json');
const REPORTS = 'tests/.tmp-test/launch-failure/reports';

/** Long enough that a slow machine is not mistaken for the old hang. */
const WATCHDOG_MS = 30_000;

/**
 * Run the real CLI and resolve only when the process exits.
 * If the watchdog fires first the child is killed and `timedOut` is reported,
 * so a regression fails the test instead of wedging the suite.
 */
function runCliWithWatchdog(args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['tools/visual-verify.js', ...args], {
      cwd: PROJECT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, WATCHDOG_MS);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, elapsedMs: Date.now() - started });
    });
  });
}

before(async () => {
  await mkdir(TMP, { recursive: true });
  // A page served by the local static server: the server must be created for the
  // defect to reproduce, because it is the leaked listener that keeps Node alive.
  await writeFile(
    CONFIG,
    `${JSON.stringify(
      {
        viewports: [{ name: 'desktop', width: 1440, height: 900 }],
        reportsDir: REPORTS,
        checks: { visual: { enabled: false } },
        pages: [
          {
            id: 'fixture-pass',
            path: '/tests/fixtures/pass/index.html',
            expect: { selectors: ['h1'] },
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test('a browser launch failure exits 3 and does not leave the process alive', async () => {
  const result = await runCliWithWatchdog(['--config', CONFIG, '--quiet'], {
    // The supported environment override used by `tools/lib/browser.js`.
    LUNIK_BROWSER_CHANNEL: 'definitely-not-a-browser',
  });

  assert.equal(
    result.timedOut,
    false,
    `the CLI did not terminate within ${WATCHDOG_MS} ms — an open resource is keeping ` +
      `the event loop alive (exit code was ${result.code}, signal ${result.signal})\n${result.stderr}`,
  );
  assert.equal(
    result.code,
    3,
    `expected exit code 3 for an environment failure, got ${result.code}\n${result.stderr}`,
  );
  assert.match(result.stderr, /Environment error: Could not launch a browser/);
  assert.ok(
    result.elapsedMs < WATCHDOG_MS,
    `the process must exit well before the watchdog, took ${result.elapsedMs} ms`,
  );
  // The run never reached a verdict, so no summary may claim otherwise.
  assert.equal(
    /passed ·/.test(result.stdout),
    false,
    `an aborted run must not print a check summary:\n${result.stdout}`,
  );
});
