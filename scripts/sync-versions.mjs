#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootManifestPath = resolve(root, 'manifest.json');
const packageJsonPath = resolve(root, 'package.json');
const safariManifestPath = resolve(root, 'safari/DownlinkSafariTest/DownlinkSafariTest Extension/Resources/manifest.json');
const xcodeProjectPath = resolve(root, 'safari/DownlinkSafariTest/DownlinkSafariTest.xcodeproj/project.pbxproj');

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`[version-sync] ${label} not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function syncVersions({ quiet = false } = {}) {
  const rootManifest = readJson(rootManifestPath, 'Root manifest');
  const version = String(rootManifest.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`[version-sync] Root manifest version must be MAJOR.MINOR.PATCH, got: ${version || '(empty)'}`);
  }

  const packageJson = readJson(packageJsonPath, 'package.json');
  if (packageJson.version !== version) {
    packageJson.version = version;
    writeJson(packageJsonPath, packageJson);
    if (!quiet) console.log(`[version-sync] package.json version → ${version}`);
  }

  const safariManifest = readJson(safariManifestPath, 'Safari manifest');
  if (safariManifest.version !== version) {
    safariManifest.version = version;
    writeJson(safariManifestPath, safariManifest);
    if (!quiet) console.log(`[version-sync] Safari extension version → ${version}`);
  }

  if (!existsSync(xcodeProjectPath)) throw new Error(`[version-sync] Xcode project not found: ${xcodeProjectPath}`);
  const buildNumber = version.split('.').at(-1);
  const project = readFileSync(xcodeProjectPath, 'utf8');
  const updatedProject = project
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`);
  if (updatedProject !== project) {
    writeFileSync(xcodeProjectPath, updatedProject);
    if (!quiet) console.log(`[version-sync] Xcode app version → ${version} (${buildNumber})`);
  }

  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncVersions();
}
