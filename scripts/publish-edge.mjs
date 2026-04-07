#!/usr/bin/env node

import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { response, body: parsed, text, headers: response.headers };
}

function operationIdFromLocation(location) {
  if (!location) return '';
  const parts = String(location).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

const zipPath = process.argv[2];
if (!zipPath) fail('Usage: publish-edge.mjs <zip-path>');

const productId = process.env.EDGE_PRODUCT_ID;
const clientId = process.env.EDGE_CLIENT_ID;
const apiKey = process.env.EDGE_API_KEY;
if (!productId || !clientId || !apiKey) {
  fail('Missing EDGE_PRODUCT_ID, EDGE_CLIENT_ID, or EDGE_API_KEY');
}

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const manifestVersion = normalizeVersion(manifest.version);
if (!manifestVersion) fail('manifest.json is missing a version field');

const headers = {
  Authorization: `ApiKey ${apiKey}`,
  'X-ClientID': clientId,
  'Content-Type': 'application/zip',
};

const baseUrl = 'https://api.addons.microsoftedge.microsoft.com/v1';
const uploadUrl = `${baseUrl}/products/${productId}/submissions/draft/package`;
const zipBytes = readFileSync(zipPath);

const upload = await requestJson(uploadUrl, {
  method: 'POST',
  headers,
  body: zipBytes,
});

if (upload.response.status !== 202 && !upload.response.ok) {
  fail(`Edge upload failed: ${upload.response.status} ${upload.text}`);
}

let uploadOperationId = operationIdFromLocation(upload.headers.get('location'));
if (!uploadOperationId) {
  fail('Edge upload did not return an operation id');
}

const uploadStatusUrl = `${baseUrl}/products/${productId}/submissions/draft/package/operations/${uploadOperationId}`;
let uploadStatus = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const status = await requestJson(uploadStatusUrl, {
    method: 'GET',
    headers,
  });
  if (!status.response.ok && status.response.status !== 202) {
    fail(`Edge upload status failed: ${status.response.status} ${status.text}`);
  }
  uploadStatus = status.body;
  if (uploadStatus?.status === 'Failed') {
    fail(`Edge upload failed: ${JSON.stringify(uploadStatus)}`);
  }
  if (uploadStatus?.status === 'Succeeded') break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (uploadStatus?.status === 'InProgress') {
  fail('Edge upload is still in progress after waiting');
}

if (uploadStatus?.status && uploadStatus.status !== 'Succeeded') {
  fail(`Edge upload did not succeed: ${JSON.stringify(uploadStatus)}`);
}

const publishUrl = `${baseUrl}/products/${productId}/submissions`;
const publish = await requestJson(publishUrl, {
  method: 'POST',
  headers: {
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
  },
  body: `Release v${manifestVersion}`,
});

if (publish.response.status !== 202 && !publish.response.ok) {
  fail(`Edge publish failed: ${publish.response.status} ${publish.text}`);
}

const publishOperationId = operationIdFromLocation(publish.headers.get('location'));
if (!publishOperationId) {
  fail('Edge publish did not return an operation id');
}

const publishStatusUrl = `${baseUrl}/products/${productId}/submissions/operations/${publishOperationId}`;
let publishStatus = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const status = await requestJson(publishStatusUrl, {
    method: 'GET',
    headers,
  });
  if (!status.response.ok && status.response.status !== 202) {
    fail(`Edge publish status failed: ${status.response.status} ${status.text}`);
  }
  publishStatus = status.body;
  if (publishStatus?.status === 'Failed') {
    fail(`Edge publish failed: ${JSON.stringify(publishStatus)}`);
  }
  if (publishStatus?.status === 'Succeeded') break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (publishStatus?.status === 'InProgress') {
  fail('Edge publish is still in progress after waiting');
}

if (publishStatus?.status && publishStatus.status !== 'Succeeded') {
  fail(`Edge publish did not succeed: ${JSON.stringify(publishStatus)}`);
}

console.log(`Microsoft Edge Add-ons update submitted for v${manifestVersion}`);
