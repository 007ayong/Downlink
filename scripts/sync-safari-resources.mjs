#!/usr/bin/env node
// Sync shared runtime files from repo root into the Safari Xcode extension Resources.
// Safari-specific overrides (background.js, manifest.json and popup.js) are
// intentionally NOT overwritten.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = resolve(root, 'safari/DownlinkSafariTest/DownlinkSafariTest Extension/Resources');

if (!existsSync(resources)) {
  console.error(`[safari-sync] Resources dir not found: ${resources}`);
  process.exit(1);
}

// Files copied verbatim from repo root → Resources (kept in sync with main build)
const rootFiles = [
  'filename-logic.js',
  'content-script.js',
  'popup-app.js',
  'popup.html',
  'preview.html',
  'preview.js',
  'gopeed-open.html',
  'gopeed-open.js',
  'motrix-open.html',
  'motrix-open.js',
  'LICENSE',
];

// lib/* are shared modules; copied verbatim
const libFiles = [
  'background-shared.js',
  'background-downloaders.js',
  'background-media.js',
  'config-defaults.js',
  'i18n.js',
  'popup-ui.js',
  'popup-settings.js',
];

// Safari-specific files that MUST NOT be overwritten by sync
const safariOnly = new Set([
  'background.js',     // Safari 专用后台逻辑
  'manifest.json',     // Safari 专用 manifest（含 downloads 权限）
  'popup.js',          // Safari 专用 popup 逻辑
]);

// Directories synced wholesale from root (icons, _locales, assets)
const sharedDirs = ['icons', '_locales', 'assets'];

function copyFile(src, dst) {
  if (!existsSync(src)) { console.warn(`[safari-sync] skip missing: ${src}`); return; }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  console.log(`[safari-sync] ${src.replace(root + '/', '')} → ${dst.replace(root + '/', '')}`);
}

function syncDir(name) {
  const src = resolve(root, name);
  const dst = resolve(resources, name);
  if (!existsSync(src)) { console.warn(`[safari-sync] skip missing dir: ${src}`); return; }
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log(`[safari-sync] dir ${name}/ synced`);
}

function verifySafariOnly() {
  for (const f of safariOnly) {
    const p = resolve(resources, f);
    if (!existsSync(p)) console.warn(`[safari-sync] WARNING: Safari-only file missing (will need manual restore): ${f}`);
  }
}

console.log('=== Safari resources sync ===');
verifySafariOnly();
for (const f of rootFiles) copyFile(resolve(root, f), resolve(resources, f));
for (const f of libFiles) copyFile(resolve(root, 'lib', f), resolve(resources, 'lib', f));
for (const d of sharedDirs) syncDir(d);
console.log('=== sync done (Safari-specific files preserved) ===');
