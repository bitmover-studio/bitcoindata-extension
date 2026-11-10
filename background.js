'use strict';

// Background worker:
// 1. Periodically checks saved addresses and notifies on new transactions.
// 2. Registers right-click context menus to check/watch Bitcoin addresses from any webpage.
// 3. Serves cached address & transaction lookups for the Bitcointalk / Altcoinstalks hover cards.
//
// Chrome runs this as a service worker (needs importScripts); Firefox loads balance-api.js
// via the "scripts" array in manifest.json.
if (typeof importScripts === 'function') {
  importScripts('components/balance-api.js');
}

const ALARM_NAME = 'balance-check';
const CHECK_PERIOD_MINUTES = 20;

const MENU_CHECK_SIDEBAR = 'bitcoindata-check-sidebar';
const MENU_ADD_WATCHLIST = 'bitcoindata-add-watchlist';

// Short-lived in-memory caches for hover card lookups
let priceCache = { value: null, expiresAt: 0 };
const addressCache = new Map();
const txCache = new Map();

async function getCachedPrice() {
  if (priceCache.value && Date.now() < priceCache.expiresAt) {
    return priceCache.value;
  }
  const { price: storedPrice } = await BalanceAPI.load();
  try {
    const fresh = await BalanceAPI.getBtcPrice();
    priceCache = { value: fresh, expiresAt: Date.now() + 120_000 };
    return fresh;
  } catch (error) {
    if (storedPrice) return storedPrice;
    throw error;
  }
}

async function syncAlarm() {
  const { autoCheck, addresses } = await BalanceAPI.load();
  const hasAddresses = BalanceAPI.parseAddresses(addresses).length > 0;

  if (autoCheck && hasAddresses) {
    const existing = await ext.alarms.get(ALARM_NAME);
    if (!existing) {
      ext.alarms.create(ALARM_NAME, {
        delayInMinutes: CHECK_PERIOD_MINUTES,
        periodInMinutes: CHECK_PERIOD_MINUTES,
      });
    }
  } else {
    await ext.alarms.clear(ALARM_NAME);
  }
}

function setupContextMenus() {
  if (!ext.contextMenus) return;
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({
      id: MENU_CHECK_SIDEBAR,
      title: 'Check balance in bitcoindata sidebar',
      contexts: ['selection', 'link'],
    });
    ext.contextMenus.create({
      id: MENU_ADD_WATCHLIST,
      title: 'Monitor address in bitcoindata',
      contexts: ['selection', 'link'],
    });
  });
}

function notify(id, title, message) {
  ext.notifications.create(id + '-' + Date.now(), {
    type: 'basic',
    iconUrl: ext.runtime.getURL('icons/icon-96x96.png'),
    title,
    message,
  });
}

function notifyChanges(changes) {
  const first = changes[0];
  const { title, amount, status } = BalanceAPI.describeChange(first);
  const more = changes.length > 1 ? `\n+${changes.length - 1} more address(es) changed` : '';

  notify('balance-change', title, `${first.address}\n${BalanceAPI.fmtDelta(amount)} BTC ${status}${more}`);

  ext.action.setBadgeBackgroundColor({ color: '#26b2a0' });
  ext.action.setBadgeText({ text: String(changes.length) });
}

async function runCheck() {
  const { addresses } = await BalanceAPI.load();
  const list = BalanceAPI.parseAddresses(addresses);
  if (!list.length) return;

  try {
    const { changes } = await BalanceAPI.checkAndStore(list);
    if (changes.length) notifyChanges(changes);
  } catch (error) {
    console.warn('Background balance check failed - ' + error);
  }
}

// ─── Context Menu Click Handler ────────────────────────────────────────────
if (ext.contextMenus?.onClicked) {
  ext.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_CHECK_SIDEBAR && info.menuItemId !== MENU_ADD_WATCHLIST) {
      return;
    }

    // Must be called synchronously inside the click listener to preserve user gesture!
    if (info.menuItemId === MENU_CHECK_SIDEBAR) {
      try {
        if (ext.sidebarAction?.open) {
          ext.sidebarAction.open();
        } else if (ext.sidePanel?.open && tab?.windowId !== undefined) {
          ext.sidePanel.open({ windowId: tab.windowId });
        }
      } catch (error) {
        console.warn('Could not open sidebar from context menu - ' + error);
      }
    }

    const rawText = [info.selectionText, info.linkUrl].filter(Boolean).join(' ');
    const foundAddresses = BalanceAPI.parseAddresses(rawText);

    if (!foundAddresses.length) {
      notify('no-address', 'bitcoindata', 'No valid Bitcoin address found in selection.');
      return;
    }

    (async () => {
      try {
        const merged = await BalanceAPI.addAddressesToStorage(foundAddresses, {
          activeView: 'balances',
        });
        const { balances } = await BalanceAPI.checkAndStore(merged);

        if (info.menuItemId === MENU_ADD_WATCHLIST) {
          const entry = balances.find(b => b.address === foundAddresses[0]);
          const summary = entry
            ? `${entry.address}\n${BalanceAPI.fmtBtc(entry.balance)} BTC (${BalanceAPI.fmtUsd(entry.value)})`
            : `Monitoring ${foundAddresses[0]}`;
          notify('watchlist-added', 'Monitoring address in bitcoindata', summary);
        }
      } catch (error) {
        console.warn('Context menu balance check failed - ' + error);
      }
    })();
  });
}

// ─── Content Script Message Handler (Forum Hover Cards) ────────────────────
ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'get-address-details') {
    (async () => {
      try {
        const address = message.address;
        const { addresses } = await BalanceAPI.load();
        const watchedSet = new Set(BalanceAPI.parseAddresses(addresses));

        const cached = addressCache.get(address);
        if (cached && Date.now() < cached.expiresAt) {
          sendResponse({ ok: true, data: { ...cached.data, isWatched: watchedSet.has(address) } });
          return;
        }

        const price = await getCachedPrice();
        const details = await BalanceAPI.getAddressDetails(address, price);
        addressCache.set(address, { data: details, expiresAt: Date.now() + 45_000 });
        sendResponse({ ok: true, data: { ...details, isWatched: watchedSet.has(address) } });
      } catch (error) {
        sendResponse({ ok: false, error: String(error.message || error) });
      }
    })();
    return true;
  }

  if (message.type === 'get-tx-details') {
    (async () => {
      try {
        const txid = String(message.txid || '').toLowerCase();
        const cached = txCache.get(txid);
        if (cached && Date.now() < cached.expiresAt) {
          sendResponse({ ok: true, data: cached.data });
          return;
        }

        const price = await getCachedPrice();
        const details = await BalanceAPI.getTransactionDetails(txid, price);
        txCache.set(txid, { data: details, expiresAt: Date.now() + 60_000 });
        sendResponse({ ok: true, data: details });
      } catch (error) {
        sendResponse({ ok: false, error: String(error.message || error) });
      }
    })();
    return true;
  }

  if (message.type === 'watch-address') {
    (async () => {
      try {
        const found = BalanceAPI.parseAddresses(message.address);
        if (!found.length) throw new Error('Invalid address');
        const merged = await BalanceAPI.addAddressesToStorage(found, { activeView: 'balances' });
        BalanceAPI.checkAndStore(merged).catch(err => console.warn(err));
        sendResponse({ ok: true, isWatched: true, count: merged.length });
      } catch (error) {
        sendResponse({ ok: false, error: String(error.message || error) });
      }
    })();
    return true;
  }

  return false;
});

ext.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  syncAlarm();
});

ext.runtime.onStartup.addListener(() => {
  setupContextMenus();
  syncAlarm();
});

setupContextMenus();

ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.autoCheck || changes.addresses)) syncAlarm();
});

ext.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) runCheck();
});
