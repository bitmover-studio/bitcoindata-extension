# bitcoindata Browser Extension

[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](manifest.json)
[![Website](https://img.shields.io/badge/Website-bitcoindata.science-26b2a0)](https://bitcoindata.science)

**bitcoindata** is an open-source browser extension for [Bitcointalk.org](https://bitcointalk.org) and [AltcoinsTalks.com](https://www.altcoinstalks.com) powered by [bitcoindata.science](https://bitcoindata.science) and [mempool.space](https://mempool.space).

It brings live Bitcoin blockchain intelligence directly into forum pages, adds one-click BBCode image generators to the forum post editor, and provides a lightweight Bitcoin address monitor in your browser's toolbar popup and sidebar.

---

## Key Features

### 1. Native Forum Hover Cards (Addresses & Transactions)
Hover over any Bitcoin address (`1...`, `3...`, `bc1q...`, `bc1p...`) or 64-character transaction ID (`TXID`) on **Bitcointalk** or **AltcoinsTalks**—across threads, user profile pages, personal messages, and signatures:
- **Address Hover Card:** Displays confirmed BTC balance, live USD value, unconfirmed mempool balance, total BTC received, transaction count, a one-click **Copy** button, a direct **mempool.space ↗** link, and a button to monitor the address in the extension.
- **Transaction Hover Card:** Displays confirmation status & block height, total output value in BTC and USD, transaction fee & fee rate (`sat/vB`), virtual size (`vB`), and a scrollable breakdown of **Inputs** and **Outputs** (including Coinbase and decoded `OP_RETURN` messages).
- **Classic Forum Styling:** Styled with Bitcointalk's native SMF `.catbg3` header and `.windowbg` palette inside an isolated Shadow DOM so it feels like a built-in forum feature.

### 2. Forum Post Editor BBCode Toolbar
When composing or replying to a post on `bitcointalk.org` or `altcoinstalks.com`, the extension injects a toolbar right above the message editor to insert dynamic, auto-updating BBCode images from the [bitcoindata.science Image API](https://bitcoindata.science/bitcointalk-api):
- **₿ Price** — Live Bitcoin price in any fiat currency.
- **Fiat Price** — Fiat amount converted to BTC.
- **Address Balance** — Live balance of any Bitcoin address.
- **Transaction** — Visual summary of any Bitcoin transaction (`TXID`).
- **Fees** — Recommended mempool fee rates (`sat/vB`).
- **Customization Controls:** Choose from 160+ fiat currencies, pick any hex text color, and toggle bold text before inserting the `[img]` tag.

### 3. Popup & Sidebar Address Monitor
Open the extension as a compact **toolbar popup** or dock it in your **browser sidebar** (`sidePanel` in Chrome/Edge/Brave, `sidebarAction` in Firefox):
- **Live BTC/USD Ticker:** Instant Bitcoin spot price on the Home tab.
- **Single-Address Monitor:** Keep track of a Bitcoin address with confirmed/unconfirmed balances, total received, and transaction count.
- **Background Notifications:** Optional 20-minute background checks (`alarms` + `notifications`) alert you with a native OS notification and toolbar badge whenever a new incoming or outgoing transaction is detected—even when all forum tabs are closed.
- **Batch Lookup Link:** Need to check up to 465 addresses at once, scan QR codes, or export CSV/JSON? Jump straight to the full [Balance Checker on bitcoindata.science](https://bitcoindata.science/bitcoin-balance-check).

### 4. Right-Click Context Menu on Any Webpage
Highlight any Bitcoin address or right-click an address link on **any website**:
- **Check balance in bitcoindata sidebar** — Opens the sidebar and checks the selected address immediately.
- **Monitor address in bitcoindata** — Sets the address as your monitored address in the background and shows a desktop notification with its current BTC and USD balance.

---

## Privacy & Security

- **100% Local Storage:** Your monitored Bitcoin address and preferences are stored exclusively in your browser (`storage.local`). Nothing is ever sent to or stored on a server.
- **Direct Public API Queries:** Blockchain data is fetched directly from `https://mempool.space/api` (with `api.blockcypher.com` as fallback) and price data from `https://bitcoindata.science/api/priceusd.json`.
- **No Analytics or Tracking:** Zero third-party trackers, telemetry, or external scripts.

---

## Installation

### Official Store Releases
- **Mozilla Firefox & Tor Browser:** [Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/bitcointalk-data-extension/)
- **Microsoft Edge / Chromium:** [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/bitcointalk-data-extensio/gcndngnnhncdblgfcbgefmhginmmjfde)
- **Userscript (post toolbar only):** [Greasy Fork](https://greasyfork.org/en/scripts/488031-bitcoindata-extension)

### Load Unpacked (Developer Mode)
1. Clone or download this repository:
   ```bash
   git clone https://github.com/bitmover-studio/bitcoindata-extension.git
   ```
2. **Chrome / Edge / Brave:**
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** and select the `bitcoindata-extension` folder.
3. **Firefox:**
   - Open `about:debugging#/runtime/this-firefox`
   - Click **Load Temporary Add-on…** and select `manifest.json`.

---

## Project Structure

```text
bitcoindata-extension/
├── manifest.json              # Manifest V3 configuration (Chrome & Firefox)
├── main.html                  # Popup & sidebar UI
├── background.js              # Background worker (alarms, notifications, context menus, hover cache)
├── components/
│   ├── balance-api.js         # Blockchain & price API client + storage helpers
│   ├── main.js                # Popup & sidebar UI controller
│   ├── darkmode.js            # Theme initialization & popup/sidebar detection
│   ├── buttons.js             # Bitcointalk & AltcoinsTalks post editor toolbar
│   └── forum-hover.js         # On-page address & transaction hover cards
├── css/
│   ├── style.css              # bitcoindata.science design system
│   └── extension.css          # Extension-specific layout overrides
├── modules/
│   └── bootstrap.min.css      # Bundled Bootstrap 5.3 CSS
├── userscript/
│   ├── build-userscript.js    # Bundles forum scripts into a single userscript
│   └── bitcoindata.user.js    # Standalone Greasy Fork / Tampermonkey userscript
└── icons/                     # Extension icons & SVG brand assets
```

### Building the Userscript

Whenever you modify `components/balance-api.js`, `components/buttons.js`, or `components/forum-hover.js`, regenerate `userscript/bitcoindata.user.js` for Greasy Fork with:

```bash
node userscript/build-userscript.js
```

---

## Community & Support

- **Bitcointalk Announcement Thread:** [Bitcointalk ANN](https://bitcointalk.org/index.php?topic=5485996.msg63701109#msg63701109)
- **Documentation & Web Tools:** [bitcoindata.science](https://bitcoindata.science)
- **Support the Project:** [bitcoindata.science/donate](https://bitcoindata.science/donate)

---

## License

Released under the [MIT License](LICENSE). Copyright (c) 2024–2026 [bitmover](https://bitcoindata.science).
