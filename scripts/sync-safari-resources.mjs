#!/usr/bin/env node
// Sync shared runtime files from the repo root into the Safari extension.
// Run with --check for a read-only preflight suitable for builds and CI.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions, syncVersions } from './sync-versions.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultResources = resolve(defaultRoot, 'safari/Downlink/Downlink Extension/Resources');

// Copied from the repository root. JavaScript files additionally get a UTF-8
// BOM prepended: Safari misdecodes extension JavaScript source files that do
// not start with a BOM (WebKit treats them as Western Latin-1), which garbles
// Chinese string literals in background/content scripts (Safari feedback
// FB23657149). Non-JavaScript files are kept byte-identical.
export const SHARED_FILES = Object.freeze([
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
  'aria2-tasks.html',
  'aria2-tasks.js',
  'aria2-settings.html',
  'aria2-settings.js',
  'aria2-create-task.html',
  'aria2-create-task.js',
  'LICENSE',
  'lib/background-shared.js',
  'lib/background-downloaders.js',
  'lib/background-media.js',
  'lib/config-defaults.js',
  'lib/aria2-rpc.js',
  'lib/downloader-picker.js',
  'lib/i18n.js',
  'lib/popup-ui.js',
  'lib/popup-settings.js',
]);

// Replaced wholesale during sync and required to have exactly the same tree.
export const SHARED_DIRECTORIES = Object.freeze([
  'icons',
  '_locales',
  'assets',
]);

// Owned by Safari. Sync never copies their content; it only prepends the
// UTF-8 BOM when a JavaScript file is missing it (same encoding invariant as
// shared JavaScript files).
export const SAFARI_ONLY_FILES = Object.freeze([
  'background.js',
  'dnr-capture.html',
  'dnr-capture.js',
  'manifest.json',
  'popup.js',
]);

// Finder metadata is neither shipped nor considered part of shared resource state.
export const IGNORED_SHARED_RESOURCE_NAMES = Object.freeze([
  '.DS_Store',
]);

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function isJavaScriptFile(filePath) {
  return /\.js$/i.test(filePath);
}

function withSafariUtf8Bom(sourceBytes) {
  if (sourceBytes.length >= 3 && sourceBytes.subarray(0, 3).equals(UTF8_BOM)) {
    return sourceBytes;
  }
  return Buffer.concat([UTF8_BOM, sourceBytes]);
}

function displayPath(rootDir, path) {
  return relative(rootDir, path) || '.';
}

function isIgnoredSharedResource(path) {
  return IGNORED_SHARED_RESOURCE_NAMES.includes(basename(path));
}

function requireResourcesDirectory(resourcesDir) {
  if (!existsSync(resourcesDir) || !statSync(resourcesDir).isDirectory()) {
    throw new Error(`[safari-sync] Resources dir not found: ${resourcesDir}`);
  }
}

function collectDirectoryEntries(base, current = base, entries = new Map()) {
  if (!existsSync(current)) return entries;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (IGNORED_SHARED_RESOURCE_NAMES.includes(entry.name)) continue;
    const absolutePath = resolve(current, entry.name);
    const entryPath = relative(base, absolutePath);
    if (entry.isDirectory()) {
      entries.set(`${entryPath}/`, { type: 'directory', path: absolutePath });
      collectDirectoryEntries(base, absolutePath, entries);
    } else if (entry.isFile()) {
      entries.set(entryPath, { type: 'file', path: absolutePath });
    } else {
      entries.set(entryPath, { type: 'other', path: absolutePath });
    }
  }
  return entries;
}

function compareFile(src, dst, label, issues) {
  if (!existsSync(src)) {
    issues.push(`shared source missing: ${label}`);
    return;
  }
  if (!statSync(src).isFile()) {
    issues.push(`shared source is not a file: ${label}`);
    return;
  }
  if (!existsSync(dst)) {
    issues.push(`Safari shared resource missing: ${label}`);
    return;
  }
  if (!statSync(dst).isFile()) {
    issues.push(`Safari shared resource is not a file: ${label}`);
    return;
  }
  const sourceBytes = readFileSync(src);
  const expected = isJavaScriptFile(dst) ? withSafariUtf8Bom(sourceBytes) : sourceBytes;
  if (!expected.equals(readFileSync(dst))) {
    issues.push(`shared resource differs: ${label}`);
  }
}

function compareDirectory(src, dst, label, issues) {
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    issues.push(`shared source directory missing: ${label}/`);
    return;
  }
  if (!existsSync(dst) || !statSync(dst).isDirectory()) {
    issues.push(`Safari shared directory missing: ${label}/`);
    return;
  }

  const sourceEntries = collectDirectoryEntries(src);
  const safariEntries = collectDirectoryEntries(dst);
  const entryNames = [...new Set([...sourceEntries.keys(), ...safariEntries.keys()])].sort();
  for (const entryName of entryNames) {
    const sourceEntry = sourceEntries.get(entryName);
    const safariEntry = safariEntries.get(entryName);
    const resourcePath = `${label}/${entryName}`;
    if (!sourceEntry) {
      issues.push(`unexpected Safari shared resource: ${resourcePath}`);
    } else if (!safariEntry) {
      issues.push(`Safari shared resource missing: ${resourcePath}`);
    } else if (sourceEntry.type !== safariEntry.type) {
      issues.push(`shared resource type differs: ${resourcePath}`);
    } else if (sourceEntry.type === 'file') {
      const sourceBytes = readFileSync(sourceEntry.path);
      const expected = isJavaScriptFile(entryName)
        ? withSafariUtf8Bom(sourceBytes)
        : sourceBytes;
      if (!expected.equals(readFileSync(safariEntry.path))) {
        issues.push(`shared resource differs: ${resourcePath}`);
      }
    }
  }
}

function safariOnlyIssues(resourcesDir, safariOnlyFiles) {
  const issues = [];
  for (const file of safariOnlyFiles) {
    const path = resolve(resourcesDir, file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      issues.push(`Safari-only resource missing: ${file}`);
    }
  }
  return issues;
}

function safariJavaScriptBomIssues(resourcesDir) {
  const issues = [];
  const entries = collectDirectoryEntries(resourcesDir);
  for (const [entryPath, entry] of entries) {
    if (entry.type !== 'file' || !isJavaScriptFile(entryPath)) continue;
    const bytes = readFileSync(entry.path);
    const hasBom = bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM);
    if (!hasBom) issues.push(`Safari JavaScript file missing UTF-8 BOM: ${entryPath}`);
  }
  return issues;
}

function normalizeSafariJavaScriptBoms(resourcesDir) {
  const entries = collectDirectoryEntries(resourcesDir);
  for (const [entryPath, entry] of entries) {
    if (entry.type !== 'file' || !isJavaScriptFile(entryPath)) continue;
    const bytes = readFileSync(entry.path);
    const normalized = withSafariUtf8Bom(bytes);
    if (!normalized.equals(bytes)) {
      writeFileSync(entry.path, normalized);
      console.log(`[safari-sync] UTF-8 BOM added: ${entryPath}`);
    }
  }
}

function syncInputIssues(rootDir, resourcesDir, sharedFiles, sharedDirectories, safariOnlyFiles) {
  const issues = safariOnlyIssues(resourcesDir, safariOnlyFiles);
  for (const file of sharedFiles) {
    const source = resolve(rootDir, file);
    if (!existsSync(source) || !statSync(source).isFile()) {
      issues.push(`shared source missing: ${file}`);
    }
  }
  for (const directory of sharedDirectories) {
    const source = resolve(rootDir, directory);
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      issues.push(`shared source directory missing: ${directory}/`);
    }
  }
  return issues;
}

export function getSafariResourceDrift({
  rootDir = defaultRoot,
  resourcesDir = resolve(rootDir, 'safari/Downlink/Downlink Extension/Resources'),
  sharedFiles = SHARED_FILES,
  sharedDirectories = SHARED_DIRECTORIES,
  safariOnlyFiles = SAFARI_ONLY_FILES,
} = {}) {
  requireResourcesDirectory(resourcesDir);
  const issues = safariOnlyIssues(resourcesDir, safariOnlyFiles);
  issues.push(...safariJavaScriptBomIssues(resourcesDir));

  for (const file of sharedFiles) {
    compareFile(resolve(rootDir, file), resolve(resourcesDir, file), file, issues);
  }
  for (const directory of sharedDirectories) {
    compareDirectory(
      resolve(rootDir, directory),
      resolve(resourcesDir, directory),
      directory,
      issues,
    );
  }
  return issues;
}

export function checkSafariResources(options = {}) {
  const rootDir = options.rootDir || defaultRoot;
  const issues = [];

  try {
    checkVersions({ rootDir, quiet: true });
  } catch (error) {
    issues.push(error.message);
  }
  try {
    issues.push(...getSafariResourceDrift(options));
  } catch (error) {
    issues.push(error.message);
  }

  if (issues.length > 0) {
    throw new Error(
      `[safari-sync] preflight failed:\n${issues.map((issue) => `  - ${issue.replace(/\n/g, '\n    ')}`).join('\n')}`
      + '\nRun "npm run safari:sync" to repair version and shared resource drift.',
    );
  }

  console.log('[safari-sync] preflight passed: versions and shared resources are in sync');
}

function copyFile(rootDir, resourcesDir, file) {
  const src = resolve(rootDir, file);
  const dst = resolve(resourcesDir, file);
  if (!existsSync(src) || !statSync(src).isFile()) {
    throw new Error(`[safari-sync] shared source missing: ${displayPath(rootDir, src)}`);
  }
  mkdirSync(dirname(dst), { recursive: true });
  const sourceBytes = readFileSync(src);
  if (isJavaScriptFile(file)) {
    writeFileSync(dst, withSafariUtf8Bom(sourceBytes));
  } else {
    cpSync(src, dst);
  }
  console.log(`[safari-sync] ${file} → ${displayPath(rootDir, dst)}`);
}

function syncDirectory(rootDir, resourcesDir, directory) {
  const src = resolve(rootDir, directory);
  const dst = resolve(resourcesDir, directory);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`[safari-sync] shared source directory missing: ${directory}/`);
  }
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, {
    recursive: true,
    filter: (source) => !isIgnoredSharedResource(source),
  });
  console.log(`[safari-sync] dir ${directory}/ synced`);
}

export function syncSafariResources({
  rootDir = defaultRoot,
  resourcesDir = resolve(rootDir, 'safari/Downlink/Downlink Extension/Resources'),
  sharedFiles = SHARED_FILES,
  sharedDirectories = SHARED_DIRECTORIES,
  safariOnlyFiles = SAFARI_ONLY_FILES,
} = {}) {
  requireResourcesDirectory(resourcesDir);
  const inputIssues = syncInputIssues(
    rootDir,
    resourcesDir,
    sharedFiles,
    sharedDirectories,
    safariOnlyFiles,
  );
  if (inputIssues.length > 0) {
    throw new Error(`[safari-sync] input validation failed:\n${inputIssues.map((issue) => `  - ${issue}`).join('\n')}`);
  }

  console.log('=== Safari resources sync ===');
  syncVersions({ rootDir });
  for (const file of sharedFiles) copyFile(rootDir, resourcesDir, file);
  for (const directory of sharedDirectories) syncDirectory(rootDir, resourcesDir, directory);
  normalizeSafariJavaScriptBoms(resourcesDir);
  console.log('=== sync done (Safari-specific resources preserved; version synchronized; UTF-8 BOM enforced on JavaScript files) ===');
}

function printResourceOwnership() {
  console.log('Shared files:');
  for (const file of SHARED_FILES) console.log(`  ${file}`);
  console.log('Shared directories:');
  for (const directory of SHARED_DIRECTORIES) console.log(`  ${directory}/`);
  console.log('Safari-only files:');
  for (const file of SAFARI_ONLY_FILES) console.log(`  ${file}`);
}

function runCli(args) {
  const knownArguments = new Set(['--check', '--list']);
  const unknownArguments = args.filter((arg) => !knownArguments.has(arg));
  if (unknownArguments.length > 0) {
    throw new Error(`[safari-sync] unknown argument: ${unknownArguments.join(', ')}`);
  }
  if (args.includes('--list')) printResourceOwnership();
  if (args.includes('--list') && args.length === 1) return;
  if (args.includes('--check')) checkSafariResources();
  else syncSafariResources({ resourcesDir: defaultResources });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
