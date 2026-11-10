'use strict';

// Shared balance-checker & blockchain lookup logic, used by main.html (popup / sidebar), background.js
// and the userscript build (userscript/bitcoindata.user.js).
// Ported from bitcoindata/components/balance-check.js and bitcoindata/api/transaction.php.

// Firefox exposes the promise-based `browser` namespace, Chrome exposes `chrome`.
// In the userscript build there are no extension APIs, so every use of `ext` is guarded.
const ext = globalThis.browser ?? globalThis.chrome;

const BalanceAPI = (() => {
  const SATS = 1e8;
  const MAX_ADDRESSES = 1; // Single-address monitor in extension; multi-address checks go to bitcoindata.science
  const SINGLE_LOOKUP_LIMIT = 20;
  const BATCH_SIZE = 100;
  const ADDRESS_RE = /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,71})$/;
  const TXID_RE = /^[a-fA-F0-9]{64}$/;

  const STORAGE_DEFAULTS = {
    addresses: '',      // raw textarea content
    balances: [],       // [{ address, balance, value, unconfirmed, unconfirmed_value }]
    changes: [],        // deltas found on the last check
    price: null,        // last BTC/USD price
    lastChecked: null,  // timestamp (ms)
    autoCheck: true,    // background check + notifications
    activeView: null,   // optional view requested by background action ('home' | 'balances')
  };

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

  // ─── Formatting helpers ──────────────────────────────────────────────────
  const fmtBtc = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
  const fmtUsd = n => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const fmtDelta = n => (n > 0 ? '+' : '') + fmtBtc(n);

  // ─── Address & TXID parsing ──────────────────────────────────────────────
  function parseAddresses(text = '') {
    const unique = new Set();
    // Split on whitespace and common URL/punctuation delimiters so URLs like
    // https://mempool.space/address/bc1q... or bitcoin:1A1z...?amount=1 also work.
    for (let item of String(text).split(/[\s,;:?&#=/'"<>()[\]]+/)) {
      if (!item) continue;
      if (/^bc1/i.test(item)) item = item.toLowerCase();
      if (ADDRESS_RE.test(item)) unique.add(item);
    }
    return [...unique].slice(0, MAX_ADDRESSES);
  }

  function parseTxids(text = '') {
    const unique = new Set();
    for (const item of String(text).split(/[\s,;:?&#=/'"<>()[\]]+/)) {
      if (item && TXID_RE.test(item)) unique.add(item.toLowerCase());
    }
    return [...unique];
  }

  // ─── Network ─────────────────────────────────────────────────────────────
  // Userscript managers (Tampermonkey, Violentmonkey, Greasemonkey) expose a cross-origin request
  // API that is not subject to the forum page's CORS / CSP rules. Undefined inside the extension.
  const gmXhr = typeof GM_xmlhttpRequest === 'function'
    ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);

  function gmGetJSON(url) {
    return new Promise((resolve, reject) => {
      gmXhr({
        method: 'GET',
        url,
        timeout: 15000,
        headers: { Accept: 'application/json' },
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status} - ${url}`));
            return;
          }
          try {
            resolve(JSON.parse(response.responseText));
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error(`Network error - ${url}`)),
        ontimeout: () => reject(new Error(`Timeout - ${url}`)),
      });
    });
  }

  async function getJSON(url) {
    if (gmXhr) return gmGetJSON(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} - ${url}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function getBtcPrice() {
    try {
      const data = await getJSON('https://bitcoindata.science/api/priceusd.json');
      const price = Number(data.price);
      if (price > 0) return price;
      throw new Error('invalid price');
    } catch (error) {
      console.warn('bitcoindata API failed - ' + error);
      const data = await getJSON('https://mempool.space/api/v1/prices');
      return Number(data.USD);
    }
  }

  async function getAddressBalance(address) {
    try {
      const data = await getJSON('https://mempool.space/api/address/' + address);
      const funded = data.chain_stats?.funded_txo_sum || 0;
      const spent = data.chain_stats?.spent_txo_sum || 0;
      const mempoolFunded = data.mempool_stats?.funded_txo_sum || 0;
      const mempoolSpent = data.mempool_stats?.spent_txo_sum || 0;
      return {
        address,
        balance: (funded - spent) / SATS,
        unconfirmed: (mempoolFunded - mempoolSpent) / SATS,
        totalReceived: funded / SATS,
        totalSent: spent / SATS,
        txCount: (data.chain_stats?.tx_count || 0) + (data.mempool_stats?.tx_count || 0),
      };
    } catch (error) {
      console.warn('Mempool API failed - ' + error);
      const data = await getJSON('https://api.blockcypher.com/v1/btc/main/addrs/' + address + '/balance');
      return {
        address,
        balance: (data.balance || 0) / SATS,
        unconfirmed: (data.unconfirmed_balance || 0) / SATS,
        totalReceived: (data.total_received || 0) / SATS,
        totalSent: (data.total_sent || 0) / SATS,
        txCount: data.final_n_tx || data.n_tx || 0,
      };
    }
  }

  async function getAddressDetails(address, price) {
    const info = await getAddressBalance(address);
    return {
      ...info,
      value: round(info.balance * price, 2),
      unconfirmed_value: round(info.unconfirmed * price, 2),
      totalReceivedUsd: round((info.totalReceived || 0) * price, 2),
    };
  }

  function decodeHexAscii(hex = '') {
    try {
      let out = '';
      for (let i = 0; i < hex.length; i += 2) {
        const code = parseInt(hex.slice(i, i + 2), 16);
        if (code >= 32 && code <= 126) out += String.fromCharCode(code);
      }
      return out.trim();
    } catch {
      return '';
    }
  }

  async function getTransactionDetails(txid, price) {
    const data = await getJSON('https://mempool.space/api/tx/' + txid);
    const feeSats = data.fee || 0;
    const fee = feeSats / SATS;
    const vsize = data.weight > 0 ? data.weight / 4 : (data.size || 1);
    const feeRate = round(feeSats / vsize, 2);
    const confirmed = Boolean(data.status?.confirmed);

    const inputs = (data.vin || []).map(vin => {
      if (vin.is_coinbase) {
        return {
          isCoinbase: true,
          label: 'Coinbase' + (vin.scriptsig ? ` (${decodeHexAscii(vin.scriptsig)})` : ''),
          value: null,
          valueUsd: null,
        };
      }
      const value = (vin.prevout?.value || 0) / SATS;
      return {
        address: vin.prevout?.scriptpubkey_address || 'Unknown',
        value,
        valueUsd: round(value * price, 2),
      };
    });

    const outputs = (data.vout || []).map(vout => {
      const value = (vout.value || 0) / SATS;
      if (vout.scriptpubkey_type === 'op_return') {
        const parts = String(vout.scriptpubkey_asm || '').split(' ');
        const decoded = decodeHexAscii(parts[parts.length - 1] || '');
        return {
          isOpReturn: true,
          label: 'OP_RETURN' + (decoded ? `: ${decoded}` : ''),
          value,
          valueUsd: round(value * price, 2),
        };
      }
      return {
        address: vout.scriptpubkey_address || vout.scriptpubkey_type || 'Output',
        value,
        valueUsd: round(value * price, 2),
      };
    });

    const totalOut = outputs.reduce((sum, o) => sum + (o.value || 0), 0);

    return {
      txid: data.txid || txid,
      confirmed,
      blockHeight: data.status?.block_height || null,
      blockTime: data.status?.block_time || null,
      fee,
      feeSats,
      feeUsd: round(fee * price, 2),
      vsize: Math.round(vsize),
      feeRate,
      totalOut,
      totalOutUsd: round(totalOut * price, 2),
      inputs,
      outputs,
    };
  }

  async function getMultipleAddressBalance(addresses) {
    const data = await getJSON('https://blockchain.info/balance?active=' + addresses.join('|'));
    return Object.keys(data).map(address => ({
      address,
      balance: data[address].final_balance / SATS,
      unconfirmed: 0,
    }));
  }

  async function getBalances(addresses, price, onProgress) {
    let list = [];
    if (addresses.length <= SINGLE_LOOKUP_LIMIT) {
      for (const [i, address] of addresses.entries()) {
        if (i > 0) await delay(500); // be gentle with mempool.space rate limits
        try {
          list.push(await getAddressBalance(address));
        } catch (error) {
          console.warn(`Could not fetch ${address} - ${error}`);
        }
        onProgress?.(i + 1, addresses.length);
      }
    } else {
      for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        list.push(...await getMultipleAddressBalance(addresses.slice(i, i + BATCH_SIZE)));
        onProgress?.(Math.min(i + BATCH_SIZE, addresses.length), addresses.length);
      }
    }

    list = list.map(i => ({
      address: i.address,
      balance: i.balance,
      value: round(i.balance * price, 2),
      unconfirmed: i.unconfirmed,
      unconfirmed_value: round(i.unconfirmed * price, 2),
      totalReceived: i.totalReceived || 0,
      txCount: i.txCount || 0,
    }));
    return list.sort((a, b) => b.balance - a.balance);
  }

  // ─── Change detection ────────────────────────────────────────────────────
  function diffBalances(oldList = [], newList = []) {
    const previous = new Map(oldList.map(i => [i.address, i]));
    const changes = [];
    for (const entry of newList) {
      const old = previous.get(entry.address);
      if (!old) continue;
      const balanceDelta = round(entry.balance - old.balance, 8);
      const unconfirmedDelta = round(entry.unconfirmed - old.unconfirmed, 8);
      if (balanceDelta !== 0 || unconfirmedDelta !== 0) {
        changes.push({ address: entry.address, balanceDelta, unconfirmedDelta });
      }
    }
    return changes;
  }

  function describeChange(change) {
    if (change.balanceDelta !== 0) {
      return {
        title: change.balanceDelta > 0 ? 'New transaction confirmed' : 'Outgoing transaction confirmed',
        amount: change.balanceDelta,
        status: 'confirmed',
      };
    }
    return {
      title: change.unconfirmedDelta > 0 ? 'Incoming transaction' : 'Outgoing transaction',
      amount: change.unconfirmedDelta,
      status: 'unconfirmed',
    };
  }

  // ─── Storage ─────────────────────────────────────────────────────────────
  // Only the popup, sidebar and background use storage; the userscript gets harmless no-ops.
  const hasStorage = Boolean(ext?.storage?.local);
  const load = () => (hasStorage
    ? ext.storage.local.get(STORAGE_DEFAULTS)
    : Promise.resolve(structuredClone(STORAGE_DEFAULTS)));
  const save = values => (hasStorage ? ext.storage.local.set(values) : Promise.resolve());

  // Set the monitored address in storage (single-address mode).
  async function addAddressesToStorage(newAddresses = [], extraStorage = {}) {
    const selected = newAddresses.slice(0, MAX_ADDRESSES);
    const addressesText = selected.join('\n');
    await save({ addresses: addressesText, ...extraStorage });
    return selected;
  }

  // Fetch price + balances, compare with the stored ones and persist everything.
  async function checkAndStore(addresses, onProgress) {
    const { balances: previous } = await load();
    const price = await getBtcPrice();
    const balances = await getBalances(addresses, price, onProgress);
    const changes = diffBalances(previous, balances);
    await save({ balances, changes, price, lastChecked: Date.now() });
    return { balances, changes, price };
  }

  return {
    MAX_ADDRESSES,
    ADDRESS_RE,
    TXID_RE,
    parseAddresses,
    parseTxids,
    getBtcPrice,
    getAddressDetails,
    getTransactionDetails,
    getBalances,
    diffBalances,
    describeChange,
    addAddressesToStorage,
    checkAndStore,
    load,
    save,
    fmtBtc,
    fmtUsd,
    fmtDelta,
  };
})();
