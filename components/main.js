'use strict';

// UI logic for main.html — used both as the toolbar popup and as the browser sidebar.
// Note: MV3 forbids inline scripts / onclick handlers, so everything is bound here.

const $ = id => document.getElementById(id);
const isPopup = document.documentElement.classList.contains('is-popup');

const escapeHTML = str => String(str).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

$('version').textContent = ext.runtime.getManifest().version;

// ─── Theme toggle (same behavior as the website navbar) ────────────────────
function showActiveTheme() {
  const theme = document.documentElement.getAttribute('data-bs-theme');
  document.querySelectorAll('[data-bs-theme-value]').forEach(el => {
    el.classList.toggle('d-none', el.dataset.bsThemeValue === theme);
  });
}

document.querySelectorAll('[data-bs-theme-value]').forEach(toggle => {
  toggle.addEventListener('click', () => {
    const theme = toggle.dataset.bsThemeValue;
    localStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-bs-theme', theme);
    BalanceAPI.save({ theme });
    showActiveTheme();
  });
});
new MutationObserver(showActiveTheme).observe(document.documentElement, { attributeFilter: ['data-bs-theme'] });
showActiveTheme();

// ─── Views (Home / Balances) ───────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('[data-view]').forEach(section => {
    section.hidden = section.dataset.view !== name;
  });
  document.querySelectorAll('.ext-tabs [data-view-target]').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.viewTarget === name);
  });
  localStorage.setItem('ext-view', name);
  if (name === 'balances') ext.action.setBadgeText({ text: '' });
}

document.querySelectorAll('[data-view-target]').forEach(el => {
  el.addEventListener('click', event => {
    event.preventDefault();
    showView(el.dataset.viewTarget);
  });
});
showView(localStorage.getItem('ext-view') || 'home');

// ─── Open in sidebar (only shown in the popup) ─────────────────────────────
// Firefox: sidebarAction.open() / Chrome: sidePanel.open(). Both must run synchronously
// inside the click handler (user gesture), so the Chrome window id is fetched up-front.
const canOpenSidebar = isPopup && (ext.sidebarAction?.open || ext.sidePanel?.open);
let currentWindowId;

if (canOpenSidebar) {
  $('openSidebar').classList.remove('d-none');
  if (!ext.sidebarAction && ext.windows) {
    ext.windows.getCurrent().then(win => { currentWindowId = win.id; });
  }
  $('openSidebar').addEventListener('click', () => {
    const opening = ext.sidebarAction?.open
      ? ext.sidebarAction.open()
      : ext.sidePanel.open({ windowId: currentWindowId });
    opening.then(() => window.close()).catch(error => console.warn('Could not open sidebar - ' + error));
  });
}

// ─── Home: BTC price ───────────────────────────────────────────────────────
BalanceAPI.load().then(({ price }) => {
  if (price) $('btcPrice').textContent = BalanceAPI.fmtUsd(price);
});
BalanceAPI.getBtcPrice()
  .then(price => { $('btcPrice').textContent = BalanceAPI.fmtUsd(price); })
  .catch(error => console.warn(error));

// ─── Single-Address Monitor ────────────────────────────────────────────────
const textArea = $('BalanceChecker');
const submitBtn = $('submitbutton');
const outputArea = $('balances');
let isChecking = false;
let saveTimer;

function updateAddressCount() {
  const raw = textArea.value.trim();
  const parsed = BalanceAPI.parseAddresses(raw);
  if (!raw) {
    $('addressCount').textContent = 'Paste a valid BTC address';
  } else if (parsed.length > 0) {
    $('addressCount').textContent = '✓ Valid BTC address';
  } else {
    $('addressCount').textContent = 'Invalid BTC address';
  }
  return parsed.length;
}

textArea.addEventListener('input', () => {
  const parsed = BalanceAPI.parseAddresses(textArea.value);
  if (parsed.length > 0 && textArea.value.trim() !== parsed[0]) {
    textArea.value = parsed[0];
  }
  updateAddressCount();
  textArea.classList.remove('is-invalid');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => BalanceAPI.save({ addresses: textArea.value.trim() }), 300);
});

textArea.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleClick();
  }
});

$('autoCheck').addEventListener('change', event => {
  BalanceAPI.save({ autoCheck: event.target.checked });
});

function setStatus(lastChecked) {
  const time = lastChecked
    ? ' · Updated ' + new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  $('status').textContent = 'Data from mempool.space' + time;
}

async function handleClick() {
  const addresses = BalanceAPI.parseAddresses(textArea.value);
  if (!addresses.length) {
    textArea.classList.add('is-invalid');
    textArea.focus();
    return;
  }

  textArea.value = addresses[0];
  isChecking = true;
  submitBtn.disabled = true;
  submitBtn.classList.remove('is-success');
  submitBtn.classList.add('is-loading');
  await BalanceAPI.save({ addresses: addresses[0] });

  try {
    const { balances, changes } = await BalanceAPI.checkAndStore(addresses, () => {
      $('status').textContent = 'Checking balance…';
    });
    renderBalances(balances, changes);
    setStatus(Date.now());
    submitBtn.classList.replace('is-loading', 'is-success');
  } catch (error) {
    console.warn(error);
    $('status').textContent = 'Could not fetch balance. Please try again in a moment.';
    submitBtn.classList.remove('is-loading');
  }

  setTimeout(() => {
    submitBtn.classList.remove('is-success');
    submitBtn.disabled = false;
    isChecking = false;
  }, 2000);
}
submitBtn.addEventListener('click', handleClick);

function renderBalances(balances = [], changes = []) {
  if (!balances.length) {
    outputArea.innerHTML = '';
    return;
  }

  const item = balances[0];
  const address = escapeHTML(item.address);
  const change = changes.find(c => c.address === item.address);
  const delta = change ? (change.balanceDelta || change.unconfirmedDelta) : 0;

  outputArea.innerHTML = `
    <div class="bg-body-tertiary rounded-4 p-3 shadow-sm">
      <div class="d-flex justify-content-between align-items-center gap-2 mb-2">
        <span class="small text-muted fw-semibold">Monitored Address</span>
        <a class="small fw-semibold text-primary" target="_blank" rel="noreferrer"
           href="https://mempool.space/address/${address}">mempool.space ↗</a>
      </div>

      <div class="font-monospace small text-truncate bg-body-secondary rounded-3 px-2 py-1 mb-3" title="${address}">
        ${address}
      </div>

      <div class="d-flex justify-content-between align-items-baseline gap-2">
        <div class="fs-5 fw-bold font-monospace">${BalanceAPI.fmtBtc(item.balance)} <span class="text-muted fs-6">BTC</span></div>
        ${delta ? `<span class="badge rounded-pill ${delta > 0 ? 'bg-primary-subtle text-primary-emphasis' : 'bg-danger-subtle text-danger-emphasis'}"
                     title="Change since previous check">${BalanceAPI.fmtDelta(delta)}</span>` : ''}
      </div>
      <div class="fw-semibold text-primary">${BalanceAPI.fmtUsd(item.value)}</div>

      ${item.unconfirmed !== 0 ? `
        <div class="d-flex justify-content-between small text-warning-emphasis font-monospace mt-2 pt-2 border-top border-secondary border-opacity-25">
          <span>Unconfirmed</span>
          <span>${BalanceAPI.fmtDelta(item.unconfirmed)} BTC (${BalanceAPI.fmtUsd(item.unconfirmed_value)})</span>
        </div>` : ''}

      ${(item.totalReceived !== undefined || item.txCount !== undefined) ? `
        <div class="row g-2 mt-2 pt-2 border-top border-secondary border-opacity-25 small">
          <div class="col-7">
            <div class="text-muted">Total received</div>
            <div class="font-monospace fw-semibold">${BalanceAPI.fmtBtc(item.totalReceived || 0)} BTC</div>
          </div>
          <div class="col-5 text-end">
            <div class="text-muted">Transactions</div>
            <div class="font-monospace fw-semibold">${Number(item.txCount || 0).toLocaleString('en-US')}</div>
          </div>
        </div>` : ''}
    </div>`;
}

// ─── Initial state + live updates (background checks, other open views) ────
BalanceAPI.load().then(({ addresses, balances, changes, lastChecked, autoCheck, activeView }) => {
  const first = BalanceAPI.parseAddresses(addresses)[0] || '';
  textArea.value = first;
  $('autoCheck').checked = autoCheck;
  updateAddressCount();
  renderBalances(balances.slice(0, 1), changes);
  setStatus(lastChecked);
  if (activeView) {
    showView(activeView);
    BalanceAPI.save({ activeView: null });
  }
});

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.activeView?.newValue) {
    showView(changes.activeView.newValue);
    BalanceAPI.save({ activeView: null });
  }
  if (changes.price?.newValue) $('btcPrice').textContent = BalanceAPI.fmtUsd(changes.price.newValue);
  if (changes.autoCheck) $('autoCheck').checked = changes.autoCheck.newValue;
  if (changes.addresses && document.activeElement !== textArea) {
    textArea.value = BalanceAPI.parseAddresses(changes.addresses.newValue ?? '')[0] ?? '';
    updateAddressCount();
  }
  if (changes.balances && !isChecking) {
    BalanceAPI.load().then(data => {
      renderBalances((data.balances || []).slice(0, 1), data.changes);
      setStatus(data.lastChecked);
    });
  }
});
