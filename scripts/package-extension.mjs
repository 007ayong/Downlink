#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncVersions } from './sync-versions.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

function runZip(args, cwd = repoRoot) {
  const result = spawnSync('zip', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(output || `zip ${args.join(' ')} failed`);
  }
}

const repoRoot = process.cwd();
syncVersions({ quiet: true });
const manifestPath = resolve(repoRoot, 'manifest.json');
if (!existsSync(manifestPath)) fail('manifest.json not found');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const manifestVersion = normalizeVersion(manifest.version);
if (!manifestVersion) fail('manifest.json is missing a version field');

const supportedTargets = new Set(['chromium', 'firefox', 'all']);
const supportedFlags = new Set(['--watch', '--no-zip']);
const argValues = process.argv.slice(2);
const positionalArgs = [];
for (const value of argValues) {
  if (value.startsWith('-')) {
    if (!supportedFlags.has(value)) {
      fail(`Unknown option: ${value}`);
    }
    continue;
  }
  positionalArgs.push(value);
}

const targetArgs = positionalArgs.filter((value) => supportedTargets.has(value));
if (targetArgs.length > 1) {
  fail(`Expected at most one target (${[...supportedTargets].join(', ')})`);
}

const releaseTagArgs = positionalArgs.filter((value) => !supportedTargets.has(value));
if (releaseTagArgs.length > 1) {
  fail(`Expected at most one release tag, got: ${releaseTagArgs.join(', ')}`);
}
if (releaseTagArgs[0] && !/^v?\d/.test(releaseTagArgs[0])) {
  fail(`Unknown target or release tag: ${releaseTagArgs[0]}`);
}

const target = targetArgs[0] || 'chromium';
const watchMode = argValues.includes('--watch');
const skipZip = argValues.includes('--no-zip');
const releaseTagArg = releaseTagArgs[0] || '';
const releaseTag = normalizeVersion(process.env.RELEASE_TAG || releaseTagArg || '');
if (releaseTag && /^\d/.test(releaseTag) && releaseTag !== manifestVersion) {
  fail(`Tag version (${releaseTag}) does not match manifest version (${manifestVersion})`);
}
const buildTargets = target === 'all' ? ['chromium', 'firefox'] : [target];
const firefoxAddonId = String(process.env.FIREFOX_ADDON_ID || 'downlink@winapps.cc').trim();
if (!firefoxAddonId) {
  fail('FIREFOX_ADDON_ID must not be empty');
}
const firefoxUpdateUrl = String(process.env.FIREFOX_UPDATE_URL || '').trim();
if (firefoxUpdateUrl && !firefoxUpdateUrl.startsWith('https://')) {
  fail('FIREFOX_UPDATE_URL must start with https://');
}

function manifestForTarget(baseManifest, buildTarget) {
  if (buildTarget !== 'firefox') return baseManifest;
  const geckoSettings = {
    id: firefoxAddonId,
    strict_min_version: '113.0',
    data_collection_permissions: {
      required: ['none'],
    },
  };
  if (firefoxUpdateUrl) {
    geckoSettings.update_url = firefoxUpdateUrl;
  }
  return {
    ...baseManifest,
    permissions: [...new Set([...(baseManifest.permissions || []), 'webRequestBlocking'])],
    host_permissions: [
      'http://*/*',
      'https://*/*',
      '*://127.0.0.1/*',
      '*://localhost/*',
      'ws://127.0.0.1/*',
      'ws://localhost/*',
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
    background: {
      scripts: [
        'filename-logic.js',
        'lib/config-defaults.js',
        'lib/i18n.js',
        'lib/background-shared.js',
        'lib/background-downloaders.js',
        'lib/background-media.js',
        'background.js',
      ],
    },
    browser_specific_settings: {
      gecko: geckoSettings,
    },
  };
}

function prepareBuildDir(buildTarget) {
  const buildDir = resolve(repoRoot, 'dist', buildTarget);
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  for (const archivePath of archivePaths) {
    if (archivePath === 'manifest.json') continue;
    cpSync(resolve(repoRoot, archivePath), resolve(buildDir, archivePath), { recursive: true });
  }
  writeFileSync(
    resolve(buildDir, 'manifest.json'),
    `${JSON.stringify(manifestForTarget(manifest, buildTarget), null, 2)}\n`
  );
  return buildDir;
}

const archivePaths = [
  'manifest.json',
  'background.js',
  'content-script.js',
  'filename-logic.js',
  'popup.html',
  'popup.js',
  'popup-app.js',
  'motrix-open.html',
  'motrix-open.js',
  'gopeed-open.html',
  'gopeed-open.js',
  'preview.html',
  'preview.js',
  'LICENSE',
  '_locales',
  'lib',
  'assets',
  'icons',
];

function outputPathForTarget(buildTarget) {
  const outputName = `downlink-v${manifestVersion}-${buildTarget}.zip`;
  return resolve(repoRoot, 'dist', outputName);
}

function legacyOutputPathsForTarget(buildTarget) {
  if (buildTarget === 'chromium') return [resolve(repoRoot, 'dist', `downlink-v${manifestVersion}.zip`)];
  if (buildTarget === 'firefox') return [resolve(repoRoot, 'dist', `downlink-v${manifestVersion}-${buildTarget}.xpi`)];
  return [];
}

function buildOnce({ quiet = false } = {}) {
  const resultPaths = [];
  for (const buildTarget of buildTargets) {
    const outputPath = outputPathForTarget(buildTarget);
    mkdirSync(dirname(outputPath), { recursive: true });
    if (!skipZip) {
      rmSync(outputPath, { force: true });
      for (const legacyOutputPath of legacyOutputPathsForTarget(buildTarget)) {
        rmSync(legacyOutputPath, { force: true });
      }
    }
    const buildDir = prepareBuildDir(buildTarget);
    if (skipZip) {
      resultPaths.push(buildDir);
      continue;
    }
    runZip([
      '-qr',
      outputPath,
      '.',
      '-x',
      '*.DS_Store',
      'assets/chrome-support.png',
      'assets/edge-support.png',
      'assets/firefox-support.png',
    ], buildDir);
    resultPaths.push(outputPath);
  }
  if (!quiet) {
    for (const resultPath of resultPaths) console.log(relative(repoRoot, resultPath));
  }
  return resultPaths;
}

function startWatch() {
  let timer = null;
  let watchedPaths = new Set();
  const outputSummary = buildTargets
    .map((buildTarget) => relative(repoRoot, resolve(repoRoot, 'dist', buildTarget)))
    .join(', ');
  console.log(`[dev] watching extension sources; output: ${outputSummary}`);
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        buildOnce({ quiet: true });
        refreshWatchers();
        console.log(`[dev] rebuilt ${outputSummary}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }, 100);
  };

  const refreshWatchers = () => {
    const nextWatchedPaths = collectAllWatchPaths();
    for (const sourcePath of watchedPaths) {
      if (!nextWatchedPaths.has(sourcePath)) unwatchFile(sourcePath);
    }
    for (const sourcePath of nextWatchedPaths) {
      if (watchedPaths.has(sourcePath)) continue;
      watchFile(sourcePath, { interval: 500 }, (current, previous) => {
        if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) rebuild();
      });
    }
    watchedPaths = nextWatchedPaths;
  };

  refreshWatchers();
}

function collectAllWatchPaths() {
  const watchedPaths = new Set();
  for (const archivePath of archivePaths) {
    const sourcePath = resolve(repoRoot, archivePath);
    if (!existsSync(sourcePath)) continue;
    collectWatchPaths(sourcePath, watchedPaths);
  }
  return watchedPaths;
}

function collectWatchPaths(sourcePath, watchedPaths) {
  watchedPaths.add(sourcePath);
  if (!statSync(sourcePath).isDirectory()) return;
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    collectWatchPaths(resolve(sourcePath, entry.name), watchedPaths);
  }
}

buildOnce();
if (watchMode) startWatch();
