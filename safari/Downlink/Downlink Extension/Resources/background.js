// background.js — Downlink Service Worker
// 拆分为：基础工具 / 下载器适配 / 事件注册

const PROBE_LOG_KEY = 'downlinkSafariProbeLogs';
let probeLogWritePromise = Promise.resolve();

function readProbeLogs() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (stored) => {
      if (settled) return;
      settled = true;
      resolve(Array.isArray(stored?.[PROBE_LOG_KEY]) ? stored[PROBE_LOG_KEY] : []);
    };
    try {
      const result = chrome.storage.local.get({ [PROBE_LOG_KEY]: [] }, finish);
      result?.then?.(finish).catch?.(() => finish({}));
    } catch {
      finish({});
    }
  });
}

function persistProbeLogs(logs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const result = chrome.storage.local.set({ [PROBE_LOG_KEY]: logs }, finish);
      result?.then?.(finish).catch?.(finish);
      if (!result && chrome.runtime?.lastError) finish();
    } catch {
      finish();
    }
  });
}

function writeProbeLog(message, data = {}) {
  const entry = { time: new Date().toISOString(), message, data };
  console.log(`[Downlink Safari probe] ${message}`, data);
  probeLogWritePromise = probeLogWritePromise
    .catch(() => {})
    .then(async () => {
      const previous = await readProbeLogs();
      await persistProbeLogs([...previous.slice(-99), entry]);
    })
    .catch((error) => {
    console.error('[Downlink Safari probe] failed to persist log', error);
    });
}

self.addEventListener('error', (event) => {
  writeProbeLog('top-level error', { message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno, error: event.error?.stack || String(event.error || '') });
});
self.addEventListener('unhandledrejection', (event) => {
  writeProbeLog('unhandledrejection', { reason: event.reason?.stack || String(event.reason || '') });
});

writeProbeLog('background script start');

if (!globalThis.ConfigDefaults || !globalThis.BackgroundShared || !globalThis.BackgroundDownloaders || !globalThis.BackgroundMedia) {
  try {
    importScripts(
      'filename-logic.js',
      'lib/config-defaults.js',
      'lib/i18n.js',
      'lib/background-shared.js',
      'lib/background-downloaders.js',
      'lib/background-media.js'
    );
    writeProbeLog('importScripts fallback ok');
  } catch (error) {
    writeProbeLog('importScripts fallback failed', { message: error?.message || String(error), stack: error?.stack || '' });
  }
} else {
  writeProbeLog('manifest background dependencies ready');
}
const {
  LEGACY_DEFAULT_CAPTURE_EXTENSIONS,
  DEFAULT_CAPTURE_EXTENSIONS,
} = globalThis.ConfigDefaults;
const DEFAULT_MEDIA_SNIFFING_BLACKLIST = 'x.com,youtube.com';
const DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST = 'web.telegram.org';
const CONFIG_STORAGE_AREA_KEY = '__downlinkConfigStorageArea';

const DEFAULT_CONFIG = {
  language: 'auto',
  downloaderType: 'aria2',
  aria2Rpc: 'http://localhost:6800/jsonrpc',
  aria2Secret: '',
  aria2Silent: false,
  aria2CustomSaveEnabled: false,
  aria2SaveLocations: [],
  useMotrixNext: false,
  motrixNextPort: '16801',
  motrixNextSecret: '',
  gopeedApi: 'http://127.0.0.1:9999',
  gopeedToken: '',
  gopeedSilent: false,
  externalLauncherName: 'AB DM',
  externalLauncherHost: 'localhost',
  externalLauncherPort: '15151',
  externalLauncherPath: '/start-headless-download',
  abDownloadSilent: false,
  autoCapture: true,
  mediaSniffingBlacklist: DEFAULT_MEDIA_SNIFFING_BLACKLIST,
  downloadInterceptionBlacklist: DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST,
  captureExtensions: DEFAULT_CAPTURE_EXTENSIONS,
  captureMime: true,
};
const MACOS_TAG_COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#8e8e93'];
const i18n = globalThis.Localization || {};
const t = i18n.t || ((key, substitutions, fallback = key) => {
  if (fallback && substitutions !== undefined) {
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
  }
  return fallback || key;
});

const shared = globalThis.BackgroundShared;
const downloaders = globalThis.BackgroundDownloaders;
const mediaModule = globalThis.BackgroundMedia;

const {
  cleanExpired,
  classifyDownloadCandidate,
  decodeHttpFilename,
  deriveOrigin,
  dirname,
  extOf,
  fallbackMediaFilename,
  filenameFromCD,
  filenameFromUrl,
  isDirectMediaResource,
  isLowQualityFilename,
  sanitizeFilenamePart,
} = shared;

let config = { ...DEFAULT_CONFIG };
let tasks = {};
let pendingDownloads = {};
let hiddenTaskGids = {};
let uiAlert = null;
let taskSurfaceOpenPromise = null;
let taskFallbackWindowOpenPromise = null;
let taskFallbackWindowId = null;
let autoCaptureTogglePromise = Promise.resolve();
const autoCapturePausedTabs = new Set();
const mediaBlacklistBlockedTabs = new Set();

const markedUrls = new Map();
const downloadClickIntents = new Map();
const responseCaptureClaims = new Map();
const pendingBrowserDownloadCaptures = new Map();
const requestHeadersCache = new Map();
const responseHeadersCache = new Map();
const redirectIntents = new Map();
const dnrNavigationCandidates = new Map();
const dnrRedirectBridgeNavigations = new Map();
const safariCommittedTabPages = new Map();
const safariCreatedNavigationSources = new Map();
const safariUrlCaptureClaims = new Map();
const safariDnrBypassRules = new Map();
const SAFARI_DOWNLOAD_REDIRECT_RULE_IDS = Array.from({ length: 100 }, (_, index) => 80000001 + index);
const SAFARI_DOWNLOAD_BYPASS_RULE_ID_BASE = 81000000;
const SAFARI_DOWNLOAD_ENDPOINT_REDIRECT_PATTERNS = [];
const SAFARI_NATIVE_APP_ID = 'cc.winapps.downlink';
const SAFARI_LOCAL_BRIDGE_KEEPALIVE_MS = 5000;
const EXTERNAL_LAUNCHER_TIMEOUT_MS = 3000;
let safariLocalBridgeUrl = '';
let safariLocalBridgeStartPromise = null;
let safariLocalBridgeKeepaliveTimer = null;
let activeConfigStorageArea = '';
let contextMenuRefreshVersion = 0;
const backgroundSessionStartedAt = Date.now();
const RESTORED_DOWNLOAD_GRACE_MS = 5000;
function getRuntimeLastErrorMessage() {
  try {
    return chrome.runtime?.lastError?.message || '';
  } catch {
    return '';
  }
}

function storageGet(area, defaults) {
  return new Promise((resolve, reject) => {
    if (!area?.get) {
      reject(new Error('storage area unavailable'));
      return;
    }
    try {
      const result = area.get(defaults, (stored) => {
        const error = getRuntimeLastErrorMessage();
        if (error) reject(new Error(error));
        else resolve(stored || {});
      });
      if (result && typeof result.then === 'function') {
        result.then((stored) => resolve(stored || {})).catch(reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function storageSet(area, values) {
  return new Promise((resolve, reject) => {
    if (!area?.set) {
      reject(new Error('storage area unavailable'));
      return;
    }
    try {
      const result = area.set(values, () => {
        const error = getRuntimeLastErrorMessage();
        if (error) reject(new Error(error));
        else resolve();
      });
      if (result && typeof result.then === 'function') {
        result.then(resolve).catch(reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function cookiesGetAll(details) {
  return new Promise((resolve) => {
    if (!chrome.cookies?.getAll) {
      resolve([]);
      return;
    }
    let settled = false;
    const finish = (cookies) => {
      if (settled) return;
      settled = true;
      resolve(Array.isArray(cookies) ? cookies : []);
    };
    try {
      const result = chrome.cookies.getAll(details, (cookies) => {
        if (getRuntimeLastErrorMessage()) finish([]);
        else finish(cookies);
      });
      if (result && typeof result.then === 'function') result.then(finish).catch(() => finish([]));
    } catch {
      finish([]);
    }
  });
}

async function getCookieHeaderForUrl(url = '') {
  if (!/^https?:\/\//i.test(String(url || ''))) return '';
  const cookies = await cookiesGetAll({ url });
  return cookies
    .filter((cookie) => cookie?.name)
    .sort((left, right) => String(right.path || '/').length - String(left.path || '/').length)
    .map((cookie) => `${cookie.name}=${cookie.value || ''}`)
    .join('; ');
}

async function loadStoredConfig() {
  let localStored = {};
  try {
    localStored = await storageGet(chrome.storage.local, {});
  } catch {}

  if (localStored?.[CONFIG_STORAGE_AREA_KEY] === 'local') {
    activeConfigStorageArea = 'local';
    const { [CONFIG_STORAGE_AREA_KEY]: _storageArea, ...localConfig } = localStored;
    return { ...DEFAULT_CONFIG, ...localConfig };
  }

  try {
    const syncStored = await storageGet(chrome.storage.sync, {});
    const { [CONFIG_STORAGE_AREA_KEY]: _storageArea, ...localConfig } = localStored || {};
    const hasLocalConfig = Object.keys(DEFAULT_CONFIG).some((key) => Object.prototype.hasOwnProperty.call(localConfig, key));
    const hasSyncConfig = Object.keys(DEFAULT_CONFIG).some((key) => Object.prototype.hasOwnProperty.call(syncStored, key));
    if (localStored?.[CONFIG_STORAGE_AREA_KEY] === 'sync') {
      activeConfigStorageArea = 'sync';
      return { ...DEFAULT_CONFIG, ...(hasSyncConfig ? syncStored : (hasLocalConfig ? localConfig : {})) };
    }
    if (hasSyncConfig) {
      activeConfigStorageArea = 'sync';
      return { ...DEFAULT_CONFIG, ...syncStored };
    }

    // Older builds did not persist which storage area won. If sync is empty
    // but local contains config values, preserve that local fallback state.
    activeConfigStorageArea = hasLocalConfig ? 'local' : 'sync';
    return hasLocalConfig ? { ...DEFAULT_CONFIG, ...localConfig } : { ...DEFAULT_CONFIG };
  } catch {
    // A sync-backed profile may temporarily be unreadable. Use its local
    // cache now, but keep listening to sync so recovery or another-device
    // update is not ignored. A later failed save explicitly switches the
    // marker to local.
    activeConfigStorageArea = localStored?.[CONFIG_STORAGE_AREA_KEY] === 'sync' ? 'sync' : 'local';
    const { [CONFIG_STORAGE_AREA_KEY]: _storageArea, ...localConfig } = localStored || {};
    return { ...DEFAULT_CONFIG, ...localConfig };
  }
}

function loadStoredConfigCallback(callback) {
  loadStoredConfig().then(callback).catch(() => callback(DEFAULT_CONFIG));
}

async function saveStoredConfig(nextConfig) {
  try {
    await storageSet(chrome.storage.sync, nextConfig);
    activeConfigStorageArea = 'sync';
    // Keep a local cache so a temporarily unavailable sync store does not
    // reset the extension to defaults on the next Safari launch.
    await storageSet(chrome.storage.local, {
      ...nextConfig,
      [CONFIG_STORAGE_AREA_KEY]: 'sync',
    }).catch(() => {});
    return 'sync';
  } catch {
    activeConfigStorageArea = 'local';
    await storageSet(chrome.storage.local, {
      ...nextConfig,
      [CONFIG_STORAGE_AREA_KEY]: 'local',
    });
    return 'local';
  }
}

function normalizeCaptureExtensionsConfig(value) {
  const normalized = String(value || '').replace(/\s+/g, '').toLowerCase();
  if (normalized === LEGACY_DEFAULT_CAPTURE_EXTENSIONS) return DEFAULT_CAPTURE_EXTENSIONS;
  return value;
}

function normalizeDomainBlacklist(value) {
  const entries = String(value || '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      if (entry === '*') return entry;
      try {
        return new URL(entry.includes('://') ? entry : `https://${entry}`).hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
      } catch {
        return entry.replace(/^\.+|\.+$/g, '').split('/')[0].split(':')[0];
      }
    })
    .filter(Boolean);
  return [...new Set(entries)].join(',');
}

function normalizeMediaSniffingBlacklist(value) {
  return normalizeDomainBlacklist(value);
}

function normalizeDownloadInterceptionBlacklist(value) {
  return normalizeDomainBlacklist(value);
}

function isUrlBlockedByDomainBlacklist(url, blacklistValue) {
  const blacklist = normalizeDomainBlacklist(blacklistValue);
  if (!blacklist) return false;
  const entries = blacklist.split(',');
  if (entries.includes('*')) return true;
  let hostname = '';
  try {
    hostname = new URL(String(url || '')).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return entries.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

function isMediaSniffingBlockedForUrl(url, nextConfig = config) {
  return isUrlBlockedByDomainBlacklist(url, nextConfig.mediaSniffingBlacklist);
}

function isDownloadInterceptionBlockedForUrl(url, nextConfig = config) {
  return isUrlBlockedByDomainBlacklist(url, nextConfig.downloadInterceptionBlacklist);
}

function isDownloadInterceptionBlockedForSource(...urls) {
  return urls.some((url) => isDownloadInterceptionBlockedForUrl(url, config));
}

function hostnameFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isBrowserLocalDownloadUrl(url = '') {
  try {
    return ['blob:', 'data:', 'filesystem:'].includes(new URL(String(url || '')).protocol);
  } catch {
    return /^(blob|data|filesystem):/i.test(String(url || ''));
  }
}

function buildSafariDownloadRedirectPatterns(nextConfig = config) {
  const configuredExtensions = String(nextConfig.captureExtensions || '')
    .split(',')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  const matchAnyExtension = !configuredExtensions.length || configuredExtensions.includes('*');
  const extensionPatterns = matchAnyExtension
    ? ['^(https?://[^/?#]+/[^?#]*\\.[a-zA-Z0-9]+(?:[?][^#]*)?)$']
    : configuredExtensions.map((extension) => {
      const escaped = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Capture the complete URL so regexSubstitution can carry it through
      // the loopback bridge even when DNR runs before webRequest observers.
      return `^(https?://[^/?#]+/[^?#]*\\.${escaped}(?:[?][^#]*)?)$`;
    });
  return [...SAFARI_DOWNLOAD_ENDPOINT_REDIRECT_PATTERNS, ...extensionPatterns];
}

function isSafariDnrDownloadCandidate(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    // Opaque /download, /downloads/redirect and /export endpoints may still
    // perform several redirects. Capturing them creates one task per hop.
    // Only a configured file suffix is a terminal DNR takeover candidate.
    const extension = parsed.pathname.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || '';
    if (!extension) return false;
    const configuredExtensions = String(config.captureExtensions || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    return !configuredExtensions.length || configuredExtensions.includes('*') || configuredExtensions.includes(extension);
  } catch {
    return false;
  }
}

function filenameFromSafariRedirectUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    const pathFilename = filenameFromUrl(parsed.href);
    const pathExtension = extOf(pathFilename).toLowerCase();
    if (!pathExtension) return '';

    let queryFilename = '';
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!['filename', 'file_name'].includes(key.toLowerCase())) continue;
      queryFilename = normalizeSourceFilename(value);
      if (queryFilename) break;
    }
    if (!queryFilename || isLowQualityFilename(queryFilename)) return '';

    const queryExtension = extOf(queryFilename).toLowerCase();
    if (!queryExtension || queryExtension !== pathExtension) return '';
    return queryFilename;
  } catch {
    return '';
  }
}

function isLanrarVerificationDownloadUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    const hostname = parsed.hostname.toLowerCase();
    return (hostname === 'lanrar.com' || hostname.endsWith('.lanrar.com')) &&
      /^\/file\/?$/i.test(parsed.pathname) &&
      parsed.search.length > 1;
  } catch {
    return false;
  }
}

function isValidSafariLocalBridgeUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Number(parsed.port) > 0 &&
      /^\/downlink-dnr\/[a-f0-9-]+$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function safariLocalBridgeTargetUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
        !/^\/downlink-dnr\/[a-f0-9-]+\/$/i.test(parsed.pathname)) return '';
    const targetUrl = parsed.hash.slice(1);
    return /^https?:\/\//i.test(targetUrl) ? targetUrl : '';
  } catch {
    return '';
  }
}

function safariLocalBridgeRequestTargetUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    if (!isValidSafariLocalBridgeUrl(`${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`)) return '';
    if (safariLocalBridgeUrl) {
      const activeBridge = new URL(safariLocalBridgeUrl);
      if (parsed.origin !== activeBridge.origin || parsed.pathname !== `${activeBridge.pathname}/`) return '';
    }
    const marker = '?url=';
    const serialized = String(value || '').split('#', 1)[0];
    const markerIndex = serialized.indexOf(marker);
    if (markerIndex < 0) return '';
    const carriedValue = serialized.slice(markerIndex + marker.length);
    let targetUrl = carriedValue;
    // Preserve percent-encoding inside an already serialized target URL. Only
    // decode when Safari encoded the entire scheme as a query value.
    if (/^https?%3a%2f%2f/i.test(carriedValue)) {
      try {
        targetUrl = decodeURIComponent(carriedValue);
      } catch {}
    }
    return /^https?:\/\//i.test(targetUrl) ? targetUrl : '';
  } catch {
    return '';
  }
}

function isValidSafariLocalBridgeMessageContext(senderUrl = '', targetUrl = '', candidate = null) {
  const senderTargetUrl = safariLocalBridgeTargetUrl(senderUrl);
  return Boolean(
    senderTargetUrl &&
    senderTargetUrl === targetUrl &&
    (!candidate || candidate.url === targetUrl)
  );
}

function isSafariLocalBridgeNavigationUrl(value = '') {
  return Boolean(safariLocalBridgeTargetUrl(value));
}

function isUsableSafariBridgeSourcePage(value = '', targetUrl = '') {
  const url = String(value || '');
  if (!/^https?:\/\//i.test(url) || url === targetUrl) return false;
  return !isSafariLocalBridgeNavigationUrl(url);
}

function rememberSafariCommittedPage(tabId, url = '', windowId) {
  if (typeof tabId !== 'number' || !isUsableSafariBridgeSourcePage(url) || isSafariDnrDownloadCandidate(url)) return false;
  safariCommittedTabPages.set(tabId, {
    sourcePageUrl: String(url),
    sourceTabId: tabId,
    sourceWindowId: typeof windowId === 'number' ? windowId : undefined,
  });
  return true;
}

function getSafariNavigationSource(tabId, targetUrl = '') {
  if (typeof tabId !== 'number') return {};
  cleanExpired(safariCreatedNavigationSources);
  const createdSource = safariCreatedNavigationSources.get(tabId);
  const committedSource = safariCommittedTabPages.get(tabId);
  const source = createdSource || committedSource || {};
  return {
    sourcePageUrl: isUsableSafariBridgeSourcePage(source.sourcePageUrl, targetUrl) ? source.sourcePageUrl : '',
    sourceTabId: typeof source.sourceTabId === 'number' ? source.sourceTabId : undefined,
    sourceWindowId: typeof source.sourceWindowId === 'number' ? source.sourceWindowId : undefined,
  };
}

function sendSafariNativeMessage(message = {}) {
  if (!chrome.runtime?.sendNativeMessage) return Promise.reject(new Error('native-messaging-unavailable'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (response, error = '') => {
      if (settled) return;
      settled = true;
      if (error) reject(new Error(error));
      else resolve(response);
    };
    try {
      const result = chrome.runtime.sendNativeMessage(SAFARI_NATIVE_APP_ID, message, (response) => {
        const error = getRuntimeLastErrorMessage();
        finish(response, error);
      });
      result?.then?.((response) => finish(response)).catch?.((error) => finish(null, error?.message || String(error)));
    } catch (error) {
      finish(null, error?.message || String(error));
    }
  });
}

function clearSafariDownloadRules() {
  return chrome.declarativeNetRequest?.updateSessionRules?.({
    removeRuleIds: SAFARI_DOWNLOAD_REDIRECT_RULE_IDS,
    addRules: [],
  }).catch(() => {});
}

function safariDnrBypassRuleId(tabId) {
  return SAFARI_DOWNLOAD_BYPASS_RULE_ID_BASE + (Math.abs(Number(tabId)) % 1000000);
}

async function clearSafariDnrBypassRule(tabId) {
  if (typeof tabId !== 'number' || !chrome.declarativeNetRequest?.updateSessionRules) return;
  const entry = safariDnrBypassRules.get(tabId);
  safariDnrBypassRules.delete(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [entry?.ruleId || safariDnrBypassRuleId(tabId)],
    addRules: [],
  }).catch(() => {});
}

async function installSafariDnrBypassRule(tabId, url = '') {
  if (typeof tabId !== 'number' || !/^https?:\/\//i.test(url) || !chrome.declarativeNetRequest?.updateSessionRules) {
    return false;
  }
  const ruleId = safariDnrBypassRuleId(tabId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 100,
        action: { type: 'allow' },
        condition: {
          // Keep the entire resumed redirect chain in Safari. Restricting the
          // rule to the first URL lets a terminal .zip/.exe redirect hit the
          // takeover rule again and creates a browser + Downlink duplicate.
          regexFilter: '^https?://',
          isUrlFilterCaseSensitive: false,
          resourceTypes: ['main_frame', 'other'],
          tabIds: [tabId],
        },
      }],
    });
    safariDnrBypassRules.set(tabId, { ruleId, url, expiresAt: Date.now() + 30000 });
    setTimeout(() => clearSafariDnrBypassRule(tabId).catch(() => {}), 30000);
    return true;
  } catch (error) {
    writeProbeLog('Safari DNR one-shot bypass rule installation failed', {
      tabId,
      url,
      message: error?.message || String(error),
    });
    return false;
  }
}

async function isSafariDnrBypassActive(tabId, url = '') {
  if (typeof tabId !== 'number' || !/^https?:\/\//i.test(url)) return false;
  const cached = safariDnrBypassRules.get(tabId);
  if (cached && cached.expiresAt > Date.now()) return true;
  if (!chrome.declarativeNetRequest?.getSessionRules) return false;
  const ruleId = safariDnrBypassRuleId(tabId);
  const rules = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
  const persisted = rules.find((rule) => rule.id === ruleId && rule.action?.type === 'allow');
  if (!persisted) return false;
  safariDnrBypassRules.set(tabId, { ruleId, url, expiresAt: Date.now() + 30000 });
  return true;
}

async function probeSafariLocalBridge(bridgeUrl = '') {
  if (!isValidSafariLocalBridgeUrl(bridgeUrl) || typeof fetch !== 'function') return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), 1000);
  try {
    const response = await fetch(`${bridgeUrl}/`, {
      cache: 'no-store',
      signal: controller?.signal,
    });
    return response.ok;
  } catch (error) {
    writeProbeLog('Safari local DNR bridge health check failed', {
      bridgeUrl,
      message: error?.message || String(error),
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function ensureSafariLocalBridge({ force = false } = {}) {
  if (!force && isValidSafariLocalBridgeUrl(safariLocalBridgeUrl)) return Promise.resolve(safariLocalBridgeUrl);
  if (safariLocalBridgeStartPromise) return safariLocalBridgeStartPromise;

  safariLocalBridgeStartPromise = Promise.race([
    sendSafariNativeMessage({ type: 'START_DNR_BRIDGE' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('native-bridge-timeout')), 2500)),
  ]).then(async (response) => {
    const bridgeUrl = String(response?.bridgeUrl || '');
    if (!response?.ok || !isValidSafariLocalBridgeUrl(bridgeUrl)) {
      throw new Error(response?.error || 'native-bridge-invalid-response');
    }
    if (!await probeSafariLocalBridge(bridgeUrl)) throw new Error('native-bridge-health-check-failed');
    safariLocalBridgeUrl = bridgeUrl;
    return bridgeUrl;
  }).catch((error) => {
    safariLocalBridgeUrl = '';
    writeProbeLog('Safari local DNR bridge unavailable', {
      message: error?.message || String(error),
    });
    return '';
  }).finally(() => {
    safariLocalBridgeStartPromise = null;
  });
  return safariLocalBridgeStartPromise;
}

function startSafariLocalBridgeKeepalive() {
  if (safariLocalBridgeKeepaliveTimer) return;
  safariLocalBridgeKeepaliveTimer = setInterval(async () => {
    if (!config.autoCapture) return;
    const previousUrl = safariLocalBridgeUrl;
    const bridgeUrl = await ensureSafariLocalBridge({ force: true });
    if (bridgeUrl && bridgeUrl === previousUrl) return;
    if (!bridgeUrl) {
      await clearSafariDownloadRules();
      return;
    }
    await installSafariDownloadRedirectRules();
  }, SAFARI_LOCAL_BRIDGE_KEEPALIVE_MS);
}

async function installSafariDownloadRedirectRules() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    writeProbeLog('DNR local bridge redirect unavailable');
    return false;
  }
  const bridgeUrl = config.autoCapture ? await ensureSafariLocalBridge() : '';
  const redirectPatterns = buildSafariDownloadRedirectPatterns();
  const supportedPatterns = [];
  for (let index = 0; index < redirectPatterns.length; index += 1) {
    const regexFilter = redirectPatterns[index];
    if (chrome.declarativeNetRequest.isRegexSupported) {
      try {
        const validation = await chrome.declarativeNetRequest.isRegexSupported({ regex: regexFilter });
        if (!validation?.isSupported) {
          writeProbeLog('DNR download regex unsupported', {
            ruleId: SAFARI_DOWNLOAD_REDIRECT_RULE_IDS[index],
            regexFilter,
            reason: validation?.reason || '',
          });
          continue;
        }
      } catch (error) {
        writeProbeLog('DNR download regex validation failed', {
          ruleId: SAFARI_DOWNLOAD_REDIRECT_RULE_IDS[index],
          message: error?.message || String(error),
        });
        continue;
      }
    }
    supportedPatterns.push({ index, regexFilter });
  }
  const addRules = config.autoCapture && bridgeUrl ? supportedPatterns.map(({ index, regexFilter }) => ({
    id: SAFARI_DOWNLOAD_REDIRECT_RULE_IDS[index],
    priority: 10,
    action: {
      type: 'redirect',
      // Keep the target in both the request query and document fragment. A
      // Safari download can be classified as `other`, in which case no bridge
      // document/content script exists; onSendHeaders reads the query instead.
      // Main-frame navigations continue to use the fragment confirmation.
      redirect: { regexSubstitution: `${bridgeUrl}/?url=\\1#\\1` },
    },
    condition: {
      regexFilter,
      isUrlFilterCaseSensitive: false,
      // Safari may reclassify a main-frame navigation as "other" after one or
      // more redirects when the response becomes a browser download.
      resourceTypes: ['main_frame', 'other'],
    },
  })) : [];
  try {
    // Clear legacy block/fixed-URL rules in a separate transaction. Safari
    // keeps the old rules when a combined remove+add update rejects a new
    // regexSubstitution rule.
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: SAFARI_DOWNLOAD_REDIRECT_RULE_IDS,
      addRules: [],
    });
    if (addRules.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [],
        addRules,
      });
    }
    let installedRules = [];
    if (chrome.declarativeNetRequest.getSessionRules) {
      installedRules = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
    }
    // Safari 26.3 rejects safari-web-extension:// as a main-frame redirect
    // destination and exposes an error page for block rules. A loopback-only
    // native HTTP server returns a blank 200 page that the content script can
    // consume, so Safari neither downloads nor exposes a blocker error page.
    writeProbeLog('DNR local bridge redirect rules installed', {
      ruleIds: addRules.map((rule) => rule.id),
      patterns: redirectPatterns,
      bridgeUrl,
      installedRedirects: installedRules
        .filter((rule) => SAFARI_DOWNLOAD_REDIRECT_RULE_IDS.includes(rule.id))
        .map((rule) => rule.action?.redirect || {}),
    });
    return true;
  } catch (error) {
    writeProbeLog('DNR local bridge redirect rule installation failed', {
      message: error?.message || String(error),
    });
    return false;
  }
}

function addHostnameToMediaSniffingBlacklist(value, hostname) {
  const current = String(value || '').trim();
  if (!hostname || normalizeMediaSniffingBlacklist(current).split(',').some((entry) => (
    entry === '*' || hostname === entry || hostname.endsWith(`.${entry}`)
  ))) return current;
  if (!current) return hostname;
  return /[\s,;]$/.test(current) ? `${current}${hostname}` : `${current},${hostname}`;
}

function removeHostnameFromMediaSniffingBlacklist(value, hostname) {
  if (!hostname) return String(value || '').trim();
  return String(value || '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      const normalized = normalizeMediaSniffingBlacklist(entry);
      return !(hostname === normalized || hostname.endsWith(`.${normalized}`));
    })
    .join(',');
}

function normalizeLocationColor(color = '') {
  const value = String(color || '').trim().toLowerCase();
  return MACOS_TAG_COLORS.includes(value) ? value : '#ff9500';
}

function normalizeAria2SaveLocations(locations = []) {
  if (!Array.isArray(locations)) return [];
  return locations
    .map((item) => ({
      name: String(item?.name || '').trim(),
      path: String(item?.path || '').trim(),
      color: normalizeLocationColor(item?.color),
    }))
    .filter((item) => item.name && item.path);
}

function normalizeConfig(nextConfig = {}) {
  const normalized = {
    ...nextConfig,
    aria2CustomSaveEnabled: !!nextConfig.aria2CustomSaveEnabled,
    aria2SaveLocations: normalizeAria2SaveLocations(nextConfig.aria2SaveLocations),
    externalLauncherName: 'AB DM',
    externalLauncherHost: 'localhost',
    mediaSniffingBlacklist: nextConfig.mediaSniffing === false
      ? '*'
      : String(nextConfig.mediaSniffingBlacklist || '').trim(),
    downloadInterceptionBlacklist: String(nextConfig.downloadInterceptionBlacklist || '').trim(),
    captureExtensions: normalizeCaptureExtensionsConfig(nextConfig.captureExtensions),
  };
  delete normalized.mediaSniffing;
  delete normalized.skipSmallDownloads;
  delete normalized.smallDownloadThresholdBytes;
  return normalized;
}

function isMediaSniffingEnabled(nextConfig = config) {
  return nextConfig.autoCapture !== false;
}

function applyLocaleFromConfig(nextConfig = config) {
  i18n.setLocalePreference?.(nextConfig.language || 'auto');
}

async function saveConfigAndSync(nextConfig) {
  const previousMediaSniffingEnabled = isMediaSniffingEnabled(config);
  const previousAutoCapture = config.autoCapture;
  const previousMediaSniffingBlacklist = config.mediaSniffingBlacklist;
  let storedConfig = nextConfig;
  if (nextConfig.mediaSniffing === false) {
    storedConfig = { ...nextConfig, mediaSniffing: true, mediaSniffingBlacklist: '*' };
  } else if (Object.prototype.hasOwnProperty.call(nextConfig, 'mediaSniffingBlacklist')) {
    storedConfig = { ...nextConfig, mediaSniffing: true };
  }
  await saveStoredConfig(storedConfig);
  config = normalizeConfig({ ...config, ...nextConfig });
  applyLocaleFromConfig(config);
  const autoCaptureChanged = previousAutoCapture !== config.autoCapture;
  if (autoCaptureChanged || Object.prototype.hasOwnProperty.call(nextConfig, 'captureExtensions')) {
    await installSafariDownloadRedirectRules();
  }
  if (
    autoCaptureChanged ||
    previousMediaSniffingEnabled !== isMediaSniffingEnabled(config) ||
    previousMediaSniffingBlacklist !== config.mediaSniffingBlacklist
  ) {
    await syncMediaSniffingStateForActiveTabs();
    broadcastUpdate();
  }
  return config;
}

function queueAutoCaptureToggle() {
  autoCaptureTogglePromise = autoCaptureTogglePromise
    .catch(() => {})
    .then(async () => {
      await configReady;
      await saveConfigAndSync({ autoCapture: !config.autoCapture });
    });
  return autoCaptureTogglePromise;
}

function refreshContextMenus() {
  const refreshVersion = ++contextMenuRefreshVersion;

  // Safari can mojibake non-ASCII source literals while bridging dynamic menu
  // titles to AppKit. Keep the source bytes ASCII for the Chinese menu path.
  const isEnglish = i18n.getLocale?.() === 'en';
  const linkTitle = isEnglish
    ? t('menuDownloadLink', undefined, 'Download link with current downloader')
    : '\u7528\u5f53\u524d\u4e0b\u8f7d\u5668\u4e0b\u8f7d\u94fe\u63a5';
  const pageTitle = isEnglish
    ? t('menuDownloadPage', undefined, 'Download current page with current downloader')
    : '\u7528\u5f53\u524d\u4e0b\u8f7d\u5668\u4e0b\u8f7d\u5f53\u524d\u9875\u9762';

  function safeCreateContextMenu(item) {
    chrome.contextMenus.create(item, () => {
      // Avoid noisy duplicate-id errors when multiple refreshes overlap.
      void chrome.runtime.lastError;
    });
  }

  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    if (refreshVersion !== contextMenuRefreshVersion) return;
    safeCreateContextMenu({ id: 'send-to-aria2', title: linkTitle, contexts: ['link'] });
    safeCreateContextMenu({ id: 'send-page-to-aria2', title: pageTitle, contexts: ['page'] });
  });
}

function buildConnectionFailureText(label) {
  return t('connectionFailedWithLabel', [label], `与 ${label} 连接失败，检查 ${label} 是否正在运行`);
}

function shouldConfirmBeforeSend() {
  return (
    (config.downloaderType === 'aria2' && !config.aria2Silent) ||
    (config.downloaderType === 'gopeed' && !config.gopeedSilent)
  );
}

function normalizeIntentUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url).split('#')[0];
  }
}

function normalizeSourceFilename(filename = '') {
  return sanitizeFilenamePart(decodeHttpFilename(filename));
}

function extensionFromDownloadMime(mime = '') {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  const map = {
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/x-rar': 'rar',
    'application/vnd.rar': 'rar',
    'application/x-7z-compressed': '7z',
    'application/x-tar': 'tar',
    'application/gzip': 'gz',
    'application/x-bzip2': 'bz2',
    'application/x-xz': 'xz',
    'application/x-iso9660-image': 'iso',
    'application/x-msdownload': 'exe',
    'application/vnd.microsoft.portable-executable': 'exe',
    'application/vnd.android.package-archive': 'apk',
    'application/x-apple-diskimage': 'dmg',
    'application/x-deb': 'deb',
    'application/pdf': 'pdf',
    'application/x-bittorrent': 'torrent',
  };
  return map[normalized] || '';
}

function addExtensionFromCandidates(filename = '', { mime = '', candidates = [] } = {}) {
  const cleanName = normalizeSourceFilename(filename);
  if (!cleanName || extOf(cleanName)) return cleanName;
  const ext = candidates.map((item) => extOf(item)).find(Boolean) || extensionFromDownloadMime(mime);
  return ext ? `${cleanName}.${ext}` : cleanName;
}

function resolveCapturedFilename(primaryFilename = '', { sourceFilename = '', mime = '', candidates = [] } = {}) {
  const primary = decodeHttpFilename(primaryFilename);
  const source = normalizeSourceFilename(sourceFilename);
  if (source && !isLowQualityFilename(source) && (!primary || isLowQualityFilename(primary))) {
    return addExtensionFromCandidates(source, { mime, candidates: [primary, ...candidates] });
  }
  return primary;
}

function rememberDownloadClickIntent({ url, tabId, windowId, filename, pageUrl } = {}) {
  const normalizedUrl = normalizeIntentUrl(url);
  if (!normalizedUrl || typeof tabId !== 'number' || tabId < 0) return false;
  downloadClickIntents.set(normalizedUrl, {
    tabId,
    windowId: typeof windowId === 'number' ? windowId : undefined,
    filename: normalizeSourceFilename(filename),
    pageUrl: String(pageUrl || ''),
    expiresAt: Date.now() + 30000,
  });
  cleanExpired(downloadClickIntents);
  return true;
}

function getDownloadClickIntent(...urls) {
  cleanExpired(downloadClickIntents);
  for (const url of urls) {
    const normalizedUrl = normalizeIntentUrl(url);
    if (!normalizedUrl) continue;
    const intent = downloadClickIntents.get(normalizedUrl);
    if (intent) {
      downloadClickIntents.delete(normalizedUrl);
      return intent;
    }
  }
  return null;
}

function getEffectiveConfig(override = {}) {
  return normalizeConfig({ ...config, ...(override || {}) });
}

function setUiAlert(alert) {
  uiAlert = alert;
  broadcastUpdate();
}

function clearUiAlert() {
  if (!uiAlert) return;
  uiAlert = null;
  broadcastUpdate();
}

async function openTaskSurface() {
  if (taskSurfaceOpenPromise) {
    console.info('[Downlink][popup] reuse pending popup open request');
    return taskSurfaceOpenPromise;
  }

  taskSurfaceOpenPromise = (async () => {
    try {
      console.info('[Downlink][popup] opening extension popup');
      await chrome.action.openPopup();
      console.info('[Downlink][popup] extension popup opened');
      return true;
    } catch (error) {
      console.warn('[Downlink][popup] failed to open extension popup', {
        error: error?.message || String(error),
      });
      return false;
    }
  })();

  try {
    return await taskSurfaceOpenPromise;
  } finally {
    taskSurfaceOpenPromise = null;
  }
}

async function openTaskFallbackWindow(taskInfo = {}) {
  if (!chrome.windows?.create || !chrome.runtime?.getURL) return false;
  if (taskFallbackWindowOpenPromise) return taskFallbackWindowOpenPromise;

  taskFallbackWindowOpenPromise = (async () => {
    if (typeof taskFallbackWindowId === 'number' && chrome.windows?.update) {
      try {
        await callChromeApi(chrome.windows.update.bind(chrome.windows), taskFallbackWindowId, { focused: true });
        console.info('[Downlink][popup] focused existing fallback task window', { windowId: taskFallbackWindowId });
        return true;
      } catch {
        taskFallbackWindowId = null;
      }
    }

    try {
      const created = await callChromeApi(chrome.windows.create.bind(chrome.windows), {
        url: chrome.runtime.getURL('popup.html'),
        type: 'popup',
        width: 520,
        height: 720,
        focused: true,
      });
      taskFallbackWindowId = typeof created?.id === 'number' ? created.id : null;
      console.info('[Downlink][popup] fallback task window opened', {
        windowId: taskFallbackWindowId,
        url: taskInfo.url || '',
      });
      return true;
    } catch (error) {
      console.warn('[Downlink][popup] failed to open fallback task window', {
        error: error?.message || String(error),
      });
      return false;
    }
  })();

  try {
    return await taskFallbackWindowOpenPromise;
  } finally {
    taskFallbackWindowOpenPromise = null;
  }
}

function getTab(tabId) {
  return new Promise((resolve) => {
    if (typeof tabId !== 'number' || tabId < 0 || !chrome.tabs?.get) {
      resolve(null);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });
}

function callChromeApi(method, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error = '') => {
      if (settled) return;
      settled = true;
      if (error) reject(new Error(error));
      else resolve(value);
    };
    try {
      const result = method(...args, (value) => finish(value, getRuntimeLastErrorMessage()));
      result?.then?.((value) => finish(value)).catch?.((error) => finish(null, error?.message || String(error)));
    } catch (error) {
      finish(null, error?.message || String(error));
    }
  });
}

async function focusPopupTarget({ tabId, windowId } = {}) {
  const tab = await getTab(tabId);
  const targetWindowId = typeof windowId === 'number' ? windowId : tab?.windowId;
  try {
    if (typeof targetWindowId === 'number') await chrome.windows?.update?.(targetWindowId, { focused: true });
  } catch {}
  try {
    if (typeof tab?.id === 'number') await chrome.tabs?.update?.(tab.id, { active: true });
  } catch {}
}

async function openTaskSurfaceForTask(taskInfo = {}) {
  console.info('[Downlink][popup] popup requested for task', {
    url: taskInfo.url || '',
    filename: taskInfo.filename || '',
    captureSource: taskInfo.captureSource || '',
    captureReason: taskInfo.captureReason || '',
    sourceTabId: taskInfo.sourceTabId,
    sourceWindowId: taskInfo.sourceWindowId,
    downloaderType: config.downloaderType,
  });
  await focusPopupTarget({
    tabId: taskInfo.sourceTabId,
    windowId: taskInfo.sourceWindowId,
  });
  if (await openTaskSurface()) return true;
  return openTaskFallbackWindow(taskInfo);
}

function scheduleSafariBridgePendingSurface(key = '') {
  if (!key) return;
  // The bridge content script calls history.back() after receiving the
  // capture response. Opening Safari's action popup before that navigation
  // makes Safari immediately dismiss it, so wait until the source page is
  // active again. openTaskSurfaceForTask provides a standalone popup-window
  // fallback when Safari rejects action.openPopup without a user gesture.
  setTimeout(() => {
    const taskInfo = pendingDownloads[key];
    if (!taskInfo) return;
    openTaskSurfaceForTask(taskInfo).catch(() => {});
  }, 300);
}

function scheduleSafariBridgeRecovery({ tabId, sourceTabId, openerTabId, sourcePageUrl = '', targetUrl = '' } = {}) {
  if (typeof tabId !== 'number') return '';
  const externalSourceTabId = [sourceTabId, openerTabId]
    .find((value) => typeof value === 'number' && value !== tabId);
  const returnUrl = isUsableSafariBridgeSourcePage(sourcePageUrl, targetUrl) ? sourcePageUrl : '';
  const mode = typeof externalSourceTabId === 'number' && chrome.tabs?.remove
    ? 'close'
    : 'replace';
  setTimeout(async () => {
    try {
      if (mode === 'close') {
        if (chrome.tabs?.update) {
          await callChromeApi(chrome.tabs.update.bind(chrome.tabs), externalSourceTabId, { active: true }).catch(() => {});
        }
        await callChromeApi(chrome.tabs.remove.bind(chrome.tabs), tabId);
      } else if (chrome.tabs?.update) {
        // Never replay browser history here. In a multi-hop download redirect the
        // previous history entry is commonly the terminal file URL, so going
        // back immediately triggers the same DNR rule again.
        await callChromeApi(chrome.tabs.update.bind(chrome.tabs), tabId, {
          url: returnUrl || 'about:blank',
        });
      }
      writeProbeLog('successful local bridge navigation recovered', {
        tabId,
        sourceTabId,
        openerTabId,
        externalSourceTabId,
        returnUrl,
        mode,
      });
    } catch (error) {
      writeProbeLog('successful local bridge navigation recovery failed', {
        tabId,
        sourceTabId,
        openerTabId,
        returnUrl,
        mode,
        message: error?.message || String(error),
      });
    }
  }, 50);
  return mode;
}

async function closeFirefoxInterceptedDownloadTab() {
  // Safari 不适用
  return false;
}

async function enqueuePendingDownload(taskInfo, { openSurface = true } = {}) {
  const key = taskInfo?.key || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  pendingDownloads[key] = { ...taskInfo, key };
  console.info('[Downlink][popup] pending download queued', {
    key,
    url: taskInfo?.url || '',
    filename: taskInfo?.filename || '',
    captureSource: taskInfo?.captureSource || '',
    captureReason: taskInfo?.captureReason || '',
    openSurface,
    downloaderType: config.downloaderType,
  });
  broadcastUpdate();
  if (openSurface) await openTaskSurfaceForTask(taskInfo);
  return key;
}

function preferredUrlFilename(urlFilename = '') {
  return urlFilename && extOf(urlFilename) ? urlFilename : '';
}

function getCachedResponseHeaders(...urls) {
  for (const url of urls) {
    if (!url) continue;
    const cached = responseHeadersCache.get(url);
    if (cached) return cached;
  }
  return {};
}

function getResponseHeaderValue(headers = [], name = '') {
  const lower = String(name || '').toLowerCase();
  for (const header of headers || []) {
    if (String(header.name || '').toLowerCase() === lower) return header.value || header.binaryValue || '';
  }
  return '';
}

function parseResponseSize(headers = []) {
  const contentRange = getResponseHeaderValue(headers, 'content-range');
  const rangeMatch = String(contentRange || '').match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  if (rangeMatch) return Number.parseInt(rangeMatch[1], 10) || 0;
  return Number.parseInt(getResponseHeaderValue(headers, 'content-length'), 10) || 0;
}

function firstKnownSize(...values) {
  for (const value of values) {
    const size = Number(value);
    if (Number.isFinite(size) && size > 0) return size;
  }
  return 0;
}

function shouldDeferBrowserDownloadCaptureForFilename() {
  // Safari 无 onDeterminingFilename，不延迟捕获
  return false;
}

function isBenignBrowserDownloadCancelResult(result = {}) {
  if (result.cancelled) return true;
  const reason = String(result.reason || '');
  if (reason === 'not-in-progress' || reason === 'not-active-on-recheck') return true;
  const error = String(result.error || '').toLowerCase();
  return error.includes('download must be in progress');
}

async function captureBrowserDownloadItem(item = {}, reason = 'browser-download:onCreated:capture', { allowFilenameDefer = false } = {}) {
  if (!config.autoCapture || !isDownloadInProgress(item)) return false;
  if (isRestoredBrowserDownloadItem(item)) return false;

  const url = item.finalUrl || item.url;
  if (isBrowserLocalDownloadUrl(url) || isBrowserLocalDownloadUrl(item.url)) {
    pendingBrowserDownloadCaptures.delete(item.id);
    return false;
  }
  const marked = markedUrls.get(url) || markedUrls.get(item.url);
  const cachedResponse = getCachedResponseHeaders(url, item.url);
  const requestMeta = requestHeadersCache.get(url) || requestHeadersCache.get(item.url) || {};
  if (isDownloadInterceptionBlockedForSource(
    marked?.sourcePageUrl,
    requestMeta.sourcePageUrl,
    cachedResponse.sourcePageUrl,
    item.referrer
  )) return false;

  const browserFilename = item.filename ? decodeHttpFilename(item.filename.split(/[\\/]/).pop()) : '';
  const urlFilename = filenameFromUrl(url);
  const urlPreferredFilename = preferredUrlFilename(urlFilename);
  const headerFilename = filenameFromCD(marked?.contentDisposition || cachedResponse.contentDisposition || '');
  const headerPreferredFilename = preferredUrlFilename(headerFilename);
  const markedPreferredFilename = preferredUrlFilename(marked?.filename || '');
  const sourceFilename = marked?.sourceFilename || requestHeadersCache.get(url)?.sourceFilename || requestHeadersCache.get(item.url)?.sourceFilename || cachedResponse.sourceFilename || '';
  const classification = classifyDownloadCandidate(config, {
    url,
    filename: headerPreferredFilename || urlPreferredFilename || browserFilename || headerFilename,
    mime: item.mime || cachedResponse.contentType || '',
    contentDisposition: marked?.contentDisposition || cachedResponse.contentDisposition || '',
    source: 'browser-download',
  });
  if (!marked && !classification.shouldCapture) return false;
  if (allowFilenameDefer && shouldDeferBrowserDownloadCaptureForFilename(item, {
    headerPreferredFilename,
    markedPreferredFilename,
    browserFilename,
  })) {
    pendingBrowserDownloadCaptures.set(item.id, {
      url,
      itemUrl: item.url,
      finalUrl: item.finalUrl,
      sourcePageUrl: marked?.sourcePageUrl || requestMeta.sourcePageUrl || cachedResponse.sourcePageUrl || item.referrer || '',
      expiresAt: Date.now() + 30000,
    });
    cleanExpired(pendingBrowserDownloadCaptures);
    console.info('[Downlink][browser-download] defer capture until browser determines filename', {
      ...describeBrowserDownloadItem(item),
      reason,
    });
    return true;
  }

  pendingBrowserDownloadCaptures.delete(item.id);
  const cancelResult = await cancelBrowserDownloadItem(item, reason);
  if (!isBenignBrowserDownloadCancelResult(cancelResult)) {
    console.warn('[Downlink][browser-download] skip captured task because browser download was not cancelled', {
      ...describeBrowserDownloadItem(item),
      reason,
      cancelResult,
    });
    if (marked) {
      markedUrls.delete(url);
      markedUrls.delete(item.url);
    }
    return false;
  }

  const reqHeaders = requestMeta.headers || {};
  const filename = resolveCapturedFilename(
    headerPreferredFilename || urlPreferredFilename || browserFilename || markedPreferredFilename || classification.filename || headerFilename || urlFilename || '',
    {
      sourceFilename,
      mime: marked?.mime || cachedResponse.contentType || item.mime || classification.mime || '',
      candidates: [urlPreferredFilename, headerPreferredFilename, browserFilename, markedPreferredFilename, classification.filename, headerFilename, urlFilename],
    }
  );

  if (marked) {
    markedUrls.delete(url);
    markedUrls.delete(item.url);
  }

  const key = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const taskInfo = {
    key,
    url,
    filename,
    size: firstKnownSize(item.totalBytes, marked?.size, cachedResponse.totalBytes),
    mime: marked?.mime || cachedResponse.contentType || item.mime || classification.mime || '',
    contentDisposition: marked?.contentDisposition || cachedResponse.contentDisposition || '',
    captureSource: marked?.captureSource || classification.source,
    captureReason: marked?.captureReason || classification.reason,
    headers: reqHeaders,
    method: requestMeta.method || 'GET',
    origin: reqHeaders.origin || deriveOrigin(url, reqHeaders.referer || ''),
    referrer: reqHeaders.referer || '',
    sourceTabId: typeof marked?.sourceTabId === 'number' ? marked.sourceTabId : requestMeta.sourceTabId || cachedResponse.sourceTabId,
    sourceWindowId: typeof marked?.sourceWindowId === 'number' ? marked.sourceWindowId : requestMeta.sourceWindowId || cachedResponse.sourceWindowId,
    sourceFilename,
    addedAt: Date.now(),
  };

  if (shouldConfirmBeforeSend()) {
    await enqueuePendingDownload(taskInfo);
    return true;
  }

  await sendTask(taskInfo, {}, { openPopupOnFailure: true });
  return true;
}

function getResponseCaptureClaim(...urls) {
  cleanExpired(responseCaptureClaims);
  for (const url of urls) {
    if (!url) continue;
    const claim = responseCaptureClaims.get(url);
    if (claim) return claim;
  }
  return null;
}

function deleteResponseCaptureClaim(...urls) {
  for (const url of urls) {
    if (url) responseCaptureClaims.delete(url);
  }
}

function discardResponseCaptureClaim(...urls) {
  const claim = getResponseCaptureClaim(...urls);
  deleteResponseCaptureClaim(...urls);
  if (!claim) return;
  claim.discarded = true;
  if (claim.claimState) claim.claimState.discarded = true;
  claim.promise
    .catch(() => null)
    .then((claimResult) => {
      const key = claimResult?.result?.key;
      if (key && pendingDownloads[key]) {
        delete pendingDownloads[key];
        broadcastUpdate();
      }
    });
}

async function queueOrSendCapturedDownload(taskInfo, { openPopupOnFailure = true, openPendingSurface = true, shouldReportFailure } = {}) {
  if (shouldConfirmBeforeSend()) {
    const key = await enqueuePendingDownload(taskInfo, { openSurface: openPendingSurface });
    return { ok: true, pending: true, key };
  }
  return sendTask(taskInfo, {}, { openPopupOnFailure, shouldReportFailure });
}

function captureSafariUrlDirectly({
  url = '',
  referrer = '',
  sourcePageUrl = '',
  sourceFilename = '',
  sourceTabId,
  tabId,
  windowId,
  captureSource = 'safari-dnr-block',
  captureReason = 'url-extension',
  openPendingSurface = true,
} = {}) {
  const captureKey = `${typeof tabId === 'number' ? tabId : -1}:${url}`;
  cleanExpired(safariUrlCaptureClaims);
  const existing = safariUrlCaptureClaims.get(captureKey);
  if (existing?.promise) return existing.promise;

  const promise = (async () => {
    await configReady;
    if (await isSafariDnrBypassActive(tabId, url)) {
      writeProbeLog('Safari URL capture skipped for active browser bypass', { tabId, url });
      return { ok: false, bypass: true, resumeUrl: url };
    }
    if (!config.autoCapture || !isSafariDnrDownloadCandidate(url) || isDownloadInterceptionBlockedForSource(sourcePageUrl, referrer)) {
      return { ok: false, bypass: true };
    }
    const cachedRequest = requestHeadersCache.get(url) || {};
    const headers = { ...(cachedRequest.headers || {}) };
    const cookieHeader = await getCookieHeaderForUrl(url);
    if (cookieHeader) headers.cookie = cookieHeader;
    if (referrer && !headers.referer) headers.referer = referrer;
    if (!headers['user-agent'] && typeof navigator !== 'undefined' && navigator.userAgent) {
      headers['user-agent'] = navigator.userAgent;
    }
    const urlFilename = filenameFromUrl(url);
    const redirectFilename = filenameFromSafariRedirectUrl(url);
    const filename = resolveCapturedFilename(redirectFilename || urlFilename, {
      sourceFilename,
      candidates: [redirectFilename, urlFilename],
    });
    const taskInfo = {
      key: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      url,
      filename,
      headers,
      method: 'GET',
      origin: deriveOrigin(url, referrer || sourcePageUrl),
      referrer,
      captureSource,
      captureReason,
      sourceTabId: typeof sourceTabId === 'number' ? sourceTabId : tabId,
      sourceWindowId: windowId,
      sourcePageUrl,
      addedAt: Date.now(),
    };
    writeProbeLog('Safari URL captured before browser download', {
      url,
      filename,
      tabId,
      referrer,
      sourcePageUrl,
      captureSource,
      sourceFilename,
      redirectFilename,
    });
    return queueOrSendCapturedDownload(taskInfo, {
      openPopupOnFailure: false,
      openPendingSurface,
    });
  })().catch((error) => {
    writeProbeLog('Safari URL capture failed', {
      url,
      tabId,
      message: error?.message || String(error),
    });
    return { ok: false, error: error?.message || String(error) };
  });

  safariUrlCaptureClaims.set(captureKey, { promise, expiresAt: Date.now() + 30000 });
  return promise;
}

function createResponseCaptureGate(waitForBrowserCancel = false) {
  if (!waitForBrowserCancel) {
    return {
      promise: Promise.resolve(),
      release() {},
    };
  }

  let released = false;
  let releaseGate;
  const promise = new Promise((resolve) => {
    releaseGate = resolve;
  });
  return {
    promise,
    release() {
      if (released) return;
      released = true;
      releaseGate();
    },
  };
}

function releaseResponseCaptureClaimAfterBrowserCancel(responseClaim) {
  if (!responseClaim) return;
  responseClaim.browserDownloadCancelCompleted = true;
  if (responseClaim.claimState) responseClaim.claimState.browserDownloadCancelCompleted = true;
  responseClaim.browserCancelGate?.release();
}

function rememberResponseCaptureClaim(url, promise, { cancelBrowserDownloadImmediately = false, claimState, browserCancelGate } = {}) {
  if (!url) return;
  responseCaptureClaims.set(url, {
    promise,
    cancelBrowserDownloadImmediately,
    browserDownloadCancelled: false,
    browserDownloadCancelCompleted: false,
    pendingSurfaceOpenRequested: false,
    claimState,
    browserCancelGate,
    expiresAt: Date.now() + 30000,
  });
  cleanExpired(responseCaptureClaims);
}

function openPendingSurfaceForResponseClaim(responseClaim, reason = '') {
  if (!responseClaim || responseClaim.pendingSurfaceOpenRequested) return Promise.resolve(false);
  responseClaim.pendingSurfaceOpenRequested = true;
  if (responseClaim.claimState) responseClaim.claimState.pendingSurfaceOpenRequested = true;

  return responseClaim.promise
    .catch(() => null)
    .then((claimResult) => {
      if (responseClaim.discarded || responseClaim.claimState?.discarded) return false;
      const key = claimResult?.result?.key;
      if (!claimResult?.result?.pending || !key) return false;
      const taskInfo = (key && pendingDownloads[key]) || responseClaim.claimState?.taskInfo;
      if (!taskInfo) return false;
      console.info('[Downlink][popup] opening deferred popup after browser download cancel', {
        key,
        url: taskInfo.url || '',
        filename: taskInfo.filename || '',
        reason,
      });
      return openTaskSurfaceForTask(taskInfo);
    });
}

function rememberRedirectIntent(sourceUrl = '', redirectUrl = '', details = {}) {
  if (!sourceUrl || !redirectUrl) return null;
  const requestMeta = requestHeadersCache.get(sourceUrl) || {};
  const intent = {
    sourceUrl,
    redirectUrl,
    method: details.method || requestMeta.method || '',
    headers: requestMeta.headers || {},
    tabId: details.tabId,
    sourceTabId: requestMeta.sourceTabId,
    sourceWindowId: requestMeta.sourceWindowId,
    sourceFilename: requestMeta.sourceFilename,
    sourcePageUrl: requestMeta.sourcePageUrl || details.initiator || requestMeta.headers?.referer || '',
    expiresAt: Date.now() + 30000,
  };
  redirectIntents.set(redirectUrl, intent);
  cleanExpired(redirectIntents);
  return intent;
}

function getRedirectIntent(...urls) {
  cleanExpired(redirectIntents);
  for (const url of urls) {
    if (!url) continue;
    const intent = redirectIntents.get(url);
    if (intent) return intent;
  }
  return null;
}

function deleteRedirectIntent(...urls) {
  for (const url of urls) {
    if (url) redirectIntents.delete(url);
  }
}

function isUserDownloadLikeResponse(details = {}) {
  const type = String(details.type || '').toLowerCase();
  if (!type) return true;
  return ['main_frame', 'sub_frame', 'object', 'other'].includes(type);
}

function shouldSendFromResponseHeaders(details = {}, classification = {}, redirectIntent = null) {
  if (redirectIntent) {
    return Boolean(classification.shouldCapture && (classification.byDisposition || classification.byExt || classification.byMime));
  }
  return Boolean(
    classification.shouldCapture &&
    classification.byDisposition &&
    (classification.byExt || classification.byMime) &&
    isUserDownloadLikeResponse(details)
  );
}

function isRedirectStatus(statusCode) {
  const status = Number(statusCode);
  return status >= 300 && status < 400;
}

function resolveRedirectUrl(baseUrl = '', location = '') {
  if (!location) return '';
  try {
    return new URL(location, baseUrl).href;
  } catch {
    return '';
  }
}

function isPostRedirectIntentCandidate(details = {}, redirectUrl = '') {
  if (!redirectUrl || !isRedirectStatus(details.statusCode)) return false;
  const method = String(details.method || requestHeadersCache.get(details.url)?.method || '').toUpperCase();
  if (!method || method === 'GET' || method === 'HEAD') return false;
  return true;
}

function isLikelyDownloadRedirectCandidate(details = {}, redirectUrl = '', contentDisposition = '') {
  if (!redirectUrl || !isRedirectStatus(details.statusCode) || !isUserDownloadLikeResponse(details)) return false;
  const classification = classifyDownloadCandidate(config, {
    url: redirectUrl,
    contentDisposition,
    source: 'redirect',
  });
  return Boolean(classification.shouldCapture && (classification.byDisposition || classification.byExt || classification.byMime));
}

function rememberSafariDnrRedirectCandidate(details = {}, redirectUrl = details.redirectUrl || '') {
  if (!config.autoCapture || !['main_frame', 'other'].includes(details.type) || typeof details.tabId !== 'number') return false;
  if (!isSafariDnrDownloadCandidate(redirectUrl)) return false;
  const requestMeta = requestHeadersCache.get(details.url) || {};
  const navigationSource = getSafariNavigationSource(details.tabId, redirectUrl);
  dnrNavigationCandidates.set(details.tabId, {
    url: redirectUrl,
    referrer: navigationSource.sourcePageUrl || requestMeta.sourcePageUrl || details.initiator || requestMeta.headers?.referer || details.url,
    sourcePageUrl: navigationSource.sourcePageUrl || requestMeta.sourcePageUrl || details.initiator || requestMeta.headers?.referer || details.url,
    stableSourcePageUrl: navigationSource.sourcePageUrl,
    sourceFilename: requestMeta.sourceFilename || filenameFromSafariRedirectUrl(redirectUrl),
    sourceTabId: navigationSource.sourceTabId ?? requestMeta.sourceTabId,
    sourceWindowId: navigationSource.sourceWindowId ?? requestMeta.sourceWindowId,
    requestId: details.requestId,
    expiresAt: Date.now() + 30000,
  });
  cleanExpired(dnrNavigationCandidates);
  writeProbeLog('DNR redirect target candidate observed', {
    tabId: details.tabId,
    sourceUrl: details.url,
    redirectUrl,
  });
  return true;
}

function safariBlockedNavigationFallback(candidate = {}, blockedUrl = '') {
  const urls = [candidate.sourcePageUrl, candidate.referrer];
  return urls.find((url) => /^https?:\/\//i.test(String(url || '')) && url !== blockedUrl) || 'about:blank';
}

function recoverSafariBlockedNavigation({
  tabId,
  blockedUrl = '',
  fallbackUrl = 'about:blank',
  trigger = 'unknown',
} = {}) {
  if (typeof tabId !== 'number') return Promise.resolve(false);
  const targetUrl = /^https?:\/\//i.test(String(fallbackUrl || '')) && fallbackUrl !== blockedUrl
    ? fallbackUrl
    : 'about:blank';
  return (async () => {
    const tab = await getTab(tabId);
    const currentUrl = String(tab?.url || '');
    const isSafariErrorPage = /^safari-resource:\/\/?.*ErrorPage\.html/i.test(currentUrl);
    if (currentUrl && currentUrl !== blockedUrl && currentUrl !== 'about:blank' && currentUrl !== targetUrl && !isSafariErrorPage) {
      writeProbeLog('blocked navigation recovery skipped because tab moved', {
        trigger,
        tabId,
        blockedUrl,
        currentUrl,
        targetUrl,
      });
      return false;
    }
    if (currentUrl === targetUrl) return true;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, message = '') => {
        if (settled) return;
        settled = true;
        writeProbeLog(ok ? 'blocked navigation recovered' : 'blocked navigation recovery failed', {
          trigger,
          tabId,
          blockedUrl,
          targetUrl,
          message,
        });
        resolve(ok);
      };
      try {
        const result = chrome.tabs.update(tabId, { url: targetUrl }, () => {
          const message = getRuntimeLastErrorMessage();
          finish(!message, message);
        });
        result?.then?.(() => finish(true)).catch?.((error) => finish(false, error?.message || String(error)));
      } catch (error) {
        finish(false, error?.message || String(error));
      }
    });
  })();
}

function scheduleSafariBlockedNavigationRecovery(args = {}) {
  for (const delay of [0, 120, 400, 900]) {
    setTimeout(() => {
      recoverSafariBlockedNavigation({
        ...args,
        trigger: `${args.trigger || 'unknown'}:${delay}ms`,
      }).catch(() => {});
    }, delay);
  }
}

async function recoverSafariLocalBridgeFailure(details = {}, candidate = {}) {
  if (typeof details.tabId !== 'number') return false;
  const tab = await getTab(details.tabId);
  const hasSourcePage = /^https?:\/\//i.test(String(candidate.sourcePageUrl || ''));
  if (typeof tab?.openerTabId === 'number' && !hasSourcePage && chrome.tabs?.remove) {
    try {
      await callChromeApi(chrome.tabs.remove.bind(chrome.tabs), details.tabId);
      writeProbeLog('failed local bridge download tab closed', {
        tabId: details.tabId,
        openerTabId: tab.openerTabId,
        url: details.url,
      });
      return true;
    } catch {}
  }
  if (chrome.tabs?.goBack) {
    try {
      await callChromeApi(chrome.tabs.goBack.bind(chrome.tabs), details.tabId);
      writeProbeLog('failed local bridge navigation went back', {
        tabId: details.tabId,
        url: details.url,
      });
      return true;
    } catch {}
  }
  scheduleSafariBlockedNavigationRecovery({
    tabId: details.tabId,
    blockedUrl: details.url,
    fallbackUrl: safariBlockedNavigationFallback(candidate, details.url),
    trigger: 'local-bridge-onErrorOccurred',
  });
  return true;
}

function navigateSafariRedirectToDnrBridge(details = {}, redirectUrl = details.redirectUrl || '', trigger = 'redirect') {
  if (!rememberSafariDnrRedirectCandidate(details, redirectUrl)) return false;
  const navigationKey = `${details.tabId}:${redirectUrl}`;
  cleanExpired(dnrRedirectBridgeNavigations);
  if (dnrRedirectBridgeNavigations.has(navigationKey)) return true;
  dnrRedirectBridgeNavigations.set(navigationKey, { expiresAt: Date.now() + 30000 });

  writeProbeLog('redirect download candidate recorded for DNR bridge', {
    trigger,
    tabId: details.tabId,
    sourceUrl: details.url,
    redirectUrl,
  });
  // Observation alone is not proof that Safari's final request was stopped.
  // The task is submitted only after webNavigation reaches the loopback URL,
  // which can happen only after the DNR redirect has actually won.
  return true;
}

function isDownloadInProgress(item = {}) {
  return !item.state || item.state === 'in_progress';
}

function describeBrowserDownloadItem(item = {}) {
  return {
    id: item.id,
    url: item.finalUrl || item.url || '',
    filename: item.filename || '',
    state: item.state || '',
    mime: item.mime || '',
    totalBytes: item.totalBytes,
    danger: item.danger || '',
    exists: item.exists,
  };
}

function eraseBrowserDownloadItem(downloadId, reason = '') {
  // Safari 无 chrome.downloads API，浏览器下载由 webRequest blocking 直接取消，无需 erase
}

function cancelBrowserDownloadItem(item = {}, reason = 'captured-download') {
  // Safari 无 chrome.downloads API；下载已在 webRequest 阶段 cancel，这里仅标记完成
  return Promise.resolve({ cancelled: true, reason });
}

function isRestoredBrowserDownloadItem(item = {}) {
  if (!item.startTime) return false;
  const startTime = Date.parse(item.startTime);
  if (!Number.isFinite(startTime)) return false;
  return startTime < backgroundSessionStartedAt - RESTORED_DOWNLOAD_GRACE_MS;
}

const configReady = new Promise((resolve) => {
  loadStoredConfigCallback((stored) => {
    config = normalizeConfig({ ...DEFAULT_CONFIG, ...stored });
    applyLocaleFromConfig(config);
    refreshContextMenus();
    resolve(config);
    syncMediaSniffingStateForActiveTabs().then(() => {
      broadcastUpdate();
    }).catch(() => {});
  });
});

configReady.then(() => {
  startSafariLocalBridgeKeepalive();
  return installSafariDownloadRedirectRules();
}).catch(() => {});

chrome.webNavigation?.onCommitted?.addListener?.((details) => {
  if (details.frameId !== 0 || typeof details.tabId !== 'number') return;
  getTab(details.tabId).then((tab) => {
    rememberSafariCommittedPage(details.tabId, details.url, tab?.windowId);
  }).catch(() => {});
});

chrome.webNavigation?.onCreatedNavigationTarget?.addListener?.((details) => {
  if (typeof details.tabId !== 'number' || typeof details.sourceTabId !== 'number') return;
  const committedSource = safariCommittedTabPages.get(details.sourceTabId) || {};
  const navigationSource = {
    sourcePageUrl: isUsableSafariBridgeSourcePage(committedSource.sourcePageUrl, details.url)
      ? committedSource.sourcePageUrl
      : '',
    sourceTabId: details.sourceTabId,
    sourceWindowId: committedSource.sourceWindowId,
    expiresAt: Date.now() + 30000,
  };
  // Record the source tab synchronously. A cached/loopback redirect can reach
  // the bridge before tabs.get(sourceTabId) resolves in Safari.
  safariCreatedNavigationSources.set(details.tabId, navigationSource);
  cleanExpired(safariCreatedNavigationSources);
  getTab(details.sourceTabId).then((sourceTab) => {
    const sourcePageUrl = String(sourceTab?.url || navigationSource.sourcePageUrl || '');
    navigationSource.sourcePageUrl = isUsableSafariBridgeSourcePage(sourcePageUrl, details.url) ? sourcePageUrl : '';
    navigationSource.sourceWindowId = sourceTab?.windowId;
    writeProbeLog('Safari created navigation target source recorded', {
      tabId: details.tabId,
      sourceTabId: details.sourceTabId,
      sourcePageUrl,
      targetUrl: details.url || '',
    });
  }).catch(() => {});
});

chrome.webNavigation?.onBeforeNavigate?.addListener?.(async (details) => {
  if (details.frameId !== 0 || typeof details.tabId !== 'number') return;
  const bridgedUrl = safariLocalBridgeTargetUrl(details.url);
  if (bridgedUrl) {
    cleanExpired(dnrNavigationCandidates);
    const candidate = dnrNavigationCandidates.get(details.tabId);
    if (candidate && candidate.url !== bridgedUrl) {
      writeProbeLog('local DNR bridge navigation rejected for mismatched candidate', {
        tabId: details.tabId,
        url: bridgedUrl,
        candidateUrl: candidate?.url || '',
      });
      return;
    }
    if (!candidate) {
      // Safari may apply DNR before webNavigation/webRequest reports the
      // original URL. Wait for the content script running in the real
      // loopback document to confirm sender URL and target instead of
      // rejecting a takeover that has already stopped the browser download.
      writeProbeLog('local DNR bridge navigation awaiting document confirmation', {
        tabId: details.tabId,
        url: bridgedUrl,
      });
      return;
    }
    writeProbeLog('local DNR bridge navigation confirmed takeover; awaiting document confirmation', {
      tabId: details.tabId,
      url: bridgedUrl,
      sourcePageUrl: candidate.sourcePageUrl || '',
    });
    return;
  }
  if (!isSafariDnrDownloadCandidate(details.url)) return;
  if (await isSafariDnrBypassActive(details.tabId, details.url)) {
    writeProbeLog('DNR download navigation left to Safari by active bypass', {
      tabId: details.tabId,
      url: details.url,
    });
    return;
  }
  const existingCandidate = dnrNavigationCandidates.get(details.tabId);
  if (existingCandidate?.url === details.url) {
    writeProbeLog('DNR download navigation reused redirect candidate', {
      tabId: details.tabId,
      url: details.url,
    });
    return;
  }
  const navigationSource = getSafariNavigationSource(details.tabId, details.url);
  const candidate = {
    url: details.url,
    sourcePageUrl: navigationSource.sourcePageUrl,
    stableSourcePageUrl: navigationSource.sourcePageUrl,
    sourceTabId: navigationSource.sourceTabId,
    sourceWindowId: navigationSource.sourceWindowId,
    sourceFilename: filenameFromSafariRedirectUrl(details.url),
    expiresAt: Date.now() + 30000,
  };
  dnrNavigationCandidates.set(details.tabId, candidate);
  cleanExpired(dnrNavigationCandidates);
  getTab(details.tabId).then((tab) => {
    const currentUrl = String(tab?.url || '');
    if (/^https?:\/\//i.test(currentUrl) && currentUrl !== candidate.url) candidate.sourcePageUrl = currentUrl;
    if (typeof candidate.sourceWindowId !== 'number') candidate.sourceWindowId = tab?.windowId;
  }).catch(() => {});
  writeProbeLog('DNR download navigation candidate observed', {
    tabId: details.tabId,
    url: details.url,
  });
});

chrome.webNavigation?.onErrorOccurred?.addListener?.((details) => {
  if (details.frameId !== 0 || typeof details.tabId !== 'number') return;
  cleanExpired(dnrNavigationCandidates);
  const candidate = dnrNavigationCandidates.get(details.tabId);
  if (isSafariLocalBridgeNavigationUrl(details.url)) {
    writeProbeLog('local DNR bridge navigation error observed', {
      tabId: details.tabId,
      url: details.url,
      error: details.error || '',
    });
    recoverSafariLocalBridgeFailure(details, candidate || {}).catch(() => {});
    return;
  }
  if (!candidate || candidate.url !== details.url || !isSafariDnrDownloadCandidate(details.url)) return;
  writeProbeLog('blocked download navigation error observed', {
    tabId: details.tabId,
    url: details.url,
    error: details.error || '',
  });
  scheduleSafariBlockedNavigationRecovery({
    tabId: details.tabId,
    blockedUrl: details.url,
    fallbackUrl: safariBlockedNavigationFallback(candidate, details.url),
    trigger: 'onErrorOccurred',
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName && !['sync', 'local'].includes(areaName)) return;
  if (!activeConfigStorageArea || (areaName && areaName !== activeConfigStorageArea)) return;
  const previousMediaSniffingEnabled = isMediaSniffingEnabled(config);
  const previousAutoCapture = config.autoCapture;
  for (const key in changes) {
    if (key === CONFIG_STORAGE_AREA_KEY) continue;
    config[key] = changes[key].newValue;
  }
  config = normalizeConfig(config);
  applyLocaleFromConfig(config);
  if (changes.language) refreshContextMenus();
  const autoCaptureChanged = changes.autoCapture && previousAutoCapture !== config.autoCapture;
  const mediaSniffingEnabledChanged = changes.autoCapture && previousMediaSniffingEnabled !== isMediaSniffingEnabled(config);
  if (autoCaptureChanged || changes.captureExtensions) installSafariDownloadRedirectRules().catch(() => {});
  if (autoCaptureChanged || mediaSniffingEnabledChanged || changes.mediaSniffingBlacklist || changes.mediaSniffing) {
    syncMediaSniffingStateForActiveTabs().then(() => {
      broadcastUpdate();
    }).catch(() => {});
  }
});

function notify(title, message) {
  if (!chrome.notifications?.create) {
    writeProbeLog('notification API unavailable', { title, message });
    return;
  }
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title,
      message,
    }, () => {
      const error = getRuntimeLastErrorMessage();
      if (error) writeProbeLog('notification create failed', { title, message, error });
    });
  } catch (error) {
    writeProbeLog('notification create failed', {
      title,
      message,
      error: error?.message || String(error),
    });
  }
}

function buildMotrixNextDeepLink() {
  return 'motrixnext://';
}

function buildMotrixNextBridgeUrl() {
  return chrome.runtime.getURL('motrix-open.html');
}

function buildGopeedDeepLink() {
  return 'gopeed://';
}

function buildGopeedBridgeUrl() {
  return chrome.runtime.getURL('gopeed-open.html');
}

async function openMotrixNextView() {
  const deepLink = buildMotrixNextDeepLink();
  try {
    const bridgeUrl = buildMotrixNextBridgeUrl();
    await chrome.tabs.create({ url: bridgeUrl });
    return { ok: true, url: bridgeUrl, target: deepLink, mode: 'bridge' };
  } catch (error) {
    try {
      await chrome.tabs.create({ url: deepLink });
      return { ok: true, url: deepLink, target: deepLink, mode: 'direct-fallback' };
    } catch (fallbackError) {
      const errorMessage = fallbackError?.message || error?.message || t('cannotLaunchMotrix', undefined, '无法唤起 MotrixNext');
      notify(t('motrixOpenFailed', undefined, 'MotrixNext 打开失败'), errorMessage);
      return { ok: false, error: errorMessage };
    }
  }
}

async function openGopeedView() {
  const deepLink = buildGopeedDeepLink();
  try {
    const bridgeUrl = buildGopeedBridgeUrl();
    await chrome.tabs.create({ url: bridgeUrl });
    return { ok: true, url: bridgeUrl, target: deepLink, mode: 'bridge' };
  } catch (error) {
    try {
      await chrome.tabs.create({ url: deepLink });
      return { ok: true, url: deepLink, target: deepLink, mode: 'direct-fallback' };
    } catch (fallbackError) {
      const errorMessage = fallbackError?.message || error?.message || t('cannotLaunchGopeed', undefined, '无法唤起 Gopeed');
      notify(t('gopeedOpenFailed', undefined, 'Gopeed 打开失败'), errorMessage);
      return { ok: false, error: errorMessage };
    }
  }
}

const BROADCAST_UPDATE_DELAY_MS = 60;
let broadcastUpdateTimer = null;
const pendingMediaBroadcastTabs = new Set();

function flushBroadcastUpdate() {
  broadcastUpdateTimer = null;
  const mediaState = mediaManager.getState();
  const message = {
    type: 'TASKS_UPDATE',
    tasks,
    pending: pendingDownloads,
    pausedTabs: mediaState.pausedTabs,
    mediaBlacklistBlockedTabs: Array.from(mediaBlacklistBlockedTabs),
    hiddenTaskGids: Object.keys(hiddenTaskGids),
    uiAlert,
    config,
  };
  if (pendingMediaBroadcastTabs.size) {
    message.mediaPatch = true;
    message.media = {};
    for (const tabId of pendingMediaBroadcastTabs) {
      message.media[tabId] = mediaState.media[tabId] || [];
    }
    pendingMediaBroadcastTabs.clear();
  }
  try {
    const pending = chrome.runtime.sendMessage(message);
    pending?.catch?.(() => {});
  } catch {}
}

function broadcastUpdate(mediaTabId) {
  if (typeof mediaTabId === 'number' && mediaTabId >= 0) {
    pendingMediaBroadcastTabs.add(mediaTabId);
  }
  if (broadcastUpdateTimer) return;
  broadcastUpdateTimer = setTimeout(flushBroadcastUpdate, BROADCAST_UPDATE_DELAY_MS);
}

const downloaderClients = downloaders.createClients({
  getConfig: () => config,
  notify,
  onBeforeAria2Send: () => {
    for (const [gid, task] of Object.entries(tasks)) {
      if (task?.gid && task.status !== 'paused') hiddenTaskGids[gid] = true;
    }
    broadcastUpdate();
  },
  onAria2TaskQueued: (gid, taskInfo) => {
    clearUiAlert();
    tasks[gid] = {
      gid,
      url: taskInfo.url,
      filename: taskInfo.filename,
      addedAt: taskInfo.addedAt || Date.now(),
      status: 'active',
      provider: 'aria2',
    };
    delete hiddenTaskGids[gid];
    broadcastUpdate();
  },
  onGopeedTaskQueued: (gid, taskInfo) => {
    clearUiAlert();
    tasks[gid] = {
      gid,
      url: taskInfo.url,
      filename: taskInfo.filename,
      addedAt: taskInfo.addedAt || Date.now(),
      status: 'sent',
      provider: 'gopeed',
    };
    delete hiddenTaskGids[gid];
    broadcastUpdate();
  },
});

const {
  aria2Call,
  buildExternalEndpoint,
  getAria2GlobalStat,
  getAria2Status,
  getGopeedTasks,
  getDownloaderLabel,
  sendTask: sendTaskToDownloader,
  testNeatdmConnection,
  testMotrixNextConnection,
  testGopeedConnection,
} = downloaderClients;

async function sendTask(taskInfo, extraOpts = {}, { openPopupOnFailure = false, shouldReportFailure = () => true } = {}) {
  const result = await sendTaskToDownloader(taskInfo, extraOpts);
  if (result?.ok) {
    clearUiAlert();
    return result;
  }

  const message = result?.error || buildConnectionFailureText(getDownloaderLabel(config.downloaderType));
  if (shouldReportFailure()) {
    setUiAlert({
      type: 'connection-failure',
      downloaderLabel: getDownloaderLabel(config.downloaderType),
      message,
    });
    if (openPopupOnFailure) await openTaskSurfaceForTask(taskInfo);
  }
  return {
    ...result,
    error: message,
    downloaderLabel: getDownloaderLabel(config.downloaderType),
  };
}

function updateActionBadgeForTab(tabId, count, isPaused = false) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    const isCaptureDisabled = !config.autoCapture;
    chrome.action.setBadgeBackgroundColor({ color: isCaptureDisabled || isPaused ? '#6b7280' : '#e05c2a', tabId });
    chrome.action.setBadgeTextColor?.({ color: '#ffffff', tabId });
    chrome.action.setBadgeText({ text: isCaptureDisabled ? 'OFF' : (count > 0 ? String(Math.min(count, 99)) : ''), tabId });
  } catch {}
}

function getActiveTabs() {
  return new Promise((resolve) => {
    if (!chrome.tabs?.query) {
      resolve([]);
      return;
    }
    try {
      const result = chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(Array.isArray(tabs) ? tabs : []);
      });
      if (result && typeof result.then === 'function') {
        result.then((tabs) => resolve(Array.isArray(tabs) ? tabs : [])).catch(() => resolve([]));
      }
    } catch {
      resolve([]);
    }
  });
}

async function syncMediaSniffingStateForTab(tabId, tabUrl = '') {
  if (typeof tabId !== 'number' || tabId < 0) return;
  if (!isMediaSniffingEnabled(config)) {
    mediaManager.pauseSniffing(tabId);
    autoCapturePausedTabs.add(tabId);
  } else if (autoCapturePausedTabs.has(tabId)) {
    mediaManager.resumeSniffing(tabId);
    autoCapturePausedTabs.delete(tabId);
  }
  const snapshot = tabUrl ? { url: tabUrl } : await getTabSnapshot(tabId);
  if (isMediaSniffingBlockedForUrl(snapshot.url, config)) {
    mediaBlacklistBlockedTabs.add(tabId);
    mediaManager.clearMediaResources(tabId);
  } else {
    mediaBlacklistBlockedTabs.delete(tabId);
  }
  const nextState = mediaManager.getState();
  updateActionBadgeForTab(
    tabId,
    nextState.media[tabId]?.length || 0,
    nextState.pausedTabs.includes(tabId) || mediaBlacklistBlockedTabs.has(tabId)
  );
}

async function syncMediaSniffingStateForActiveTabs() {
  const tabs = await getActiveTabs();
  for (const tab of tabs) await syncMediaSniffingStateForTab(tab?.id, tab?.url || '');
}

function getTabSnapshot(tabId) {
  return new Promise((resolve) => {
    if (typeof tabId !== 'number' || tabId < 0) {
      resolve({ title: '', url: '' });
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ title: '', url: '' });
        return;
      }
      resolve({ title: tab.title || '', url: tab.url || '' });
    });
  });
}

const mediaManager = mediaModule.createMediaManager({
  fallbackMediaFilename,
  escapeRegex: shared.escapeRegex,
  hashString: shared.hashString,
  totalSizeFromHeaders: shared.totalSizeFromHeaders,
  mediaKindOf: shared.mediaKindOf,
  deriveOrigin,
  updateActionBadgeForTab,
  broadcastUpdate,
  getRequestHeaders: (url) => requestHeadersCache.get(url)?.headers || {},
  getTabSnapshot,
});

async function pollTasks() {
  await configReady;
  if (!Object.keys(tasks).length) return;
  let gopeedTasksById = null;
  if (Object.values(tasks).some((task) => task?.provider === 'gopeed')) {
    try {
      const gopeedTasks = await getGopeedTasks();
      if (Array.isArray(gopeedTasks)) {
        gopeedTasksById = new Map(gopeedTasks.map((task) => [task.id, task]));
      }
    } catch {}
  }
  for (const gid of Object.keys(tasks)) {
    if (tasks[gid]?.provider === 'gopeed') {
      const status = gopeedTasksById?.get(gid);
      if (!status) continue;
      const taskOpts = status.meta?.opts || status.meta?.opt || {};
      const optName = taskOpts.name || '';
      const fileName = optName || status.meta?.res?.files?.[0]?.name || '';
      const filePath = status.meta?.res?.files?.[0]?.path || '';
      const mappedStatus = {
        ready: 'waiting',
        wait: 'waiting',
        running: 'active',
        pause: 'paused',
        done: 'complete',
        error: 'error',
      }[status.status] || status.status || tasks[gid].status;
      tasks[gid] = {
        ...tasks[gid],
        status: mappedStatus,
        totalLength: Number(status.size || status.meta?.res?.size) || 0,
        completedLength: Number(status.progress?.downloaded) || 0,
        downloadSpeed: Number(status.progress?.speed) || 0,
        connections: Number(taskOpts.extra?.connections) || 0,
        filePath: filePath || tasks[gid].filePath || '',
        dirPath: dirname(filePath || tasks[gid].filePath || ''),
        filename: fileName || tasks[gid].filename,
      };
      continue;
    }
    if (tasks[gid]?.provider && tasks[gid].provider !== 'aria2') continue;
    try {
      const status = await getAria2Status(gid);
      tasks[gid] = {
        ...tasks[gid],
        status: status.status,
        totalLength: parseInt(status.totalLength, 10) || 0,
        completedLength: parseInt(status.completedLength, 10) || 0,
        downloadSpeed: parseInt(status.downloadSpeed, 10) || 0,
        connections: parseInt(status.connections, 10) || 0,
        filePath: status.files?.[0]?.path || tasks[gid].filePath || '',
        dirPath: dirname(status.files?.[0]?.path || tasks[gid].filePath || ''),
        filename: status.files?.[0]?.path?.split(/[\\/]/).pop() || tasks[gid].filename,
      };
    } catch {}
  }
  broadcastUpdate();
}

setInterval(pollTasks, 1200);

// Safari 专用：webRequest blocking 取消下载，无 chrome.downloads API，无 extraHeaders

// media sniffing 作为 fire-and-forget 调用，避免占用 onHeadersReceived 的 cancel 返回值
function runMediaSniffing(details) {
  if (!isMediaSniffingEnabled(config)) return;
  (async () => {
    try {
      const tabSnapshot = await getTabSnapshot(details.tabId);
      if (isMediaSniffingBlockedForUrl(tabSnapshot.url || details.initiator || '', config)) {
        mediaBlacklistBlockedTabs.add(details.tabId);
        return;
      }
      mediaBlacklistBlockedTabs.delete(details.tabId);
      await mediaManager.handleMediaResponse(details);
    } catch (error) {
      console.warn('[Downlink][media] sniffing failed', error?.message || String(error));
    }
  })();
}

const requestHeaderExtraInfoSpec = ['requestHeaders'];
const responseHeaderExtraInfoSpec = ['responseHeaders'];
writeProbeLog('runtime detection', { runtime: 'safari', requestHeaderExtraInfoSpec, responseHeaderExtraInfoSpec, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'no navigator', hasDNR: Boolean(chrome.declarativeNetRequest), hasDNRDynamic: Boolean(chrome.declarativeNetRequest?.updateDynamicRules), hasWebRequestBlocking: false });

function handleSafariSendHeaders(details) {
    if (!config.autoCapture) return;
    const headers = {};
    for (const header of details.requestHeaders || []) headers[header.name.toLowerCase()] = header.value;
    const bridgeTargetUrl = safariLocalBridgeRequestTargetUrl(details.url);
    if (bridgeTargetUrl && details.type === 'other' && typeof details.tabId === 'number') {
      cleanExpired(dnrNavigationCandidates);
      const candidate = dnrNavigationCandidates.get(details.tabId);
      if (candidate && candidate.url !== bridgeTargetUrl) {
        writeProbeLog('local DNR other-resource request rejected for mismatched candidate', {
          tabId: details.tabId,
          url: bridgeTargetUrl,
          candidateUrl: candidate.url || '',
        });
        return;
      }
      if (candidate) dnrNavigationCandidates.delete(details.tabId);
      const navigationSource = getSafariNavigationSource(details.tabId, bridgeTargetUrl);
      const sourcePageUrl = String(candidate?.sourcePageUrl || navigationSource.sourcePageUrl || details.initiator || headers.referer || '');
      const referrer = String(candidate?.referrer || sourcePageUrl);
      writeProbeLog('local DNR other-resource takeover confirmed', {
        tabId: details.tabId,
        url: bridgeTargetUrl,
        sourcePageUrl,
      });
      captureSafariUrlDirectly({
        url: bridgeTargetUrl,
        referrer,
        sourcePageUrl,
        sourceFilename: candidate?.sourceFilename || filenameFromSafariRedirectUrl(bridgeTargetUrl),
        sourceTabId: candidate?.sourceTabId ?? navigationSource.sourceTabId,
        tabId: details.tabId,
        windowId: candidate?.sourceWindowId ?? navigationSource.sourceWindowId,
        captureSource: 'safari-local-dnr-other',
        captureReason: 'dnr-regex-substitution-other',
        openPendingSurface: true,
      }).then((result) => {
        writeProbeLog('local DNR other-resource takeover completed', {
          tabId: details.tabId,
          url: bridgeTargetUrl,
          ok: Boolean(result?.ok),
          pending: Boolean(result?.pending),
          error: result?.error || '',
        });
      }).catch(() => {});
      return;
    }
    const previewRequest = mediaManager.getActivePreviewRequestInfo(details.url);
    if (previewRequest) {
      const actualHeaders = Object.keys(headers);
      writeProbeLog('preview media request observed', {
        resourceType: details.type || '',
        tabId: details.tabId,
        modes: previewRequest.modes,
        expectedHeaders: previewRequest.expectedHeaders,
        observedExpectedHeaders: previewRequest.expectedHeaders.filter((name) => actualHeaders.includes(name)),
        missingHeaders: previewRequest.expectedHeaders.filter((name) => !actualHeaders.includes(name)),
      });
    }
    const clickIntent = getDownloadClickIntent(details.url);
    requestHeadersCache.set(details.url, {
      headers,
      method: details.method,
      tabId: details.tabId,
      sourceTabId: clickIntent?.tabId,
      sourceWindowId: clickIntent?.windowId,
      sourceFilename: clickIntent?.filename,
      sourcePageUrl: clickIntent?.pageUrl || details.initiator || headers.referer || '',
      expiresAt: Date.now() + 60000,
    });
    cleanExpired(requestHeadersCache);
}

try {
  chrome.webRequest.onSendHeaders.addListener(
    handleSafariSendHeaders,
    { urls: ['<all_urls>'] },
    requestHeaderExtraInfoSpec
  );
  writeProbeLog('onSendHeaders listener registered', { extraInfoSpec: requestHeaderExtraInfoSpec });
} catch (error) {
  writeProbeLog('onSendHeaders listener registration failed', {
    extraInfoSpec: requestHeaderExtraInfoSpec,
    message: error?.message || String(error),
    stack: error?.stack || '',
  });
}

// Safari 的 webRequest 只能观察响应；返回 { cancel: true } 不会可靠地停止下载。
// 响应头链路记录 302 目标，DNR 在目标请求发出前完成真正接管。
async function handleSafariHeadersReceived(details) {
    // media sniffing：fire-and-forget，不阻塞监听器返回值
    runMediaSniffing(details);
    if (await isSafariDnrBypassActive(details.tabId, details.url)) {
      // Keep the allow rule across 3xx hops. Once the terminal response has
      // passed DNR evaluation it is safe to remove the one-shot rule.
      if (!isRedirectStatus(details.statusCode)) {
        setTimeout(() => clearSafariDnrBypassRule(details.tabId).catch(() => {}), 1000);
      }
      writeProbeLog('Safari response left to browser by active bypass', {
        tabId: details.tabId,
        url: details.url,
        statusCode: details.statusCode,
      });
      return;
    }
    if (!config.autoCapture) return;

    const contentDisposition = getResponseHeaderValue(details.responseHeaders, 'content-disposition');
    const contentType = getResponseHeaderValue(details.responseHeaders, 'content-type');
    const redirectUrl = resolveRedirectUrl(details.url, getResponseHeaderValue(details.responseHeaders, 'location'));
    const totalBytes = parseResponseSize(details.responseHeaders);
    const requestMeta = requestHeadersCache.get(details.url) || {};
    const explicitAttachment = /attachment/i.test(contentDisposition);
    const downloadLikeRequest = isUserDownloadLikeResponse(details);

    // Playback segments and XHR/fetch resources may use configured download
    // suffixes such as .m4s, but they are not browser download navigations.
    // Keep media sniffing above, then leave these responses out of the download
    // caches, candidate map, and persistent probe log.
    if (!isRedirectStatus(details.statusCode) && !explicitAttachment && !downloadLikeRequest) return;

    if (contentDisposition || contentType) {
      responseHeadersCache.set(details.url, {
        contentDisposition,
        contentType,
        totalBytes,
        tabId: details.tabId,
        sourceTabId: requestMeta.sourceTabId,
        sourceWindowId: requestMeta.sourceWindowId,
        sourceFilename: requestMeta.sourceFilename,
        sourcePageUrl: requestMeta.sourcePageUrl || details.initiator || requestMeta.headers?.referer || '',
        expiresAt: Date.now() + 60000,
      });
      cleanExpired(responseHeadersCache);
    }

    if (isRedirectStatus(details.statusCode) && redirectUrl) {
      navigateSafariRedirectToDnrBridge(details, redirectUrl, 'onHeadersReceived');
      const existingIntent = getRedirectIntent(details.url);
      if (existingIntent) {
        redirectIntents.set(redirectUrl, {
          ...existingIntent,
          redirectUrl,
          expiresAt: Date.now() + 30000,
        });
        deleteRedirectIntent(details.url);
        return;
      }
      if (typeof requestMeta.sourceTabId === 'number') {
        rememberRedirectIntent(details.url, redirectUrl, details);
        return;
      }
      if (isLikelyDownloadRedirectCandidate(details, redirectUrl, contentDisposition)) {
        rememberRedirectIntent(details.url, redirectUrl, details);
        return;
      }
      if (isPostRedirectIntentCandidate(details, redirectUrl)) rememberRedirectIntent(details.url, redirectUrl, details);
      return;
    }

    if (details.statusCode && ![200, 206].includes(details.statusCode)) return;
    const redirectIntent = getRedirectIntent(details.url);
    if (isDownloadInterceptionBlockedForSource(
      redirectIntent?.sourcePageUrl,
      requestMeta.sourcePageUrl,
      details.initiator,
      requestMeta.headers?.referer
    )) {
      if (redirectIntent) deleteRedirectIntent(details.url, redirectIntent.sourceUrl, redirectIntent.redirectUrl);
      return;
    }

    const classification = classifyDownloadCandidate(config, {
      url: details.url,
      mime: contentType,
      contentDisposition,
      source: 'headers',
    });
    if (!classification.shouldCapture) { writeProbeLog('capture skip: shouldCapture=false', { url: details.url, mime: contentType, contentDisposition, byExt: classification.byExt, byMime: classification.byMime, byDisposition: classification.byDisposition, reason: classification.reason }); return; }

    const markedInfo = {
      filename: classification.filename,
      mime: classification.mime,
      contentDisposition,
      captureSource: redirectIntent ? 'redirect' : classification.source,
      captureReason: classification.reason,
      tabId: typeof redirectIntent?.tabId === 'number' ? redirectIntent.tabId : details.tabId,
      sourceTabId: typeof redirectIntent?.sourceTabId === 'number' ? redirectIntent.sourceTabId : requestMeta.sourceTabId,
      sourceWindowId: typeof redirectIntent?.sourceWindowId === 'number' ? redirectIntent.sourceWindowId : requestMeta.sourceWindowId,
      sourceFilename: redirectIntent?.sourceFilename || requestMeta.sourceFilename,
      sourcePageUrl: redirectIntent?.sourcePageUrl || requestMeta.sourcePageUrl || details.initiator || requestMeta.headers?.referer || '',
      size: totalBytes,
      expiresAt: Date.now() + 30000,
    };
    markedUrls.set(details.url, markedInfo);
    cleanExpired(markedUrls);
    if (redirectIntent) deleteRedirectIntent(details.url, redirectIntent.sourceUrl, redirectIntent.redirectUrl);
    writeProbeLog('download response observed without takeover', {
      url: details.url,
      reason: classification.reason,
      hasRedirectIntent: Boolean(redirectIntent),
    });
}

try {
  chrome.webRequest.onBeforeRedirect?.addListener?.(
    (details) => {
      isSafariDnrBypassActive(details.tabId, details.redirectUrl || details.url).then((bypassed) => {
        if (!bypassed) navigateSafariRedirectToDnrBridge(details, details.redirectUrl, 'onBeforeRedirect');
      }).catch(() => {});
    },
    { urls: ['<all_urls>'] }
  );
  writeProbeLog('onBeforeRedirect listener registered');
} catch (error) {
  writeProbeLog('onBeforeRedirect listener registration failed', {
    message: error?.message || String(error),
  });
}

try {
  chrome.webRequest.onHeadersReceived.addListener(
    handleSafariHeadersReceived,
    { urls: ['<all_urls>'] },
    responseHeaderExtraInfoSpec
  );
  writeProbeLog('onHeadersReceived listener registered', {
    mode: 'observe-only',
    extraInfoSpec: responseHeaderExtraInfoSpec,
  });
} catch (error) {
  writeProbeLog('onHeadersReceived blocking registration failed', {
    extraInfoSpec: responseHeaderExtraInfoSpec,
    message: error?.message || String(error),
    stack: error?.stack || '',
  });
  try {
    chrome.webRequest.onHeadersReceived.addListener(
      handleSafariHeadersReceived,
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );
    writeProbeLog('onHeadersReceived listener registered', {
      mode: 'non-blocking-fallback',
      extraInfoSpec: ['responseHeaders'],
    });
  } catch (fallbackError) {
    writeProbeLog('onHeadersReceived fallback registration failed', {
      message: fallbackError?.message || String(fallbackError),
      stack: fallbackError?.stack || '',
    });
  }
}

// media sniffing 已并入上方 blocking 监听器，避免 Safari 多监听器干扰 cancel 返回值
// Safari 无 chrome.downloads API，下载捕获完全由 webRequest blocking 完成

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await configReady;

    if (msg && msg.type === 'PROBE_PING') {
      writeProbeLog('probe ping received', { senderUrl: sender?.url || '' });
      sendResponse({ type: 'PROBE_PONG', at: new Date().toISOString() });
      return;
    }

    switch (msg.type) {
      case 'GET_STATE':
        {
          const mediaState = mediaManager.getState();
          const requestedTabId = Number.isInteger(msg.tabId) && msg.tabId >= 0 ? msg.tabId : null;
          const media = requestedTabId === null
            ? mediaState.media
            : { [requestedTabId]: mediaState.media[requestedTabId] || [] };
          sendResponse({ tasks, pending: pendingDownloads, media, pausedTabs: mediaState.pausedTabs, mediaBlacklistBlockedTabs: Array.from(mediaBlacklistBlockedTabs), config, hiddenTaskGids: Object.keys(hiddenTaskGids), uiAlert });
        }
        break;
      case 'TRACK_DOWNLOAD_CLICK':
        sendResponse({
          ok: rememberDownloadClickIntent({
            url: msg.url,
            filename: msg.filename,
            tabId: sender?.tab?.id,
            windowId: sender?.tab?.windowId,
            pageUrl: sender?.tab?.url,
          }),
        });
        break;
      case 'REGISTER_SAFARI_PAGE_CONTEXT':
        sendResponse({
          ok: rememberSafariCommittedPage(
            sender?.tab?.id,
            msg.url,
            sender?.tab?.windowId
          ),
        });
        break;
      case 'CAPTURE_LOCAL_DNR_BRIDGE': {
        const tabId = sender?.tab?.id;
        const openerTabId = sender?.tab?.openerTabId;
        const url = String(msg.url || '');
        const senderUrl = String(sender?.url || sender?.tab?.url || '');
        cleanExpired(dnrNavigationCandidates);
        const candidate = typeof tabId === 'number' ? dnrNavigationCandidates.get(tabId) : null;
        if (!isValidSafariLocalBridgeMessageContext(senderUrl, url, candidate)) {
          writeProbeLog('local DNR bridge message rejected for invalid document context', {
            tabId,
            url,
            senderUrl,
            candidateUrl: candidate?.url || '',
          });
          sendResponse({ ok: false, error: 'invalid-dnr-document-context' });
          break;
        }
        if (candidate) dnrNavigationCandidates.delete(tabId);
        const sourcePageUrl = String(candidate?.sourcePageUrl || msg.referrer || '');
        const stableSourcePageUrl = String(candidate?.stableSourcePageUrl || '');
        const referrer = String(candidate?.referrer || sourcePageUrl);
        if (!config.autoCapture || !isSafariDnrDownloadCandidate(url) || isDownloadInterceptionBlockedForSource(sourcePageUrl, referrer)) {
          const bypass = await installSafariDnrBypassRule(tabId, url);
          sendResponse({
            ok: false,
            error: 'download-not-eligible',
            bypass,
            resumeUrl: bypass ? url : '',
          });
          break;
        }
        writeProbeLog('local DNR bridge carried download target', {
          tabId,
          url,
          referrer,
          sourcePageUrl,
        });
        const result = await captureSafariUrlDirectly({
          url,
          referrer,
          sourcePageUrl,
          sourceFilename: candidate?.sourceFilename || filenameFromSafariRedirectUrl(url),
          sourceTabId: candidate?.sourceTabId ?? openerTabId,
          tabId,
          windowId: candidate?.sourceWindowId ?? sender?.tab?.windowId,
          captureSource: 'safari-local-dnr-bridge',
          captureReason: 'dnr-regex-substitution',
          openPendingSurface: false,
        });
        const sourceTabId = candidate?.sourceTabId ?? openerTabId;
        const recoveryMode = result?.ok ? scheduleSafariBridgeRecovery({
          tabId,
          sourceTabId,
          openerTabId,
          sourcePageUrl: stableSourcePageUrl,
          targetUrl: url,
        }) : '';
        const bridgeHandled = Boolean(result?.ok && recoveryMode);
        const closeBridgeTab = recoveryMode === 'close';
        sendResponse({ ...result, url, bridgeHandled, closeBridgeTab, recoveryMode });
        if (result?.pending && result?.key) scheduleSafariBridgePendingSurface(result.key);
        break;
      }
      case 'CAPTURE_DNR_DOWNLOAD': {
        const tabId = sender?.tab?.id;
        cleanExpired(dnrNavigationCandidates);
        const candidate = typeof tabId === 'number' ? dnrNavigationCandidates.get(tabId) : null;
        if (typeof tabId === 'number') dnrNavigationCandidates.delete(tabId);
        const url = String(candidate?.url || '');
        const sourcePageUrl = String(candidate?.sourcePageUrl || msg.referrer || '');
        const referrer = String(candidate?.referrer || sourcePageUrl);
        if (!config.autoCapture || !isSafariDnrDownloadCandidate(url) || isDownloadInterceptionBlockedForSource(sourcePageUrl)) {
          sendResponse({ ok: false, error: 'download-not-eligible', bypass: true });
          break;
        }
        writeProbeLog('DNR download bridge received navigation', {
          tabId,
          url,
          referrer,
          sourcePageUrl,
        });
        const result = await captureSafariUrlDirectly({
          url,
          referrer,
          sourcePageUrl,
          sourceFilename: candidate?.sourceFilename || '',
          sourceTabId: candidate?.sourceTabId,
          tabId,
          windowId: candidate?.sourceWindowId ?? sender?.tab?.windowId,
          captureSource: 'safari-dnr-bridge',
          captureReason: 'main-frame-redirect',
        });
        sendResponse({ ...result, url });
        break;
      }
      case 'OPEN_TASK_SURFACE':
        sendResponse({ ok: await openTaskSurface() });
        break;
      case 'CAPTURE_LINK_DOWNLOAD': {
        const url = String(msg.url || '');
        const sourcePageUrl = String(msg.referrer || sender?.tab?.url || '');
        let protocol = '';
        try {
          protocol = new URL(url).protocol;
        } catch {}
        if (!config.autoCapture || !['http:', 'https:'].includes(protocol) || isDownloadInterceptionBlockedForSource(sourcePageUrl)) {
          sendResponse({ ok: false, bypass: true });
          break;
        }

        const referrer = sourcePageUrl;
        const cachedRequest = requestHeadersCache.get(url) || {};
        const cookieHeader = await getCookieHeaderForUrl(url);
        const headers = { ...(cachedRequest.headers || {}) };
        if (cookieHeader) headers.cookie = cookieHeader;
        if (referrer && !headers.referer) headers.referer = referrer;
        if (!headers['user-agent'] && typeof navigator !== 'undefined' && navigator.userAgent) {
          headers['user-agent'] = navigator.userAgent;
        }
        const taskInfo = {
          key: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          url,
          filename: resolveCapturedFilename(msg.filename || filenameFromUrl(url), {
            sourceFilename: msg.filename || '',
            candidates: [filenameFromUrl(url)],
          }),
          headers,
          method: 'GET',
          origin: deriveOrigin(url, referrer),
          referrer,
          captureSource: 'safari-link-click',
          captureReason: 'pre-navigation',
          sourceTabId: sender?.tab?.id,
          sourceWindowId: sender?.tab?.windowId,
          sourcePageUrl,
          addedAt: Date.now(),
        };
        writeProbeLog('capture link before navigation', {
          url,
          filename: taskInfo.filename,
          sourceTabId: taskInfo.sourceTabId,
        });
        sendResponse(await queueOrSendCapturedDownload(taskInfo, {
          openPopupOnFailure: false,
          openPendingSurface: true,
        }));
        break;
      }
      case 'CONFIRM_DOWNLOAD': {
        const info = pendingDownloads[msg.key];
        if (!info) break;
        const result = await sendTask({ ...info, filename: msg.filename || info.filename }, msg.opts || {}, { openPopupOnFailure: false });
        if (result?.ok) delete pendingDownloads[msg.key];
        sendResponse(result);
        broadcastUpdate();
        break;
      }
      case 'REJECT_DOWNLOAD':
        delete pendingDownloads[msg.key];
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      case 'ADD_URL':
        sendResponse(await sendTask({
          url: msg.url,
          filename: msg.filename || '',
          headers: msg.headers || {},
          method: msg.method || 'GET',
          body: typeof msg.body === 'string' ? msg.body : undefined,
          labels: msg.labels || undefined,
          referrer: msg.referrer || '',
          addedAt: Date.now(),
        }, msg.opts || {}, { openPopupOnFailure: false }));
        break;
      case 'ADD_MEDIA_TASK': {
        const media = mediaManager.findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: t('mediaExpired', undefined, '媒体资源不存在或已过期。') });
          break;
        }
        sendResponse(await sendTask({
          url: media.resourceUrl,
          filename: msg.filename || media.filename || '',
          headers: media.headers || {},
          method: 'GET',
          mime: media.mime || '',
          contentDisposition: media.contentDisposition || '',
          referrer: media.referrer || media.headers?.referer || media.pageUrl || '',
          downloadPage: media.pageUrl || media.referrer || '',
          origin: media.origin || '',
          addedAt: Date.now(),
        }, { ...(msg.opts || {}), abDownloadMode: 'headless' }, { openPopupOnFailure: false }));
        break;
      }
      case 'GET_MEDIA_ITEM': {
        const media = mediaManager.findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: t('mediaExpired', undefined, '媒体资源不存在或已过期。') });
          break;
        }
        sendResponse({ ok: true, media });
        break;
      }
      case 'PREPARE_MEDIA_PREVIEW': {
        const media = mediaManager.findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: t('mediaExpired', undefined, '媒体资源不存在或已过期。') });
          break;
        }
        try {
          const result = await mediaManager.preparePreviewRule(msg.tabId, media);
          sendResponse({ ok: true, ...result });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || t('previewPatchFailed', undefined, '预览请求补头失败') });
        }
        break;
      }
      case 'PREPARE_MEDIA_METADATA': {
        const media = mediaManager.findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: t('mediaExpired', undefined, '媒体资源不存在或已过期。') });
          break;
        }
        try {
          const result = await mediaManager.prepareMetadataRule(media);
          sendResponse({ ok: true, ...result });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || t('previewPatchFailed', undefined, '预览请求补头失败') });
        }
        break;
      }
      case 'PREPARE_MEDIA_METADATA_BATCH': {
        const media = Array.from(new Set(msg.ids || []))
          .map((id) => mediaManager.findMediaResourceById(id))
          .filter(Boolean);
        if (!media.length) {
          sendResponse({ ok: false, error: t('mediaExpired', undefined, '媒体资源不存在或已过期。') });
          break;
        }
        try {
          sendResponse(await mediaManager.prepareMetadataRules(media));
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || t('previewPatchFailed', undefined, '预览请求补头失败') });
        }
        break;
      }
      case 'PREPARE_MEDIA_HOVER_PREVIEW': {
        const media = mediaManager.findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: t('mediaExpired', undefined, '媒体资源不存在或已过期。') });
          break;
        }
        try {
          const result = await mediaManager.prepareHoverPreviewRule(media);
          sendResponse({ ok: true, ...result });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || t('previewPatchFailed', undefined, '预览请求补头失败') });
        }
        break;
      }
      case 'CLEAR_MEDIA_PREVIEW':
        await mediaManager.clearPreviewRule(msg.tabId);
        sendResponse({ ok: true });
        break;
      case 'CLEAR_MEDIA_METADATA': {
        await mediaManager.clearMetadataRule(msg.id);
        sendResponse({ ok: true });
        break;
      }
      case 'CLEAR_MEDIA_HOVER_PREVIEW': {
        await mediaManager.clearHoverPreviewRule(msg.id);
        sendResponse({ ok: true });
        break;
      }
      case 'UPDATE_MEDIA_METADATA': {
        const updated = mediaManager.updateMediaMetadata(msg.id, {
          duration: typeof msg.duration === 'number' ? msg.duration : undefined,
          width: typeof msg.width === 'number' ? msg.width : undefined,
          height: typeof msg.height === 'number' ? msg.height : undefined,
          kind: ['audio', 'video', 'media'].includes(msg.kind) ? msg.kind : undefined,
          metadataFailed: typeof msg.metadataFailed === 'boolean' ? msg.metadataFailed : undefined,
        });
        if (!updated) {
          sendResponse({ ok: false });
          break;
        }
        sendResponse({ ok: true });
        break;
      }
      case 'CLEAR_MEDIA':
        mediaManager.clearMediaResources(msg.tabId);
        broadcastUpdate(msg.tabId);
        sendResponse({ ok: true });
        break;
      case 'ADD_SITE_TO_MEDIA_BLACKLIST': {
        const tabSnapshot = await getTabSnapshot(msg.tabId);
        const hostname = hostnameFromUrl(tabSnapshot.url);
        if (!hostname) {
          sendResponse({ ok: false, error: t('mediaBlacklistSiteUnavailable', undefined, '当前页面无法加入媒体嗅探黑名单') });
          break;
        }
        const mediaSniffingBlacklist = addHostnameToMediaSniffingBlacklist(config.mediaSniffingBlacklist, hostname);
        await saveConfigAndSync({ mediaSniffingBlacklist });
        await syncMediaSniffingStateForTab(msg.tabId, tabSnapshot.url);
        broadcastUpdate(msg.tabId);
        sendResponse({ ok: true, hostname, mediaSniffingBlacklist });
        break;
      }
      case 'REMOVE_SITE_FROM_MEDIA_BLACKLIST': {
        const tabSnapshot = await getTabSnapshot(msg.tabId);
        const hostname = hostnameFromUrl(tabSnapshot.url);
        if (!hostname) {
          sendResponse({ ok: false, error: t('mediaBlacklistSiteUnavailable', undefined, '当前页面无法修改媒体嗅探黑名单') });
          break;
        }
        if (normalizeMediaSniffingBlacklist(config.mediaSniffingBlacklist).split(',').includes('*')) {
          sendResponse({
            ok: false,
            globalDisabled: true,
            error: t('mediaBlacklistGlobalDisabled', undefined, '媒体嗅探已全局禁用，请在设置中删除 * 后再恢复'),
          });
          break;
        }
        const mediaSniffingBlacklist = removeHostnameFromMediaSniffingBlacklist(config.mediaSniffingBlacklist, hostname);
        await saveConfigAndSync({ mediaSniffingBlacklist });
        await syncMediaSniffingStateForTab(msg.tabId, tabSnapshot.url);
        broadcastUpdate(msg.tabId);
        sendResponse({ ok: true, hostname, mediaSniffingBlacklist });
        break;
      }
      case 'PAUSE_MEDIA_SNIFFING':
        mediaManager.pauseSniffing(msg.tabId);
        autoCapturePausedTabs.delete(msg.tabId);
        updateActionBadgeForTab(msg.tabId, mediaManager.getState().media[msg.tabId]?.length || 0, true);
        broadcastUpdate(msg.tabId);
        sendResponse({ ok: true });
        break;
      case 'RESUME_MEDIA_SNIFFING':
        if (!isMediaSniffingEnabled(config)) {
          await syncMediaSniffingStateForTab(msg.tabId);
          broadcastUpdate(msg.tabId);
          sendResponse({ ok: false, disabled: true });
          break;
        }
        await syncMediaSniffingStateForTab(msg.tabId);
        if (mediaBlacklistBlockedTabs.has(msg.tabId)) {
          broadcastUpdate(msg.tabId);
          sendResponse({ ok: false, disabled: true, blacklisted: true });
          break;
        }
        mediaManager.resumeSniffing(msg.tabId);
        autoCapturePausedTabs.delete(msg.tabId);
        updateActionBadgeForTab(msg.tabId, mediaManager.getState().media[msg.tabId]?.length || 0, false);
        broadcastUpdate(msg.tabId);
        sendResponse({ ok: true });
        break;
      case 'CLEAR_MEDIA_BADGE':
        if (typeof msg.tabId === 'number' && msg.tabId >= 0) {
          const state = mediaManager.getState();
          updateActionBadgeForTab(msg.tabId, state.media[msg.tabId]?.length || 0, state.pausedTabs.includes(msg.tabId));
        }
        sendResponse({ ok: true });
        break;
      case 'PAUSE_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) await aria2Call('pause', [msg.gid]).catch(() => {});
        sendResponse({ ok: true });
        break;
      case 'RESUME_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) await aria2Call('unpause', [msg.gid]).catch(() => {});
        sendResponse({ ok: true });
        break;
      case 'REMOVE_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) {
          await aria2Call('remove', [msg.gid]).catch(() => {});
          await aria2Call('removeDownloadResult', [msg.gid]).catch(() => {});
        }
        delete hiddenTaskGids[msg.gid];
        delete tasks[msg.gid];
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      case 'TEST_CONNECTION':
        const testConfig = getEffectiveConfig(msg.config);
        if (testConfig.downloaderType === 'abdownload') {
          try {
            const endpoint = buildExternalEndpoint(testConfig, '/queues');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), EXTERNAL_LAUNCHER_TIMEOUT_MS);
            let res;
            try {
              res = await fetch(endpoint, { signal: controller.signal });
            } finally {
              clearTimeout(timer);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            clearUiAlert();
            sendResponse({ ok: true, mode: 'abdownload', message: t('connectedToEndpoint', [endpoint], `已连接 ${endpoint}`) });
          } catch (error) {
            sendResponse({ ok: false, mode: 'abdownload', error: buildConnectionFailureText('AB DM') });
          }
          break;
        }
        if (testConfig.downloaderType === 'neatdm') {
          const result = await testNeatdmConnection();
          if (result?.ok) clearUiAlert();
          sendResponse(result);
          break;
        }
        if (testConfig.downloaderType === 'motrixnext') {
          const result = await testMotrixNextConnection(testConfig);
          if (result?.ok) clearUiAlert();
          sendResponse(result);
          break;
        }
        if (testConfig.downloaderType === 'gopeed') {
          const result = await testGopeedConnection(testConfig);
          if (result?.ok) clearUiAlert();
          sendResponse(result);
          break;
        }
        try {
          const stat = await getAria2GlobalStat(testConfig);
          clearUiAlert();
          sendResponse({ ok: true, stat, mode: 'aria2' });
        } catch (error) {
          sendResponse({ ok: false, error: buildConnectionFailureText('Aria2'), mode: 'aria2' });
        }
        break;
      case 'SAVE_CONFIG':
        await saveConfigAndSync(msg.config || {});
        sendResponse({ ok: true });
        break;
      case 'OPEN_MOTRIXNEXT_VIEW':
        sendResponse(await openMotrixNextView());
        break;
      case 'OPEN_GOPEED_VIEW':
        sendResponse(await openGopeedView());
        break;
    }
  })();

  return true;
});

chrome.commands?.onCommand?.addListener((command) => {
  if (command !== 'toggle-auto-capture') return;
  queueAutoCaptureToggle().catch((error) => {
    console.warn('[Downlink] failed to toggle auto capture from shortcut', error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  refreshContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await configReady;
  const url = info.linkUrl || tab?.url;
  if (!url) return;
  if (info.menuItemId === 'send-to-aria2' && isLanrarVerificationDownloadUrl(url)) {
    writeProbeLog('context menu opening verification download page', {
      url,
      sourceTabId: tab?.id,
    });
    try {
      await chrome.tabs.create({
        url,
        active: true,
        ...(typeof tab?.id === 'number' ? { openerTabId: tab.id } : {}),
      });
    } catch {
      if (typeof tab?.id === 'number') await chrome.tabs.update(tab.id, { url });
    }
    return;
  }
  const reqHeaders = { ...(requestHeadersCache.get(url)?.headers || {}) };
  const cookieHeader = await getCookieHeaderForUrl(url);
  if (cookieHeader) reqHeaders.cookie = cookieHeader;
  if (tab?.url && !reqHeaders.referer) reqHeaders.referer = tab.url;
  if (!reqHeaders['user-agent'] && typeof navigator !== 'undefined' && navigator.userAgent) {
    reqHeaders['user-agent'] = navigator.userAgent;
  }
  const taskInfo = {
    url,
    filename: url.split('?')[0].split('/').pop() || '',
    headers: reqHeaders,
    method: requestHeadersCache.get(url)?.method || 'GET',
    referrer: reqHeaders.referer || tab?.url || '',
    sourceTabId: tab?.id,
    sourceWindowId: tab?.windowId,
    addedAt: Date.now(),
  };
  if (config.downloaderType === 'aria2' || config.downloaderType === 'gopeed') {
    if (shouldConfirmBeforeSend()) {
      await enqueuePendingDownload(taskInfo);
      return;
    }
  }
  await sendTask(taskInfo, {}, { openPopupOnFailure: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  autoCapturePausedTabs.delete(tabId);
  mediaBlacklistBlockedTabs.delete(tabId);
  safariCommittedTabPages.delete(tabId);
  safariCreatedNavigationSources.delete(tabId);
  dnrNavigationCandidates.delete(tabId);
  mediaManager.clearTabState(tabId);
  mediaManager.clearPreviewRule(tabId);
});

chrome.windows?.onRemoved?.addListener?.((windowId) => {
  if (windowId === taskFallbackWindowId) taskFallbackWindowId = null;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  syncMediaSniffingStateForTab(tabId).then(() => broadcastUpdate()).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  mediaManager.clearTabState(tabId);
  autoCapturePausedTabs.delete(tabId);
  mediaBlacklistBlockedTabs.delete(tabId);
  syncMediaSniffingStateForTab(tabId).then(() => broadcastUpdate()).catch(() => {});
  mediaManager.clearPreviewRule(tabId);
});

chrome.runtime.onStartup.addListener(async () => {
  await configReady;
  if (config.downloaderType !== 'aria2') return;
  try {
    for (const status of await aria2Call('tellActive')) {
      const filePath = status.files?.[0]?.path || '';
      tasks[status.gid] = {
        gid: status.gid,
        url: status.files?.[0]?.uris?.[0]?.uri || '',
        filename: filePath.split(/[\\/]/).pop() || '',
        filePath,
        dirPath: dirname(filePath),
        addedAt: Date.now(),
        status: status.status,
      };
    }
  } catch {}
});

globalThis.isDirectMediaResource = isDirectMediaResource;
globalThis.openMotrixNextView = openMotrixNextView;
globalThis.openGopeedView = openGopeedView;
globalThis.getBackgroundConfig = () => config;
globalThis.__backgroundTestHooks = {
  setUiAlert,
  clearUiAlert,
  pollTasks,
  openTaskSurface,
  waitForAutoCaptureToggle: () => autoCaptureTogglePromise,
  mediaManager,
};
