#!/usr/bin/env node
// Packages clean store-ready ZIP archives for Firefox AMO and Microsoft Edge Add-ons.
// Usage: node userscript/build-packages.js
//
// Why a custom ZIP writer instead of Windows Compress-Archive?
// Windows PowerShell Compress-Archive writes backslash (\) path separators inside ZIP headers,
// which Firefox AMO's validator rejects. This script always writes standard POSIX (/) paths,
// puts manifest.json at the archive root, and excludes .git/, dist/, and userscript/.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const baseManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const VERSION = baseManifest.version || '0.3';

// Files and folders to include in the extension package
const INCLUDE_FILES = [
  'manifest.json',
  'background.js',
  'main.html',
  'LICENSE',
  'README.md',
];

const INCLUDE_DIRS = [
  'components',
  'css',
  'icons',
  'modules',
];

// ─── Minimal CRC32 + PKZIP writer (zero external dependencies) ───────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const rawData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(rawData);
    const deflated = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = deflated.length < rawData.length;
    const compData = useDeflate ? deflated : rawData;
    const method = useDeflate ? 8 : 0;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);     // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);     // compression method
    localHeader.writeUInt16LE(0, 10);         // mod time
    localHeader.writeUInt16LE(0x5421, 12);    // mod date
    localHeader.writeUInt32LE(crc, 14);       // crc32
    localHeader.writeUInt32LE(compData.length, 18); // compressed size
    localHeader.writeUInt32LE(rawData.length, 22);  // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);  // filename length
    localHeader.writeUInt16LE(0, 28);         // extra field length

    localParts.push(localHeader, nameBuf, compData);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);         // version made by
    centralHeader.writeUInt16LE(20, 6);         // version needed
    centralHeader.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);    // compression method
    centralHeader.writeUInt16LE(0, 12);         // mod time
    centralHeader.writeUInt16LE(0x5421, 14);    // mod date
    centralHeader.writeUInt32LE(crc, 16);       // crc32
    centralHeader.writeUInt32LE(compData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // extra length
    centralHeader.writeUInt16LE(0, 32);         // comment length
    centralHeader.writeUInt16LE(0, 34);         // disk number
    centralHeader.writeUInt16LE(0, 36);         // internal attrs
    centralHeader.writeUInt32LE(0, 38);         // external attrs
    centralHeader.writeUInt32LE(offset, 42);    // local header offset

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compData.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);            // EOCD signature
  eocd.writeUInt16LE(0, 4);                     // disk number
  eocd.writeUInt16LE(0, 6);                     // central dir disk
  eocd.writeUInt16LE(entries.length, 8);        // entries on disk
  eocd.writeUInt16LE(entries.length, 10);       // total entries
  eocd.writeUInt32LE(centralSize, 12);          // central dir size
  eocd.writeUInt32LE(offset, 16);               // central dir offset
  eocd.writeUInt16LE(0, 20);                    // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function collectDirFiles(relDir) {
  const results = [];
  const absDir = path.join(ROOT, relDir);
  for (const item of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = path.posix.join(relDir.replace(/\\/g, '/'), item.name);
    if (item.isDirectory()) {
      results.push(...collectDirFiles(relPath));
    } else if (item.isFile()) {
      results.push({
        name: relPath,
        data: fs.readFileSync(path.join(ROOT, relPath)),
      });
    }
  }
  return results;
}

function buildEntries(manifestObj) {
  const entries = [];
  for (const file of INCLUDE_FILES) {
    if (file === 'manifest.json') {
      entries.push({
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify(manifestObj, null, 4) + '\n', 'utf8'),
      });
    } else {
      entries.push({
        name: file,
        data: fs.readFileSync(path.join(ROOT, file)),
      });
    }
  }
  for (const dir of INCLUDE_DIRS) {
    entries.push(...collectDirFiles(dir));
  }
  return entries;
}

// 1. Firefox AMO manifest (uses background.scripts + sidebar_action + gecko ID; strips Chrome-only sidePanel)
const firefoxManifest = JSON.parse(JSON.stringify(baseManifest));
firefoxManifest.permissions = firefoxManifest.permissions.filter(p => p !== 'sidePanel');
delete firefoxManifest.side_panel;
delete firefoxManifest.background.service_worker;

// 2. Microsoft Edge / Chromium manifest (uses background.service_worker + side_panel; strips Firefox-only keys)
const edgeManifest = JSON.parse(JSON.stringify(baseManifest));
delete edgeManifest.browser_specific_settings;
delete edgeManifest.sidebar_action;
delete edgeManifest.background.scripts;

fs.mkdirSync(DIST_DIR, { recursive: true });

const targets = [
  { filename: `bitcoindata-firefox-v${VERSION}.zip`, manifest: firefoxManifest },
  { filename: `bitcoindata-edge-v${VERSION}.zip`, manifest: edgeManifest },
];

for (const target of targets) {
  const entries = buildEntries(target.manifest);
  const zipBuf = createZipBuffer(entries);
  const outPath = path.join(DIST_DIR, target.filename);
  fs.writeFileSync(outPath, zipBuf);
  console.log(`Built dist/${target.filename} (${entries.length} files, ${(zipBuf.length / 1024).toFixed(1)} KB)`);
}
