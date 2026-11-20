export const id = 'network';
export const title = 'Failed network requests';

/** How many findings/URLs to inline before the evidence is truncated. */
const MAX_EVIDENCE_ITEMS = 10;

/**
 * Ignore matching for `checks.network.ignore`.
 *
 * The syntax is unchanged from earlier versions: a URL is ignored when it
 * contains one of the configured substrings. The same predicate is used for
 * failed, cancelled *and* pending requests, so a URL cannot be ignored in one
 * bucket and fatal in another.
 *
 * @param {string} url
 * @param {unknown} ignore
 * @returns {boolean}
 */
export function matchesIgnore(url, ignore) {
  if (!Array.isArray(ignore) || typeof url !== 'string') return false;
  return ignore.some((pattern) => typeof pattern === 'string' && pattern !== '' && url.includes(pattern));
}

/**
 * Judge the network observation window collected by the runner.
 *
 * The verdict model has to keep six states apart, because collapsing any of
 * them into "pass" or "fail" produces a false answer:
 *
 *  - an HTTP 4xx/5xx response or a transport failure  -> `fail`
 *  - a response received (status inspected)           -> success for that request
 *  - a request cancelled before any response          -> reported, not evaluated
 *  - an ignored request                               -> excluded, counted, disclosed
 *  - a request still pending at the hard timeout      -> `inconclusive` (exit 3)
 *  - a request that started after the window closed   -> outside the scope, disclosed
 *
 * A request counts as having completed once its response has been received, not
 * once its body has been consumed: Chromium never emits `requestfinished` for a
 * fetch whose body the page ignores, so requiring that event would turn a
 * healthy request into a permanent pending one.
 */
export function run({ collectors, checkConfig }) {
  const ignore = Array.isArray(checkConfig?.ignore) ? checkConfig.ignore : [];
  const observation = collectors.observation ?? null;

  const failures = dedupe([
    ...(collectors.failedRequests ?? []).map((request) => ({
      kind: 'request-failed',
      url: request.url,
      detail: request.failure,
    })),
    ...(collectors.badResponses ?? []).map((response) => ({
      kind: 'bad-status',
      url: response.url,
      detail: `HTTP ${response.status}`,
    })),
  ]);

  const reported = failures.filter((failure) => !matchesIgnore(failure.url, ignore));
  const ignoredFailures = failures.length - reported.length;

  const cancelledAll = collectors.cancelledRequests ?? [];
  const cancelled = cancelledAll.filter((request) => !matchesIgnore(request.url, ignore));
  const ignoredCancelled = cancelledAll.length - cancelled.length;

  const pendingAll = observation?.pending ?? [];
  const pending = pendingAll.filter((request) => !matchesIgnore(request.url, ignore));
  const ignoredPending = pendingAll.length - pending.length;

  const outsideWindow = (collectors.outsideObservation ?? []).map((request) => ({ url: request.url }));

  const evidence = {
    counts: {
      failed: reported.length,
      cancelled: cancelled.length,
      pending: pending.length,
      responsesWithoutFinishEvent: observation?.respondedWithoutFinish ?? 0,
      outsideObservationWindow: outsideWindow.length,
      ignored: {
        failed: ignoredFailures,
        cancelled: ignoredCancelled,
        pending: ignoredPending,
      },
    },
    observation: observation
      ? {
          windowMs: observation.windowMs,
          pendingTimeoutMs: observation.pendingTimeoutMs,
          waitedMs: observation.waitedMs,
          scope:
            `Requests initiated more than ${observation.windowMs} ms after the last interaction ` +
            'step are outside the observation scope: they are not waited for and are not counted ' +
            'as evidence that nothing happened.',
        }
      : null,
  };

  if (reported.length > 0) {
    evidence.count = reported.length;
    evidence.items = reported.slice(0, MAX_EVIDENCE_ITEMS);
    if (pending.length > 0) evidence.pending = pending.slice(0, MAX_EVIDENCE_ITEMS);
    return {
      ok: false,
      message: `${reported.length} failed network request(s).`,
      evidence,
      remediation:
        'Correct the URL, restore the missing asset, or handle the failing response in the application.',
    };
  }

  if (observation?.aborted) {
    return {
      inconclusive:
        `The page closed before the ${observation.windowMs} ms observation window finished ` +
        `(${observation.aborted}), so the network verdict is incomplete.`,
      evidence,
    };
  }

  if (pending.length > 0) {
    evidence.pending = pending.slice(0, MAX_EVIDENCE_ITEMS);
    return {
      inconclusive:
        `${pending.length} network request(s) had not received a response within the ` +
        `${observation.windowMs} ms observation window plus the ` +
        `${observation.pendingTimeoutMs} ms pending-request timeout, so their outcome is unknown. ` +
        'A request that is still pending is never counted as a success.',
      evidence,
      remediation:
        'Make the request complete before the interaction ends, raise checks.network.pendingTimeoutMs ' +
        'if it is legitimately slow, or list a by-design long-lived connection (an event stream, a ' +
        'long poll) in checks.network.ignore.',
    };
  }

  const windowNote = observation
    ? ` Observation window: ${observation.windowMs} ms after the last interaction step; ` +
      'requests initiated later are outside the observation scope.'
    : '';

  if (cancelled.length > 0) {
    evidence.cancelled = cancelled.slice(0, MAX_EVIDENCE_ITEMS);
    return {
      ok: true,
      message:
        `No completed request failed. ${cancelled.length} request(s) were cancelled before a ` +
        'response arrived (the document navigated away or the browser aborted them) and could not ' +
        `be evaluated.${windowNote}`,
      evidence,
    };
  }

  if (outsideWindow.length > 0) {
    evidence.outsideObservationWindow = outsideWindow.slice(0, MAX_EVIDENCE_ITEMS);
  }

  const ignoredTotal = ignoredFailures + ignoredCancelled + ignoredPending;
  const ignoredNote =
    ignoredTotal > 0
      ? ` ${ignoredTotal} request(s) matched checks.network.ignore and were excluded from this verdict.`
      : '';
  const outsideNote =
    outsideWindow.length > 0
      ? ` ${outsideWindow.length} request(s) started after the observation window and were not evaluated.`
      : '';

  return {
    ok: true,
    message: `All network requests that produced a verdict succeeded.${windowNote}${ignoredNote}${outsideNote}`,
    evidence,
  };
}

/** Drop exact duplicates: the same URL failing the same way is one finding. */
function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind}|${item.url}|${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
