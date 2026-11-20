import path from 'node:path';
import { launchBrowser } from './browser.js';
import { EnvironmentError } from './errors.js';
import { baselineFileFor, readManifest } from './baseline.js';
import {
  NETWORK_OBSERVATION_DEFAULT_MS,
  NETWORK_PENDING_DEFAULT_MS,
  resolvePageUrl,
} from './config.js';
import { ensureDir, relativePosix } from './fs-utils.js';
import { displayPath } from './invocation.js';
import { startStaticServer } from './server.js';
import { SEVERITY, STATUS, statusFor } from './severity.js';

import * as consoleCheck from './checks/console.js';
import * as networkCheck from './checks/network.js';
import * as overflowCheck from './checks/overflow.js';
import * as a11yNamesCheck from './checks/a11y-names.js';
import * as labelsCheck from './checks/labels.js';
import * as contrastCheck from './checks/contrast.js';
import * as linksCheck from './checks/links.js';
import * as elementsCheck from './checks/elements.js';
import * as visualCheck from './checks/visual.js';
import * as interactionsCheck from './checks/interactions.js';

/**
 * Execution order matters:
 *  - observational checks run against the page as loaded,
 *  - the screenshot is captured before interactions so it reflects the initial view,
 *  - interactions run last because they mutate state.
 */
const CHECKS = [
  consoleCheck,
  networkCheck,
  overflowCheck,
  a11yNamesCheck,
  labelsCheck,
  contrastCheck,
  linksCheck,
  elementsCheck,
  visualCheck,
  interactionsCheck,
];

/**
 * Console and network are pure functions over the collectors, so they are
 * evaluated *after* interactions run while still occupying their original
 * position in the report. Interactions can raise exceptions and fail requests;
 * evaluating these checks at load time would silently drop those findings.
 * Every other check reads the DOM and must therefore run before interactions
 * mutate it.
 */
const DEFERRED_CHECKS = new Set(['console', 'network']);

/**
 * How often the observation window re-reads the pending set.
 *
 * The window itself is timed from configured values
 * (`checks.network.observationWindowMs` + `checks.network.pendingTimeoutMs`),
 * never from how busy the page happens to be, so the cost of a run stays
 * predictable and a page that keeps a request open cannot extend it.
 */
const NETWORK_POLL_MS = 25;

/** Chromium reports a request aborted by navigation as this error text. */
const ABORTED = 'net::ERR_ABORTED';

/** CSS that removes motion so a screenshot only depends on layout and colour. */
const FREEZE_MOTION_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
html { scroll-behavior: auto !important; }
`;

/**
 * Run every configured check for every page at every viewport.
 *
 * @param {object} options
 * @param {string} options.root absolute project root
 * @param {object} options.config merged config
 * @param {object[]} options.pages pages to verify
 * @param {object[]} options.viewports viewports to verify
 * @param {string} options.runId
 * @param {string} options.reportsRoot absolute reports directory
 * @param {(event: object) => void} [options.onProgress]
 * @returns {Promise<{results: object[], environment: object, browserInfo: object}>}
 */
export async function runVerification({
  root,
  config,
  configPath = null,
  pages,
  viewports,
  runId,
  reportsRoot,
  onProgress = () => {},
}) {
  const needsServer = pages.some((page) => !page.url);
  const baselinesRoot = path.join(root, config.baselinesDir);
  const manifest = await readManifest(baselinesRoot);
  const results = [];

  let server = null;
  let browser = null;
  let browserInfo = null;
  let failure = null;

  try {
    // Both resources are acquired inside the guarded region. Starting the
    // server before the browser is only safe because it is released on every
    // exit path: an open listener keeps Node alive, so a failed launch would
    // otherwise print the error, set exitCode 3, and then hang forever.
    if (needsServer) server = await startStaticServer({ root });

    const launched = await launchBrowser(config.browser ?? {});
    browser = launched.browser;
    browserInfo = launched.info;
    onProgress({ type: 'browser', browserInfo });

    for (const pageDef of pages) {
      const pageUrl = resolvePageUrl(pageDef, server?.origin ?? null);

      for (const viewport of viewports) {
        onProgress({ type: 'page-start', pageId: pageDef.id, viewport: viewport.name });

        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          locale: 'en-US',
          timezoneId: 'UTC',
          colorScheme: config.browser?.colorScheme ?? 'light',
          reducedMotion: 'reduce',
          hasTouch: false,
        });

        const pageResults = await runOnePageViewport({
          context,
          pageDef,
          pageUrl,
          viewport,
          config,
          configPath,
          root,
          runId,
          reportsRoot,
          manifest,
          baselinesRoot,
          browserVersion: browserInfo.version,
        });

        results.push(...pageResults);
        await context.close();

        onProgress({
          type: 'page-done',
          pageId: pageDef.id,
          viewport: viewport.name,
          results: pageResults,
        });
      }
    }
  } catch (error) {
    failure = error;
  }

  const cleanupFailures = await releaseResources({ browser, server });

  if (failure) {
    // The original failure stays primary. A cleanup problem must never replace
    // the reason verification actually stopped (for example a launch error).
    if (cleanupFailures.length > 0 && failure instanceof Error) {
      failure.cleanupFailures = cleanupFailures;
    }
    throw failure;
  }

  if (cleanupFailures.length > 0) {
    throw new EnvironmentError('Verification finished but resources were not released.', cleanupFailures);
  }

  return { results, browserInfo };
}

/**
 * Close every resource that was actually created.
 *
 * Each close is isolated: a browser that refuses to close must not leave the
 * static server listening (which would hang the process), and a cleanup error
 * must not mask the original failure.
 *
 * @returns {Promise<string[]>} human-readable cleanup problems, if any
 */
async function releaseResources({ browser, server }) {
  const failures = [];
  for (const [label, close] of [
    ['browser', () => browser?.close()],
    ['static server', () => server?.close()],
  ]) {
    try {
      const result = close();
      if (result && typeof result.then === 'function') await result;
    } catch (error) {
      failures.push(`${label}: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  return failures;
}

async function runOnePageViewport({
  context,
  pageDef,
  pageUrl,
  viewport,
  config,
  configPath,
  root,
  runId,
  reportsRoot,
  manifest,
  baselinesRoot,
  browserVersion,
}) {
  const page = await context.newPage();
  const collectors = {
    consoleErrors: [],
    pageErrors: [],
    /** Transport failures, in the order they were observed. */
    failedRequests: [],
    /** Responses with status >= 400, in the order they were observed. */
    badResponses: [],
    /** Requests invalidated before any response arrived (navigation, abort). */
    cancelledRequests: [],
    /**
     * Every request seen on the page, keyed by Playwright's Request object.
     * A record is the single source of truth for that request's lifecycle, so
     * duplicate or out-of-order browser events cannot double-count anything.
     */
    requests: new Map(),
    /** Requests that started after the observation window closed. */
    outsideObservation: [],
    /** Requests started so far, reported as context in the evidence. */
    requestCount: 0,
    /** Filled in by {@link observeNetwork}; null when no observation was needed. */
    observation: null,
  };

  /**
   * Which document each frame is currently showing.
   *
   * A request belongs to the document that issued it. When a frame swaps
   * documents, the previous document's unanswered requests are resolved as
   * cancelled instead of waiting forever — Chromium emits neither
   * `requestfinished` nor `requestfailed` for them.
   */
  const frameDocuments = new Map();
  let nextDocumentId = 1;

  /**
   * Document state for a frame, created on first use.
   *
   * `navigating` distinguishes a real document swap from a same-document
   * navigation (`history.pushState`, a `#hash` change): Playwright emits
   * `framenavigated` for both, but only a document request means the previous
   * document's requests were invalidated.
   */
  const documentStateFor = (frame) => {
    if (!frame) return { docId: 0, committed: true, navigating: false };
    let state = frameDocuments.get(frame);
    if (!state) {
      state = { docId: nextDocumentId, committed: false, navigating: false };
      nextDocumentId += 1;
      frameDocuments.set(frame, state);
    }
    return state;
  };

  const frameOf = (request) => {
    try {
      return request.frame();
    } catch {
      // Service-worker and browser-initiated requests have no frame.
      return null;
    }
  };

  /**
   * Resolve every request still awaiting a response from a document that is no
   * longer displayed.
   *
   * The cancellation is explicit and carries a reason: the request is reported
   * as "cancelled before a response", never as a success and never as a
   * failure it did not prove.
   */
  const invalidateDocument = (documentId, nextId) => {
    for (const record of collectors.requests.values()) {
      if (record.documentId !== documentId) continue;
      if (record.isNavigation) {
        // The document request itself belongs to the *incoming* document.
        record.documentId = nextId;
        continue;
      }
      if (record.state === 'cancelled') {
        // Chromium may report the abort before the frame commits; the reason is
        // upgraded so the report names navigation rather than a bare abort.
        record.reason = 'navigation';
        if (record.cancellation) record.cancellation.reason = 'navigation';
        continue;
      }
      if (record.state !== 'awaiting') continue;
      record.state = 'cancelled';
      record.reason = 'navigation';
      record.cancellation = {
        url: record.url,
        reason: 'navigation',
        detail: 'the document navigated away before a response arrived',
      };
      collectors.cancelledRequests.push(record.cancellation);
    }
  };

  // These listeners stay attached for the whole life of the page, not just the
  // load: the console and network checks are evaluated after interactions run,
  // so an exception or a failed request raised by a scripted flow is reported.
  const handlers = {
    console: (message) => {
      if (message.type() === 'error') {
        collectors.consoleErrors.push({
          type: message.type(),
          text: message.text(),
          location: message.location(),
        });
      }
    },
    pageerror: (error) => {
      collectors.pageErrors.push({ message: error.message, stack: error.stack ?? null });
    },
    request: (request) => {
      collectors.requestCount += 1;
      const frame = frameOf(request);
      const documentState = documentStateFor(frame);
      const record = {
        url: request.url(),
        frame,
        documentId: documentState.docId,
        isNavigation: request.isNavigationRequest(),
        state: 'awaiting',
        status: null,
        failure: null,
        reason: null,
        cancellation: null,
        startedAt: Date.now(),
        afterObservationWindow: collectors.observation?.closed === true,
      };
      collectors.requests.set(request, record);
      if (record.isNavigation) documentState.navigating = true;

      if (record.afterObservationWindow && !record.isNavigation) {
        collectors.outsideObservation.push({ url: record.url });
      }
    },
    requestfinished: (request) => {
      const record = collectors.requests.get(request);
      if (!record) return;
      // Idempotent: a finish after a failure/cancellation changes nothing, and a
      // second finish for the same request is ignored.
      if (record.state === 'awaiting' || record.state === 'responded') record.state = 'finished';
    },
    requestfailed: (request) => {
      const failure = request.failure()?.errorText ?? 'unknown';
      let record = collectors.requests.get(request);
      if (!record) {
        // A failure for a request whose start we never saw is still a finding.
        record = {
          url: request.url(),
          frame: frameOf(request),
          documentId: 0,
          isNavigation: request.isNavigationRequest(),
          state: 'awaiting',
          status: null,
          failure: null,
          reason: null,
          cancellation: null,
          startedAt: Date.now(),
          afterObservationWindow: false,
        };
        collectors.requests.set(request, record);
      }

      if (record.state === 'failed') return;

      if (failure === ABORTED) {
        if (record.state === 'cancelled') return;
        // A cancellation proves nothing about the URL: it never produced a
        // response. It is kept apart from failures so the check can say
        // "not evaluated" rather than pass or fail on no evidence.
        record.state = 'cancelled';
        record.failure = failure;
        record.reason = 'aborted';
        record.cancellation = { url: record.url, reason: 'aborted', detail: failure };
        collectors.cancelledRequests.push(record.cancellation);
        return;
      }

      // A real transport failure is evidence, even when a navigation already
      // resolved the same request speculatively: the observation wins.
      if (record.state === 'cancelled') {
        const index = collectors.cancelledRequests.indexOf(record.cancellation);
        if (index >= 0) collectors.cancelledRequests.splice(index, 1);
        record.cancellation = null;
        record.reason = null;
      }
      record.state = 'failed';
      record.failure = failure;
      collectors.failedRequests.push({ url: record.url, failure });
    },
    response: (response) => {
      const request = response.request();
      const record = collectors.requests.get(request) ?? null;
      const status = response.status();
      const firstReport = record ? record.status !== status : true;

      if (status >= 400 && firstReport) {
        collectors.badResponses.push({ url: response.url(), status });
      }
      if (!record) return;

      // Receiving a response ends the wait for one, including a redirect hop's
      // 3xx. The body may never be consumed — and Chromium then never emits
      // `requestfinished` — so requiring that event would leave a healthy
      // request pending until the hard timeout.
      if (record.state === 'awaiting') record.state = 'responded';
      record.status = status;
    },
    framenavigated: (frame) => {
      const state = documentStateFor(frame);
      if (!state.committed) {
        // The first commit for a frame is the document the harness loaded on
        // purpose: nothing from an earlier document can still be pending.
        state.committed = true;
        state.navigating = false;
        return;
      }
      if (!state.navigating) return; // same-document navigation: no new document

      const previous = state.docId;
      state.docId = nextDocumentId;
      nextDocumentId += 1;
      state.navigating = false;
      invalidateDocument(previous, state.docId);
    },
    framedetached: (frame) => {
      const state = frameDocuments.get(frame);
      if (!state) return;
      // The frame and its document are gone: whatever it was still waiting for
      // will never produce an event.
      frameDocuments.delete(frame);
      invalidateDocument(state.docId, null);
    },
  };

  page.on('console', handlers.console);
  page.on('pageerror', handlers.pageerror);
  page.on('request', handlers.request);
  page.on('requestfinished', handlers.requestfinished);
  page.on('requestfailed', handlers.requestfailed);
  page.on('response', handlers.response);
  page.on('framenavigated', handlers.framenavigated);
  page.on('framedetached', handlers.framedetached);

  const detachCollectors = () => {
    page.off('console', handlers.console);
    page.off('pageerror', handlers.pageerror);
    page.off('request', handlers.request);
    page.off('requestfinished', handlers.requestfinished);
    page.off('requestfailed', handlers.requestfailed);
    page.off('response', handlers.response);
    page.off('framenavigated', handlers.framenavigated);
    page.off('framedetached', handlers.framedetached);
  };

  // The page and its listeners are released on every exit path, including the
  // navigation-error early return inside observePage, so a page-level failure
  // cannot leave a live page or attached collectors behind.
  try {
    return await observePage({
      page,
      collectors,
      pageDef,
      pageUrl,
      viewport,
      config,
      configPath,
      root,
      runId,
      reportsRoot,
      manifest,
      baselinesRoot,
      browserVersion,
    });
  } finally {
    detachCollectors();
    await page.close().catch(() => {});
  }
}

/**
 * Measure one page at one viewport.
 *
 * Called inside `runOnePageViewport`'s cleanup guard, so every return path —
 * including the navigation-error one — releases the page and the collectors.
 */
async function observePage({
  page,
  collectors,
  pageDef,
  pageUrl,
  viewport,
  config,
  configPath,
  root,
  runId,
  reportsRoot,
  manifest,
  baselinesRoot,
  browserVersion,
}) {
  const navigationError = await loadPage(page, pageUrl);

  if (navigationError) {
    // A page that never loaded cannot produce any trustworthy result. This is
    // `inconclusive` (exit 3), never a pass.
    return [
      baseResult({
        pageDef,
        viewport,
        pageUrl,
        check: 'navigation',
        title: 'Page navigation',
        severity: SEVERITY.ERROR,
        status: STATUS.INCONCLUSIVE,
        message: navigationError,
        remediation: 'Confirm the page URL is correct and the application starts without error.',
      }),
    ];
  }

  await page.addStyleTag({ content: FREEZE_MOTION_CSS }).catch(() => {});

  const artifacts = {
    screenshot: relativePosix(root, screenshotPath(reportsRoot, runId, pageDef.id, viewport.name)),
    screenshotPath: screenshotPath(reportsRoot, runId, pageDef.id, viewport.name),
    diff: relativePosix(root, diffPath(reportsRoot, runId, pageDef.id, viewport.name)),
    diffPath: diffPath(reportsRoot, runId, pageDef.id, viewport.name),
  };

  let captured = false;
  const capture = async () => {
    if (captured) return;
    await ensureDir(path.dirname(artifacts.screenshotPath));
    await page.screenshot({
      path: artifacts.screenshotPath,
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
    });
    captured = true;
  };

  // Capture once, immediately after the page is ready and before any check or
  // interaction can focus, click, or otherwise mutate it. This must not depend
  // on the visual check being enabled: a disabled visual comparison still
  // produces a reviewable initial screenshot.
  await capture().catch(() => {});

  // The observation policy is configured per check, and the runner needs the
  // same values as the check itself: one bounds what is observed, the other how
  // long a request known to be in scope may take.
  const networkConfig = config.checks?.network ?? {};

  const results = [];
  const deferred = [];
  const checkContext = {
    page,
    pageDef,
    pageId: pageDef.id,
    viewport,
    pageUrl,
    collectors,
    config,
    configPath,
    root,
    artifacts,
    baselinePath: baselineFileFor(baselinesRoot, pageDef.id, viewport.name),
    manifest,
    baselinesRoot,
    browserVersion,
  };

  for (const check of CHECKS) {
    const checkConfig = config.checks?.[check.id] ?? {};
    const severity = checkConfig.severity ?? SEVERITY.ERROR;
    // Reserve the slot up front so the report order always follows CHECKS,
    // even though two checks are evaluated later.
    const position = results.length;
    results.push(null);

    if (checkConfig.enabled === false) {
      const configLabel = configPath
        ? displayPath(configPath)
        : 'the active configuration file';
      const disabled = baseResult({
        pageDef,
        viewport,
        pageUrl,
        check: check.id,
        title: check.title,
        severity,
        status: STATUS.SKIPPED,
        message:
          check.id === visualCheck.id
            ? `Disabled in ${configLabel}. Visual comparison is off; the initial screenshot is still captured at ${artifacts.screenshot}.`
            : `Disabled in ${configLabel}.`,
        durationMs: 0,
      });
      if (check.id === visualCheck.id) {
        disabled.artifacts = { screenshot: artifacts.screenshot };
      }
      results[position] = disabled;
      continue;
    }

    if (DEFERRED_CHECKS.has(check.id)) {
      deferred.push({ check, severity, checkConfig, position });
      continue;
    }

    results[position] = await evaluateCheck({
      check,
      severity,
      checkConfig,
      checkContext,
    });
  }

  // Interactions have now run, but a request they started may still be in
  // flight: its response event arrives a tick later, and a reload between flows
  // delivers the response for the *previous* document even later. Evaluating
  // now would report a false pass for a request that is about to 404.
  if ((pageDef.interactions ?? []).length > 0) {
    await observeNetwork(page, collectors, networkConfig);
  }

  // Interactions have now run, so the collectors hold the complete observation
  // window. Each deferred check is evaluated exactly once against that window.
  for (const { check, severity, checkConfig, position } of deferred) {
    results[position] = await evaluateCheck({ check, severity, checkConfig, checkContext });
  }

  return results;
}

/**
 * Observe the network after the last interaction step, under an explicit policy.
 *
 * Two distinct budgets are applied in order:
 *
 *  1. The **observation window** (`observationWindowMs`) is a fixed wait during
 *     which newly initiated requests count as in scope. It is never extended
 *     because requests keep arriving: a run's cost must stay predictable.
 *  2. The **pending-request timeout** (`pendingTimeoutMs`) is a second budget
 *     for requests that started inside the window to receive a response.
 *
 * Requests that start after the window has closed are recorded as outside the
 * observation scope. They are neither waited for nor counted, and they are
 * disclosed in the report — bounded observation is not complete monitoring.
 *
 * Requests that are still awaiting a response when both budgets are spent are
 * left pending; the check reports that as `inconclusive`, never as a pass.
 * Ignored URLs are excluded from the wait entirely, so a by-design long-lived
 * connection cannot force exit code 3.
 *
 * @param {import('playwright').Page} page
 * @param {object} collectors
 * @param {{observationWindowMs?: number, pendingTimeoutMs?: number, ignore?: string[]}} networkConfig
 */
async function observeNetwork(page, collectors, networkConfig = {}) {
  const windowMs = networkConfig.observationWindowMs ?? NETWORK_OBSERVATION_DEFAULT_MS;
  const pendingTimeoutMs = networkConfig.pendingTimeoutMs ?? NETWORK_PENDING_DEFAULT_MS;
  const ignore = Array.isArray(networkConfig.ignore) ? networkConfig.ignore : [];
  const ignored = (url) => networkCheck.matchesIgnore(url, ignore);

  const inScopePending = () => {
    let count = 0;
    for (const record of collectors.requests.values()) {
      if (record.state !== 'awaiting') continue;
      if (record.afterObservationWindow) continue;
      if (ignored(record.url)) continue;
      count += 1;
    }
    return count;
  };

  const started = Date.now();
  const windowEndsAt = started + windowMs;
  const hardDeadline = windowEndsAt + pendingTimeoutMs;
  const observation = {
    windowMs,
    pendingTimeoutMs,
    /** Set once the window has closed; requests seen afterwards are out of scope. */
    closed: false,
    waitedMs: 0,
    aborted: null,
    pending: [],
    respondedWithoutFinish: 0,
  };
  collectors.observation = observation;

  // Phase 1 — the observation window itself. Fixed length on purpose.
  while (Date.now() < windowEndsAt) {
    const failure = await sleepOnPage(page, windowEndsAt - Date.now(), NETWORK_POLL_MS);
    if (failure) {
      observation.aborted = failure;
      break;
    }
  }
  observation.closed = true;

  // Phase 2 — let requests that started inside the window reach a verdict,
  // within their own budget. Requests that start now are out of scope and are
  // never awaited, which is what keeps a repeat-polling page bounded.
  while (!observation.aborted && Date.now() < hardDeadline) {
    if (inScopePending() === 0) break;
    const failure = await sleepOnPage(page, hardDeadline - Date.now(), NETWORK_POLL_MS);
    if (failure) {
      observation.aborted = failure;
      break;
    }
  }

  // Snapshot the final state. A record still awaiting a response is reported as
  // pending, never as a success; the check decides what that means.
  const pending = [];
  let respondedWithoutFinish = 0;
  for (const record of collectors.requests.values()) {
    if (record.state === 'awaiting' && !record.afterObservationWindow) {
      pending.push({ url: record.url });
    }
    if (record.state === 'responded') respondedWithoutFinish += 1;
  }

  observation.waitedMs = Date.now() - started;
  observation.pending = pending;
  observation.respondedWithoutFinish = respondedWithoutFinish;
}

/**
 * Sleep for at most `remaining` ms while polling at `step`, and report a page
 * failure (a crash, a closed page) instead of throwing out of the observation.
 *
 * @returns {Promise<string|null>} a short reason, or null when the sleep ended
 */
async function sleepOnPage(page, remaining, step) {
  const ms = Math.min(step, remaining);
  if (!(ms > 0)) return null;
  try {
    await page.waitForTimeout(ms);
    return null;
  } catch (error) {
    return String(error?.message ?? error).split('\n')[0];
  }
}

/**
 * Run one check and translate its verdict, converting a throwing check into an
 * `inconclusive` result (a defect in the check is never a pass and never a
 * failure of the page).
 */
async function evaluateCheck({ check, severity, checkConfig, checkContext }) {
  const { pageDef, viewport, pageUrl, artifacts } = checkContext;
  const started = Date.now();

  try {
    const outcome = await check.run({ ...checkContext, checkConfig, server: null });
    return translateOutcome({
      outcome,
      check,
      severity,
      pageDef,
      viewport,
      pageUrl,
      artifacts,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    return baseResult({
      pageDef,
      viewport,
      pageUrl,
      check: check.id,
      title: check.title,
      severity,
      status: STATUS.INCONCLUSIVE,
      message: `Check threw: ${String(error.message).split('\n')[0]}`,
      remediation: 'This is a defect in the check itself, not necessarily in the page.',
      durationMs: Date.now() - started,
    });
  }
}

async function loadPage(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    // Waiting for fonts to settle keeps text screenshots stable.
    await page.evaluate(() => (document.fonts?.ready ?? Promise.resolve())).catch(() => {});
    if (!response) return 'Navigation returned no response.';
    if (response.status() >= 400) {
      return `Page responded with HTTP ${response.status()} at ${url}`;
    }
    return null;
  } catch (error) {
    return `Navigation failed: ${String(error.message).split('\n')[0]}`;
  }
}

function translateOutcome({ outcome, check, severity, pageDef, viewport, pageUrl, artifacts, durationMs }) {
  if (outcome?.skip) {
    return baseResult({
      pageDef,
      viewport,
      pageUrl,
      check: check.id,
      title: check.title,
      severity,
      status: STATUS.SKIPPED,
      message: outcome.skip,
      durationMs,
    });
  }

  if (outcome?.inconclusive) {
    // An inconclusive result is not a verdict about the page, so the evidence
    // that explains what could not be measured travels with it.
    return baseResult({
      pageDef,
      viewport,
      pageUrl,
      check: check.id,
      title: check.title,
      severity,
      status: STATUS.INCONCLUSIVE,
      message: outcome.inconclusive,
      evidence: outcome?.evidence ?? null,
      remediation: outcome?.remediation ?? null,
      durationMs,
    });
  }

  const status = statusFor(Boolean(outcome?.ok), severity);
  const result = baseResult({
    pageDef,
    viewport,
    pageUrl,
    check: check.id,
    title: check.title,
    severity,
    status,
    message: outcome?.message ?? '',
    evidence: outcome?.evidence ?? null,
    remediation: outcome?.remediation ?? null,
    durationMs,
  });

  if (outcome?.artifacts) {
    result.artifacts = { ...outcome.artifacts };
  } else if (check.id === visualCheck.id) {
    result.artifacts = { screenshot: artifacts.screenshot };
  }
  return result;
}

function baseResult({
  pageDef,
  viewport,
  pageUrl,
  check,
  title,
  severity,
  status,
  message,
  evidence = null,
  remediation = null,
  durationMs = null,
}) {
  return {
    pageId: pageDef.id,
    pageUrl,
    viewport: viewport.name,
    viewportSize: { width: viewport.width, height: viewport.height },
    check,
    title,
    severity,
    status,
    message,
    evidence,
    remediation,
    artifacts: null,
    durationMs,
  };
}

function screenshotPath(reportsRoot, runId, pageId, viewportName) {
  return path.join(reportsRoot, runId, 'screenshots', pageId, `${viewportName}.png`);
}

function diffPath(reportsRoot, runId, pageId, viewportName) {
  return path.join(reportsRoot, runId, 'diffs', pageId, `${viewportName}.png`);
}
