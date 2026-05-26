#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

function runZip(args) {
  const result = spawnSync('zip', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(output || `zip ${args.join(' ')} failed`);
  }
}

const repoRoot = process.cwd();
const manifestPath = resolve(repoRoot, 'manifest.json');
if (!existsSync(manifestPath)) fail('manifest.json not found');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const manifestVersion = normalizeVersion(manifest.version);
if (!manifestVersion) fail('manifest.json is missing a version field');

const releaseTag = normalizeVersion(process.env.RELEASE_TAG || process.argv[2] || '');
if (releaseTag && /^\d/.test(releaseTag) && releaseTag !== manifestVersion) {
  fail(`Tag version (${releaseTag}) does not match manifest version (${manifestVersion})`);
}

const outputName = `downlink-v${manifestVersion}.zip`;
const outputPath = resolve(repoRoot, 'dist', outputName);
mkdirSync(dirname(outputPath), { recursive: true });

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
  'preview.html',
  'preview.js',
  'LICENSE',
  '_locales',
  'lib',
  'assets',
  'icons',
];

rmSync(outputPath, { force: true });
runZip([
  '-qr',
  outputPath,
  ...archivePaths,
  '-x',
  '*.DS_Store',
  'assets/chrome-support.png',
  'assets/edge-support.png',
]);

console.log(relative(repoRoot, outputPath));
