// background.js — Downlink Service Worker
// 拆分为：基础工具 / 下载器适配 / 事件注册

try {
  importScripts(
    'filename-logic.js',
    'lib/config-defaults.js',
    'lib/i18n.js',
    'lib/background-shared.js',
    'lib/background-downloaders.js',
    'lib/background-media.js'
  );
} catch {}

const {
  LEGACY_DEFAULT_CAPTURE_EXTENSIONS,
  DEFAULT_CAPTURE_EXTENSIONS,
} = globalThis.ConfigDefaults;
const DEFAULT_MEDIA_SNIFFING_BLACKLIST = 'x.com,youtube.com';
const DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST = 'web.telegram.org';
const DEFAULT_ARIA2_TRACKER_SUBSCRIPTION = 'https://ngosang.github.io/trackerslist/trackers_best.txt';

const DEFAULT_CONFIG = {
  language: 'auto',
  downloaderType: 'aria2',
  aria2Rpc: 'http://localhost:6800/jsonrpc',
  aria2Secret: '',
  aria2Profiles: [],
  aria2ActiveProfileId: '',
  aria2Silent: false,
  aria2CustomSaveEnabled: false,
  aria2SaveLocations: [],
  aria2TrackerSubscriptions: [DEFAULT_ARIA2_TRACKER_SUBSCRIPTION],
  aria2Trackers: [],
  aria2TrackersUpdatedAt: 0,
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
  skipSmallDownloads: false,
  smallDownloadThresholdBytes: 1048576,
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
const EXTERNAL_LAUNCHER_TIMEOUT_MS = 3000;
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

const ARIA2_ORIGINAL_URI_STORAGE_KEY = 'aria2OriginalUris';
const MAX_ARIA2_ORIGINAL_URI_RECORDS = 2000;
const ARIA2_TASK_META_STORAGE_KEY = 'aria2TaskMeta';
const MAX_ARIA2_TASK_META_RECORDS = 2000;
const ARIA2_TASK_RESULT_METHODS = new Set(['tellActive', 'tellWaiting', 'tellStopped', 'tellStatus']);
let aria2OriginalUris = {};
let aria2OriginalUrisReady = Promise.resolve();
let aria2OriginalUrisWrite = Promise.resolve();
let aria2TaskMeta = {};
let aria2TaskMetaReady = Promise.resolve();
let aria2TaskMetaWrite = Promise.resolve();

function normalizeAria2OriginalUris(value) {
  if (!Array.isArray(value)) return [];
  return value.map((uri) => String(uri || '').trim()).filter(Boolean);
}

async function loadAria2OriginalUris() {
  try {
    const stored = await storageGet(chrome.storage.local, { [ARIA2_ORIGINAL_URI_STORAGE_KEY]: {} });
    const saved = stored?.[ARIA2_ORIGINAL_URI_STORAGE_KEY];
    if (!saved || typeof saved !== 'object') return;
    aria2OriginalUris = Object.fromEntries(
      Object.entries(saved)
        .map(([gid, uris]) => [String(gid), normalizeAria2OriginalUris(uris)])
        .filter(([, uris]) => uris.length),
    );
  } catch {
    aria2OriginalUris = {};
  }
}

aria2OriginalUrisReady = loadAria2OriginalUris();

function normalizeAria2TaskMeta(value) {
  const addedAt = Number(value?.addedAt) || 0;
  return addedAt > 0 ? { addedAt } : null;
}

async function loadAria2TaskMeta() {
  try {
    const stored = await storageGet(chrome.storage.local, { [ARIA2_TASK_META_STORAGE_KEY]: {} });
    const saved = stored?.[ARIA2_TASK_META_STORAGE_KEY];
    if (!saved || typeof saved !== 'object') return;
    aria2TaskMeta = Object.fromEntries(
      Object.entries(saved)
        .map(([gid, meta]) => [String(gid), normalizeAria2TaskMeta(meta)])
        .filter(([, meta]) => meta),
    );
  } catch {
    aria2TaskMeta = {};
  }
}

aria2TaskMetaReady = loadAria2TaskMeta();

function getAria2TaskAddedAt(gid) {
  const key = String(gid || '').trim();
  return Number(aria2TaskMeta[key]?.addedAt) || Number(tasks[key]?.addedAt) || 0;
}

function rememberAria2TaskAddedAtIfMissing(gid) {
  const key = String(gid || '').trim();
  const existing = getAria2TaskAddedAt(key);
  if (!key || existing > 0) return { addedAt: existing, write: Promise.resolve() };

  const addedAt = Date.now();
  aria2TaskMeta[key] = { addedAt, source: 'first-observed' };
  return { addedAt, write: rememberAria2TaskAddedAt(key, addedAt) };
}

function rememberAria2TaskAddedAt(gid, addedAt = Date.now()) {
  const key = String(gid || '').trim();
  const value = Number(addedAt) || 0;
  if (!key || value <= 0) return Promise.resolve();

  aria2TaskMetaWrite = aria2TaskMetaWrite
    .catch(() => {})
    .then(async () => {
      await aria2TaskMetaReady;
      aria2TaskMeta[key] = { addedAt: value };
      const keys = Object.keys(aria2TaskMeta);
      if (keys.length > MAX_ARIA2_TASK_META_RECORDS) {
        keys
          .sort((a, b) => aria2TaskMeta[a].addedAt - aria2TaskMeta[b].addedAt)
          .slice(0, keys.length - MAX_ARIA2_TASK_META_RECORDS)
          .forEach((oldKey) => delete aria2TaskMeta[oldKey]);
      }
      await storageSet(chrome.storage.local, { [ARIA2_TASK_META_STORAGE_KEY]: aria2TaskMeta });
    })
    .catch((error) => {
      console.warn('[Downlink][aria2] failed to persist task creation time', error);
    });
  return aria2TaskMetaWrite;
}

function forgetAria2TaskAddedAt(gids) {
  const keys = (Array.isArray(gids) ? gids : [gids])
    .map((gid) => String(gid || '').trim())
    .filter(Boolean);
  if (!keys.length) return Promise.resolve();

  aria2TaskMetaWrite = aria2TaskMetaWrite
    .catch(() => {})
    .then(async () => {
      await aria2TaskMetaReady;
      keys.forEach((key) => delete aria2TaskMeta[key]);
      await storageSet(chrome.storage.local, { [ARIA2_TASK_META_STORAGE_KEY]: aria2TaskMeta });
    })
    .catch((error) => {
      console.warn('[Downlink][aria2] failed to remove task creation time', error);
    });
  return aria2TaskMetaWrite;
}

function getAria2OriginalUris(gid) {
  const remembered = normalizeAria2OriginalUris(aria2OriginalUris[String(gid || '')]);
  if (remembered.length) return remembered;
  const taskUrl = String(tasks[String(gid || '')]?.url || '').trim();
  return taskUrl ? [taskUrl] : [];
}

function rememberAria2OriginalUris(gid, uris) {
  const key = String(gid || '').trim();
  const normalized = normalizeAria2OriginalUris(uris);
  if (!key || !normalized.length) return Promise.resolve();

  aria2OriginalUrisWrite = aria2OriginalUrisWrite
    .catch(() => {})
    .then(async () => {
      await aria2OriginalUrisReady;
      aria2OriginalUris[key] = normalized;
      const keys = Object.keys(aria2OriginalUris);
      if (keys.length > MAX_ARIA2_ORIGINAL_URI_RECORDS) {
        keys.slice(0, keys.length - MAX_ARIA2_ORIGINAL_URI_RECORDS).forEach((oldKey) => {
          delete aria2OriginalUris[oldKey];
        });
      }
      await storageSet(chrome.storage.local, { [ARIA2_ORIGINAL_URI_STORAGE_KEY]: aria2OriginalUris });
    })
    .catch((error) => {
      console.warn('[Downlink][aria2] failed to persist original URI', error);
    });
  return aria2OriginalUrisWrite;
}

function forgetAria2OriginalUris(gids) {
  const keys = (Array.isArray(gids) ? gids : [gids])
    .map((gid) => String(gid || '').trim())
    .filter(Boolean);
  if (!keys.length) return Promise.resolve();

  aria2OriginalUrisWrite = aria2OriginalUrisWrite
    .catch(() => {})
    .then(async () => {
      await aria2OriginalUrisReady;
      keys.forEach((key) => delete aria2OriginalUris[key]);
      await storageSet(chrome.storage.local, { [ARIA2_ORIGINAL_URI_STORAGE_KEY]: aria2OriginalUris });
    })
    .catch((error) => {
      console.warn('[Downlink][aria2] failed to remove original URI', error);
    });
  return aria2OriginalUrisWrite;
}

async function attachAria2OriginalUris(result) {
  await Promise.all([aria2OriginalUrisReady, aria2TaskMetaReady]);
  const attach = async (task) => {
    if (!task || typeof task !== 'object') return task;
    const taskTime = rememberAria2TaskAddedAtIfMissing(task.gid);
    await taskTime.write;
    const addedAt = taskTime.addedAt;
    const enrichedTask = !task.addedTime && addedAt > 0
      ? { ...task, addedTime: String(Math.floor(addedAt / 1000)) }
      : task;
    const uris = getAria2OriginalUris(task.gid);
    return uris.length ? { ...enrichedTask, downlinkOriginalUris: uris } : enrichedTask;
  };
  return Array.isArray(result) ? Promise.all(result.map(attach)) : attach(result);
}

function loadStoredConfigCallback(callback) {
  let settled = false;
  const finish = (stored) => {
    if (settled) return;
    settled = true;
    callback(stored || DEFAULT_CONFIG);
  };
  const finishWithLocalConfig = (stored) => {
    // Local settings include saves made while sync was unavailable.
    // Read them over sync defaults so restarting cannot restore stale ports.
    const cacheDefaults = { ...DEFAULT_CONFIG, ...stored };
    try {
      const localResult = chrome.storage.local?.get?.(cacheDefaults, (cached) => {
        finish({ ...stored, ...cached });
      });
      if (localResult && typeof localResult.then === 'function') {
        localResult.then((cached) => finish({ ...stored, ...cached })).catch(() => finish(stored));
      }
      if (!chrome.storage.local?.get) finish(stored);
    } catch {
      finish(stored);
    }
  };
  const fallbackToLocal = () => {
    try {
      const localResult = chrome.storage.local?.get?.(DEFAULT_CONFIG, (stored) => finish(stored));
      if (localResult && typeof localResult.then === 'function') {
        localResult.then((stored) => finish(stored)).catch(() => finish(DEFAULT_CONFIG));
      }
      if (!chrome.storage.local?.get) finish(DEFAULT_CONFIG);
    } catch {
      finish(DEFAULT_CONFIG);
    }
  };

  try {
    const syncResult = chrome.storage.sync?.get?.(DEFAULT_CONFIG, (stored) => {
      const error = getRuntimeLastErrorMessage();
      if (error) fallbackToLocal();
      else finishWithLocalConfig(stored);
    });
    if (syncResult && typeof syncResult.then === 'function') {
      syncResult.then((stored) => finishWithLocalConfig(stored)).catch(fallbackToLocal);
    }
    if (!chrome.storage.sync?.get) fallbackToLocal();
  } catch {
    fallbackToLocal();
  }
}

async function saveStoredConfig(nextConfig) {
  // A successful save must be durable on this device, regardless of sync.
  await storageSet(chrome.storage.local, nextConfig);
  const syncConfig = { ...nextConfig };
  for (const key of ['aria2Trackers', 'aria2TrackersUpdatedAt']) {
    if (!Object.prototype.hasOwnProperty.call(syncConfig, key)) continue;
    delete syncConfig[key];
  }
  try {
    if (Object.keys(syncConfig).length) await storageSet(chrome.storage.sync, syncConfig);
    return 'sync';
  } catch {
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

function isAria2TrackerUrl(value) {
  return /^(https?|udp|ws|wss):\/\//i.test(String(value || '').trim());
}

function normalizeAria2TrackerSubscriptions(subscriptions = []) {
  if (!Array.isArray(subscriptions)) return [];
  const unique = [];
  for (const item of subscriptions) {
    const value = String(item || '').trim();
    if (value && !unique.includes(value)) unique.push(value);
  }
  return unique;
}

function normalizeAria2Trackers(trackers = []) {
  if (!Array.isArray(trackers)) return [];
  const unique = [];
  for (const item of trackers) {
    const value = String(item || '').trim();
    if (isAria2TrackerUrl(value) && !unique.includes(value)) unique.push(value);
  }
  return unique;
}

function normalizeConfig(nextConfig = {}) {
  const normalized = {
    ...nextConfig,
    aria2CustomSaveEnabled: !!nextConfig.aria2CustomSaveEnabled,
    aria2SaveLocations: normalizeAria2SaveLocations(nextConfig.aria2SaveLocations),
    aria2TrackerSubscriptions: nextConfig.aria2TrackerSubscriptions === undefined
      ? [DEFAULT_ARIA2_TRACKER_SUBSCRIPTION]
      : normalizeAria2TrackerSubscriptions(nextConfig.aria2TrackerSubscriptions),
    aria2Trackers: normalizeAria2Trackers(nextConfig.aria2Trackers),
    aria2TrackersUpdatedAt: Math.max(0, Number(nextConfig.aria2TrackersUpdatedAt) || 0),
    externalLauncherName: 'AB DM',
    externalLauncherHost: 'localhost',
    mediaSniffingBlacklist: nextConfig.mediaSniffing === false
      ? '*'
      : String(nextConfig.mediaSniffingBlacklist || '').trim(),
    downloadInterceptionBlacklist: String(nextConfig.downloadInterceptionBlacklist || '').trim(),
    captureExtensions: normalizeCaptureExtensionsConfig(nextConfig.captureExtensions),
  };
  delete normalized.mediaSniffing;
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
  // Keep legacy connection editors and every download adapter on the active profile.
  if ('aria2Rpc' in nextConfig || 'aria2Secret' in nextConfig || 'aria2Profiles' in nextConfig) {
    const merged = { ...config, ...nextConfig };
    const profiles = Array.isArray(merged.aria2Profiles) ? merged.aria2Profiles.map((item) => ({ ...item })) : [];
    if (!profiles.length) profiles.push({ id: 'default', name: '默认配置', rpc: merged.aria2Rpc, secret: merged.aria2Secret });
    const active = profiles.find((item) => item.id === merged.aria2ActiveProfileId) || profiles[0];
    active.rpc = merged.aria2Rpc;
    active.secret = merged.aria2Secret;
    nextConfig = { ...nextConfig, aria2Profiles: profiles, aria2ActiveProfileId: active.id };
  }
  let storedConfig = nextConfig;
  if (nextConfig.mediaSniffing === false) {
    storedConfig = { ...nextConfig, mediaSniffing: true, mediaSniffingBlacklist: '*' };
  } else if (Object.prototype.hasOwnProperty.call(nextConfig, 'mediaSniffingBlacklist')) {
    storedConfig = { ...nextConfig, mediaSniffing: true };
  }
  await saveStoredConfig(storedConfig);
  config = normalizeConfig({ ...config, ...nextConfig });
  applyLocaleFromConfig(config);
  if (
    previousAutoCapture !== config.autoCapture ||
    previousMediaSniffingEnabled !== isMediaSniffingEnabled(config) ||
    previousMediaSniffingBlacklist !== config.mediaSniffingBlacklist
  ) {
    await syncMediaSniffingStateForActiveTabs();
    broadcastUpdate();
  }
  return config;
}

const ARIA2_TRACKER_FETCH_TIMEOUT_MS = 8000;
const ARIA2_TRACKER_AUTO_REFRESH_MS = 24 * 60 * 60 * 1000;
let aria2TrackerRefreshQueue = Promise.resolve();
const aria2TrackerRefreshJobs = new Map();

function parseTrackerSubscriptionText(text = '') {
  const candidates = String(text || '').match(/(?:https?|udp|ws|wss):\/\/[^\s"'<>,;]+/gi) || [];
  const trackers = [];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim().replace(/[)\]}>.,;:!?]+$/, '');
    if (isAria2TrackerUrl(value) && !trackers.includes(value)) trackers.push(value);
  }
  return trackers;
}

async function fetchAria2TrackerSubscription(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARIA2_TRACKER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(String(url), { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const trackers = parseTrackerSubscriptionText(await response.text());
    if (!trackers.length) throw new Error('未解析到有效 Tracker');
    return trackers;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function refreshAria2TrackersFromSubscriptions({ force = true } = {}) {
  const subscriptions = normalizeAria2TrackerSubscriptions(config.aria2TrackerSubscriptions);
  if (!force && Date.now() - config.aria2TrackersUpdatedAt < ARIA2_TRACKER_AUTO_REFRESH_MS) {
    return Promise.resolve({ ok: true, trackers: config.aria2Trackers, failed: [], updated: false, cached: true });
  }
  const refreshKey = JSON.stringify(subscriptions);
  if (aria2TrackerRefreshJobs.has(refreshKey)) return aria2TrackerRefreshJobs.get(refreshKey);

  const refreshJob = aria2TrackerRefreshQueue
    .catch(() => {})
    .then(async () => {
      if (!subscriptions.length) {
        if (config.aria2Trackers?.length || config.aria2TrackersUpdatedAt) {
          await saveConfigAndSync({ aria2Trackers: [], aria2TrackersUpdatedAt: 0 });
        }
        return { ok: true, trackers: [], failed: [], updated: false };
      }

      const results = await Promise.allSettled(subscriptions.map(async (url) => {
        const trackers = await fetchAria2TrackerSubscription(url);
        return { url, trackers };
      }));

      const merged = [];
      const failed = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          merged.push(...result.value.trackers);
        } else {
          failed.push({
            url: subscriptions[index],
            error: result.reason?.message || String(result.reason),
          });
        }
      });
      const successfulCount = results.length - failed.length;
      if (!successfulCount) {
        return { ok: true, trackers: config.aria2Trackers, failed, updated: false, preserved: true };
      }
      const trackers = normalizeAria2Trackers(failed.length ? [...merged, ...config.aria2Trackers] : merged);
      const updatedAt = Date.now();
      await saveConfigAndSync({ aria2Trackers: trackers, aria2TrackersUpdatedAt: updatedAt });
      return { ok: true, trackers, failed, updated: true, updatedAt };
    });
  aria2TrackerRefreshQueue = refreshJob;
  aria2TrackerRefreshJobs.set(refreshKey, refreshJob);
  const clearRefreshJob = () => {
    if (aria2TrackerRefreshJobs.get(refreshKey) === refreshJob) aria2TrackerRefreshJobs.delete(refreshKey);
  };
  refreshJob.then(clearRefreshJob, clearRefreshJob);
  return refreshJob;
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
  return openTaskSurface();
}

async function closeFirefoxInterceptedDownloadTab(taskInfo = {}, reason = '') {
  if (!isFirefoxRuntime || typeof taskInfo.downloadTabId !== 'number' || taskInfo.downloadTabId < 0) return false;
  if (typeof taskInfo.sourceTabId === 'number') return false;

  const tab = await getTab(taskInfo.downloadTabId);
  if (typeof tab?.openerTabId !== 'number' || tab.openerTabId < 0) {
    console.info('[Downlink][firefox-tab] keep intercepted download tab because opener is unknown', {
      tabId: taskInfo.downloadTabId,
      url: taskInfo.url || '',
      reason,
    });
    return false;
  }

  try {
    console.info('[Downlink][firefox-tab] closing intercepted download tab', {
      tabId: taskInfo.downloadTabId,
      openerTabId: tab.openerTabId,
      url: taskInfo.url || '',
      reason,
    });
    await chrome.tabs?.remove?.(taskInfo.downloadTabId);
    return true;
  } catch (error) {
    console.warn('[Downlink][firefox-tab] failed to close intercepted download tab', {
      tabId: taskInfo.downloadTabId,
      error: error?.message || String(error),
      reason,
    });
    return false;
  }
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

function firstKnownSize(...values) {
  for (const value of values) {
    const size = Number(value);
    if (Number.isFinite(size) && size > 0) return size;
  }
  return 0;
}

function shouldDeferBrowserDownloadCaptureForFilename(item = {}, filenames = {}) {
  if (isFirefoxRuntime || typeof item.id !== 'number') return false;
  if (item.filename) return false;
  if (filenames.headerPreferredFilename || filenames.markedPreferredFilename || filenames.browserFilename) return false;
  return Boolean(chrome.downloads.onDeterminingFilename?.addListener);
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
  if (shouldSkipSmallDownloadSize(firstKnownSize(item.totalBytes, marked?.size, cachedResponse.totalBytes), config)) {
    if (marked) {
      markedUrls.delete(url);
      markedUrls.delete(item.url);
    }
    return false;
  }

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
  console.info('[Downlink][browser-download] erase browser download record', {
    id: downloadId,
    reason,
  });
  chrome.downloads.erase({ id: downloadId }, () => {
    const ignoredError = chrome.runtime.lastError;
    if (ignoredError) {
      console.warn('[Downlink][browser-download] erase browser download record failed', {
        id: downloadId,
        reason,
        error: ignoredError.message || String(ignoredError),
      });
    }
  });
}

function cancelBrowserDownloadItem(item = {}, reason = 'captured-download') {
  if (typeof item.id !== 'number') return Promise.resolve({ cancelled: false, reason: 'missing-id' });
  const summary = describeBrowserDownloadItem(item);
  console.info('[Downlink][browser-download] cancel browser download requested', {
    ...summary,
    reason,
  });

  return new Promise((resolve) => {
    if (!isDownloadInProgress(item)) {
      console.info('[Downlink][browser-download] browser download already stopped before cancel', {
        ...summary,
        reason,
      });
      eraseBrowserDownloadItem(item.id, `${reason}:not-in-progress`);
      resolve({ cancelled: false, reason: 'not-in-progress' });
      return;
    }

    const cancel = () => {
      console.info('[Downlink][browser-download] calling chrome.downloads.cancel', {
        id: item.id,
        reason,
      });
      chrome.downloads.cancel(item.id, () => {
        const ignoredError = chrome.runtime.lastError;
        if (ignoredError) {
          console.warn('[Downlink][browser-download] chrome.downloads.cancel failed', {
            id: item.id,
            reason,
            error: ignoredError.message || String(ignoredError),
          });
        } else {
          console.info('[Downlink][browser-download] chrome.downloads.cancel completed', {
            id: item.id,
            reason,
          });
        }
        eraseBrowserDownloadItem(item.id, reason);
        resolve({ cancelled: !ignoredError, error: ignoredError?.message || '' });
      });
    };

    if (!chrome.downloads.search) {
      console.info('[Downlink][browser-download] chrome.downloads.search unavailable, cancel directly', {
        id: item.id,
        reason,
      });
      cancel();
      return;
    }

    chrome.downloads.search({ id: item.id }, (items = []) => {
      const searchError = chrome.runtime.lastError;
      if (searchError) {
        console.warn('[Downlink][browser-download] chrome.downloads.search failed before cancel', {
          id: item.id,
          reason,
          error: searchError.message || String(searchError),
        });
        cancel();
        return;
      }
      const current = items?.[0];
      if (!current || !isDownloadInProgress(current)) {
        console.info('[Downlink][browser-download] browser download missing or not active when rechecked', {
          ...describeBrowserDownloadItem(current || item),
          found: Boolean(current),
          reason,
        });
        eraseBrowserDownloadItem(item.id, `${reason}:not-active-on-recheck`);
        resolve({ cancelled: false, reason: 'not-active-on-recheck' });
        return;
      }
      cancel();
    });
  });
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

let syncConfigChangesQueue = Promise.resolve();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName && !['sync', 'local'].includes(areaName)) return;
  if (areaName === 'sync') {
    const values = {};
    for (const [key, change] of Object.entries(changes)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) continue;
      if (['aria2Trackers', 'aria2TrackersUpdatedAt'].includes(key)) continue;
      values[key] = change.newValue === undefined ? DEFAULT_CONFIG[key] : change.newValue;
    }
    if (!Object.keys(values).length) return;
    // Commit incoming sync updates to the same store used on restart.
    // The resulting local onChanged event applies the durable values.
    syncConfigChangesQueue = syncConfigChangesQueue.then(() => storageSet(chrome.storage.local, values))
      .catch((error) => console.warn('[Downlink] failed to persist synced settings', error));
    return syncConfigChangesQueue;
  }
  const previousMediaSniffingEnabled = isMediaSniffingEnabled(config);
  const previousAutoCapture = config.autoCapture;
  for (const key in changes) config[key] = changes[key].newValue;
  config = normalizeConfig(config);
  applyLocaleFromConfig(config);
  if (changes.language) refreshContextMenus();
  const autoCaptureChanged = changes.autoCapture && previousAutoCapture !== config.autoCapture;
  const mediaSniffingEnabledChanged = changes.autoCapture && previousMediaSniffingEnabled !== isMediaSniffingEnabled(config);
  if (autoCaptureChanged || mediaSniffingEnabledChanged || changes.mediaSniffingBlacklist || changes.mediaSniffing) {
    syncMediaSniffingStateForActiveTabs().then(() => {
      broadcastUpdate();
    }).catch(() => {});
  } else if (changes.aria2Profiles || changes.aria2ActiveProfileId || changes.aria2Rpc || changes.aria2Secret || changes.aria2CustomSaveEnabled || changes.aria2SaveLocations) {
    broadcastUpdate();
  }
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
const ARIA2_MANAGER_METHODS = new Set([
  'getGlobalStat',
  'tellActive',
  'tellWaiting',
  'tellStopped',
  'tellStatus',
  'pause',
  'pauseAll',
  'unpause',
  'unpauseAll',
  'remove',
  'forceRemove',
  'purgeDownloadResult',
  'removeDownloadResult',
  'changeGlobalOption',
  'getGlobalOption',
  'addUri',
  'getOption',
]);
const ARIA2_REMOVE_METHODS = new Set(['remove', 'forceRemove', 'removeDownloadResult']);
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
    const addedAt = taskInfo.addedAt || Date.now();
    tasks[gid] = {
      gid,
      url: taskInfo.url,
      filename: taskInfo.filename,
      addedAt,
      status: 'active',
      provider: 'aria2',
    };
    delete hiddenTaskGids[gid];
    broadcastUpdate();
    return Promise.all([
      rememberAria2OriginalUris(gid, [taskInfo.url]),
      rememberAria2TaskAddedAt(gid, addedAt),
    ]);
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

function observeTabScopedActionCall(result, operation, tabId) {
  if (!result || typeof result.catch !== 'function') return;
  result.catch((error) => {
    const message = error?.message || String(error || '');
    // A tab can disappear between a webRequest/tab event and this badge update.
    // Chromium reports that normal race as a rejected Promise, not a sync throw.
    if (/\bNo tab with id\b/i.test(message)) return;
    console.warn('[Downlink][badge] failed to update tab badge', {
      operation,
      tabId,
      error: message,
    });
  });
}

function updateActionBadgeForTab(tabId, count, isPaused = false) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    const isCaptureDisabled = !config.autoCapture;
    observeTabScopedActionCall(
      chrome.action.setBadgeBackgroundColor({ color: isCaptureDisabled || isPaused ? '#6b7280' : '#e05c2a', tabId }),
      'setBadgeBackgroundColor',
      tabId
    );
    observeTabScopedActionCall(
      chrome.action.setBadgeTextColor?.({ color: '#ffffff', tabId }),
      'setBadgeTextColor',
      tabId
    );
    observeTabScopedActionCall(
      chrome.action.setBadgeText({ text: isCaptureDisabled ? '✕' : (count > 0 ? String(Math.min(count, 99)) : ''), tabId }),
      'setBadgeText',
      tabId
    );
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

const isFirefoxRuntime = Boolean(chrome.runtime.getBrowserInfo || globalThis.browser?.runtime?.getBrowserInfo);
const requestHeaderExtraInfoSpec = isFirefoxRuntime
  ? ['requestHeaders']
  : ['requestHeaders', 'extraHeaders'];
const responseHeaderExtraInfoSpec = isFirefoxRuntime
  ? ['responseHeaders', 'blocking']
  : ['responseHeaders', 'extraHeaders'];

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!config.autoCapture) return;
    const headers = {};
    for (const header of details.requestHeaders || []) headers[header.name.toLowerCase()] = header.value;
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
  },
  { urls: ['<all_urls>'] },
  requestHeaderExtraInfoSpec
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!config.autoCapture) return;

    const contentDisposition = getResponseHeaderValue(details.responseHeaders, 'content-disposition');
    const contentType = getResponseHeaderValue(details.responseHeaders, 'content-type');
    const redirectUrl = resolveRedirectUrl(details.url, getResponseHeaderValue(details.responseHeaders, 'location'));
    const totalBytes = parseResponseSize(details.responseHeaders);
    const requestMeta = requestHeadersCache.get(details.url) || {};

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
    if (!classification.shouldCapture) return;

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

    if (!shouldSendFromResponseHeaders(details, classification, redirectIntent)) return;
    if (shouldSkipSmallDownloadSize(totalBytes, config)) return;

    const captureResponse = () => {
      const existingClaim = getResponseCaptureClaim(details.url);
      if (existingClaim) return undefined;

      const reqHeaders = requestMeta.headers || redirectIntent?.headers || {};
      const key = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const responseSourceFilename = redirectIntent?.sourceFilename || requestMeta.sourceFilename;
      const responseUrlFilename = filenameFromUrl(details.url);
      const responsePrimaryFilename = classification.filename || preferredUrlFilename(responseUrlFilename) || responseUrlFilename || '';
      const taskInfo = {
        key,
        url: details.url,
        filename: resolveCapturedFilename(responsePrimaryFilename, {
          sourceFilename: responseSourceFilename,
          mime: classification.mime,
          candidates: [classification.filename, responseUrlFilename],
        }),
        size: totalBytes,
        mime: classification.mime,
        contentDisposition,
        captureSource: redirectIntent ? 'redirect' : classification.source,
        captureReason: classification.reason,
        headers: reqHeaders,
        method: redirectIntent?.method || requestMeta.method || 'GET',
        origin: reqHeaders.origin || deriveOrigin(details.url, reqHeaders.referer || redirectIntent?.sourceUrl || ''),
        referrer: reqHeaders.referer || redirectIntent?.sourceUrl || '',
        downloadTabId: typeof redirectIntent?.tabId === 'number' ? redirectIntent.tabId : details.tabId,
        sourceTabId: typeof redirectIntent?.sourceTabId === 'number' ? redirectIntent.sourceTabId : requestMeta.sourceTabId,
        sourceWindowId: typeof redirectIntent?.sourceWindowId === 'number' ? redirectIntent.sourceWindowId : requestMeta.sourceWindowId,
        sourceFilename: responseSourceFilename,
        sourcePageUrl: redirectIntent?.sourcePageUrl || requestMeta.sourcePageUrl || details.initiator || reqHeaders.referer || '',
        addedAt: Date.now(),
      };

      const deferPendingSurfaceUntilBrowserCancel =
        !isFirefoxRuntime &&
        shouldConfirmBeforeSend() &&
        typeof taskInfo.sourceTabId !== 'number';
      const claimState = { discarded: false, taskInfo };
      const browserCancelGate = createResponseCaptureGate(!isFirefoxRuntime && !shouldConfirmBeforeSend());
      const claimPromise = (async () => {
        await browserCancelGate.promise;
        const result = await queueOrSendCapturedDownload(taskInfo, {
          openPopupOnFailure: true,
          openPendingSurface: !deferPendingSurfaceUntilBrowserCancel,
          shouldReportFailure: () => !claimState.discarded,
        });
        return { handled: Boolean(result?.ok), result };
      })().catch((error) => ({ handled: false, result: { ok: false, error: error?.message || String(error) } }));
      const claimOptions = { cancelBrowserDownloadImmediately: true, claimState, browserCancelGate };
      rememberResponseCaptureClaim(details.url, claimPromise, claimOptions);
      if (redirectIntent) {
        rememberResponseCaptureClaim(redirectIntent.sourceUrl, claimPromise, claimOptions);
        if (redirectIntent.redirectUrl && redirectIntent.redirectUrl !== details.url) rememberResponseCaptureClaim(redirectIntent.redirectUrl, claimPromise, claimOptions);
        deleteRedirectIntent(details.url, redirectIntent.sourceUrl, redirectIntent.redirectUrl);
      }
      if (isFirefoxRuntime) {
        claimPromise.then(() => closeFirefoxInterceptedDownloadTab(taskInfo, 'response-headers-cancel'));
      }
      return isFirefoxRuntime ? { cancel: true } : undefined;
    };

    return captureResponse();
  },
  { urls: ['<all_urls>'] },
  responseHeaderExtraInfoSpec
);

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (!isMediaSniffingEnabled(config)) return;
    const tabSnapshot = await getTabSnapshot(details.tabId);
    if (isMediaSniffingBlockedForUrl(tabSnapshot.url || details.initiator || '', config)) {
      mediaBlacklistBlockedTabs.add(details.tabId);
      return;
    }
    mediaBlacklistBlockedTabs.delete(details.tabId);
    return mediaManager.handleMediaResponse(details);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

if (!isFirefoxRuntime && chrome.downloads.onDeterminingFilename?.addListener) {
  chrome.downloads.onDeterminingFilename.addListener(async (item, suggest) => {
    let didSuggest = false;
    const safeSuggest = () => {
      if (didSuggest) return;
      didSuggest = true;
      suggest?.();
    };

    if (!config.autoCapture || !isDownloadInProgress(item)) {
      safeSuggest();
      return;
    }

    const url = item.finalUrl || item.url;
    const pendingBrowserCapture = pendingBrowserDownloadCaptures.get(item.id);
    if (isDownloadInterceptionBlockedForSource(item.referrer, pendingBrowserCapture?.sourcePageUrl)) {
      safeSuggest();
      return;
    }
    const marked = markedUrls.get(url) || markedUrls.get(item.url);

    const responseClaim = getResponseCaptureClaim(url, item.url, item.finalUrl);
    if (responseClaim) {
      if (responseClaim.cancelBrowserDownloadImmediately) {
        responseClaim.browserDownloadCancelled = true;
        if (responseClaim.claimState) responseClaim.claimState.browserDownloadCancelled = true;
        await cancelBrowserDownloadItem(item, 'response-claim:onDeterminingFilename:immediate');
        releaseResponseCaptureClaimAfterBrowserCancel(responseClaim);
        openPendingSurfaceForResponseClaim(responseClaim, 'response-claim:onDeterminingFilename:immediate');
        markedUrls.delete(url);
        markedUrls.delete(item.url);
        return;
      }
      safeSuggest();
      responseClaim.promise.then(() => {
        cancelBrowserDownloadItem(item, 'response-claim:onDeterminingFilename:after-claim');
      });
      markedUrls.delete(url);
      markedUrls.delete(item.url);
      return;
    }

    if (pendingBrowserCapture) {
      try {
        const captured = await captureBrowserDownloadItem(item, 'browser-download:onDeterminingFilename:capture');
        if (!captured) safeSuggest();
      } catch (error) {
        console.warn('[Downlink][browser-download] deferred filename capture failed', {
          ...describeBrowserDownloadItem(item),
          error: error?.message || String(error),
        });
        safeSuggest();
      }
      return;
    }

    safeSuggest();
  });
}

chrome.downloads.onCreated.addListener(async (item) => {
  await configReady;
  if (!config.autoCapture || !isDownloadInProgress(item)) return;
  if (isRestoredBrowserDownloadItem(item)) return;

  const url = item.finalUrl || item.url;
  if (isDownloadInterceptionBlockedForSource(item.referrer)) return;
  const marked = markedUrls.get(url) || markedUrls.get(item.url);

  const responseClaim = getResponseCaptureClaim(url, item.url, item.finalUrl);
  if (responseClaim) {
    deleteResponseCaptureClaim(url, item.url, item.finalUrl);
    if (responseClaim.browserDownloadCancelled || responseClaim.claimState?.browserDownloadCancelled) {
      console.info('[Downlink][browser-download] skip duplicate cancel for already cancelled response claim', {
        ...describeBrowserDownloadItem(item),
        reason: 'response-claim:onCreated',
      });
    } else {
      responseClaim.browserDownloadCancelled = true;
      if (responseClaim.claimState) responseClaim.claimState.browserDownloadCancelled = true;
      await cancelBrowserDownloadItem(item, 'response-claim:onCreated');
      releaseResponseCaptureClaimAfterBrowserCancel(responseClaim);
      await openPendingSurfaceForResponseClaim(responseClaim, 'response-claim:onCreated');
    }
    markedUrls.delete(url);
    markedUrls.delete(item.url);
    return;
  }

  await captureBrowserDownloadItem(item, 'browser-download:onCreated:capture', { allowFilenameDefer: true });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await configReady;

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
        await forgetAria2OriginalUris(msg.gid);
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
      case 'REFRESH_ARIA2_TRACKERS':
        {
          const result = await refreshAria2TrackersFromSubscriptions();
          sendResponse({ ok: true, ...result });
        }
        break;
      case 'OPEN_MOTRIXNEXT_VIEW':
        sendResponse(await openMotrixNextView());
        break;
      case 'OPEN_GOPEED_VIEW':
        sendResponse(await openGopeedView());
        break;
      case 'ARIA2_RPC':
        {
          const method = String(msg.method || '');
          if (!ARIA2_MANAGER_METHODS.has(method)) {
            sendResponse({ ok: false, error: `Unsupported aria2 method: ${method}` });
            break;
          }
          try {
            let params = Array.isArray(msg.params) ? msg.params : [];
            let purgedGids = [];
            const effectiveConfig = getEffectiveConfig(msg.config);
            if (method === 'addUri' && Array.isArray(effectiveConfig.aria2Trackers) && effectiveConfig.aria2Trackers.length) {
              const uris = Array.isArray(params[0]) ? params[0] : [];
              const hasMagnet = uris.some((uri) => /^magnet:/i.test(String(uri || '')));
              const opts = params[1] && typeof params[1] === 'object' && !Array.isArray(params[1]) ? params[1] : {};
              if (hasMagnet && !opts['bt-tracker']) {
                params = [...params];
                params[1] = { ...opts, 'bt-tracker': effectiveConfig.aria2Trackers.join(',') };
              }
            }
            if (method === 'purgeDownloadResult') {
              try {
                const stopped = await aria2Call('tellStopped', [0, MAX_ARIA2_ORIGINAL_URI_RECORDS], msg.config);
                purgedGids = (Array.isArray(stopped) ? stopped : [])
                  .map((task) => task?.gid)
                  .filter(Boolean);
              } catch {}
            }
            let result = await aria2Call(method, params, msg.config);
            if (method === 'addUri') {
              await rememberAria2OriginalUris(result, params[0]);
              const gid = String(result || '').trim();
              const addedAt = Date.now();
              if (gid) {
                await rememberAria2TaskAddedAt(gid, addedAt);
              }
            } else if (ARIA2_TASK_RESULT_METHODS.has(method)) {
              result = await attachAria2OriginalUris(result);
            }
            if (ARIA2_REMOVE_METHODS.has(method)) {
              await forgetAria2OriginalUris(params[0]);
              await forgetAria2TaskAddedAt(params[0]);
            } else if (method === 'purgeDownloadResult') {
              await forgetAria2OriginalUris(purgedGids);
              await forgetAria2TaskAddedAt(purgedGids);
            }
            sendResponse({ ok: true, result });
          } catch (error) {
            sendResponse({ ok: false, error: error?.message || String(error) });
          }
        }
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
  configReady
    .then(() => refreshAria2TrackersFromSubscriptions({ force: false }))
    .catch(() => {});
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
  mediaManager.clearTabState(tabId);
  mediaManager.clearPreviewRule(tabId);
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
  refreshAria2TrackersFromSubscriptions({ force: false }).catch(() => {});
  if (config.downloaderType !== 'aria2') return;
  await Promise.all([aria2OriginalUrisReady, aria2TaskMetaReady]);
  try {
    for (const status of await aria2Call('tellActive')) {
      const filePath = status.files?.[0]?.path || '';
      tasks[status.gid] = {
        gid: status.gid,
        url: getAria2OriginalUris(status.gid)[0] || status.files?.[0]?.uris?.[0]?.uri || '',
        filename: filePath.split(/[\\/]/).pop() || '',
        filePath,
        dirPath: dirname(filePath),
        addedAt: getAria2TaskAddedAt(status.gid),
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
  updateActionBadgeForTab,
  mediaManager,
};
