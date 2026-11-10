'use strict';

// Content script for bitcointalk.org and altcoinstalks.com:
// Detects Bitcoin addresses and transaction IDs inside forum pages and shows a
// hover card styled to blend with classic SMF / Bitcointalk forum aesthetics.
// Also bundled into the userscript build (userscript/bitcoindata.user.js).

(() => {
  const ext = globalThis.browser ?? globalThis.chrome;

  // Extension content script → lookups go through background.js (shared cache, watch button).
  // Userscript build (BDS_USERSCRIPT is defined by the build) → lookups call BalanceAPI directly.
  const isExtension = typeof BDS_USERSCRIPT === 'undefined' && Boolean(ext?.runtime?.id);

  // Avoid duplicate highlights / hover cards when both the extension and the userscript are installed.
  if (document.documentElement.dataset.bdsHover) return;
  document.documentElement.dataset.bdsHover = isExtension ? 'extension' : 'userscript';

  const ADDRESS_EXACT_RE = /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,71})$/i;
  const TXID_EXACT_RE = /^[a-fA-F0-9]{64}$/;
  // Combined regex for scanning plain text nodes inside posts
  const INLINE_ENTITY_RE = /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,71}|[a-fA-F0-9]{64})\b/gi;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON', 'NOSCRIPT']);

  const fmtBtc = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 });
  const fmtUsd = n => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const shortStr = (s, len = 8) => (s && s.length > len * 2 + 3 ? `${s.slice(0, len)}…${s.slice(-len)}` : s);
  const escapeHTML = str => String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function normalizeAddress(addr) {
    return /^bc1/i.test(addr) ? addr.toLowerCase() : addr;
  }

  // ─── Inject minimal page style for inline highlights ─────────────────────
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `
    .bds-hover-target {
      border-bottom: 1px dotted #476C8E;
      cursor: pointer;
      transition: background-color 0.12s ease, border-color 0.12s ease;
    }
    .bds-hover-target:hover {
      border-bottom-style: solid;
      background-color: rgba(71, 108, 142, 0.12);
    }
  `;
  (document.head || document.documentElement).appendChild(pageStyle);

  // ─── Extract entity from URLs (links & bitcoindata API images) ───────────
  function extractEntityFromUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl, location.href);
      if (url.protocol === 'bitcoin:') {
        const addr = url.pathname.replace(/^\/+/, '');
        if (ADDRESS_EXACT_RE.test(addr)) return { type: 'address', id: normalizeAddress(addr) };
      }

      const addrParam = url.searchParams.get('address');
      if (addrParam && ADDRESS_EXACT_RE.test(addrParam)) {
        return { type: 'address', id: normalizeAddress(addrParam) };
      }

      const idParam = url.searchParams.get('id') || url.searchParams.get('txid');
      if (idParam && TXID_EXACT_RE.test(idParam)) {
        return { type: 'tx', id: idParam.toLowerCase() };
      }

      const parts = url.pathname.split('/').filter(Boolean);
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i].toLowerCase();
        const val = parts[i + 1];
        if ((key === 'address' || key === 'addr' || key === 'addresses') && ADDRESS_EXACT_RE.test(val)) {
          return { type: 'address', id: normalizeAddress(val) };
        }
        if ((key === 'tx' || key === 'transaction' || key === 'transactions') && TXID_EXACT_RE.test(val)) {
          return { type: 'tx', id: val.toLowerCase() };
        }
      }
    } catch {
      // Ignore malformed URLs
    }
    return null;
  }

  // ─── Scan forum content and mark addresses / transactions ────────────────
  function annotateContainer(root) {
    // 1. Check <a> links and <img> widgets first
    root.querySelectorAll('a[href], img[src]').forEach(el => {
      if (el.dataset.bdsType) return;
      const rawUrl = el.tagName === 'IMG' ? el.getAttribute('src') : el.getAttribute('href');
      let entity = extractEntityFromUrl(rawUrl);

      if (!entity && el.tagName === 'A') {
        const text = el.textContent.trim();
        if (ADDRESS_EXACT_RE.test(text)) {
          entity = { type: 'address', id: normalizeAddress(text) };
        } else if (TXID_EXACT_RE.test(text)) {
          entity = { type: 'tx', id: text.toLowerCase() };
        }
      }

      if (entity) {
        el.dataset.bdsType = entity.type;
        el.dataset.bdsId = entity.id;
      }
    });

    // 2. Walk plain text nodes for inline addresses and 64-hex TXIDs
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 26) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[data-bds-type]')) return NodeFilter.FILTER_REJECT;
        INLINE_ENTITY_RE.lastIndex = 0;
        return INLINE_ENTITY_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      const text = node.nodeValue;
      INLINE_ENTITY_RE.lastIndex = 0;
      let match;
      let lastIndex = 0;
      const frag = document.createDocumentFragment();

      while ((match = INLINE_ENTITY_RE.exec(text)) !== null) {
        const token = match[1];
        const isTx = token.length === 64 && TXID_EXACT_RE.test(token);
        const isAddr = !isTx && ADDRESS_EXACT_RE.test(token);
        if (!isTx && !isAddr) continue;

        if (match.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const span = document.createElement('span');
        span.className = 'bds-hover-target';
        span.dataset.bdsType = isTx ? 'tx' : 'address';
        span.dataset.bdsId = isTx ? token.toLowerCase() : normalizeAddress(token);
        span.textContent = token;
        frag.appendChild(span);

        lastIndex = match.index + token.length;
      }

      if (lastIndex > 0) {
        if (lastIndex < text.length) {
          frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  function scanPage() {
    const root = document.getElementById('bodyarea') || document.body;
    if (root) annotateContainer(root);
  }

  // ─── Theme sync with extension (light mode only for now) ─────────────────
  let currentTheme = 'light';
  /*
  let currentTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

  ext?.storage?.local?.get({ theme: null }).then(({ theme }) => {
    if (theme === 'light' || theme === 'dark') {
      currentTheme = theme;
      if (cardEl) cardEl.dataset.theme = currentTheme;
    }
  });

  ext?.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.theme?.newValue) {
      currentTheme = changes.theme.newValue;
      if (cardEl) cardEl.dataset.theme = currentTheme;
    }
  });
  */

  // ─── Shadow DOM Hover Card (Bitcointalk / SMF Forum Aesthetic) ───────────
  let hostEl = null;
  let shadow = null;
  let cardEl = null;

  function ensurePopover() {
    if (cardEl) return cardEl;

    // Sample the active forum theme's .catbg3 background so the header matches 1:1
    const probe = document.createElement('div');
    probe.className = 'catbg3';
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const catStyle = window.getComputedStyle(probe);
    const catBgImage = catStyle.backgroundImage && catStyle.backgroundImage !== 'none'
      ? catStyle.backgroundImage
      : 'url("https://bitcointalk.org/Themes/custom1/images/catbg.jpg")';
    const catBgColor = catStyle.backgroundColor && catStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
      ? catStyle.backgroundColor
      : '#88A6C0';
    probe.remove();

    hostEl = document.createElement('div');
    hostEl.id = 'bds-hover-root';
    hostEl.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    hostEl.style.setProperty('--bds-catbg-image', catBgImage);
    hostEl.style.setProperty('--bds-catbg-color', catBgColor);
    shadow = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      .bds-card,
      .bds-card[data-theme="light"] {
        /* Classic Bitcointalk / SMF Babylon palette */
        --bds-bg: #ECEDF3;
        --bds-surface: #F6F6F6;
        --bds-border: #696969;
        --bds-inner-border: #FFFFFF;
        --bds-divider: #C8CCD8;
        --bds-text: #1A1A1A;
        --bds-text-secondary: #333333;
        --bds-muted: #5A6270;
        --bds-faint: #737B8C;
        --bds-accent: #476C8E;
        --bds-accent-bg: #DDE3EE;
        --bds-btn-bg: #476C8E;
        --bds-btn-text: #FFFFFF;
        --bds-warn: #B45309;
        --bds-warn-bg: #FEF3C7;
        --bds-icon-bg: #F6F6F6;
        --bds-icon-border: #B0B7C6;
        --bds-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
      }
      /*
      .bds-card[data-theme="dark"] {
        --bds-bg: #161F2C;
        --bds-surface: #1F2B3D;
        --bds-header-bg: linear-gradient(180deg, #24344B 0%, #1B2738 100%);
        --bds-border: #3B4D66;
        --bds-inner-border: rgba(255, 255, 255, 0.06);
        --bds-divider: #2C3B50;
        --bds-text: #F1F5F9;
        --bds-text-secondary: #CBD5E1;
        --bds-muted: #94A3B8;
        --bds-faint: #64748B;
        --bds-accent: #7DA2C4;
        --bds-accent-bg: rgba(125, 162, 196, 0.16);
        --bds-btn-bg: #476C8E;
        --bds-btn-text: #FFFFFF;
        --bds-warn: #FBBF24;
        --bds-warn-bg: rgba(251, 191, 36, 0.14);
        --bds-icon-bg: #253449;
        --bds-icon-border: #3B4D66;
        --bds-shadow: 0 10px 26px rgba(0, 0, 0, 0.6);
      }
      */
      .bds-card {
        position: fixed;
        width: 360px;
        max-width: calc(100vw - 24px);
        background: var(--bds-bg);
        color: var(--bds-text);
        border: 1px solid var(--bds-border);
        box-shadow: inset 0 0 0 1px var(--bds-inner-border), var(--bds-shadow);
        border-radius: 0;
        overflow: hidden;
        font-family: Verdana, Arial, Helvetica, sans-serif;
        font-size: 11.5px;
        line-height: 1.45;
        pointer-events: auto;
        opacity: 0;
        transform: translateY(3px);
        transition: opacity 0.14s ease, transform 0.14s ease;
      }
      .bds-card.is-visible {
        opacity: 1;
        transform: translateY(0);
      }
      /* Bitcointalk .catbg3 header bar */
      .bds-header.catbg3 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 5px 10px;
        background: var(--bds-catbg-image) var(--bds-catbg-color, #88A6C0) repeat-x;
        color: #ffffff;
        border-bottom: solid 1px #375576;
        font-size: 95%;
        font-weight: bold;
      }
      .bds-body {
        padding: 10px 12px 12px;
      }
      .bds-brand,
      .bds-header.catbg3 a.bds-brand:link,
      .bds-header.catbg3 a.bds-brand:visited {
        font-weight: bold;
        font-size: 11px;
        color: #ffffff;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .bds-brand:hover {
        text-decoration: underline;
      }
      .bds-brand-accent {
        color: #ffffff;
      }
      .bds-pill {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border: 1px solid rgba(255, 255, 255, 0.45);
        border-radius: 2px;
        font-size: 10px;
        font-weight: 700;
        background: rgba(255, 255, 255, 0.18);
        color: #ffffff;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .bds-pill.warn {
        background: var(--bds-warn-bg);
        color: var(--bds-warn);
        border-color: var(--bds-warn);
      }
      .bds-mono {
        font-family: Consolas, "Courier New", monospace;
      }
      .bds-id-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        background: var(--bds-surface);
        border: 1px solid var(--bds-divider);
        padding: 4px 8px;
        border-radius: 2px;
        margin-bottom: 8px;
        font-size: 11px;
        color: var(--bds-text-secondary);
      }
      .bds-id-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .bds-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .bds-icon-btn {
        background: var(--bds-icon-bg);
        border: 1px solid var(--bds-icon-border);
        color: var(--bds-accent);
        border-radius: 2px;
        padding: 1px 6px;
        font-family: Verdana, Arial, sans-serif;
        font-size: 10px;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
      }
      .bds-icon-btn:hover {
        background: var(--bds-accent-bg);
      }
      .bds-balance-box {
        background: var(--bds-surface);
        border: 1px solid var(--bds-divider);
        padding: 8px 10px;
        border-radius: 2px;
      }
      .bds-main-val {
        font-size: 16px;
        font-weight: 700;
        color: var(--bds-text);
        line-height: 1.25;
      }
      .bds-unit {
        font-size: 11.5px;
        color: var(--bds-muted);
        font-weight: 700;
      }
      .bds-sub-val {
        font-size: 12px;
        font-weight: 700;
        color: var(--bds-accent);
        margin-top: 2px;
      }
      .bds-unconfirmed {
        margin-top: 6px;
        padding: 4px 8px;
        border-radius: 2px;
        border: 1px solid var(--bds-warn);
        background: var(--bds-warn-bg);
        color: var(--bds-warn);
        font-size: 11px;
        display: flex;
        justify-content: space-between;
      }
      .bds-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-top: 8px;
      }
      .bds-stat-cell {
        background: var(--bds-surface);
        border: 1px solid var(--bds-divider);
        padding: 5px 8px;
        border-radius: 2px;
      }
      .bds-stat-label {
        font-size: 10px;
        color: var(--bds-muted);
      }
      .bds-stat-value {
        font-size: 11px;
        font-weight: 700;
        color: var(--bds-text-secondary);
        margin-top: 1px;
      }
      .bds-io-section {
        margin-top: 8px;
        background: var(--bds-surface);
        border: 1px solid var(--bds-divider);
        padding: 6px 8px;
        border-radius: 2px;
      }
      .bds-io-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--bds-accent);
        margin-bottom: 4px;
      }
      .bds-io-list {
        max-height: 96px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding-right: 2px;
      }
      .bds-io-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
        font-size: 11px;
        color: var(--bds-text-secondary);
      }
      .bds-io-addr {
        color: var(--bds-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .bds-io-amt {
        white-space: nowrap;
        font-weight: 700;
      }
      .bds-io-usd {
        color: var(--bds-faint);
        font-size: 10px;
        font-weight: 400;
        margin-left: 4px;
      }
      .bds-btn {
        margin-top: 8px;
        width: 100%;
        padding: 5px 10px;
        border-radius: 2px;
        border: 1px solid var(--bds-accent);
        background: var(--bds-btn-bg);
        color: var(--bds-btn-text);
        font-family: Verdana, Arial, sans-serif;
        font-weight: 700;
        font-size: 11px;
        cursor: pointer;
      }
      .bds-btn:hover {
        opacity: 0.92;
      }
      a.bds-btn {
        display: block;
        text-align: center;
        text-decoration: none;
      }
      .bds-btn.is-watched {
        background: var(--bds-accent-bg);
        color: var(--bds-accent);
        cursor: default;
      }
      .bds-loading {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        color: var(--bds-muted);
      }
      .bds-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--bds-divider);
        border-top-color: var(--bds-accent);
        border-radius: 50%;
        animation: bds-spin 0.7s linear infinite;
      }
      @keyframes bds-spin {
        to { transform: rotate(360deg); }
      }
      .bds-error {
        color: #B91C1C;
        font-size: 11px;
        padding: 10px 12px;
      }
    `;

    cardEl = document.createElement('div');
    cardEl.className = 'bds-card';
    cardEl.dataset.theme = currentTheme;
    cardEl.hidden = true;

    cardEl.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
    });
    cardEl.addEventListener('mouseleave', () => {
      scheduleHide();
    });

    shadow.appendChild(style);
    shadow.appendChild(cardEl);
    document.body.appendChild(hostEl);
    return cardEl;
  }

  function positionCard(anchorRect) {
    const card = ensurePopover();
    const margin = 6;
    const cardWidth = 360;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchorRect.left;
    if (left + cardWidth > vw - 12) left = vw - cardWidth - 12;
    if (left < 12) left = 12;

    card.style.left = `${Math.round(left)}px`;

    // Measure height after content render
    const cardHeight = card.offsetHeight || 220;
    let top = anchorRect.bottom + margin;
    if (top + cardHeight > vh - 12 && anchorRect.top - cardHeight - margin > 12) {
      top = anchorRect.top - cardHeight - margin;
    }
    card.style.top = `${Math.round(Math.max(12, top))}px`;
  }

  function renderAddressCard(data) {
    const addr = escapeHTML(data.address);
    return `
      <div class="bds-header catbg3">
        <a class="bds-brand" href="https://bitcoindata.science/bitcoin-balance-check" target="_blank" rel="noreferrer">
          <span><span class="bds-brand-accent">bitcoindata</span>.science</span>
        </a>
        <span class="bds-pill">Address</span>
      </div>

      <div class="bds-body">
        <div class="bds-id-row bds-mono">
          <span class="bds-id-text" title="${addr}">${addr}</span>
          <span class="bds-actions">
            <button type="button" class="bds-icon-btn" data-copy="${addr}">Copy</button>
            <a class="bds-icon-btn" href="https://mempool.space/address/${addr}" target="_blank" rel="noreferrer" title="Open on mempool.space">mempool ↗</a>
          </span>
        </div>

        <div class="bds-balance-box">
          <div class="bds-main-val bds-mono">${fmtBtc(data.balance)} <span class="bds-unit">BTC</span></div>
          <div class="bds-sub-val">${fmtUsd(data.value)}</div>
        </div>

        ${data.unconfirmed !== 0 ? `
          <div class="bds-unconfirmed bds-mono">
            <span>Unconfirmed</span>
            <span>${data.unconfirmed > 0 ? '+' : ''}${fmtBtc(data.unconfirmed)} BTC (${fmtUsd(data.unconfirmed_value)})</span>
          </div>
        ` : ''}

        <div class="bds-grid">
          <div class="bds-stat-cell">
            <div class="bds-stat-label">Total received</div>
            <div class="bds-stat-value bds-mono">${fmtBtc(data.totalReceived)} BTC</div>
          </div>
          <div class="bds-stat-cell">
            <div class="bds-stat-label">Transactions</div>
            <div class="bds-stat-value bds-mono">${Number(data.txCount || 0).toLocaleString('en-US')}</div>
          </div>
        </div>
${renderWatchAction(data)}
      </div>
    `;
  }

  // Userscript build: no background worker to store the address, so point to the extension instead.
  function renderWatchAction(data) {
    const addr = escapeHTML(data.address);
    if (isExtension) {
      return `
        <button type="button" class="bds-btn ${data.isWatched ? 'is-watched' : ''}" id="bdsWatchBtn" data-address="${addr}">
          ${data.isWatched ? '✓ Monitored in extension' : 'Monitor this address in extension'}
        </button>`;
    }
    return `
        <a class="bds-btn" href="https://bitcoindata.science/browser-extension" target="_blank" rel="noreferrer">
          Monitor this address with the browser extension ↗
        </a>`;
  }

  function renderTxCard(data) {
    const txid = escapeHTML(data.txid);
    const statusLabel = data.confirmed
      ? `Confirmed${data.blockHeight ? ` #${Number(data.blockHeight).toLocaleString('en-US')}` : ''}`
      : 'Unconfirmed';
    const timeStr = data.confirmed && data.blockTime
      ? new Date(data.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      : '';

    const renderIoRows = items => items.slice(0, 25).map(item => {
      const label = item.isCoinbase || item.isOpReturn
        ? escapeHTML(item.label)
        : escapeHTML(shortStr(item.address, 8));
      const fullTitle = escapeHTML(item.address || item.label || '');
      const valText = item.value !== null && item.value !== undefined
        ? `${fmtBtc(item.value)} BTC<span class="bds-io-usd">${fmtUsd(item.valueUsd)}</span>`
        : '';
      return `
        <div class="bds-io-row bds-mono">
          <span class="bds-io-addr" title="${fullTitle}">${label}</span>
          <span class="bds-io-amt">${valText}</span>
        </div>`;
    }).join('');

    return `
      <div class="bds-header catbg3">
        <a class="bds-brand" href="https://bitcoindata.science" target="_blank" rel="noreferrer">
          <span><span class="bds-brand-accent">bitcoindata</span>.science</span>
        </a>
        <span class="bds-pill ${data.confirmed ? '' : 'warn'}">${escapeHTML(statusLabel)}</span>
      </div>

      <div class="bds-body">
        <div class="bds-id-row bds-mono">
          <span class="bds-id-text" title="${txid}">${escapeHTML(shortStr(data.txid, 11))}</span>
          <span class="bds-actions">
            <button type="button" class="bds-icon-btn" data-copy="${txid}">Copy</button>
            <a class="bds-icon-btn" href="https://mempool.space/tx/${txid}" target="_blank" rel="noreferrer" title="Open on mempool.space">mempool ↗</a>
          </span>
        </div>

        <div class="bds-balance-box">
          <div class="bds-main-val bds-mono">${fmtBtc(data.totalOut)} <span class="bds-unit">BTC</span></div>
          <div class="bds-sub-val">${fmtUsd(data.totalOutUsd)}</div>
        </div>

        <div class="bds-grid">
          <div class="bds-stat-cell">
            <div class="bds-stat-label">Fee</div>
            <div class="bds-stat-value bds-mono">${fmtBtc(data.fee)} BTC (${fmtUsd(data.feeUsd)})</div>
          </div>
          <div class="bds-stat-cell">
            <div class="bds-stat-label">Fee rate${timeStr ? ` · ${escapeHTML(timeStr.slice(0, 10))}` : ''}</div>
            <div class="bds-stat-value bds-mono">${data.feeRate} sat/vB (${data.vsize} vB)</div>
          </div>
        </div>

        <div class="bds-io-section">
          <div class="bds-io-title">Inputs (${data.inputs.length})</div>
          <div class="bds-io-list">${renderIoRows(data.inputs)}</div>
        </div>

        <div class="bds-io-section">
          <div class="bds-io-title">Outputs (${data.outputs.length})</div>
          <div class="bds-io-list">${renderIoRows(data.outputs)}</div>
        </div>
      </div>
    `;
  }

  function bindCardInteractions(card) {
    const copyBtn = card.querySelector('[data-copy]');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(copyBtn.dataset.copy);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      });
    }

    const watchBtn = card.querySelector('#bdsWatchBtn');
    if (watchBtn && !watchBtn.classList.contains('is-watched')) {
      watchBtn.addEventListener('click', () => {
        const address = watchBtn.dataset.address;
        watchBtn.classList.add('is-watched');
        watchBtn.textContent = '✓ Monitored in extension';
        ext.runtime.sendMessage({ type: 'watch-address', address });
      });
    }
  }

  // ─── Data lookups ────────────────────────────────────────────────────────
  // Short-lived cache for the userscript build (the extension caches in background.js).
  const directCache = { price: null, priceExpiresAt: 0, items: new Map() };

  async function getDirectPrice() {
    if (directCache.price && Date.now() < directCache.priceExpiresAt) return directCache.price;
    directCache.price = await BalanceAPI.getBtcPrice();
    directCache.priceExpiresAt = Date.now() + 120_000;
    return directCache.price;
  }

  async function lookup(type, id) {
    if (isExtension) {
      const msg = type === 'tx'
        ? { type: 'get-tx-details', txid: id }
        : { type: 'get-address-details', address: id };
      const response = await ext.runtime.sendMessage(msg);
      if (!response?.ok) throw new Error(response?.error || 'Could not load data');
      return response.data;
    }

    if (typeof BalanceAPI === 'undefined') throw new Error('BalanceAPI is not available');
    const key = `${type}:${id}`;
    const cached = directCache.items.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    const price = await getDirectPrice();
    const data = type === 'tx'
      ? await BalanceAPI.getTransactionDetails(id, price)
      : await BalanceAPI.getAddressDetails(id, price);
    directCache.items.set(key, { data, expiresAt: Date.now() + (type === 'tx' ? 60_000 : 45_000) });
    return data;
  }

  // ─── Hover state management ──────────────────────────────────────────────
  let showTimer = null;
  let hideTimer = null;
  let activeRequestId = 0;
  let currentTarget = null;

  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!cardEl) return;
      cardEl.classList.remove('is-visible');
      setTimeout(() => {
        if (cardEl && !cardEl.classList.contains('is-visible')) {
          cardEl.hidden = true;
          currentTarget = null;
        }
      }, 140);
    }, 220);
  }

  async function openForTarget(target) {
    const type = target.dataset.bdsType;
    const id = target.dataset.bdsId;
    if (!type || !id) return;

    const reqId = ++activeRequestId;
    const rect = target.getBoundingClientRect();
    const card = ensurePopover();

    card.innerHTML = `
      <div class="bds-header catbg3">
        <span class="bds-brand"><span class="bds-brand-accent">bitcoindata</span>.science</span>
        <span class="bds-pill">${type === 'tx' ? 'Transaction' : 'Address'}</span>
      </div>
      <div class="bds-loading">
        <span class="bds-spinner"></span>
        <span>Loading ${type === 'tx' ? 'transaction details' : 'address balance'}…</span>
      </div>
    `;
    card.hidden = false;
    positionCard(rect);
    requestAnimationFrame(() => card.classList.add('is-visible'));

    try {
      const data = await lookup(type, id);
      if (reqId !== activeRequestId) return;

      card.innerHTML = type === 'tx'
        ? renderTxCard(data)
        : renderAddressCard(data);
      bindCardInteractions(card);
      positionCard(target.getBoundingClientRect());
    } catch (error) {
      if (reqId !== activeRequestId) return;
      card.innerHTML = `
        <div class="bds-header catbg3">
          <span class="bds-brand"><span class="bds-brand-accent">bitcoindata</span>.science</span>
          <span class="bds-pill warn">Error</span>
        </div>
        <div class="bds-error">Could not load data from mempool.space.</div>
      `;
    }
  }

  document.addEventListener('mouseover', event => {
    const target = event.target.closest?.('[data-bds-type]');
    if (!target) return;

    clearTimeout(hideTimer);
    if (target === currentTarget && cardEl && !cardEl.hidden) return;

    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      currentTarget = target;
      openForTarget(target);
    }, 180);
  });

  document.addEventListener('mouseout', event => {
    const target = event.target.closest?.('[data-bds-type]');
    if (!target) return;
    if (event.relatedTarget && target.contains(event.relatedTarget)) return;
    scheduleHide();
  });

  // Initial scan + observe dynamically previewed content
  scanPage();
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.id === 'bds-hover-root' || node.classList?.contains('bds-hover-target')) continue;
        if (SKIP_TAGS.has(node.tagName)) continue;
        annotateContainer(node);
      }
    }
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
