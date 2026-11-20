/**
 * Sentinel sample dashboard.
 *
 * Every value here is invented sample data. This example performs no security
 * operations, contacts no services, and collects nothing — it exists so the
 * verifier has a dense, interactive, dark-theme page to audit.
 */

const ALERTS = [
  {
    id: 'ALT-2041',
    severity: 'critical',
    title: 'Credential stuffing burst blocked',
    detail: '412 failed sign-ins / 96 accounts',
    asset: 'edge-gateway-01',
    detected: '09:41',
    state: 'Investigating',
  },
  {
    id: 'ALT-2038',
    severity: 'high',
    title: 'Unusual outbound transfer volume',
    detail: '1.8 GB to unrecognised destination',
    asset: 'FS-014',
    detected: '09:12',
    state: 'Quarantined',
  },
  {
    id: 'ALT-2035',
    severity: 'medium',
    title: 'Antivirus definitions outdated',
    detail: '12 endpoints older than 48h',
    asset: 'fleet-wide',
    detected: '08:47',
    state: 'Open',
  },
  {
    id: 'ALT-2031',
    severity: 'low',
    title: 'Service account password rotation due',
    detail: '3 accounts reach rotation age in 5 days',
    asset: 'svc-batch-3',
    detected: '07:58',
    state: 'Open',
  },
  {
    id: 'ALT-2028',
    severity: 'high',
    title: 'Privilege escalation attempt blocked',
    detail: 'Token manipulation on domain controller',
    asset: 'DC-02',
    detected: '07:20',
    state: 'Open',
  },
  {
    id: 'ALT-2022',
    severity: 'critical',
    title: 'Malicious macro execution blocked',
    detail: 'Attachment quarantined before execution',
    asset: 'WS-118',
    detected: '06:44',
    state: 'Investigating',
  },
  {
    id: 'ALT-2019',
    severity: 'medium',
    title: 'Repeated MFA denials from single IP',
    detail: '34 denials in 11 minutes',
    asset: 'idp-tenant',
    detected: '06:12',
    state: 'Open',
  },
  {
    id: 'ALT-2014',
    severity: 'medium',
    title: 'Unpatched TLS configuration on web tier',
    detail: 'Weak cipher suite still enabled',
    asset: 'WEB-06',
    detected: '05:38',
    state: 'Open',
  },
];

const SEVERITY_LABELS = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const state = {
  severity: 'all',
  query: '',
  acknowledged: new Set(),
};

const body = document.querySelector('[data-alert-body]');
const emptyState = document.querySelector('[data-empty-state]');
const resultCount = document.querySelector('[data-result-count]');
const liveStatus = document.querySelector('[data-live-status]');
const searchInput = document.querySelector('[data-search]');
const chips = Array.from(document.querySelectorAll('[data-severity]'));
const alertTable = document.querySelector('[data-alert-table]');
const tableWrap = document.querySelector('.table-wrap');
const scrollHint = document.querySelector('[data-scroll-hint]');
const scrollEdge = document.querySelector('[data-scroll-edge]');
const lastRefreshed = document.querySelector('[data-last-refreshed]');
const countOutputs = Array.from(document.querySelectorAll('[data-count]'));

/**
 * Keep the horizontal-overflow cue honest.
 *
 * The alert table is wider than its scroll box across most of the supported
 * widths, and nothing in this browser paints a scrollbar until the box is
 * already scrolled (see the .table-scroll-hint comment in styles.css). So the
 * cue is a label whose visibility is derived from the box's real state: shown
 * while content is hidden to the right, hidden at the rightmost position and
 * hidden whenever the table fits, so it never implies content that is not
 * there.
 *
 * Ordering matters for determinism: the verifier captures right after `load`
 * and `document.fonts.ready`, so the cue a screenshot shows has to be the real
 * state, not a post-hydration guess. A module script runs before layout, when
 * `clientWidth` can still be 0 — reading it there would claim hidden columns on
 * a page that does not overflow. So a reveal is only possible from a real
 * measurement (`clientWidth > 0`); before that the label stays hidden, which
 * under-states the cue for one frame instead of inventing content that is not
 * there. `load`, `document.fonts.ready`, resize and a ResizeObserver all
 * re-measure the same way.
 *
 * The 0.5px slack absorbs fractional layout widths in one direction only: a
 * sub-half-pixel remainder is rounding, not hidden content, and reaching the end
 * must not leave the label behind. Anything from 1px of hidden table upwards is
 * cued, which is the range the responsive suite exercises explicitly.
 */
function syncScrollHint() {
  if (!tableWrap || !scrollHint) return;
  const measured = tableWrap.clientWidth > 0;
  const max = tableWrap.scrollWidth - tableWrap.clientWidth;
  const visible = measured && max >= 1 && tableWrap.scrollLeft < max - 0.5;
  scrollHint.dataset.visible = String(visible);
  if (scrollEdge) scrollEdge.dataset.visible = String(visible);
}

function visibleAlerts() {
  const needle = state.query.trim().toLowerCase();
  return ALERTS.filter((alert) => {
    const matchesSeverity = state.severity === 'all' || alert.severity === state.severity;
    const matchesQuery =
      needle === '' ||
      alert.title.toLowerCase().includes(needle) ||
      alert.asset.toLowerCase().includes(needle) ||
      alert.id.toLowerCase().includes(needle);
    return matchesSeverity && matchesQuery;
  });
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function stateClass(label, acknowledged) {
  if (acknowledged) return 'is-ack';
  return `is-${label.toLowerCase().replace(/\s+/g, '-')}`;
}

function rowFor(alert) {
  const isAcknowledged = state.acknowledged.has(alert.id);
  const stateLabel = isAcknowledged ? 'Acknowledged' : alert.state;

  return `
    <tr data-row data-alert-row="${alert.id}"${isAcknowledged ? ' class="is-acknowledged"' : ''}>
      <td>
        <span class="badge badge-${alert.severity}">${SEVERITY_LABELS[alert.severity]}</span>
      </td>
      <td>
        <span class="alert-name">${escapeHtml(alert.title)}</span>
        <span class="alert-meta">${escapeHtml(alert.id)} · ${escapeHtml(alert.detail)}</span>
      </td>
      <td class="mono">${escapeHtml(alert.asset)}</td>
      <td class="mono">${escapeHtml(alert.detected)}</td>
      <td data-state-cell="${alert.id}">
        <span class="state-pill ${stateClass(stateLabel, isAcknowledged)}">
          <span class="state-dot" aria-hidden="true"></span>${escapeHtml(stateLabel)}
        </span>
      </td>
      <td>
        <button
          class="button button-ghost"
          type="button"
          data-action="acknowledge"
          data-alert="${alert.id}"
          aria-label="${isAcknowledged ? 'Acknowledged' : 'Acknowledge'} alert ${alert.id}: ${escapeHtml(alert.title)}"
          ${isAcknowledged ? 'disabled' : ''}
        >
          ${isAcknowledged ? 'Acknowledged' : 'Acknowledge'}
        </button>
      </td>
    </tr>`;
}

function render() {
  const rows = visibleAlerts();
  body.innerHTML = rows.map(rowFor).join('');

  const isEmpty = rows.length === 0;
  emptyState.hidden = !isEmpty;
  document.querySelector('[data-alert-table]').hidden = isEmpty;

  resultCount.textContent = String(rows.length);
  liveStatus.textContent = isEmpty
    ? 'No alerts match the current filters.'
    : `${rows.length} alert${rows.length === 1 ? '' : 's'} shown.`;

  for (const chip of chips) {
    const isActive = chip.dataset.severity === state.severity;
    chip.classList.toggle('is-active', isActive);
    chip.setAttribute('aria-pressed', String(isActive));
  }

  for (const output of countOutputs) {
    const key = output.dataset.count;
    output.textContent = String(
      key === 'all' ? ALERTS.length : ALERTS.filter((alert) => alert.severity === key).length,
    );
  }

  // The empty state hides the table, which removes any overflow with it.
  syncScrollHint();
}

/**
 * Where focus should go after an alert is acknowledged.
 *
 * The control that was activated is disabled by the re-render, so focusing it
 * again is a no-op and focus silently falls back to <body>: the next Tab then
 * restarts from the top of the document. Instead, focus continues the triage
 * task at the next actionable alert, and falls back to the table region (which
 * is focusable and named) when this was the last one.
 */
function focusAfterAcknowledge(alertId) {
  const currentRow = body.querySelector(`[data-alert-row="${alertId}"]`);
  const candidates = Array.from(
    body.querySelectorAll('[data-action="acknowledge"]:not([disabled])'),
  );

  const next =
    candidates.find(
      (button) =>
        currentRow &&
        (currentRow.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ) ?? null;

  const target = next ?? document.querySelector('.table-wrap');
  target?.focus();
}

body.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="acknowledge"]');
  if (!button) return;
  const alertId = button.dataset.alert;
  if (!alertId) return;
  state.acknowledged.add(alertId);
  render();
  // Announce the outcome for screen-reader users, then move focus somewhere
  // that can actually receive it.
  liveStatus.textContent = `Alert ${alertId} acknowledged.`;
  focusAfterAcknowledge(alertId);
});

for (const chip of chips) {
  chip.addEventListener('click', () => {
    state.severity = chip.dataset.severity ?? 'all';
    render();
  });
}

searchInput?.addEventListener('input', (event) => {
  state.query = event.target.value;
  render();
});

document.querySelector('[data-action="reset-filters"]')?.addEventListener('click', () => {
  state.severity = 'all';
  state.query = '';
  if (searchInput) searchInput.value = '';
  render();
  searchInput?.focus();
});

document.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
  // Deliberately local: re-renders sample data and states that nothing was fetched.
  render();
  if (lastRefreshed) lastRefreshed.textContent = 'Updated just now';
  liveStatus.textContent = 'Sample data re-rendered. No external request was made.';
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  // Only take over "/" from the document itself. A focused input, button, link
  // or focusable scroll region already owns the keyboard.
  const isInControl =
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        'input, textarea, select, button, a[href], [contenteditable="true"], [tabindex]',
      ),
    );

  if (event.key === '/' && !isInControl && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    searchInput?.focus();
  }
});

if (tableWrap && scrollHint) {
  tableWrap.addEventListener('scroll', syncScrollHint, { passive: true });
  window.addEventListener('resize', syncScrollHint);
  window.addEventListener('load', syncScrollHint);
  // Web fonts and wrapping change the table's intrinsic width after first
  // paint; watching the table keeps the cue correct without polling.
  if (alertTable) new ResizeObserver(syncScrollHint).observe(alertTable);
  document.fonts?.ready.then(syncScrollHint);
}

render();
