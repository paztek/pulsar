#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'assets/pulsar.icns');
const target = path.join(
  root,
  'node_modules/node-notifier/vendor/mac.noindex/terminal-notifier.app/Contents/Resources/Terminal.icns'
);
const appBundle = path.join(
  root,
  'node_modules/node-notifier/vendor/mac.noindex/terminal-notifier.app'
);

if (!fs.existsSync(src)) {
  console.log(`[install-icon] source not found at ${src} — skipping`);
  process.exit(0);
}
if (!fs.existsSync(path.dirname(target))) {
  // Non-macOS or node-notifier not present yet.
  console.log(`[install-icon] terminal-notifier vendor dir not found — skipping`);
  process.exit(0);
}

fs.copyFileSync(src, target);
// Bump the app bundle's mtime so macOS refreshes the cached icon next launch.
const now = new Date();
fs.utimesSync(appBundle, now, now);
console.log(`[install-icon] installed pulsar.icns into terminal-notifier.app`);
