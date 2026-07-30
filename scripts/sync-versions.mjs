#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function versionPaths(rootDir) {
  return {
    rootManifestPath: resolve(rootDir, 'manifest.json'),
    packageJsonPath: resolve(rootDir, 'package.json'),
    safariManifestPath: resolve(rootDir, 'safari/Downlink/Downlink Extension/Resources/manifest.json'),
    xcodeProjectPath: resolve(rootDir, 'safari/Downlink/Downlink.xcodeproj/project.pbxproj'),
  };
}

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`[version-sync] ${label} not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function canonicalVersion(rootManifestPath) {
  const rootManifest = readJson(rootManifestPath, 'Root manifest');
  const version = String(rootManifest.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`[version-sync] Root manifest version must be MAJOR.MINOR.PATCH, got: ${version || '(empty)'}`);
  }
  return version;
}

function xcodeVersionIssues(project, version) {
  const expectedBuildNumber = version.split('.').at(-1);
  const marketingVersions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((match) => match[1].trim());
  const buildNumbers = [...project.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map((match) => match[1].trim());
  const issues = [];

  if (marketingVersions.length === 0) {
    issues.push('Xcode project has no MARKETING_VERSION setting');
  } else if (marketingVersions.some((value) => value !== version)) {
    issues.push(`Xcode MARKETING_VERSION is ${[...new Set(marketingVersions)].join(', ')}, expected ${version}`);
  }

  if (buildNumbers.length === 0) {
    issues.push('Xcode project has no CURRENT_PROJECT_VERSION setting');
  } else if (buildNumbers.some((value) => value !== expectedBuildNumber)) {
    issues.push(`Xcode CURRENT_PROJECT_VERSION is ${[...new Set(buildNumbers)].join(', ')}, expected ${expectedBuildNumber}`);
  }

  return issues;
}

export function getVersionDrift({ rootDir = defaultRoot } = {}) {
  const {
    rootManifestPath,
    packageJsonPath,
    safariManifestPath,
    xcodeProjectPath,
  } = versionPaths(rootDir);
  const version = canonicalVersion(rootManifestPath);
  const issues = [];

  const packageJson = readJson(packageJsonPath, 'package.json');
  if (packageJson.version !== version) {
    issues.push(`package.json version is ${packageJson.version || '(empty)'}, expected ${version}`);
  }

  const safariManifest = readJson(safariManifestPath, 'Safari manifest');
  if (safariManifest.version !== version) {
    issues.push(`Safari manifest version is ${safariManifest.version || '(empty)'}, expected ${version}`);
  }

  if (!existsSync(xcodeProjectPath)) {
    throw new Error(`[version-sync] Xcode project not found: ${xcodeProjectPath}`);
  }
  issues.push(...xcodeVersionIssues(readFileSync(xcodeProjectPath, 'utf8'), version));

  return { version, issues };
}

export function checkVersions({ rootDir = defaultRoot, quiet = false } = {}) {
  const { version, issues } = getVersionDrift({ rootDir });
  if (issues.length > 0) {
    throw new Error(`[version-sync] version drift detected:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
  }
  if (!quiet) console.log(`[version-sync] versions match ${version}`);
  return version;
}

export function syncVersions({ quiet = false, rootDir = defaultRoot, checkOnly = false } = {}) {
  if (checkOnly) return checkVersions({ rootDir, quiet });

  const {
    rootManifestPath,
    packageJsonPath,
    safariManifestPath,
    xcodeProjectPath,
  } = versionPaths(rootDir);
  const version = canonicalVersion(rootManifestPath);

  const packageJson = readJson(packageJsonPath, 'package.json');
  const safariManifest = readJson(safariManifestPath, 'Safari manifest');
  if (!existsSync(xcodeProjectPath)) throw new Error(`[version-sync] Xcode project not found: ${xcodeProjectPath}`);
  const buildNumber = version.split('.').at(-1);
  const project = readFileSync(xcodeProjectPath, 'utf8');
  const unsupportedProjectIssues = xcodeVersionIssues(project, version)
    .filter((issue) => issue.includes('has no '));
  if (unsupportedProjectIssues.length > 0) {
    throw new Error(`[version-sync] cannot synchronize Xcode project:\n${unsupportedProjectIssues.map((issue) => `  - ${issue}`).join('\n')}`);
  }
  const updatedProject = project
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`);

  // All inputs are readable and synchronizable before the first write occurs.
  if (packageJson.version !== version) {
    packageJson.version = version;
    writeJson(packageJsonPath, packageJson);
    if (!quiet) console.log(`[version-sync] package.json version → ${version}`);
  }

  if (safariManifest.version !== version) {
    safariManifest.version = version;
    writeJson(safariManifestPath, safariManifest);
    if (!quiet) console.log(`[version-sync] Safari extension version → ${version}`);
  }

  if (updatedProject !== project) {
    writeFileSync(xcodeProjectPath, updatedProject);
    if (!quiet) console.log(`[version-sync] Xcode app version → ${version} (${buildNumber})`);
  }

  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    syncVersions({ checkOnly: process.argv.slice(2).includes('--check') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
