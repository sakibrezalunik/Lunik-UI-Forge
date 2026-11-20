/**
 * Northwind sample dashboard.
 *
 * All data below is invented and lives in this file. The example makes no
 * network requests and claims no live integration — it exists so the verifier
 * has a realistic, interactive page to audit.
 */

const ACCOUNTS = [
  { name: 'Contoso Ltd', plan: 'Business', status: 'active', seats: 240, mrr: 12800 },
  { name: 'Fabrikam', plan: 'Business', status: 'active', seats: 186, mrr: 9400 },
  { name: 'Northwind Labs', plan: 'Team', status: 'active', seats: 64, mrr: 3100 },
  { name: 'Adventure Works', plan: 'Team', status: 'paused', seats: 48, mrr: 2400 },
  { name: 'Tailspin Toys', plan: 'Enterprise', status: 'active', seats: 512, mrr: 21600 },
  { name: 'Proseware', plan: 'Team', status: 'active', seats: 33, mrr: 1650 },
  { name: 'Wide World Importers', plan: 'Business', status: 'active', seats: 152, mrr: 7900 },
  { name: 'Litware', plan: 'Starter', status: 'paused', seats: 12, mrr: 480 },
  { name: 'Blue Yonder Airlines', plan: 'Enterprise', status: 'active', seats: 380, mrr: 17400 },
  { name: 'Coho Vineyard', plan: 'Starter', status: 'paused', seats: 8, mrr: 320 },
  { name: 'Lucerne Publishing', plan: 'Team', status: 'active', seats: 91, mrr: 4550 },
  { name: 'Trey Research', plan: 'Business', status: 'active', seats: 118, mrr: 6100 },
];

const STATUS_LABELS = {
  active: 'Active',
  paused: 'Paused',
  churned: 'Churned',
};

const state = {
  query: '',
  status: 'all',
  sortKey: 'mrr',
  sortDirection: 'desc',
};

const body = document.querySelector('[data-accounts-body]');
const emptyState = document.querySelector('[data-empty-state]');
const resultCount = document.querySelector('[data-result-count]');
const totalMrr = document.querySelector('[data-total-mrr]');
const liveStatus = document.querySelector('[data-live-status]');
const searchInput = document.querySelector('[data-search]');
const chips = Array.from(document.querySelectorAll('[data-filter]'));
const table = document.querySelector('[data-accounts-table]');
const tableHint = document.querySelector('.table-hint');

const notificationButton = document.querySelector('[data-action="notifications"]');
const notifications = document.querySelector('.notifications');
const notificationPanel = document.querySelector('[data-notifications-panel]');
const notificationStatus = document.querySelector('[data-notifications-status]');
const markReadButton = document.querySelector('[data-action="mark-read"]');

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function visibleAccounts() {
  const needle = state.query.trim().toLowerCase();
  return ACCOUNTS.filter((account) => {
    const matchesStatus = state.status === 'all' || account.status === state.status;
    const matchesQuery =
      needle === '' ||
      account.name.toLowerCase().includes(needle) ||
      account.plan.toLowerCase().includes(needle);
    return matchesStatus && matchesQuery;
  });
}

function sortedAccounts(rows) {
  const direction = state.sortDirection === 'asc' ? 1 : -1;
  return [...rows].sort((first, second) => {
    const a = first[state.sortKey];
    const b = second[state.sortKey];
    if (typeof a === 'number' && typeof b === 'number') {
      return (a - b) * direction;
    }
    return String(a).localeCompare(String(b), 'en', { sensitivity: 'base' }) * direction;
  });
}

function statusBadge(status) {
  const label = STATUS_LABELS[status] ?? status;
  return `<span class="badge badge-${status}">${label}</span>`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
}

function syncSortUi() {
  for (const button of document.querySelectorAll('[data-sort]')) {
    const header = button.closest('th');
    const isActive = button.dataset.sort === state.sortKey;
    header.setAttribute(
      'aria-sort',
      isActive ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
    );
    if (isActive) {
      button.dataset.direction = state.sortDirection;
    } else {
      delete button.dataset.direction;
    }
  }
}

function render() {
  const rows = sortedAccounts(visibleAccounts());

  body.innerHTML = rows
    .map(
      (account) => `
        <tr data-row>
          <td>
            <span class="account-cell">
              <span class="account-avatar" aria-hidden="true">${escapeHtml(initials(account.name))}</span>
              <span class="account-name">${escapeHtml(account.name)}</span>
            </span>
          </td>
          <td><span class="plan-tag">${escapeHtml(account.plan)}</span></td>
          <td>${statusBadge(account.status)}</td>
          <td class="numeric">${account.seats}</td>
          <td class="numeric">${currency.format(account.mrr)}</td>
        </tr>`,
    )
    .join('');

  const isEmpty = rows.length === 0;
  emptyState.hidden = !isEmpty;
  table.hidden = isEmpty;
  if (tableHint) tableHint.hidden = isEmpty;

  resultCount.textContent = String(rows.length);
  if (totalMrr) {
    totalMrr.textContent = currency.format(rows.reduce((sum, account) => sum + account.mrr, 0));
  }

  liveStatus.textContent =
    rows.length === 0
      ? 'No accounts match the current filters.'
      : `${rows.length} account${rows.length === 1 ? '' : 's'} shown.`;

  for (const chip of chips) {
    const isActive = chip.dataset.filter === state.status;
    chip.classList.toggle('is-active', isActive);
    chip.setAttribute('aria-pressed', String(isActive));
  }

  syncSortUi();
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

function resetFilters() {
  state.query = '';
  state.status = 'all';
  if (searchInput) searchInput.value = '';
  render();
  searchInput?.focus();
}

for (const chip of chips) {
  chip.addEventListener('click', () => {
    state.status = chip.dataset.filter ?? 'all';
    render();
  });
}

searchInput?.addEventListener('input', (event) => {
  state.query = event.target.value;
  render();
});

document.querySelector('[data-action="reset-filters"]')?.addEventListener('click', resetFilters);

for (const button of document.querySelectorAll('[data-sort]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.sort;
    if (!key) return;

    if (state.sortKey === key) {
      state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDirection = key === 'name' ? 'asc' : 'desc';
    }
    render();
  });
}

document.querySelector('[data-action="export"]')?.addEventListener('click', () => {
  const header = 'Account,Plan,Status,Seats,MRR';
  const lines = sortedAccounts(visibleAccounts()).map((account) =>
    [account.name, account.plan, account.status, account.seats, account.mrr]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(','),
  );
  const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'northwind-accounts.csv';
  link.click();
  URL.revokeObjectURL(url);
});

/* ---------- notifications ---------- */

let notificationsOpen = false;

function setNotificationsOpen(open, { restoreFocus = false } = {}) {
  notificationsOpen = open;
  if (!notificationPanel || !notificationButton) return;

  notificationPanel.hidden = !open;
  notificationButton.setAttribute('aria-expanded', String(open));
  notificationButton.setAttribute(
    'aria-label',
    open ? 'Close notifications' : 'Open notifications',
  );

  if (open) {
    markReadButton?.focus();
  } else if (restoreFocus) {
    notificationButton.focus();
  }
}

notificationButton?.addEventListener('click', () => {
  setNotificationsOpen(!notificationsOpen);
});

markReadButton?.addEventListener('click', () => {
  notificationPanel.dataset.read = 'true';
  notifications?.classList.add('is-read');
  markReadButton.disabled = true;
  markReadButton.textContent = 'All read';
  notificationStatus.textContent = 'All notifications marked as read.';
  notificationButton.focus();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && notificationsOpen) {
    setNotificationsOpen(false, { restoreFocus: true });
    return;
  }

  const target = event.target;
  // Only take over "/" from the document itself. A focused input, button,
  // link or focusable region already owns the keyboard.
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

document.addEventListener('pointerdown', (event) => {
  if (!notificationsOpen || !(event.target instanceof Node)) return;
  if (!notifications?.contains(event.target)) {
    setNotificationsOpen(false);
  }
});

document.addEventListener('focusin', (event) => {
  if (!notificationsOpen || !(event.target instanceof Node)) return;
  if (!notifications?.contains(event.target)) {
    setNotificationsOpen(false);
  }
});

render();
