#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

const xpiPath = process.argv[2];
const outputPath = process.argv[3];
if (!xpiPath || !outputPath) {
  fail('Usage: generate-firefox-update-manifest.mjs <xpi-path> <output-path>');
}
if (!existsSync(xpiPath)) fail(`Firefox XPI not found: ${xpiPath}`);

const firefoxManifestPath = new URL('../dist/firefox/manifest.json', import.meta.url);
if (!existsSync(firefoxManifestPath)) {
  fail('Firefox build manifest not found. Run package-extension.mjs firefox --no-zip before generating updates.');
}

const manifest = JSON.parse(readFileSync(firefoxManifestPath, 'utf8'));
const version = normalizeVersion(manifest.version);
if (!version) fail('manifest.json is missing a version field');

const tagName = process.env.RELEASE_TAG || `v${version}`;
if (normalizeVersion(tagName) !== version) {
  fail(`Tag version (${tagName}) does not match manifest version (${version})`);
}

const owner = process.env.GITHUB_REPOSITORY_OWNER || '007ayong';
const repository = process.env.GITHUB_REPOSITORY || `${owner}/Downlink`;
const xpiName = `downlink-v${version}-firefox.xpi`;
const xpiUrl = `https://github.com/${repository}/releases/download/${tagName}/${xpiName}`;
const xpiBytes = readFileSync(xpiPath);
const updateHash = createHash('sha256').update(xpiBytes).digest('hex');

const gecko = manifest.browser_specific_settings?.gecko || {};
const addonId = gecko.id || 'downlink@winapps.cc';
const updateManifest = {
  addons: {
    [addonId]: {
      updates: [
        {
          version,
          update_link: xpiUrl,
          update_hash: `sha256:${updateHash}`,
        },
      ],
    },
  },
};

if (gecko.strict_min_version) {
  updateManifest.addons[addonId].updates[0].applications = {
    gecko: {
      strict_min_version: gecko.strict_min_version,
    },
  };
}

mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(updateManifest, null, 2)}\n`);
console.log(outputPath);
