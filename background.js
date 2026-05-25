// background.js — Downlink Service Worker
// 拆分为：基础工具 / 下载器适配 / 事件注册

try {
  importScripts(
    'filename-logic.js',
    'lib/i18n.js',
    'lib/background-shared.js',
    'lib/background-downloaders.js',
    'lib/background-media.js'
  );
} catch {}

const LEGACY_DEFAULT_CAPTURE_EXTENSIONS = 'zip,rar,7z,tar,gz,bz2,xz,iso,dmg,exe,msi,deb,pkg,apk,mp4,m4s,mkv,avi,mov,webm,mp3,flac,wav,pdf,torrent';
const DEFAULT_CAPTURE_EXTENSIONS = `${LEGACY_DEFAULT_CAPTURE_EXTENSIONS},esd,cab,msu,wim`;

const DEFAULT_CONFIG = {
  language: 'auto',
  downloaderType: 'aria2',
  aria2Rpc: 'http://localhost:6800/jsonrpc',
  aria2Secret: '',
  aria2Silent: false,
  useMotrixNext: false,
  motrixBridgeAutoClose: false,
  motrixNextPort: '16801',
  motrixNextSecret: '',
  externalLauncherName: 'AB DM',
  externalLauncherHost: 'localhost',
  externalLauncherPort: '15151',
  externalLauncherPath: '/start-headless-download',
  abDownloadSilent: false,
  autoCapture: true,
  captureBypassModifier: 'alt',
  captureExtensions: DEFAULT_CAPTURE_EXTENSIONS,
  captureMime: true,
  skipSmallDownloads: false,
  smallDownloadThresholdBytes: 1048576,
  saveDir: '',
};
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
} = shared;

let config = { ...DEFAULT_CONFIG };
let tasks = {};
let pendingDownloads = {};
let hiddenTaskGids = {};
let uiAlert = null;
let taskSurfaceWindowId = null;
let taskSurfaceOpenPromise = null;

const markedUrls = new Map();
const responseCaptureClaims = new Map();
const bypassCaptureClicks = new Map();
const requestHeadersCache = new Map();
const responseHeadersCache = new Map();
const redirectIntents = new Map();
const EXTERNAL_LAUNCHER_TIMEOUT_MS = 3000;
let contextMenuRefreshVersion = 0;

function normalizeCaptureExtensionsConfig(value) {
  const normalized = String(value || '').replace(/\s+/g, '').toLowerCase();
  if (normalized === LEGACY_DEFAULT_CAPTURE_EXTENSIONS) return DEFAULT_CAPTURE_EXTENSIONS;
  return value;
}

function normalizeConfig(nextConfig = {}) {
  return {
    ...nextConfig,
    externalLauncherName: 'AB DM',
    captureExtensions: normalizeCaptureExtensionsConfig(nextConfig.captureExtensions),
  };
}

function applyLocaleFromConfig(nextConfig = config) {
  i18n.setLocalePreference?.(nextConfig.language || 'auto');
}

function refreshContextMenus() {
  const refreshVersion = ++contextMenuRefreshVersion;

  function safeCreateContextMenu(item) {
    chrome.contextMenus.create(item, () => {
      // Avoid noisy duplicate-id errors when multiple refreshes overlap.
      void chrome.runtime.lastError;
    });
  }

  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    if (refreshVersion !== contextMenuRefreshVersion) return;
    safeCreateContextMenu({ id: 'send-to-aria2', title: t('menuDownloadLink', undefined, '用当前下载器下载链接'), contexts: ['link'] });
    safeCreateContextMenu({ id: 'send-page-to-aria2', title: t('menuDownloadPage', undefined, '用当前下载器下载当前页面'), contexts: ['page'] });
  });
}

function buildConnectionFailureText(label) {
  return t('connectionFailedWithLabel', [label], `与 ${label} 连接失败，检查 ${label} 是否正在运行`);
}

function shouldConfirmBeforeSend() {
  return config.downloaderType === 'aria2' && !config.aria2Silent;
}

function normalizeBypassUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url).split('#')[0];
  }
}

function normalizeBypassShortcut(value) {
  const tokens = String(value || '')
    .toLowerCase()
    .replace(/control/g, 'ctrl')
    .replace(/option/g, 'alt')
    .replace(/command|cmd|meta/g, 'cmd')
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (tokens.includes('none') || tokens.includes('off')) return 'none';
  const ordered = ['ctrl', 'alt', 'shift', 'cmd'].filter((key) => tokens.includes(key));
  return ordered.join('+') || DEFAULT_CONFIG.captureBypassModifier;
}

function cleanBypassCaptureClicks() {
  cleanExpired(bypassCaptureClicks);
}

function markBypassCaptureClick({ url, modifier, tabId } = {}) {
  const expectedModifier = normalizeBypassShortcut(config.captureBypassModifier || DEFAULT_CONFIG.captureBypassModifier);
  if (expectedModifier === 'none' || normalizeBypassShortcut(modifier) !== expectedModifier) return false;
  const scopedTabId = typeof tabId === 'number' ? tabId : 'global';
  const key = normalizeBypassUrl(url) || `__next__:${scopedTabId}:${expectedModifier}`;
  bypassCaptureClicks.set(key, {
    modifier,
    tabId: typeof tabId === 'number' ? tabId : undefined,
    expiresAt: Date.now() + 10000,
  });
  cleanBypassCaptureClicks();
  return true;
}

function shouldBypassAutoCapture(item, url, marked, { consume = true } = {}) {
  cleanBypassCaptureClicks();
  const requestMeta = requestHeadersCache.get(url) || requestHeadersCache.get(item?.url) || requestHeadersCache.get(item?.finalUrl);
  const markedTabId = typeof marked?.tabId === 'number' && marked.tabId >= 0 ? marked.tabId : undefined;
  const requestTabId = typeof requestMeta?.tabId === 'number' && requestMeta.tabId >= 0 ? requestMeta.tabId : undefined;
  const sourceTabId = markedTabId ?? requestTabId;
  const candidates = [url, item?.url, item?.finalUrl].map(normalizeBypassUrl).filter(Boolean);
  for (const candidate of candidates) {
    const marker = bypassCaptureClicks.get(candidate);
    if (!marker) continue;
    if (typeof marker.tabId === 'number' && typeof sourceTabId === 'number' && marker.tabId !== sourceTabId) continue;
    if (consume) bypassCaptureClicks.delete(candidate);
    return true;
  }
  for (const [key] of bypassCaptureClicks) {
    if (!String(key).startsWith('__next__:')) continue;
    const marker = bypassCaptureClicks.get(key);
    if (typeof marker?.tabId === 'number' && typeof sourceTabId === 'number' && marker.tabId !== sourceTabId) continue;
    if (typeof marker?.tabId === 'number' && typeof sourceTabId !== 'number') continue;
    if (consume) bypassCaptureClicks.delete(key);
    return true;
  }
  return false;
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
  if (taskSurfaceOpenPromise) return taskSurfaceOpenPromise;

  taskSurfaceOpenPromise = (async () => {
    if (taskSurfaceWindowId !== null) {
      try {
        if (chrome.windows?.update) await chrome.windows.update(taskSurfaceWindowId, { focused: true });
        return true;
      } catch {
        taskSurfaceWindowId = null;
      }
    }

    try {
      await chrome.action.openPopup();
      return true;
    } catch {
      try {
        if (taskSurfaceWindowId !== null) {
          if (chrome.windows?.update) await chrome.windows.update(taskSurfaceWindowId, { focused: true });
          return true;
        }
        if (chrome.windows?.create) {
          const win = await chrome.windows.create({
            url: chrome.runtime.getURL('popup.html'),
            type: 'popup',
            width: 420,
            height: 720,
          });
          if (typeof win?.id === 'number') taskSurfaceWindowId = win.id;
          return true;
        }
      } catch {}
      try {
        await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
        return true;
      } catch {
        return false;
      }
    }
  })();

  try {
    return await taskSurfaceOpenPromise;
  } finally {
    taskSurfaceOpenPromise = null;
  }
}

async function enqueuePendingDownload(taskInfo, { openSurface = true } = {}) {
  const key = taskInfo?.key || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  pendingDownloads[key] = { ...taskInfo, key };
  broadcastUpdate();
  if (openSurface) await openTaskSurface();
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

function getSmallDownloadThresholdBytes(cfg = config) {
  const raw = Number(cfg.smallDownloadThresholdBytes);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONFIG.smallDownloadThresholdBytes;
}

function shouldSkipSmallDownloadSize(totalBytes, cfg = config) {
  if (!cfg.skipSmallDownloads) return false;
  const size = Number(totalBytes);
  if (!Number.isFinite(size) || size <= 0) return false;
  return size < getSmallDownloadThresholdBytes(cfg);
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

async function queueOrSendCapturedDownload(taskInfo, { openPopupOnFailure = true, shouldReportFailure } = {}) {
  if (shouldConfirmBeforeSend()) {
    const key = await enqueuePendingDownload(taskInfo);
    return { ok: true, pending: true, key };
  }
  return sendTask(taskInfo, {}, { openPopupOnFailure, shouldReportFailure });
}

function rememberResponseCaptureClaim(url, promise, { cancelBrowserDownloadImmediately = false, claimState } = {}) {
  if (!url) return;
  responseCaptureClaims.set(url, {
    promise,
    cancelBrowserDownloadImmediately,
    claimState,
    expiresAt: Date.now() + 30000,
  });
  cleanExpired(responseCaptureClaims);
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

function cancelBrowserDownloadItem(item = {}) {
  if (typeof item.id !== 'number') return;
  chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
}

const configReady = new Promise((resolve) => {
  chrome.storage.sync.get(DEFAULT_CONFIG, (stored) => {
    config = normalizeConfig({ ...DEFAULT_CONFIG, ...stored });
    applyLocaleFromConfig(config);
    refreshContextMenus();
    resolve(config);
  });
});

chrome.storage.onChanged.addListener((changes) => {
  for (const key in changes) config[key] = changes[key].newValue;
  config = normalizeConfig(config);
  applyLocaleFromConfig(config);
  if (changes.language) refreshContextMenus();
});

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
  });
}

function buildMotrixNextDeepLink() {
  return 'motrixnext://';
}

function buildMotrixNextBridgeUrl() {
  return chrome.runtime.getURL('motrix-open.html');
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

function broadcastUpdate() {
  const mediaState = mediaManager.getState();
  chrome.runtime.sendMessage({
    type: 'TASKS_UPDATE',
    tasks,
    pending: pendingDownloads,
    media: mediaState.media,
    pausedTabs: mediaState.pausedTabs,
    hiddenTaskGids: Object.keys(hiddenTaskGids),
    uiAlert,
  }).catch(() => {});
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
});

const {
  aria2Call,
  buildExternalEndpoint,
  getAria2GlobalStat,
  getAria2Status,
  getDownloaderLabel,
  sendTask: sendTaskToDownloader,
  testNeatdmConnection,
  testMotrixNextConnection,
} = downloaderClients;

async function sendTask(taskInfo, extraOpts = {}, { openPopupOnFailure = false, shouldReportFailure = () => true } = {}) {
  const result = await sendTaskToDownloader(taskInfo, extraOpts);
  if (result?.ok) {
    clearUiAlert();
    return result;
  }

  const message = result?.error || buildConnectionFailureText(getDownloaderLabel(config.downloaderType));
  if (shouldReportFailure()) {
    setUiAlert({ type: 'connection-failure', message });
    if (openPopupOnFailure) await openTaskSurface();
  }
  return { ...result, error: message };
}

function updateActionBadgeForTab(tabId, count, isPaused = false) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    chrome.action.setBadgeBackgroundColor({ color: isPaused ? '#6b7280' : '#e05c2a', tabId });
    chrome.action.setBadgeTextColor?.({ color: '#ffffff', tabId });
    chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '', tabId });
  } catch {}
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
  for (const gid of Object.keys(tasks)) {
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

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!config.autoCapture) return;
    const headers = {};
    for (const header of details.requestHeaders || []) headers[header.name.toLowerCase()] = header.value;
    requestHeadersCache.set(details.url, { headers, method: details.method, tabId: details.tabId, expiresAt: Date.now() + 60000 });
    cleanExpired(requestHeadersCache);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!config.autoCapture) return;

    const contentDisposition = getResponseHeaderValue(details.responseHeaders, 'content-disposition');
    const contentType = getResponseHeaderValue(details.responseHeaders, 'content-type');
    const redirectUrl = resolveRedirectUrl(details.url, getResponseHeaderValue(details.responseHeaders, 'location'));
    const totalBytes = parseResponseSize(details.responseHeaders);

    if (contentDisposition || contentType) {
      responseHeadersCache.set(details.url, {
        contentDisposition,
        contentType,
        totalBytes,
        tabId: details.tabId,
        expiresAt: Date.now() + 60000,
      });
      cleanExpired(responseHeadersCache);
    }

    if (isRedirectStatus(details.statusCode) && redirectUrl) {
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
      if (isPostRedirectIntentCandidate(details, redirectUrl)) rememberRedirectIntent(details.url, redirectUrl, details);
      return;
    }

    if (details.statusCode && ![200, 206].includes(details.statusCode)) return;

    const classification = classifyDownloadCandidate(config, {
      url: details.url,
      mime: contentType,
      contentDisposition,
      source: 'headers',
    });
    if (!classification.shouldCapture) return;
    const redirectIntent = getRedirectIntent(details.url);

    markedUrls.set(details.url, {
      filename: classification.filename,
      mime: classification.mime,
      contentDisposition,
      captureSource: redirectIntent ? 'redirect' : classification.source,
      captureReason: classification.reason,
      tabId: typeof redirectIntent?.tabId === 'number' ? redirectIntent.tabId : details.tabId,
      size: totalBytes,
      expiresAt: Date.now() + 30000,
    });
    cleanExpired(markedUrls);

    const bypassItem = { url: details.url, finalUrl: details.url };
    if (shouldBypassAutoCapture(bypassItem, details.url, { tabId: details.tabId }, { consume: false })) return;

    if (!shouldSendFromResponseHeaders(details, classification, redirectIntent)) return;
    if (shouldSkipSmallDownloadSize(totalBytes, config)) return;

    const existingClaim = getResponseCaptureClaim(details.url);
    if (existingClaim) return;

    const reqHeaders = requestHeadersCache.get(details.url)?.headers || redirectIntent?.headers || {};
    const key = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const taskInfo = {
      key,
      url: details.url,
      filename: decodeHttpFilename(preferredUrlFilename(filenameFromUrl(details.url)) || classification.filename || filenameFromUrl(details.url) || ''),
      size: totalBytes,
      mime: classification.mime,
      contentDisposition,
      captureSource: redirectIntent ? 'redirect' : classification.source,
      captureReason: classification.reason,
      headers: reqHeaders,
      origin: reqHeaders.origin || deriveOrigin(details.url, reqHeaders.referer || redirectIntent?.sourceUrl || ''),
      referrer: reqHeaders.referer || redirectIntent?.sourceUrl || '',
      addedAt: Date.now(),
    };

    const claimState = { discarded: false };
    const claimPromise = (async () => {
      const result = await queueOrSendCapturedDownload(taskInfo, {
        openPopupOnFailure: true,
        shouldReportFailure: () => !claimState.discarded,
      });
      return { handled: Boolean(result?.ok), result };
    })().catch((error) => ({ handled: false, result: { ok: false, error: error?.message || String(error) } }));
    const claimOptions = { cancelBrowserDownloadImmediately: true, claimState };
    rememberResponseCaptureClaim(details.url, claimPromise, claimOptions);
    if (redirectIntent) {
      rememberResponseCaptureClaim(redirectIntent.sourceUrl, claimPromise, claimOptions);
      if (redirectIntent.redirectUrl && redirectIntent.redirectUrl !== details.url) rememberResponseCaptureClaim(redirectIntent.redirectUrl, claimPromise, claimOptions);
      deleteRedirectIntent(details.url, redirectIntent.sourceUrl, redirectIntent.redirectUrl);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => mediaManager.handleMediaResponse(details),
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.downloads.onDeterminingFilename?.addListener(async (item, suggest) => {
  if (!config.autoCapture || item.state === 'complete') {
    suggest?.();
    return;
  }

  const url = item.finalUrl || item.url;
  const marked = markedUrls.get(url) || markedUrls.get(item.url);
  if (shouldBypassAutoCapture(item, url, marked)) {
    discardResponseCaptureClaim(url, item.url, item.finalUrl);
    if (marked) {
      markedUrls.delete(url);
      markedUrls.delete(item.url);
    }
    suggest?.();
    return;
  }

  const responseClaim = getResponseCaptureClaim(url, item.url, item.finalUrl);
  if (responseClaim) {
    if (responseClaim.cancelBrowserDownloadImmediately) {
      cancelBrowserDownloadItem(item);
      markedUrls.delete(url);
      markedUrls.delete(item.url);
      suggest?.();
      return;
    }
    await responseClaim.promise;
    cancelBrowserDownloadItem(item);
    markedUrls.delete(url);
    markedUrls.delete(item.url);
  }

  suggest?.();
});

chrome.downloads.onCreated.addListener(async (item) => {
  await configReady;
  if (!config.autoCapture || item.state === 'complete') return;

  const url = item.finalUrl || item.url;
  const marked = markedUrls.get(url) || markedUrls.get(item.url);
  if (shouldBypassAutoCapture(item, url, marked)) {
    discardResponseCaptureClaim(url, item.url, item.finalUrl);
    if (marked) {
      markedUrls.delete(url);
      markedUrls.delete(item.url);
    }
    return;
  }

  const responseClaim = getResponseCaptureClaim(url, item.url, item.finalUrl);
  if (responseClaim) {
    await responseClaim.promise;
    deleteResponseCaptureClaim(url, item.url, item.finalUrl);
    cancelBrowserDownloadItem(item);
    markedUrls.delete(url);
    markedUrls.delete(item.url);
    return;
  }

  const browserFilename = item.filename ? decodeHttpFilename(item.filename.split(/[\\/]/).pop()) : '';
  const urlFilename = filenameFromUrl(url);
  const urlPreferredFilename = preferredUrlFilename(urlFilename);
  const cachedResponse = getCachedResponseHeaders(url, item.url);
  const headerFilename = filenameFromCD(marked?.contentDisposition || cachedResponse.contentDisposition || '');
  const headerPreferredFilename = preferredUrlFilename(headerFilename);
  const markedPreferredFilename = preferredUrlFilename(marked?.filename || '');
  const classification = classifyDownloadCandidate(config, {
    url,
    filename: urlPreferredFilename || headerPreferredFilename || browserFilename || headerFilename,
    mime: item.mime || cachedResponse.contentType || '',
    contentDisposition: marked?.contentDisposition || cachedResponse.contentDisposition || '',
    source: 'browser-download',
  });
  if (!marked && !classification.shouldCapture) return;
  if (shouldSkipSmallDownloadSize(item.totalBytes || cachedResponse.totalBytes, config)) {
    if (marked) {
      markedUrls.delete(url);
      markedUrls.delete(item.url);
    }
    return;
  }

  cancelBrowserDownloadItem(item);

  const filename = decodeHttpFilename(urlPreferredFilename || headerPreferredFilename || browserFilename || markedPreferredFilename || classification.filename || headerFilename || urlFilename || '');
  const reqHeaders = requestHeadersCache.get(url)?.headers || requestHeadersCache.get(item.url)?.headers || {};

  if (marked) {
    markedUrls.delete(url);
    markedUrls.delete(item.url);
  }

  const key = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const taskInfo = {
    key,
    url,
    filename,
    size: item.totalBytes || cachedResponse.totalBytes || 0,
    mime: marked?.mime || cachedResponse.contentType || '',
    contentDisposition: marked?.contentDisposition || cachedResponse.contentDisposition || '',
    captureSource: marked?.captureSource || classification.source,
    captureReason: marked?.captureReason || classification.reason,
    headers: reqHeaders,
    origin: reqHeaders.origin || deriveOrigin(url, reqHeaders.referer || ''),
    referrer: reqHeaders.referer || '',
    addedAt: Date.now(),
  };

  if (shouldConfirmBeforeSend()) {
    await enqueuePendingDownload(taskInfo);
    return;
  }

  await sendTask(taskInfo, {}, { openPopupOnFailure: true });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await configReady;

    switch (msg.type) {
      case 'GET_STATE':
        sendResponse({ tasks, pending: pendingDownloads, media: mediaManager.getState().media, pausedTabs: mediaManager.getState().pausedTabs, config, hiddenTaskGids: Object.keys(hiddenTaskGids), uiAlert });
        break;
      case 'BYPASS_NEXT_DOWNLOAD':
        sendResponse({
          ok: markBypassCaptureClick({
            url: msg.url,
            modifier: msg.modifier,
            tabId: sender?.tab?.id,
          }),
        });
        break;
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
      case 'CLEAR_MEDIA_PREVIEW':
        await mediaManager.clearPreviewRule(msg.tabId);
        sendResponse({ ok: true });
        break;
      case 'CLEAR_MEDIA_METADATA': {
        await mediaManager.clearMetadataRule(msg.id);
        sendResponse({ ok: true });
        break;
      }
      case 'UPDATE_MEDIA_METADATA': {
        const updated = mediaManager.updateMediaMetadata(msg.id, {
          duration: typeof msg.duration === 'number' ? msg.duration : undefined,
          width: typeof msg.width === 'number' ? msg.width : undefined,
          height: typeof msg.height === 'number' ? msg.height : undefined,
          kind: ['audio', 'video', 'media'].includes(msg.kind) ? msg.kind : undefined,
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
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      case 'PAUSE_MEDIA_SNIFFING':
        mediaManager.pauseSniffing(msg.tabId);
        updateActionBadgeForTab(msg.tabId, mediaManager.getState().media[msg.tabId]?.length || 0, true);
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      case 'RESUME_MEDIA_SNIFFING':
        mediaManager.resumeSniffing(msg.tabId);
        updateActionBadgeForTab(msg.tabId, mediaManager.getState().media[msg.tabId]?.length || 0, false);
        broadcastUpdate();
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
        try {
          const stat = await getAria2GlobalStat(testConfig);
          clearUiAlert();
          sendResponse({ ok: true, stat, mode: 'aria2' });
        } catch (error) {
          sendResponse({ ok: false, error: buildConnectionFailureText('Aria2'), mode: 'aria2' });
        }
        break;
      case 'SAVE_CONFIG':
        const savedConfig = { ...msg.config };
        await chrome.storage.sync.set(savedConfig);
        config = { ...config, ...savedConfig };
        sendResponse({ ok: true });
        break;
      case 'OPEN_MOTRIXNEXT_VIEW':
        sendResponse(await openMotrixNextView());
        break;
    }
  })();

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  refreshContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await configReady;
  const url = info.linkUrl || tab?.url;
  if (!url) return;
  const reqHeaders = requestHeadersCache.get(url)?.headers || {};
  const taskInfo = {
    url,
    filename: url.split('?')[0].split('/').pop() || '',
    headers: reqHeaders,
    referrer: reqHeaders.referer || tab?.url || '',
    addedAt: Date.now(),
  };
  if (config.downloaderType === 'motrixnext') {
    await sendTask(taskInfo, {}, { openPopupOnFailure: true });
    return;
  }
  await enqueuePendingDownload(taskInfo);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaManager.clearTabState(tabId);
  mediaManager.clearPreviewRule(tabId);
});

chrome.windows?.onRemoved?.addListener((windowId) => {
  if (windowId === taskSurfaceWindowId) taskSurfaceWindowId = null;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const state = mediaManager.getState();
  updateActionBadgeForTab(tabId, state.media[tabId]?.length || 0, state.pausedTabs.includes(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  mediaManager.clearTabState(tabId);
  updateActionBadgeForTab(tabId, 0);
  mediaManager.clearPreviewRule(tabId);
  broadcastUpdate();
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
globalThis.getBackgroundConfig = () => config;
globalThis.__backgroundTestHooks = {
  setUiAlert,
  clearUiAlert,
  openTaskSurface,
  mediaManager,
};
