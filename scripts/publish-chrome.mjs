#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/, '');
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessToken(serviceAccountJson, scope) {
  const credentials = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    iss: credentials.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = base64UrlEncode(signer.sign(credentials.private_key));
  const assertion = `${header}.${payload}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    fail(`Chrome OAuth token request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  if (!data.access_token) fail('Chrome OAuth token response did not include access_token');
  return data.access_token;
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
  return { response, body: parsed, text };
}

const zipPath = process.argv[2];
if (!zipPath) fail('Usage: publish-chrome.mjs <zip-path>');

const publisherId = process.env.CHROME_PUBLISHER_ID;
const extensionId = process.env.CHROME_EXTENSION_ID;
const serviceAccountJson = process.env.CHROME_SERVICE_ACCOUNT_JSON;
if (!publisherId || !extensionId || !serviceAccountJson) {
  fail('Missing CHROME_PUBLISHER_ID, CHROME_EXTENSION_ID, or CHROME_SERVICE_ACCOUNT_JSON');
}

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const manifestVersion = normalizeVersion(manifest.version);
if (!manifestVersion) fail('manifest.json is missing a version field');

const token = await getAccessToken(
  serviceAccountJson,
  'https://www.googleapis.com/auth/chromewebstore'
);

const uploadUrl = `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisherId}/items/${extensionId}:upload`;
const zipBytes = readFileSync(zipPath);
const upload = await requestJson(uploadUrl, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/zip',
  },
  body: zipBytes,
});

if (!upload.response.ok && upload.response.status !== 202) {
  fail(`Chrome upload failed: ${upload.response.status} ${upload.text}`);
}

const statusUrl = `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}:fetchStatus`;
let statusData = upload.body;
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (statusData?.uploadState && statusData.uploadState !== 'UPLOAD_IN_PROGRESS') break;
  if (attempt > 0 || !statusData?.uploadState) {
    const status = await requestJson(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!status.response.ok) {
      fail(`Chrome upload status check failed: ${status.response.status} ${status.text}`);
    }
    statusData = status.body;
    if (statusData?.uploadState && statusData.uploadState !== 'UPLOAD_IN_PROGRESS') break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (statusData?.uploadState === 'UPLOAD_IN_PROGRESS') {
  fail('Chrome upload is still in progress after waiting');
}

if (statusData?.uploadState && !['SUCCESS', 'SUCCEEDED', 'OK'].includes(statusData.uploadState)) {
  fail(`Chrome upload did not succeed: ${JSON.stringify(statusData)}`);
}

const publishUrl = `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}:publish`;
const publish = await requestJson(publishUrl, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

if (!publish.response.ok && publish.response.status !== 202) {
  fail(`Chrome publish failed: ${publish.response.status} ${publish.text}`);
}

console.log(`Chrome Web Store update submitted for v${manifestVersion}`);
